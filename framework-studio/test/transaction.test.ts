import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { EditError, EditService, writeAtomically } from "../server/edits/transaction";
import { SnapshotBuilder } from "../server/snapshot";

/**
 * Writes, against a disposable copy of the repository's configuration.
 *
 * The copy lives under .cache/framework-studio/ inside the repository, so it
 * resolves @repo/framework and tsx exactly as the real config does, while
 * nothing a test writes can reach framework-config/ or wake Compose Watch.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");
const fixture = path.join(repositoryRoot, ".cache", "framework-studio", `fixture-${randomUUID()}`);
const serviceFile = path.join(fixture, "framework-config", "services", "example.ts");
const taskFile = path.join(fixture, "framework-config", "tasks", "worker.ts");
let builder: SnapshotBuilder;
let edits: EditService;

before(async () => {
  mkdirSync(path.join(fixture, "cdk-app", "lambda_functions"), { recursive: true });
  for (const id of ["cognito-custom-message", "cognito-post-confirmation-trigger"]) {
    const relative = `cdk-app/lambda_functions/event_functions/${id}`;
    mkdirSync(path.join(fixture, relative), { recursive: true });
    cpSync(path.join(repositoryRoot, relative, "index.ts"), path.join(fixture, relative, "index.ts"));
  }
  cpSync(path.join(repositoryRoot, "framework-config"), path.join(fixture, "framework-config"), { recursive: true });
  cpSync(path.join(repositoryRoot, "framework.config.ts"), path.join(fixture, "framework.config.ts"));
  // Test-only binding: a cloud caller must prevent removing its worker's cloud lane.
  writeFileSync(taskFile, 'export const worker = { "transaction-worker": { deploy: "both", } };\n');
  writeFileSync(path.join(fixture, "framework-config/http/worker.ts"), `import { runsTask } from "@repo/framework/config";
export const workerRoute = { "/worker": { directory: "/lambda_functions/worker", methods: ["POST"], cloud: { bindings: [runsTask("transaction-worker")] } } };
`);
  const configFile = path.join(fixture, "framework.config.ts");
  writeFileSync(configFile, 'import { worker } from "./framework-config/tasks/worker";\nimport { workerRoute } from "./framework-config/http/worker";\n' + readFileSync(configFile, "utf8")
    .replace(/http: \[([^\]]*)\]/, "http: [$1, workerRoute]")
    .replace(/tasks: \[([^\]]*)\]/, "tasks: [$1, worker]"));
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
});

after(async () => {
  await builder.dispose();
  rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function revision(): string {
  return builder.current!.snapshot.revision;
}

test("local replay reviews config and handler together, restores both exactly, and preserves concurrent handler edits", async () => {
  const target = "lambda:cognito-custom-message";
  const config = path.join(fixture, "framework-config/events/cognito.ts");
  const handler = path.join(fixture, "cdk-app/lambda_functions/event_functions/cognito-custom-message/index.ts");
  const beforeConfig = readFileSync(config, "utf8");
  const beforeHandler = readFileSync(handler, "utf8");
  const intent = { target, field: "events.localReplay", value: true } as const;
  const plan = await edits.planBatch([{ kind: "field", intent }], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.changes.length, 2);
  assert.equal(readFileSync(handler, "utf8"), beforeHandler, "review writes nothing");
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  const enabledHandler = readFileSync(handler, "utf8");
  const enabledConfig = readFileSync(config, "utf8");
  assert.match(enabledHandler, /lambdaHandler = withLocalReplay\(async/);
  assert.equal(builder.current!.snapshot.models.dev.fields[target].find((fact) => fact.field === "events.localReplay")?.effective, true);
  const off = await edits.planBatch([{ kind: "field", intent: { target, field: "events.localReplay", inherit: true } }], revision());
  assert.equal(off.ok, true, JSON.stringify(off.preflight));
  assert.equal((await edits.applyBatch(off.planId)).status, "applied");
  assert.ok(!readFileSync(handler, "utf8").includes("withLocalReplay(async"));
  assert.equal(builder.current!.snapshot.models.dev.fields[target].find((fact) => fact.field === "events.localReplay")?.effective, false);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(handler, "utf8"), enabledHandler);
  assert.equal(readFileSync(config, "utf8"), enabledConfig);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(handler, "utf8"), beforeHandler);
  assert.equal(readFileSync(config, "utf8"), beforeConfig);
  assert.equal((await edits.redo()).status, "applied");
  assert.equal(readFileSync(handler, "utf8"), enabledHandler);
  await edits.undo();
  const conflicting = await edits.planBatch([{ kind: "field", intent }], revision());
  writeFileSync(handler, `${beforeHandler}\n// Concurrent author edit\n`);
  await assert.rejects(edits.applyBatch(conflicting.planId), /handler changed/);
  assert.equal(readFileSync(config, "utf8"), beforeConfig);
  assert.ok(readFileSync(handler, "utf8").endsWith("// Concurrent author edit\n"));
  writeFileSync(handler, beforeHandler);
  await builder.refresh();
  const required = await edits.planBatch([{ kind: "field", intent: { target: "lambda:cognito-post-confirmation-trigger", field: "events.localReplay", inherit: true } }], revision());
  assert.equal(required.ok, false, "an event using the database still needs local replay");
  await assert.rejects(edits.applyBatch(required.planId), /rejected settings/);
  assert.equal(readFileSync(config, "utf8"), beforeConfig);
  await assert.rejects(edits.plan(intent, revision()), /configuration and handler wrapper/);
});

test("five settings are reviewed together, persisted together and undone as one exact source change", async () => {
  const target = "lambda:graphql-api";
  const file = path.join(fixture, builder.current!.snapshot.source.entities[target].value.file);
  const original = readFileSync(file, "utf8");
  const values = [["lambda.memorySize", 768], ["lambda.timeoutSeconds", 25], ["lambda.architecture", "x86_64"], ["lambda.logRetentionDays", 14], ["lambda.bundling.minify", false]] as const;
  const plan = await edits.planBatch(values.map(([field, value]) => ({ kind: "field", intent: { target, field, value } })), revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.summaries.length, 5);
  assert.equal(plan.changes.length, 1, "same-file changes share one diff");
  assert.equal(readFileSync(file, "utf8"), original, "review writes no source");
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  for (const [field, value] of values) assert.equal(builder.current!.snapshot.models.dev.fields[target].find((fact) => fact.field === field)!.authored, value);
  const changed = readFileSync(file, "utf8");
  assert.match(edits.history().undo!, /5 inspector changes/);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal((await edits.redo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), changed);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original, "comments, imports and formatting return byte for byte");
});

test("a route and nested settings compose across files without losing prior splices", async () => {
  const state = builder.current!.snapshot;
  const target = state.models.dev.routes.find((route) => route.path === "/worker")!.target;
  const file = path.join(fixture, state.source.entities[target].value.file);
  const defaultsFile = path.join(fixture, "framework-config/defaults.ts");
  const originals = [file, defaultsFile].map((file) => [file, readFileSync(file, "utf8")] as const);
  const plan = await edits.planBatch([
    { kind: "field", intent: { target, field: "lambda.memorySize", value: 256 } },
    { kind: "field", intent: { target, field: "lambda.bundling.minify", value: false } },
    { kind: "field", intent: { target: "defaults:http", field: "defaults.http.timeoutSeconds", value: 20 } },
    { kind: "route", route: "route:http:/worker", value: "/batch-worker" },
  ], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.changes.length, 2);
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  const model = builder.current!.snapshot.models.dev;
  assert.ok(model.routes.some((route) => route.path === "/batch-worker" && route.target === target));
  assert.equal(model.fields[target].find((fact) => fact.field === "lambda.memorySize")!.effective, 256);
  assert.equal(model.fields[target].find((fact) => fact.field === "lambda.bundling.minify")!.effective, false);
  assert.equal((await edits.undo()).status, "applied");
  for (const [file, original] of originals) assert.equal(readFileSync(file, "utf8"), original);
});

test("interdependent edits validate as a complete configuration and rejected drafts write nothing", async () => {
  const route = builder.current!.snapshot.models.dev.routes.find((route) => route.path === "/worker")!;
  const worker = { kind: "field", intent: { target: "task:transaction-worker", field: "deploy", value: "local-only" } } as const;
  const invalid = await edits.planBatch([worker], revision());
  assert.equal(invalid.ok, false, "the cloud caller still needs a cloud worker");
  await rejects(edits.applyBatch(invalid.planId), 422, /rejected settings/);
  const combined = await edits.planBatch([worker, { kind: "field", intent: { target: route.target, field: "deploy", value: "local-only" } }], revision());
  assert.equal(combined.ok, true, JSON.stringify(combined.preflight));
  assert.equal((await edits.applyBatch(combined.planId)).status, "applied");
  assert.equal((await edits.undo()).status, "applied");
});

test("a concurrent change to one batch file prevents every batch write", async () => {
  const defaultsFile = path.join(fixture, "framework-config/defaults.ts");
  const original = readFileSync(defaultsFile, "utf8");
  const originalService = readFileSync(serviceFile, "utf8");
  const plan = await edits.planBatch([
    { kind: "field", intent: { target: "defaults:lambda", field: "defaults.lambda.memorySize", value: 256 } },
    { kind: "field", intent: { target: "service:example-service", field: "deploy", value: "both" } },
  ], revision());
  assert.equal(plan.ok, true);
  writeFileSync(defaultsFile, original + "\n// External edit\n");
  await rejects(edits.applyBatch(plan.planId), 409, /Source files changed/);
  assert.equal(readFileSync(serviceFile, "utf8"), originalService);
  assert.equal(readFileSync(defaultsFile, "utf8"), original + "\n// External edit\n");
  writeFileSync(defaultsFile, original);
  await builder.refresh();
});

test("island defaults insert a service group, preserve workload overrides, and undo/redo exact source", async () => {
  const file = path.join(fixture, "framework-config", "defaults.ts");
  const original = readFileSync(file, "utf8");
  const model = () => builder.current!.snapshot.models.dev;
  const facts = () => model().fields["defaults:http"];
  const field = facts().find((fact) => fact.field === "defaults.http.memorySize")!;
  assert.equal(field.authored, undefined);
  assert.equal(field.effective, 128);
  assert.ok(field.usage!.inherited > 0);
  assert.equal(builder.current!.snapshot.source.editability["defaults:http"][field.field].kind, "absent");
  const before = new Map(model().targets.filter((target) => target.role === "http").map((target) => [target.ref, model().fields[target.ref].find((fact) => fact.field === "lambda.memorySize")!]));
  const plan = await edits.plan({ target: "defaults:http", field: field.field, value: 384 }, revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.file, "framework-config/defaults.ts");
  assert.equal(readFileSync(file, "utf8"), original, "preview never writes");
  assert.equal((await edits.apply(plan.planId)).status, "applied");
  assert.equal(facts().find((fact) => fact.field === field.field)!.authored, 384);
  for (const [ref, old] of before) {
    const next = model().fields[ref].find((fact) => fact.field === "lambda.memorySize")!;
    assert.equal(next.authored, old.authored, "individual source overrides stay intact");
    assert.equal(next.effective, old.authored === undefined ? 384 : old.effective);
  }
  const authored = readFileSync(file, "utf8");
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal((await edits.redo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), authored);
  const inherit = await edits.plan({ target: "defaults:http", field: field.field, inherit: true }, revision());
  assert.equal((await edits.apply(inherit.planId)).status, "applied");
  assert.equal(facts().find((fact) => fact.field === field.field)!.effective, 128);
  // Return the disposable file to its original bytes for neighboring tests.
  assert.equal((await edits.undo()).status, "applied");
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original);
});

test("shared default switches, required baselines and numeric domains use the existing edit safeguards", async () => {
  await rejects(edits.plan({ target: "defaults:lambda", field: "defaults.lambda.memorySize", inherit: true }, revision()), 422, /required baseline/);
  await rejects(edits.plan({ target: "defaults:database", field: "defaults.database.pool.maxConnections", value: 0 }, revision()), 422, /whole number/);
  const file = path.join(fixture, "framework-config", "defaults.ts");
  const original = readFileSync(file, "utf8");
  const plan = await edits.plan({ target: "defaults:lambda", field: "defaults.lambda.bundling.minify", value: false }, revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal((await edits.apply(plan.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.fields["defaults:lambda"].find((fact) => fact.field === plan.field)!.effective, false);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original);
});

test("container and database pool defaults retain their own nested source paths", async () => {
  const file = path.join(fixture, "framework-config", "defaults.ts");
  const original = readFileSync(file, "utf8");
  for (const [target, field, value] of [
    ["defaults:container", "defaults.container.architecture", "arm64"],
    ["defaults:database", "defaults.database.pool.maxConnections", 11],
  ] as const) {
    const plan = await edits.plan({ target, field, value }, revision());
    assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
    assert.equal((await edits.apply(plan.planId)).status, "applied");
    assert.equal(builder.current!.snapshot.models.dev.fields[target].find((fact) => fact.field === field)!.effective, value);
    assert.equal((await edits.undo()).status, "applied");
    assert.equal(readFileSync(file, "utf8"), original);
  }
});

async function rejects(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof EditError, String(error));
    assert.equal(error.status, status, error.message);
    assert.match(error.message, message);
    return true;
  });
}

test("a valid edit is written, reflected in the next snapshot, and undone to the byte", async () => {
  const original = readFileSync(serviceFile, "utf8");
  const plan = await edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.ok(plan.impact.includes("Runs in local → local, prod AWS."), plan.impact.join(" | "));
  assert.equal(readFileSync(serviceFile, "utf8"), original, "planning writes nothing");

  const applied = await edits.apply(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.equal(readFileSync(serviceFile, "utf8"), original.replace('deploy: "local-only"', 'deploy: "both"'));
  const service = builder.current!.snapshot.models.dev.targets.find((target) => target.ref === "service:example-service")!;
  assert.equal(service.lanes.deploy, "both");
  assert.deepEqual(edits.history(), { undo: 'service:example-service Deploy: "local-only" → "both"' });

  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(serviceFile, "utf8"), original);
  assert.equal((await edits.redo()).status, "applied");
  assert.equal(readFileSync(serviceFile, "utf8"), original.replace('deploy: "local-only"', 'deploy: "both"'));
  await edits.undo();
  assert.equal(readFileSync(serviceFile, "utf8"), original);
});

test("a change the framework refuses is previewed with its reason and cannot be applied", async () => {
  const original = readFileSync(taskFile, "utf8");
  const plan = await edits.plan({ target: "task:transaction-worker", field: "deploy", value: "local-only" }, revision());
  assert.equal(plan.ok, false);
  assert.match(plan.preflight.dev.diagnostics[0]!.message, /removes from the cloud lane the caller still runs in/);
  await rejects(edits.apply(plan.planId), 422, /refuses/);
  assert.equal(readFileSync(taskFile, "utf8"), original);
});

test("Lambda build controls round-trip architecture, numeric retention and boolean bundling through validated writes", async () => {
  const file = path.join(fixture, "framework-config/http/graphql.ts");
  const original = readFileSync(file, "utf8");
  for (const [field, value] of [["lambda.architecture", "x86_64"], ["lambda.runtime", "nodejs22"], ["lambda.logRetentionDays", 14], ["lambda.bundling.minify", false], ["lambda.bundling.sourceMap", true]] as const) {
    const plan = await edits.plan({ target: "lambda:graphql-api", field, value }, revision());
    assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
    assert.equal(plan.preflight.dev.predicted?.effective, value);
    assert.equal((await edits.apply(plan.planId)).status, "applied");
    assert.equal(builder.current!.snapshot.models.dev.fields["lambda:graphql-api"]!.find((fact) => fact.field === field)?.effective, value);
    assert.equal((await edits.undo()).status, "applied");
    assert.equal(readFileSync(file, "utf8"), original);
  }
  const refused = await edits.plan({ target: "lambda:graphql-api", field: "lambda.packaging", value: "container" }, revision());
  assert.equal(refused.ok, false, "a database Lambda cannot switch to an image outside the supported database runtime");
  await rejects(edits.apply(refused.planId), 422, /refuses/);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("Cognito event Lambda settings can be previewed, written and undone in their section module", async () => {
  const file = path.join(fixture, "framework-config/events/cognito.ts");
  const original = readFileSync(file, "utf8");
  const target = "lambda:cognito-pre-signup-trigger";
  for (const [field, value] of [["lambda.architecture", "x86_64"], ["lambda.runtime", "nodejs22"], ["lambda.bundling.minify", false], ["lambda.bundling.sourceMap", false], ["lambda.logRetentionDays", 14]] as const) {
    const plan = await edits.plan({ target, field, value }, revision());
    assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
    assert.equal(plan.file, "framework-config/events/cognito.ts");
    assert.equal((await edits.apply(plan.planId)).status, "applied");
    assert.equal(builder.current!.snapshot.models.dev.fields[target]!.find((fact) => fact.field === field)?.effective, value);
    assert.equal((await edits.undo()).status, "applied");
    assert.equal(readFileSync(file, "utf8"), original);
  }
  const packaging = await edits.plan({ target, field: "lambda.packaging", value: "container" }, revision());
  assert.equal(packaging.ok, true, JSON.stringify(packaging.preflight));
  assert.equal(readFileSync(file, "utf8"), original, "a preview alone never changes the app's declaration");
});

test("a file edited after the preview is never overwritten", async () => {
  const plan = await edits.plan({ target: "service:example-service", field: "container.subnet", value: "private" }, revision());
  const theirs = readFileSync(serviceFile, "utf8").replace("cpu: 256", "cpu: 512");
  writeFileSync(serviceFile, theirs);
  await rejects(edits.apply(plan.planId), 409, /changed since this preview/);
  assert.equal(readFileSync(serviceFile, "utf8"), theirs);
  writeFileSync(serviceFile, theirs.replace("cpu: 512", "cpu: 256"));
  await builder.refresh();
});

test("a preview from an older snapshot is refused, and a refresh expires outstanding previews", async () => {
  await rejects(edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, "0-stale"), 409, /changed since this view/);
  const plan = await edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, revision());
  await builder.refresh();
  edits.expirePlans();
  await rejects(edits.apply(plan.planId), 410, /expired/);
});

test("a config that stops loading keeps its last good model, refuses edits, and recovers", async () => {
  const original = readFileSync(taskFile, "utf8");
  writeFileSync(taskFile, original.replace('deploy: "both",', 'deploy: "both",,,'));
  try {
    const broken = (await builder.refresh()).snapshot;
    assert.equal(broken.models.dev.stale, true);
    assert.equal(broken.models.dev.diagnostics[0]?.stage, "load");
    assert.match(broken.models.dev.diagnostics[0]!.message, /worker\.ts:\d+:\d+/);
    assert.ok(broken.models.dev.targets.some((target) => target.ref === "task:transaction-worker"), "the last good targets are still shown");
    await rejects(
      edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, broken.revision),
      422,
      /does not load right now/,
    );
  } finally {
    writeFileSync(taskFile, original);
  }
  const recovered = (await builder.refresh()).snapshot;
  assert.equal(recovered.models.dev.stale, undefined);
  assert.equal(recovered.models.dev.status, "ok");
});

test("an atomic write leaves no temporary file behind", () => {
  const target = path.join(fixture, "atomic.txt");
  writeFileSync(target, "before");
  writeAtomically(fixture, target, "after");
  assert.equal(readFileSync(target, "utf8"), "after");
  assert.deepEqual(readdirSync(path.join(fixture, ".cache", "framework-studio", "tmp")), []);
});

test("an HTTP route rename updates its gateway and preserves the Lambda identity through undo and redo", async () => {
  const file = path.join(fixture, "framework-config/http/examples.ts");
  const original = readFileSync(file, "utf8");
  const identity = (mode: "dev" | "prod") => builder.current!.snapshot.models[mode].targets.map((target) => [target.ref, target.constructId]);
  const before = { dev: identity("dev"), prod: identity("prod") };
  const plan = await edits.planRoute("route:http:/examples/python", "/examples/renamed", revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal((await edits.apply(plan.planId)).status, "applied");
  for (const mode of ["dev", "prod"] as const) {
    assert.deepEqual(identity(mode), before[mode]);
    const model = builder.current!.snapshot.models[mode];
    assert.equal(model.routes.find((route) => route.id === "route:http:/examples/renamed")?.target, "lambda:python-example");
    assert.equal(model.routes.find((route) => route.id === "route:http:/examples/renamed")?.browserPath, "/api/examples/renamed");
    assert.ok(!model.routes.some((route) => route.id === "route:http:/examples/python"));
  }
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal((await edits.redo()).status, "applied");
  await edits.undo();
  assert.equal(readFileSync(file, "utf8"), original);
});

test("route renames reject duplicate and invalid paths and preserve concurrent edits", async () => {
  await rejects(edits.planRoute("route:http:/examples/python", "/graphql", revision()), 422, /already uses/);
  await rejects(edits.planRoute("route:http:/examples/python", "no-leading-slash", revision()), 422, /beginning with/);
  const invalid = await edits.planRoute("route:http:/examples/python", "/examples/:id", revision());
  assert.equal(invalid.ok, false);
  await rejects(edits.apply(invalid.planId), 422, /refuses/);
  const file = path.join(fixture, "framework-config/http/examples.ts");
  const original = readFileSync(file, "utf8");
  const plan = await edits.planRoute("route:http:/examples/python", "/examples/another", revision());
  const theirs = `${original}\n// concurrent edit\n`;
  writeFileSync(file, theirs);
  await rejects(edits.apply(plan.planId), 409, /changed since this preview/);
  assert.equal(readFileSync(file, "utf8"), theirs);
  writeFileSync(file, original);
  await builder.refresh();
});

test("HTTP authorizer auth can be switched off and on without changing handler user-pool access", async () => {
  const file = path.join(fixture, "framework-config/http/graphql.ts");
  const original = readFileSync(file, "utf8");
  const before = builder.current!.snapshot.models.dev.targets.find((target) => target.ref === "lambda:graphql-api")!;
  const disabled = await edits.plan({ target: before.ref, field: "http.auth", inherit: true }, revision());
  assert.equal(disabled.ok, true, JSON.stringify(disabled.preflight));
  assert.equal(disabled.preflight.dev.predicted?.effective, false);
  assert.equal((await edits.apply(disabled.planId)).status, "applied");
  assert.equal(readFileSync(file, "utf8"), original.replace("    auth: true,\n", ""));
  const model = builder.current!.snapshot.models.dev;
  assert.equal(model.routes.find((route) => route.id === "route:http:/graphql")?.auth, false);
  const target = model.targets.find((target) => target.ref === before.ref)!;
  assert.equal(target.constructId, before.constructId);
  assert.equal(target.userPool, true);
  assert.deepEqual(target.environment, before.environment);
  const enabled = await edits.plan({ target: before.ref, field: "http.auth", value: true }, revision());
  assert.equal(enabled.ok, true, JSON.stringify(enabled.preflight));
  assert.equal((await edits.apply(enabled.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.prod.routes.find((route) => route.id === "route:http:/graphql")?.auth, true);
  assert.ok(!readFileSync(file, "utf8").includes("auth: false"));
  await edits.undo();
  await edits.undo();
  assert.equal(readFileSync(file, "utf8"), original);
  await rejects(edits.plan({ target: before.ref, field: "http.auth", value: false }, revision()), 422, /takes one of true/);
});

test("HTTP service mounts expose the same API authorizer control and event Lambdas do not", async () => {
  const original = readFileSync(serviceFile, "utf8");
  const model = builder.current!.snapshot.models.dev;
  assert.ok(model.fields["service:example-service"]!.some((field) => field.field === "http.auth"));
  assert.ok(!model.fields["lambda:cognito-pre-signup-trigger"]!.some((field) => field.field === "http.auth"));
  const plan = await edits.plan({ target: "service:example-service", field: "http.auth", inherit: true }, revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal((await edits.apply(plan.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.routes.find((route) => route.id === "route:service:/example-service/*")?.auth, false);
  await edits.undo();
  assert.equal(readFileSync(serviceFile, "utf8"), original);
});
