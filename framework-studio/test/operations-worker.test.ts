import assert from "./support/assert";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { domainOutcome, executionSpec, prepareIntent, reconcileOutcome } from "../server/operations/adapter";
import { Tools } from "../server/deploy/process";
import { processIdentity } from "../server/operations/identity";
import { OperationStore } from "../server/operations/store";
import { runWorker } from "../server/operations/worker";
import type { JobView, OperationIntent, OperationRecord } from "../shared/operations";

function canInspect(context: TestContext): boolean {
  try { processIdentity("test-probe"); return true; }
  catch { context.skip("Host process tests need ps access; rerun outside the process-inspection sandbox."); return false; }
}

function fixture(first: string, second = "console.log('second command completed');") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-worker-")));
  const state = path.join(root, "state");
  mkdirSync(path.join(root, "packages/framework/scripts"), { recursive: true });
  mkdirSync(path.join(root, "cdk-app"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(path.join(root, "packages/framework/scripts/generate-contracts.ts"), first);
  writeFileSync(path.join(root, "packages/framework/scripts/check-local.ts"), second);
  symlinkSync(path.resolve(__dirname, "../../node_modules"), path.join(root, "node_modules"), "dir");
  const config = path.join(root, "aws-config"), credentials = path.join(root, "aws-credentials");
  writeFileSync(config, ""); writeFileSync(credentials, "");
  const previous = { config: process.env.AWS_CONFIG_FILE, credentials: process.env.AWS_SHARED_CREDENTIALS_FILE };
  process.env.AWS_CONFIG_FILE = config; process.env.AWS_SHARED_CREDENTIALS_FILE = credentials;
  return { root, state, close() {
    if (previous.config === undefined) delete process.env.AWS_CONFIG_FILE; else process.env.AWS_CONFIG_FILE = previous.config;
    if (previous.credentials === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = previous.credentials;
    rmSync(root, { recursive: true, force: true });
  } };
}

test("detached development workers repeat the local-off gate after acceptance and before their command", async context => {
  const f = fixture("console.log('unused')");
  let containers: { ID: string; State: string }[] = [];
  const scriptReads: string[] = [];
  writeFileSync(path.join(f.root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:app": "example", "framework:appId": "00000000-0000-4000-8000-000000000001" } }));
  const result = (text: string, env: NodeJS.ProcessEnv) => ({ file: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(text)})`], cwd: f.root, env, display: "fixture read" });
  context.mock.method(Tools.prototype, "docker", (args: readonly string[], env: NodeJS.ProcessEnv) => result(args[0] === "version"
    ? JSON.stringify({ Server: { Version: "fixture", Os: "linux" } })
    : args[0] === "ps" ? containers.map(container => JSON.stringify(container)).join("\n") : "fixture", env));
  const original = Tools.prototype.script;
  context.mock.method(Tools.prototype, "script", function (this: Tools, script: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string) {
    scriptReads.push(script);
    if (script === "scripts/deployment-status.ts") return result(JSON.stringify([{ name: "dev" }]), env);
    return original.call(this, script, args, env, cwd);
  });
  try {
    const request = { kind: "export" as const, params: { deployment: "example-dev", profile: "dev" } };
    const intent = await prepareIntent(f.root, f.state, request);
    mkdirSync(path.join(f.state, "jobs"), { recursive: true });
    const watch = path.join(f.state, "jobs/watch.json");
    writeFileSync(watch, JSON.stringify({ id: "watch", kind: "local-watch", status: "running" }));
    await assert.rejects(() => executionSpec(f.root, f.state, intent, () => {}), /Stop local runtime/);
    writeFileSync(watch, JSON.stringify({ id: "watch", kind: "local-watch", status: "interrupted" }));
    const accepted = await executionSpec(f.root, f.state, intent, () => {});
    try {
      containers = [{ ID: "fixture-active-container", State: "paused" }];
      await assert.rejects(() => accepted.spec.steps[0]!.run!({ job: "worker", signal: new AbortController().signal, log() {}, setSummary() {}, setPlanId() {} }), /Stop local runtime/);
    } finally { accepted.close(); }
    assert.equal(scriptReads.some(script => script.includes("export-cdk-outputs")), false, "no export command is resolved while local runtime is active");
  } finally { f.close(); }
});

test("worker captures real subprocess output durably and redacts split sensitive values", async context => {
  if (!canInspect(context)) return;
  const secret = "fixture-secret-☃-value";
  const f = fixture(`const fs=require('node:fs'); fs.writeFileSync('executed', 'once'); process.stdout.write('value fixture-secret-'); setTimeout(()=>{process.stdout.write('☃-value done\\n'); process.stderr.write('AWS_SESSION_TOKEN=unlisted-token\\n');}, 30);`);
  writeFileSync(path.join(f.root, "cdk-app/.env.dev"), `PRIVATE_VALUE=${secret}\n`);
  const store = new OperationStore(path.join(f.state, "operations"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept(intent, "worker-redaction"), token = store.dispatch(job.id)!;
    await runWorker(f.root, f.state, job.id, token);
    const result = store.get(job.id)!.view;
    assert.equal(result.status, "succeeded"); assert.equal(result.execution, "finished"); assert.equal(result.outcome, "confirmed");
    const lines = store.log(job.id).lines;
    const text = lines.map(line => line.text).join("\n");
    assert.match(text, /value \[redacted\] done/); assert.match(text, /AWS_SESSION_TOKEN=\[redacted\]/);
    assert.ok(!text.includes(secret)); assert.ok(!text.includes("unlisted-token"));
    assert.match(text, /second command completed/);
    assert.deepEqual(lines.map(line => line.seq), lines.map((_, index) => index + 1));
    assert.equal(readFileSync(path.join(f.root, "executed"), "utf8"), "once");
    assert.equal(store.dispatch(job.id), undefined);
  } finally { store.close(); f.close(); }
});

test("a changed accepted binding fails preflight without launching the command", async context => {
  if (!canInspect(context)) return;
  const f = fixture("require('node:fs').writeFileSync('must-not-execute','started');");
  const store = new OperationStore(path.join(f.state, "operations"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept({ ...intent, binding: "changed-after-acceptance" }, "worker-preflight"), token = store.dispatch(job.id)!;
    await runWorker(f.root, f.state, job.id, token);
    const result = store.get(job.id)!.view;
    assert.equal(result.execution, "finished"); assert.equal(result.outcome, "unverified");
    assert.equal(existsSync(path.join(f.root, "must-not-execute")), false);
    assert.equal(store.log(job.id).lines.length, 0);
  } finally { store.close(); f.close(); }
});

test("failed subprocess output stays redacted and prevents later steps", async context => {
  if (!canInspect(context)) return;
  const f = fixture("throw new Error('fixture-private-failure');", "require('node:fs').writeFileSync('must-not-execute','started');");
  writeFileSync(path.join(f.root, "cdk-app/.env.prod"), "PRIVATE_FAILURE=fixture-private-failure\n");
  const store = new OperationStore(path.join(f.state, "operations"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept(intent, "worker-failure"), token = store.dispatch(job.id)!;
    await runWorker(f.root, f.state, job.id, token);
    const result = store.get(job.id)!.view;
    assert.equal(result.status, "failed"); assert.equal(result.outcome, "unverified");
    assert.equal(result.steps?.[1]?.status, "skipped");
    assert.equal(existsSync(path.join(f.root, "must-not-execute")), false);
    const recorded = JSON.stringify({ result, log: store.log(job.id) });
    assert.ok(!recorded.includes("fixture-private-failure")); assert.ok(recorded.includes("[redacted]"));
  } finally { store.close(); f.close(); }
});

test("unreadable private inputs between steps prevent launching an uncaptured command", async context => {
  if (!canInspect(context)) return;
  const f = fixture("require('node:fs').mkdirSync('.env');", "require('node:fs').writeFileSync('must-not-execute','started');");
  const store = new OperationStore(path.join(f.state, "operations"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept(intent, "redaction-preflight"), token = store.dispatch(job.id)!;
    await runWorker(f.root, f.state, job.id, token);
    const result = store.get(job.id)!.view;
    assert.equal(result.status, "failed"); assert.equal(result.execution, "finished");
    assert.equal(result.steps?.[0]?.status, "done"); assert.equal(result.steps?.[1]?.status, "failed");
    assert.equal(existsSync(path.join(f.root, "must-not-execute")), false);
  } finally { store.close(); f.close(); }
});

test("log storage failure before execution launches nothing and retains uncertainty", async context => {
  if (!canInspect(context)) return;
  const f = fixture("require('node:fs').writeFileSync('must-not-execute','started');");
  const store = new OperationStore(path.join(f.state, "operations"), { alive: () => false });
  const raw = new DatabaseSync(path.join(f.state, "operations/operations.sqlite"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept(intent, "worker-disk-failure"), token = store.dispatch(job.id)!;
    raw.exec("CREATE TRIGGER fail_log BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT, 'fixture no disk'); END;");
    await runWorker(f.root, f.state, job.id, token);
    assert.equal(existsSync(path.join(f.root, "must-not-execute")), false);
    store.reconcile();
    assert.equal(store.get(job.id)?.view.execution, "lost"); assert.equal(store.get(job.id)?.view.outcome, "uncertain");
    assert.equal(store.dispatch(job.id), undefined);
  } finally { raw.close(); store.close(); f.close(); }
});

test("an invalid worker token cannot alter another attempt", async context => {
  if (!canInspect(context)) return;
  const f = fixture("require('node:fs').writeFileSync('must-not-execute','started');");
  const store = new OperationStore(path.join(f.state, "operations"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept(intent, "worker-token"); store.dispatch(job.id);
    await runWorker(f.root, f.state, job.id, "invalid-worker-token");
    assert.equal(store.get(job.id)?.view.execution, "dispatching");
    assert.equal(existsSync(path.join(f.root, "must-not-execute")), false);
  } finally { store.close(); f.close(); }
});

test("cancellation persisted after dispatch and before claim prevents every command", async context => {
  if (!canInspect(context)) return;
  const f = fixture("require('node:fs').writeFileSync('must-not-execute','started');");
  const store = new OperationStore(path.join(f.state, "operations"));
  try {
    const intent = await prepareIntent(f.root, f.state, { kind: "framework-check", params: {} });
    const job = store.accept(intent, "cancel-before-claim"), token = store.dispatch(job.id)!;
    store.requestCancel(job.id);
    await runWorker(f.root, f.state, job.id, token);
    const result = store.get(job.id)!.view;
    assert.equal(result.status, "cancelled"); assert.equal(result.execution, "finished"); assert.equal(result.outcome, "confirmed");
    assert.equal(existsSync(path.join(f.root, "must-not-execute")), false);
    assert.equal(store.log(job.id).lines.length, 0);
    assert.ok(store.accept(intent, "after-confirmed-cancel"), "known pre-execution cancellation releases checkout claims");
  } finally { store.close(); f.close(); }
});

test("reconciliation only trusts a verified result matching the accepted review", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-reconcile-")));
  const state = path.join(root, "state"), key = "review-fixture", directory = path.join(state, "plans", key);
  mkdirSync(directory, { recursive: true });
  const plan = JSON.stringify({ planId: "plan-fixture-original", status: "ready", review: "template", identity: { deployment: "fixture", account: "123456789012", region: "us-east-1", mode: "prod" }, target: { inputsFile: path.join(root, "inputs") }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), stacks: [] });
  writeFileSync(path.join(directory, "plan.json"), plan);
  const binding = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const record: OperationRecord = {
    intent: { version: 1, workspace: root, binding, request: { kind: "deploy-apply", params: { plan: key } }, locks: [], consumptionKey: `apply:${key}`, view: { kind: "deploy-apply", title: "Apply", params: { plan: key }, planId: key } },
    view: { id: "fixture-operation", kind: "deploy-apply", title: "Apply", params: { plan: key }, planId: key, status: "interrupted", execution: "lost", outcome: "uncertain", startedAt: new Date().toISOString(), lastSeq: 0 },
  };
  const result = { planId: "plan-fixture-original", status: "succeeded", verification: { verified: true, stacks: [] }, deferred: [], secretUpdates: [] };
  try {
    writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ...result, planId: "copied-from-another-review" }));
    assert.equal(reconcileOutcome(record, state), undefined);
    writeFileSync(path.join(directory, "result.json"), JSON.stringify(result));
    assert.equal(reconcileOutcome(record, state)?.outcome, "confirmed");
    writeFileSync(path.join(directory, "plan.json"), `${plan}\n`);
    assert.equal(reconcileOutcome(record, state), undefined, "changed review bytes cannot confirm accepted intent");
    writeFileSync(path.join(directory, "plan.json"), plan);
    writeFileSync(path.join(directory, "result.json"), JSON.stringify({ ...result, verification: { verified: false, stacks: [] } }));
    assert.equal(reconcileOutcome(record, state), undefined);
    writeFileSync(path.join(directory, "result.json"), "{torn");
    assert.equal(reconcileOutcome(record, state), undefined);
    writeFileSync(path.join(directory, "result.json"), JSON.stringify(result));
    assert.equal(reconcileOutcome({ ...record, intent: { ...record.intent, request: { kind: "deploy-plan", params: { autoApply: true } } } }, state), undefined, "auto-apply needs stronger generated-plan binding before reconciliation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("observed skipped auto-apply releases planning claims but absent apply results retain uncertainty", () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-auto-apply-outcome-")));
  const store = new OperationStore(path.join(directory, "operations"));
  const intent: OperationIntent = {
    version: 1, workspace: directory, request: { kind: "deploy-plan", params: { autoApply: true } }, locks: ["workspace-tooling"],
    view: { kind: "deploy-plan", title: "Plan and apply", params: { autoApply: true }, planId: "fixture-plan" },
  };
  const steps: NonNullable<JobView["steps"]> = [{ label: "Plan", status: "done" }, { label: "Apply", status: "skipped" }];
  try {
    const planned = store.accept(intent, "known-skipped-apply");
    const skipped = domainOutcome(directory, intent, { autoApplyStep: steps[1]!.status });
    assert.equal(skipped.outcome, "unverified");
    store.update(planned.id, { status: "succeeded", execution: "finished", steps, ...skipped });
    const next = store.accept(intent, "later-reviewed-work");
    assert.ok(next.id, "a known skipped apply must allow later review and separately authorized work");
    const executed = domainOutcome(directory, intent, { autoApplyStep: "done" });
    assert.equal(executed.outcome, "uncertain", "process completion without a result cannot verify effects");
    assert.equal(domainOutcome(directory, intent).outcome, "uncertain", "missing execution evidence cannot prove a skip");
    assert.equal(domainOutcome(directory, { ...intent, request: { kind: "deploy-apply", params: { plan: "fixture-plan" } } }, { autoApplyStep: "skipped" }).outcome, "uncertain", "skip evidence only applies to the automatic planning step");
    store.update(next.id, { status: "succeeded", execution: "finished", ...executed });
    assert.throws(() => store.accept(intent, "conflicting-after-unknown-apply"), (error: unknown) => (error as { status?: number }).status === 409);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
