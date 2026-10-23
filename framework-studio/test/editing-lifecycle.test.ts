import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { SourceJournal } from "../server/edits/journal";
import { creationDefaults, readCreationRequest, type CreationKind } from "../shared/creation";

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, ".cache/framework-studio", `lifecycle-${randomUUID()}`);
let builder: SnapshotBuilder, edits: EditService;
before(async () => {
  mkdirSync(fixture, { recursive: true });
  const filter = (source: string) => !/(?:^|\/)(?:node_modules|cdk\.out|dist|\.git)(?:\/|$)/.test(source) && (!/\/\.env(?:\.|$)/.test(source) || path.basename(source) === ".env.example");
  for (const relative of ["framework-config", "framework.config.ts", "package.json", "package-lock.json", "docker-compose.yml", "docker-compose.services.yml", "packages/framework/src", "packages/api-contract/src/generated", "cdk-app/lib", "cdk-app/bin", "cdk-app/deployment.ts", "cdk-app/database-settings.ts", "cdk-app/cdk.json", "cdk-app/tsconfig.json", "cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents", "scripts"]) cpSync(path.join(root, relative), path.join(fixture, relative), { recursive: true, filter });
  for (const relative of globSync(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).workspaces.map((pattern: string) => `${pattern}/package.json`), { cwd: root })) { mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true }); cpSync(path.join(root, relative), path.join(fixture, relative)); }
  for (const mode of ["dev", "prod"]) cpSync(path.join(root, `cdk-app/.env.${mode}.template`), path.join(fixture, `cdk-app/.env.${mode}.template`));
  builder = new SnapshotBuilder(fixture); edits = new EditService(fixture, builder); await builder.refresh();
});
after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });
const state = () => builder.current!;
const revision = () => state().snapshot.revision;
const request = (kind: CreationKind, values: Record<string, unknown>) => readCreationRequest({ kind, ...creationDefaults(kind), ...values });

test("packaging conversion refuses missing canonical artifacts without source writes", async () => {
  const file = path.join(fixture, "framework-config/workloads/events.ts"), before = readFileSync(file, "utf8");
  const plan = await edits.planBatch([{ kind: "field", intent: { target: "lambda:invocation-test-step", field: "lambda.packaging", value: "container" } }], revision());
  assert.equal(plan.ok, false);
  assert.match(JSON.stringify(plan.preflight), /no Dockerfile/);
  await assert.rejects(edits.applyBatch(plan.planId), /rejected/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("missing configured implementation is visible and reviewed repair preserves occupied paths and undo", async () => {
  const created = await edits.planBatch([{ kind: "create", request: request("function", { id: "audit-repair", category: "http", path: "/audit-repair", auth: false, directory: "/lambda_functions/http_functions/audit-custom-repair" }) }], revision());
  assert.ok(created.ok, JSON.stringify(created.preflight)); assert.equal((await edits.applyBatch(created.planId)).status, "applied");
  const directory = path.join(fixture, "cdk-app/lambda_functions/http_functions/audit-custom-repair"), backup = path.join(fixture, "backup-step");
  renameSync(directory, backup);
  try {
    await builder.refresh();
    assert.equal(state().snapshot.models.dev.targets.find(target => target.ref === "lambda:audit-repair")?.implementation?.ready, false);
    const review = await edits.planBatch([{ kind: "implementation", target: "lambda:audit-repair" }], revision());
    assert.ok(review.ok, JSON.stringify(review.preflight));
    assert.ok(review.changes.some(change => change.file.endsWith("audit-custom-repair/index.ts") && change.operation === "create"));
    assert.equal(existsSync(directory), false, "review creates no implementation directory");
    mkdirSync(directory); writeFileSync(path.join(directory, "index.ts"), "// later editor\n");
    await assert.rejects(edits.applyBatch(review.planId), /changed/);
    assert.equal(readFileSync(path.join(directory, "index.ts"), "utf8"), "// later editor\n");
    rmSync(directory, { recursive: true });
    const retry = await edits.planBatch([{ kind: "implementation", target: "lambda:audit-repair" }], revision());
    assert.equal((await edits.applyBatch(retry.planId)).status, "applied");
    assert.equal(state().snapshot.models.dev.targets.find(target => target.ref === "lambda:audit-repair")?.implementation?.ready, true);
    assert.equal((await edits.undo()).status, "applied");
    assert.equal(existsSync(path.join(directory, "index.ts")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); renameSync(backup, directory); await builder.refresh(); assert.equal((await edits.undo()).status, "applied"); }
});

test("route edits review and install real generated contracts; late implementation changes stale the review", async () => {
  const generated = path.join(fixture, "packages/api-contract/src/generated/framework-routes.ts"), before = readFileSync(generated, "utf8");
  const plan = await edits.planBatch([{ kind: "route", route: "route:http:/graphql", value: "/audit-graphql" }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.ok(plan.changes.some(change => change.file.endsWith("framework-routes.ts")));
  const handler = path.join(fixture, "cdk-app/lambda_functions/http_functions/graphql-api/index.ts"), original = readFileSync(handler, "utf8");
  writeFileSync(handler, original + "\n// external change\n");
  await assert.rejects(edits.applyBatch(plan.planId), /changed/);
  assert.equal(readFileSync(generated, "utf8"), before);
  writeFileSync(handler, original);
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  assert.match(readFileSync(generated, "utf8"), /audit-graphql/);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(generated, "utf8"), before);
});

test("echo and tool starters use real contracts without introducing model prerequisites", async () => {
  const agent = await edits.planBatch([{ kind: "create", request: request("agent", { id: "audit-echo", directory: "/agents/audit-custom-echo" }) }], revision());
  assert.ok(agent.ok, JSON.stringify(agent.preflight));
  assert.ok(agent.changes.some(change => change.file === "agents/audit-custom-echo/index.ts"));
  assert.ok(!agent.changes.find(change => change.file === "agents/audit-custom-echo/package.json")!.diff.unified.includes("@repo/models"));
  assert.equal((await edits.applyBatch(agent.planId)).status, "applied");
  assert.equal(state().snapshot.models.prod.targets.find(target => target.ref === "agent:audit-echo")!.requirements, 0);
  assert.equal((await edits.undo()).status, "applied");
  const tool = await edits.planBatch([{ kind: "create", request: request("tool", { id: "audit-tool" }) }], revision());
  assert.ok(tool.ok, JSON.stringify(tool.preflight));
  assert.match(tool.changes.find(change => change.file.endsWith("audit-tool/index.ts"))!.diff.unified, /authenticatedTool/);
  assert.equal((await edits.applyBatch(tool.planId)).status, "applied");
  assert.equal(state().snapshot.models.dev.targets.find(target => target.ref === "lambda:audit-tool")!.role, "tool");
  assert.equal((await edits.undo()).status, "applied");
});

test("partial tool scaffold rejects an incompatible existing contract without overwriting it", async () => {
  const creation = await edits.planBatch([{ kind: "create", request: request("tool", { id: "audit-partial-tool" }) }], revision());
  assert.ok(creation.ok, JSON.stringify(creation.preflight)); assert.equal((await edits.applyBatch(creation.planId)).status, "applied");
  const directory = path.join(fixture, "cdk-app/lambda_functions/tool_functions/audit-partial-tool"), handler = path.join(directory, "index.ts"), contract = path.join(directory, "contract.ts");
  const originalHandler = readFileSync(handler, "utf8"), originalContract = readFileSync(contract, "utf8");
  try {
    rmSync(handler); writeFileSync(contract, originalContract.replace("message: z.string().min(1).max(8000)", "other: z.string()")); await builder.refresh();
    const rejected = await edits.planBatch([{ kind: "implementation", target: "lambda:audit-partial-tool" }], revision());
    assert.equal(rejected.ok, false); assert.match(JSON.stringify(rejected.preflight), /message/);
    assert.equal(existsSync(handler), false); assert.match(readFileSync(contract, "utf8"), /other/);
    writeFileSync(contract, originalContract); await builder.refresh();
    const repair = await edits.planBatch([{ kind: "implementation", target: "lambda:audit-partial-tool" }], revision());
    assert.ok(repair.ok, JSON.stringify(repair.preflight));
    writeFileSync(contract, originalContract + "\n// changed after review\n");
    await assert.rejects(edits.applyBatch(repair.planId), /changed/); assert.equal(existsSync(handler), false);
  } finally { writeFileSync(contract, originalContract); writeFileSync(handler, originalHandler); await builder.refresh(); assert.equal((await edits.undo()).status, "applied"); }
});

test("existing code creation uses the configured path and rejects unsafe implementation paths", async () => {
  for (const directory of ["/lambda_functions/../escape", "/lambda_functions/http_functions/a\\b", "/outside/handler"]) assert.throws(() => request("function", { id: "audit-existing", category: "http", path: "/audit-existing", directory }));
  const directory = path.join(fixture, "cdk-app/lambda_functions/http_functions/audit-existing-code"); mkdirSync(directory);
  const file = path.join(directory, "index.ts"), bytes = 'export const lambdaHandler = async () => ({ statusCode: 200, body: "User owned" });\n'; writeFileSync(file, bytes);
  try {
    const createRequest = request("function", { id: "audit-existing", category: "http", path: "/audit-existing", auth: false, directory: "/lambda_functions/http_functions/audit-existing-code", implementation: "existing" });
    const plan = await edits.planBatch([{ kind: "create", request: createRequest }], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight)); assert.ok(!plan.changes.some(change => change.file === "cdk-app/lambda_functions/http_functions/audit-existing-code/index.ts"));
    assert.equal((await edits.applyBatch(plan.planId)).status, "applied"); assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal((await edits.undo()).status, "applied"); assert.equal(readFileSync(file, "utf8"), bytes);
  } finally { rmSync(directory, { recursive: true }); }
});

test("container and agent removal include source archives, workspace projections and exact undo", async () => {
  for (const kind of ["service", "task", "agent"] as const) {
    const id = `audit-remove-${kind}`, creation = await edits.planBatch([{ kind: "create", request: request(kind, { id, ...(kind === "service" ? { path: `/${id}/*` } : {}), ...(["service", "task"].includes(kind) ? { vpc: "application" } : {}) }) }], revision());
    assert.ok(creation.ok, JSON.stringify(creation.preflight)); assert.equal((await edits.applyBatch(creation.planId)).status, "applied");
    const removal = await edits.planBatch([{ kind: "removeWorkload", target: `${kind}:${id}` }], revision());
    assert.ok(removal.ok, JSON.stringify(removal.preflight)); assert.ok(removal.changes.some(change => change.file.startsWith(`archived-workloads/${kind}/${id}/`)));
    assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
    assert.equal(state().snapshot.models.dev.targets.some(target => target.ref === `${kind}:${id}`), false);
    assert.equal((await edits.undo()).status, "applied"); assert.equal(state().snapshot.models.dev.targets.some(target => target.ref === `${kind}:${id}`), true);
    assert.equal((await edits.undo()).status, "applied");
  }
});

test("tool removal updates its generated target manifest and restores it through undo", async () => {
  const creation = await edits.planBatch([{ kind: "create", request: request("tool", { id: "audit-remove-tool" }) }], revision());
  assert.ok(creation.ok, JSON.stringify(creation.preflight)); assert.equal((await edits.applyBatch(creation.planId)).status, "applied");
  const removal = await edits.planBatch([{ kind: "removeWorkload", target: "lambda:audit-remove-tool" }], revision());
  assert.ok(removal.ok, JSON.stringify(removal.preflight));
  assert.ok(removal.changes.some(change => change.file.endsWith("target-ids.ts") && change.diff.lines.some(line => line.kind === "remove" && line.text.includes("audit-remove-tool"))));
  assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
  assert.equal((await edits.undo()).status, "applied"); assert.ok(state().snapshot.models.dev.targets.some(target => target.ref === "lambda:audit-remove-tool"));
  assert.equal((await edits.undo()).status, "applied");
});

test("database and invocation connections preserve identities and generated outputs through undo", async () => {
  const ref = "lambda:sign-in", construct = state().snapshot.models.prod.targets.find(target => target.ref === ref)!.constructId;
  for (const connection of [{ kind: "connection", target: ref, connection: "database", enabled: true } as const, { kind: "connection", target: ref, connection: "runsTask", destination: "task:invocation-test-task", enabled: true } as const]) {
    const plan = await edits.planBatch([connection], revision()); assert.ok(plan.ok, JSON.stringify(plan.preflight));
    assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
    assert.equal(state().snapshot.models.prod.targets.find(target => target.ref === ref)!.constructId, construct);
    assert.ok(state().snapshot.models.prod.edges.some(edge => edge.from === ref && edge.relation === connection.connection));
    assert.equal((await edits.undo()).status, "applied");
  }
});

test("literal workload removal archives exact code and generated references, then undo restores it", async () => {
  const creation = await edits.planBatch([{ kind: "create", request: request("function", { id: "audit-removable", category: "http", path: "/audit-removable", auth: false }) }], revision());
  assert.ok(creation.ok, JSON.stringify(creation.preflight)); assert.equal((await edits.applyBatch(creation.planId)).status, "applied");
  const source = "cdk-app/lambda_functions/http_functions/audit-removable/index.ts", bytes = readFileSync(path.join(fixture, source), "utf8");
  const removal = await edits.planBatch([{ kind: "removeWorkload", target: "lambda:audit-removable" }], revision());
  assert.ok(removal.ok, JSON.stringify(removal.preflight));
  assert.ok(removal.changes.some(change => change.file === source && change.operation === "delete"));
  assert.ok(removal.changes.some(change => change.file === "archived-workloads/lambda/audit-removable/index.ts" && change.operation === "create"));
  assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
  assert.equal(existsSync(path.join(fixture, source)), false);
  assert.equal(readFileSync(path.join(fixture, "archived-workloads/lambda/audit-removable/index.ts"), "utf8"), bytes);
  assert.equal(state().snapshot.models.dev.targets.some(target => target.ref === "lambda:audit-removable"), false);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(path.join(fixture, source), "utf8"), bytes);
  assert.equal((await edits.undo()).status, "applied");
  await assert.rejects(edits.planBatch([{ kind: "removeWorkload", target: "lambda:invocation-test-step" }], revision()), /consumers/);
});

test("private bucket template, native scoped grant and secret delivery use catalog authority", async () => {
  const stack = await edits.planBatch([{ kind: "create", request: request("stack", { id: "auditUploads", className: "AuditUploadsStack", template: "bucket" }) }], revision());
  assert.ok(stack.ok, JSON.stringify(stack.preflight));
  const code = stack.changes.find(change => change.file.endsWith("audit-uploads-stack.ts"))!.diff.unified;
  assert.match(code, /BLOCK_ALL/); assert.match(code, /RemovalPolicy.RETAIN/); assert.match(code, /autoDeleteObjects: false/);
  assert.equal((await edits.applyBatch(stack.planId)).status, "applied");
  const grant = await edits.planBatch([{ kind: "connection", target: "lambda:sign-in", connection: "grant", destination: "resource:auditUploads.bucket", grant: "grantRead", scope: "uploads/*", enabled: true }], revision());
  assert.ok(grant.ok, JSON.stringify(grant.preflight));
  assert.equal((await edits.applyBatch(grant.planId)).status, "applied");
  assert.ok(state().snapshot.models.prod.edges.some(edge => edge.from === "lambda:sign-in" && edge.to === "resource:auditUploads.bucket" && edge.relation === "grant"));
  const disconnect = await edits.planBatch([{ kind: "connection", target: "lambda:sign-in", connection: "grant", destination: "resource:auditUploads.bucket", grant: "grantRead", scope: "uploads/*", enabled: false }], revision());
  assert.ok(disconnect.ok, JSON.stringify(disconnect.preflight)); assert.equal((await edits.applyBatch(disconnect.planId)).status, "applied");
  assert.ok(!state().snapshot.models.prod.edges.some(edge => edge.from === "lambda:sign-in" && edge.to === "resource:auditUploads.bucket" && edge.relation === "grant"));
  assert.equal((await edits.undo()).status, "applied"); assert.equal((await edits.undo()).status, "applied"); assert.equal((await edits.undo()).status, "applied");
  await assert.rejects(edits.planBatch([{ kind: "connection", target: "lambda:sign-in", connection: "resource", destination: "resource:openaiApiKey", variable: "AUDIT_PROVIDER_SECRET_ARN", enabled: true }], revision()), /computed/);
  const secret = await edits.planBatch([{ kind: "connection", target: "lambda:test-run-task", connection: "resource", destination: "resource:openaiApiKey", variable: "AUDIT_PROVIDER_SECRET_ARN", enabled: true }], revision());
  assert.ok(secret.ok, JSON.stringify(secret.preflight));
  assert.ok(secret.changes.some(change => /\.arn/.test(change.diff.unified)));
  assert.equal((await edits.applyBatch(secret.planId)).status, "applied");
  const source = readFileSync(path.join(fixture, "framework-config/workloads/http.ts"), "utf8");
  assert.ok(!source.includes("studioConnectionResources"), "existing catalog import is reused");
  assert.equal((await edits.undo()).status, "applied");
});

test("durable interrupted source recovery preserves later edits and has a fingerprint-bound completion", () => {
  const directory = path.join(fixture, "framework-config/journal-fixture"), one = path.join(directory, "one.ts"), two = path.join(directory, "two.ts"); mkdirSync(directory);
  writeFileSync(one, "original one\n"); writeFileSync(two, "original two\n");
  const first = new SourceJournal(fixture), runningId = first.begin("Running fixture", [{ file: one, before: "original one\n", after: "reviewed one\n" }]);
  const separateService = new SourceJournal(fixture);
  assert.deepEqual(separateService.pending(), []);
  assert.throws(() => separateService.restore(runningId, "RESTORE SOURCE"), /still applying/);
  assert.throws(() => separateService.keepCurrent(runningId, "", "KEEP CURRENT SOURCE"), /still applying/);
  first.finish(runningId, "restored");
  const killed = spawnSync(process.execPath, ["--import", "tsx", "-e", `const {SourceJournal}=require(${JSON.stringify(path.join(root, "framework-studio/server/edits/journal.ts"))}); const {writeSourceChange}=require(${JSON.stringify(path.join(root, "framework-studio/server/edits/io.ts"))}); const j=new SourceJournal(${JSON.stringify(fixture)});j.begin("Interrupted fixture",${JSON.stringify([{ file: one, before: "original one\n", after: "reviewed one\n" }, { file: two, before: "original two\n", after: "reviewed two\n" }])});writeSourceChange(${JSON.stringify(fixture)},${JSON.stringify(one)},"original one\\n","reviewed one\\n");process.kill(process.pid,"SIGKILL");`], { cwd: root, encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const restarted = new SourceJournal(fixture);
  const id = restarted.pending()[0]!.id;
  assert.deepEqual(restarted.pending()[0]!.files.map(file => file.state), ["written", "original"]);
  writeFileSync(two, "later user edit\n");
  assert.throws(() => restarted.restore(id, ""), /RESTORE SOURCE/);
  const remaining = restarted.restore(id, "RESTORE SOURCE");
  assert.equal(readFileSync(one, "utf8"), "original one\n"); assert.equal(readFileSync(two, "utf8"), "later user edit\n");
  assert.equal(remaining[0]!.files[1]!.state, "conflicted");
  const fingerprint = remaining[0]!.fingerprint; writeFileSync(two, "newer edit\n");
  assert.throws(() => restarted.keepCurrent(id, fingerprint, "KEEP CURRENT SOURCE"), /changed/);
  assert.deepEqual(restarted.keepCurrent(id, restarted.pending()[0]!.fingerprint, "KEEP CURRENT SOURCE"), []);
  const linked = path.join(fixture, ".cache/framework-studio/transactions", `${randomUUID()}.json`); symlinkSync(one, linked);
  try { assert.throws(() => restarted.pending(), /symbolic/); } finally { rmSync(linked); rmSync(directory, { recursive: true }); }
});

test("competing Studio processes exclusively lock source and explicit recovery releases a dead owner", async () => {
  const file = path.join(fixture, "framework-config/concurrency-fixture.ts"), barrier = path.join(fixture, "begin-barrier"); writeFileSync(file, "original\n");
  const script = `const {SourceJournal}=require(${JSON.stringify(path.join(root, "framework-studio/server/edits/journal.ts"))}); const fs=require("node:fs"); const j=new SourceJournal(${JSON.stringify(fixture)}); process.stdout.write("ready\\n"); while(!fs.existsSync(${JSON.stringify(barrier)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5); try { const id=j.begin("Competing fixture",${JSON.stringify([{ file, before: "original\n", after: "reviewed\n" }])}); fs.writeFileSync(${JSON.stringify(file)},"reviewed\\n"); process.stdout.write("acquired "+id+"\\n"); setInterval(()=>{},1000); } catch(e) { process.stdout.write("rejected "+e.status+"\\n"); }`;
  const children = [0, 1].map(() => { const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); const output = { child, text: "", errors: "" }; child.stdout.on("data", chunk => { output.text += String(chunk); }); child.stderr.on("data", chunk => { output.errors += String(chunk); }); return output; });
  const until = (ready: () => boolean) => new Promise<void>((resolve, reject) => { const started = Date.now(); const poll = () => { if (ready()) resolve(); else if (Date.now() - started > 15_000) reject(new Error(JSON.stringify(children.map(child => [child.text, child.errors])))); else setTimeout(poll, 10); }; poll(); });
  try {
    await until(() => children.every(child => child.text.includes("ready"))); writeFileSync(barrier, "start");
    await until(() => children.every(child => /acquired |rejected /.test(child.text)));
    assert.equal(children.filter(child => child.text.includes("acquired ")).length, 1); assert.equal(children.filter(child => child.text.includes("rejected 409")).length, 1);
    const winner = children.find(child => child.text.includes("acquired "))!;
    assert.deepEqual(new SourceJournal(fixture).pending(), [], "a different live process is excluded from recovery");
    const exited = new Promise<void>(resolve => winner.child.once("exit", () => resolve())); winner.child.kill("SIGKILL"); await exited;
    const journal = new SourceJournal(fixture), pending = journal.pending(); assert.equal(pending.length, 1);
    assert.throws(() => journal.begin("No automatic stale reclaim", [{ file, before: "reviewed\n", after: "later\n" }]), /recovery/i);
    assert.deepEqual(journal.restore(pending[0]!.id, "RESTORE SOURCE"), []); assert.equal(readFileSync(file, "utf8"), "original\n");
    const orphan = randomUUID(); writeFileSync(path.join(fixture, ".cache/framework-studio/transactions/source.lock"), JSON.stringify({ id: orphan, root: realpathSync(fixture), ownerPid: winner.child.pid }));
    const interruptedBeforeWrites = journal.pending()[0]!; assert.equal(interruptedBeforeWrites.id, orphan); assert.deepEqual(interruptedBeforeWrites.files, []);
    assert.deepEqual(journal.keepCurrent(orphan, interruptedBeforeWrites.fingerprint, "KEEP CURRENT SOURCE"), []);
  } finally { for (const child of children) child.child.kill("SIGKILL"); rmSync(barrier, { force: true }); rmSync(file, { force: true }); }
});
