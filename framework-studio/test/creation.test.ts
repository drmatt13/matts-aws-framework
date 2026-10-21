import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { CREATION_KINDS, creationDefaults, readCreationRequest, type CreationKind } from "../shared/creation";
import { assertCreationFile, planCreation } from "../server/edits/creation";
import { EditService } from "../server/edits/transaction";
import { writeSourceChange } from "../server/edits/io";
import { SnapshotBuilder } from "../server/snapshot";
import { generateCreationArtifacts } from "../server/edits/creation-generation";
import { resourceTypeErrors } from "../server/resources-source";
import { buildScene } from "../src/scene/build";

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, ".cache/framework-studio", `creation-${randomUUID()}`);
let builder: SnapshotBuilder;
let edits: EditService;
before(async () => {
  mkdirSync(fixture, { recursive: true });
  const include = (source: string) => !/(?:^|\/)(?:node_modules|cdk\.out|dist|\.git)(?:\/|$)/.test(source) && (!/\/\.env(?:\.|$)/.test(source) || path.basename(source) === ".env.example");
  for (const relative of ["framework-config", "framework.config.ts", "package.json", "package-lock.json", "docker-compose.yml", "docker-compose.services.yml", "packages/framework/src", "packages/api-contract/src/generated", "cdk-app/lib", "cdk-app/bin", "cdk-app/deployment.ts", "cdk-app/database-settings.ts", "cdk-app/tsconfig.json", "cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents", "scripts"]) cpSync(path.join(root, relative), path.join(fixture, relative), { recursive: true, filter: include });
  const manifests = require("node:fs").globSync(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).workspaces.map((pattern: string) => `${pattern}/package.json`), { cwd: root }) as string[];
  for (const relative of manifests) { mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true }); cpSync(path.join(root, relative), path.join(fixture, relative)); }
  for (const mode of ["dev", "prod"]) cpSync(path.join(root, `cdk-app/.env.${mode}.template`), path.join(fixture, `cdk-app/.env.${mode}.template`));
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
});
after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });
// Add only fields the selected discriminant accepts: the HTTP parser rejects extras.
function valid(kind: CreationKind, extra: Record<string, unknown> = {}) {
  const defaults = creationDefaults(kind);
  return readCreationRequest({ kind, ...defaults, ...("id" in defaults ? { id: ["input", "secret", "stack"].includes(kind) ? "studioExample" : `studio-${kind}` } : {}), ...("envName" in defaults ? { envName: "STUDIO_EXAMPLE" } : {}), ...(kind === "stack" ? { className: "StudioExampleStack" } : {}), ...(kind === "route" ? { path: "/studio-example" } : {}), ...(kind === "service" ? { path: "/studio-example/*" } : {}), ...(kind === "vpc" ? { cidr: "10.42.0.0/16" } : {}), ...extra });
}
const state = () => builder.current!;
const revision = () => state().snapshot.revision;

for (const kind of CREATION_KINDS) test(`${kind}: complete reviewed creation, discovery, conflict protection, undo and redo`, async () => {
  const intent = valid(kind, { description: `Created in Studio: ${kind}` });
  const planned = planCreation(fixture, state(), intent);
  const originals = new Map([...planned.overrides].map(([file]) => [file, existsSync(file) ? readFileSync(file, "utf8") : null]));
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.select, planned.expected.select);
  assert.ok(plan.changes.length >= planned.overrides.size);
  for (const change of plan.changes) if (!originals.has(path.join(fixture, change.file))) originals.set(path.join(fixture, change.file), existsSync(path.join(fixture, change.file)) ? readFileSync(path.join(fixture, change.file), "utf8") : null);
  for (const [file, before] of originals) assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before, "review never writes source");
  const applied = await edits.applyBatch(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.equal(applied.select, planned.expected.select);
  assert.equal(state().snapshot.descriptions.values[planned.expected.select], intent.description, "the existing Inspector description reads the created description");
  for (const mode of ["dev", "prod"] as const) {
    const model = state().snapshot.models[mode];
    const ids = new Set([...model.targets.map((item) => item.ref), ...model.resources.map((item) => item.id), ...model.routes.map((item) => item.id)]);
    for (const id of [...planned.expected.targets, ...planned.expected.resources, ...planned.expected.routes]) assert.ok(ids.has(id), `${mode} discovers ${id}`);
    const scene = buildScene(model);
    assert.ok(scene.nodes.some((node) => node.id === planned.expected.select) || scene.islands.some((island) => island.id === planned.expected.select), "the canonical resource appears in the actual graph projection");
    assert.equal(model.status, "ok");
  }
  if (kind === "vpc") await assert.rejects(edits.planBatch([{ kind: "create", request: intent }], revision()), /no source changes/);
  else await assert.rejects(edits.planBatch([{ kind: "create", request: intent }], revision()), /already|exists/);
  const undo = await edits.undo();
  assert.equal(undo.status, "applied", undo.message);
  for (const [file, before] of originals) assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before, "undo restores exact bytes and removes only generated files");
  const redo = await edits.redo();
  assert.equal(redo.status, "applied", redo.message);
  const file = [...originals.keys()][0]!;
  const after = readFileSync(file, "utf8");
  writeFileSync(file, after + "\n// Concurrent user edit\n");
  await assert.rejects(edits.undo(), /changed/);
  assert.equal(readFileSync(file, "utf8"), after + "\n// Concurrent user edit\n");
  writeFileSync(file, after);
  assert.equal((await edits.undo()).status, "applied");
});

test("untrusted requests reject unsupported settings and never reflect secret plaintext", () => {
  for (const kind of CREATION_KINDS) {
    assert.throws(() => readCreationRequest({ ...valid(kind), [kind === "vpc" ? "zones" : "id"]: kind === "vpc" ? 1 : "../../outside" }));
    assert.throws(() => readCreationRequest({ ...valid(kind), plaintext: "do-not-echo-this" }), (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo-this"));
  }
  assert.throws(() => readCreationRequest({ ...valid("secret"), defaultValue: "do-not-echo-this" }), /unsupported settings/);
});

test("creation paths reject traversal, arbitrary files and symbolic-link parents", () => {
  for (const file of ["../outside.ts", "cdk-app/.env.dev", "package.json", "framework-config/../secret.ts", "framework-config/x/../../secret.ts", "framework-config/x\\secret.ts"]) assert.throws(() => assertCreationFile(fixture, file));
  const linked = path.join(fixture, "framework-config/linked");
  symlinkSync(path.join(fixture, "framework-config/http"), linked);
  try { assert.throws(() => assertCreationFile(fixture, "framework-config/linked/test.ts"), /symbolic/); }
  finally { rmSync(linked); }
});

test("concurrent source changes and newly occupied handler paths prevent all writes", async () => {
  const intent = valid("function", { id: "concurrent-function" });
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const handler = path.join(fixture, "cdk-app/lambda_functions/event_functions/concurrent-function/index.ts");
  mkdirSync(path.dirname(handler), { recursive: true });
  writeFileSync(handler, "// User-owned file\n");
  await assert.rejects(edits.applyBatch(plan.planId), /changed/);
  assert.equal(readFileSync(handler, "utf8"), "// User-owned file\n");
  assert.ok(!existsSync(path.join(fixture, "framework-config/events/concurrent-function.ts")));
  rmSync(path.dirname(handler), { recursive: true });
});

test("an HTTP route and authenticated handler include bindings, permission edges and generated routes in one review", async () => {
  const intent = valid("route", { id: "bound-route", path: "/bound-route", bindingResource: "resource:openaiApiKey", bindingVariable: "PROVIDER_SECRET_ARN" });
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  for (const file of ["cdk-app/lambda_functions/http_functions/bound-route/index.ts", "framework.config.ts", "framework-config/http/bound-route.ts", "packages/api-contract/src/generated/framework-routes.ts"]) assert.ok(plan.changes.some((change) => change.file === file), `review includes ${file}`);
  assert.match(plan.changes.find((change) => change.file.endsWith("bound-route/index.ts"))!.diff.unified, /authenticated/);
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  const model = state().snapshot.models.prod;
  const target = model.targets.find((item) => item.ref === "lambda:bound-route")!;
  assert.equal(target.userPool, true);
  assert.ok(model.edges.some((edge) => edge.from === target.ref && edge.to === "resource:openaiApiKey"));
  assert.ok(target.environment.some((entry) => entry.name === "PROVIDER_SECRET_ARN" && entry.value.kind === "reference"));
  assert.equal((await edits.undo()).status, "applied");
});

test("route aliases preserve target identity and WebSocket creation uses canonical ws route IDs", async () => {
  const target = state().snapshot.models.dev.targets.find((target) => target.ref === "lambda:graphql-api")!;
  const alias = await edits.planBatch([{ kind: "create", request: valid("route", { id: "route-alias", existingTarget: target.ref, path: "/route-alias", method: "POST" }) }], revision());
  assert.ok(alias.ok, JSON.stringify(alias.preflight));
  assert.equal((await edits.applyBatch(alias.planId)).status, "applied");
  assert.equal(state().snapshot.models.dev.targets.find((item) => item.ref === target.ref)!.constructId, target.constructId);
  assert.equal(state().snapshot.models.dev.routes.find((item) => item.id === "route:http:/route-alias")!.target, target.ref);
  assert.equal((await edits.undo()).status, "applied");
  const ws = await edits.planBatch([{ kind: "create", request: valid("route", { id: "ws-action", category: "webSocket", path: "studioAction" }) }], revision());
  assert.ok(ws.ok, JSON.stringify(ws.preflight));
  const result = await edits.applyBatch(ws.planId);
  assert.equal(result.status, "applied", result.message);
  assert.equal(result.select, "route:ws:studioAction");
  assert.equal((await edits.undo()).status, "applied");
});

test("catalog creation preserves authored environment values and secret consumers use automatic ARN delivery", async () => {
  const authored = path.join(fixture, "cdk-app/.env.dev");
  const privateValue = "fixture-value-kept-out-of-review";
  writeFileSync(authored, `STUDIO_EXAMPLE=${privateValue}\n`);
  const input = await edits.planBatch([{ kind: "create", request: valid("input", { required: true, defaultValue: "configured", consumer: "lambda:graphql-api", consumerVariable: "STUDIO_SETTING" }) }], revision());
  assert.ok(input.ok, JSON.stringify(input.preflight));
  assert.ok(!JSON.stringify(input).includes(privateValue));
  assert.equal((await edits.applyBatch(input.planId)).status, "applied");
  assert.equal(state().snapshot.models.dev.resources.find((item) => item.id === "resource:studioExample")!.absent, false);
  assert.equal(state().snapshot.models.prod.resources.find((item) => item.id === "resource:studioExample")!.absent, false);
  assert.equal((await edits.undo()).status, "applied");
  const secret = await edits.planBatch([{ kind: "create", request: valid("secret", { consumer: "lambda:graphql-api", consumerVariable: "STUDIO_SECRET_ARN" }) }], revision());
  assert.ok(secret.ok, JSON.stringify(secret.preflight));
  assert.ok(secret.changes.every((change) => !/^cdk-app\/\.env\.(dev|prod)$/.test(change.file)));
  assert.ok(secret.changes.some((change) => change.diff.unified.includes('.arn')));
  assert.equal((await edits.applyBatch(secret.planId)).status, "applied");
  assert.ok(state().snapshot.models.dev.edges.some((edge) => edge.from === "lambda:graphql-api" && edge.to === "resource:studioExample"));
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(authored, "utf8"), `STUDIO_EXAMPLE=${privateValue}\n`);
  rmSync(authored);
});

test("partial multi-file write failure restores existing files and removes newly created files", async () => {
  let writes = 0;
  const failing = new EditService(fixture, builder, (root, file, before, after) => {
    if (++writes === 2) throw new Error("Simulated second-write failure");
    writeSourceChange(root, file, before, after);
  });
  const plan = await failing.planBatch([{ kind: "create", request: valid("function", { id: "failed-function" }) }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const before = plan.changes.map(({ file }) => ({ file: path.join(fixture, file), content: existsSync(path.join(fixture, file)) ? readFileSync(path.join(fixture, file), "utf8") : null }));
  const result = await failing.applyBatch(plan.planId);
  assert.equal(result.status, "reverted", result.message);
  for (const { file, content } of before) assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, content);
  assert.equal(failing.history().undo, undefined);
  assert.ok(!existsSync(path.join(fixture, "cdk-app/lambda_functions/event_functions/failed-function")), "failed scaffolding directories are cleaned up");
});

test("post-write evaluation failure compensates the entire creation", async () => {
  const plan = await edits.planBatch([{ kind: "create", request: valid("function", { id: "verification-failure" }) }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const refresh = builder.refresh.bind(builder);
  let fail = true;
  builder.refresh = async () => { if (fail) { fail = false; throw new Error("Simulated post-write verification failure"); } return refresh(); };
  try {
    const result = await edits.applyBatch(plan.planId);
    assert.equal(result.status, "reverted", result.message);
    assert.ok(!existsSync(path.join(fixture, "framework-config/events/verification-failure.ts")));
    assert.ok(!existsSync(path.join(fixture, "cdk-app/lambda_functions/event_functions/verification-failure/index.ts")));
  } finally { builder.refresh = refresh; }
});

test("a catalog input can be a single-file transaction and source changes expire its approval", async () => {
  const files = ["dev", "prod"].map((mode) => path.join(fixture, `cdk-app/.env.${mode}.template`));
  const templates = files.map((file) => readFileSync(file, "utf8"));
  files.forEach((file, index) => writeFileSync(file, templates[index] + "\n# STUDIO_SINGLE=\n"));
  try {
    const intent = valid("input", { id: "singleInput", envName: "STUDIO_SINGLE" });
    const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    assert.deepEqual(plan.changes.map((change) => change.file), ["framework-config/resources.ts"]);
    const file = path.join(fixture, "framework-config/resources.ts");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before + "\n// Concurrent source edit\n");
    await assert.rejects(edits.applyBatch(plan.planId), /changed/);
    assert.equal(readFileSync(file, "utf8"), before + "\n// Concurrent source edit\n");
    writeFileSync(file, before);
    await builder.refresh();
    const fresh = await edits.planBatch([{ kind: "create", request: intent }], revision());
    assert.equal((await edits.applyBatch(fresh.planId)).status, "applied");
    assert.ok(buildScene(state().snapshot.models.dev).nodes.some((node) => node.id === "resource:singleInput"));
    assert.equal((await edits.undo()).status, "applied");
  } finally { files.forEach((file, index) => writeFileSync(file, templates[index]!)); }
});

test("generated declarations and stack registration survive full offline development and production synthesis", async () => {
  // Transaction behavior is exercised independently for every family above.
  // Build one realistic application fixture, generate once, then synth both graphs.
  const originals = new Map<string, string | null>();
  const source = new Map<string, string>();
  const stage = (file: string, text: string) => {
    if (!originals.has(file)) originals.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    source.set(file, text);
  };
  const baseline = state();
  for (const intent of [valid("stack", { id: "synthStack", className: "StudioSynthStack", scope: "prod" }), valid("workflow", { id: "synth-workflow", steps: ["lambda:invocation-test-step", "task:invocation-test-task"] }), valid("function", { id: "synth-function" }), valid("route", { id: "synth-route", path: "/synth-route" }), valid("service", { id: "synth-service", path: "/synth-service/*", deploy: "both" }), valid("task", { id: "synth-task" }), valid("agent", { id: "synth-agent", auth: false, tools: ["add-numbers"] }), valid("input", { id: "synthInput", envName: "STUDIO_SYNTH_INPUT" }), valid("secret", { id: "synthSecret", envName: "STUDIO_SYNTH_SECRET" }), valid("vpc")]) {
    for (const [file, text] of planCreation(fixture, baseline, intent).overrides) stage(file, text);
  }
  for (const [file, text] of (await generateCreationArtifacts(fixture, source)).overrides) stage(file, text);
  assert.deepEqual(resourceTypeErrors(fixture, Object.fromEntries(source)), []);
  const configured = await builder.refresh();
  for (const model of Object.values(configured.snapshot.models)) assert.equal(model.status, "ok", JSON.stringify(model.diagnostics));
  const project = JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.json"), "utf8")).context;
  const assemblyDirectory = path.join(root, ".cache/framework-studio", `creation-assembly-${randomUUID()}`);
  const cached = existsSync(path.join(root, "cdk-app/cdk.context.json")) ? JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.context.json"), "utf8")) : {};
  try {
    for (const mode of ["dev", "prod"] as const) {
      const inputs = path.join(fixture, `${mode}-synth.env`);
      writeFileSync(inputs, mode === "dev" ? "CDK_APP_NAME=my-aws-app\nLOCAL_DEV_URL=http://localhost:3000\n" : "USE_FRONTEND_CUSTOM_DOMAIN=false\nUSE_COGNITO_CUSTOM_DOMAIN=false\n");
      const outdir = path.join(assemblyDirectory, mode);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(CDK_|FRAMEWORK_|AWS_PROFILE$|PROD_DEPLOYMENT$|DEPLOY_PROD_WEBSOCKET_API$|DATABASE_)/.test(key)) delete env[key];
      const synth = spawnSync(process.execPath, ["--import", "tsx", "bin/main.ts"], { cwd: path.join(fixture, "cdk-app"), encoding: "utf8", timeout: 120_000, env: { ...env, CDK_OUTDIR: outdir, CDK_DEFAULT_ACCOUNT: "734849394764", CDK_DEFAULT_REGION: "us-east-1", AWS_EC2_METADATA_DISABLED: "true", CDK_CONTEXT_JSON: JSON.stringify({ ...project, ...cached, "aws:cdk:bundling-stacks": [], prodDeployment: String(mode === "prod"), deployProdWebSocketApi: String(mode === "prod") }), FRAMEWORK_INPUTS_FILE: inputs } });
      assert.equal(synth.status, 0, `${synth.stdout}\n${synth.stderr}`);
      const manifest = JSON.parse(readFileSync(path.join(outdir, "manifest.json"), "utf8"));
      const stacks = Object.keys(manifest.artifacts);
      assert.equal(stacks.some((id) => id.endsWith("StudioSynthStack")), mode === "prod", "stack registration honors its catalog scope");
      if (mode === "prod") {
        const artifact = manifest.artifacts[stacks.find((id) => id.endsWith("StudioSynthStack"))!] as { type: string; properties: { templateFile: string } };
        assert.equal(artifact.type, "aws:cloudformation:stack");
        const template = JSON.parse(readFileSync(path.join(outdir, artifact.properties.templateFile), "utf8"));
        assert.ok(Object.values(template.Resources).some((resource: any) => resource.Type === "AWS::SQS::Queue"));
      }
    }
  } finally {
    rmSync(assemblyDirectory, { recursive: true, force: true });
    for (const [file, before] of [...originals].reverse()) writeSourceChange(fixture, file, readFileSync(file, "utf8"), before);
  }
});
