import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { JobLogLine, JobView, OperationRequest } from "../shared/operations";
import { DeployService } from "../server/deploy/service";
import { OperationsClient } from "../server/operations/client";

const root = path.resolve(__dirname, "../..");
const operation = (patch: Partial<JobView> = {}): JobView => ({
  id: "runner-fixture", kind: "deploy-plan", title: "Plan fixture", params: { profile: "fixture" },
  status: "running", execution: "running", outcome: "pending", startedAt: "2026-01-01T00:00:00.000Z",
  lastSeq: 0, origin: "/deploy", ...patch,
});
const line = (seq: number): JobLogLine => ({ seq, at: "2026-01-01T00:00:00.000Z", stream: "info", text: `line ${seq}` });

/** Exercise the production service boundary without launching a runner or touching AWS. */
function fixture(t: TestContext, onEvent?: (event: string, data: unknown) => void) {
  const state = mkdtempSync(path.join(tmpdir(), "studio-operation-service-"));
  const events: { event: string; data: unknown }[] = [];
  const source = {
    jobs: [] as JobView[],
    lines: [] as JobLogLine[],
    progress: [] as { seq: number; event: string; data: unknown }[],
    problem: undefined as Error | undefined,
    submitted: [] as OperationRequest[],
    cancelled: [] as string[],
    closes: 0,
    read: async (): Promise<JobView[]> => source.jobs,
    submit: async (_request: OperationRequest): Promise<JobView> => operation(),
  };
  t.mock.method(OperationsClient.prototype, "list", async () => {
    if (source.problem) throw source.problem;
    return source.read();
  });
  t.mock.method(OperationsClient.prototype, "log", async (id: string, after: number) => ({
    job: source.jobs.find(job => job.id === id)!, lines: source.lines.filter(entry => entry.seq > after),
  }));
  t.mock.method(OperationsClient.prototype, "events", async (_id: string, after: number) => ({
    events: source.progress.filter(entry => entry.seq > after), lastSeq: source.progress.at(-1)?.seq ?? 0,
  }));
  t.mock.method(OperationsClient.prototype, "submit", async (request: OperationRequest) => {
    source.submitted.push(request);
    return source.submit(request);
  });
  t.mock.method(OperationsClient.prototype, "cancel", async (id: string) => {
    source.cancelled.push(id);
    return operation({ id, cancelRequested: true });
  });
  t.mock.method(OperationsClient.prototype, "close", () => { source.closes++; });
  const service = new DeployService(root, (event, data) => { events.push({ event, data }); onEvent?.(event, data); }, { stateDirectory: state, operations: true });
  t.after(async () => { await service.dispose(); rmSync(state, { recursive: true, force: true }); });
  return { service, source, events, state };
}

test("runner discovery projects individual jobs and cursor log batches to shared and deployment subscribers", async t => {
  const { service, source, events } = fixture(t);
  await service.listOperations();
  source.jobs = [operation()];
  assert.deepEqual(await service.listOperations(), source.jobs);
  assert.equal(service.hasUnobservedOperations(), false);
  assert.deepEqual(events.filter(entry => entry.event === "operation-job").map(entry => entry.data), source.jobs);
  assert.deepEqual(events.filter(entry => entry.event === "deploy-job").map(entry => entry.data), source.jobs);
  const destination = { deployment: "fixture-dev", profile: "fixture", account: "123456789012", region: "us-east-1" };
  source.progress = [{ seq: 1, event: "deploy-stacks", data: { ...destination, stacks: [{ name: "fixture-dev-Stack", status: "UPDATE_IN_PROGRESS" }] } },
    { seq: 2, event: "deploy-event", data: { ...destination, stack: "fixture-dev-Stack", event: { id: "event-fixture", logicalId: "Resource", status: "UPDATE_COMPLETE" } } }];
  source.lines = [line(1), line(2)];
  source.jobs = [operation({ lastSeq: 2 })];
  await service.listOperations();
  assert.deepEqual(events.filter(entry => ["deploy-stacks", "deploy-event"].includes(entry.event)), source.progress.map(({ event, data }) => ({ event, data })));
  assert.deepEqual(events.filter(entry => entry.event === "operation-log").map(entry => entry.data), [{ id: "runner-fixture", lines: source.lines }]);
  assert.deepEqual(events.filter(entry => entry.event === "deploy-log").map(entry => entry.data), [{ id: "runner-fixture", lines: source.lines }]);
  await service.listOperations();
  assert.equal(events.filter(entry => entry.event === "operation-log").length, 1);
  assert.equal(events.filter(entry => entry.event === "deploy-event").length, 1);
  assert.deepEqual(await service.operationLog("runner-fixture", 1), { job: source.jobs[0], lines: [line(2)] });
  source.jobs = [operation({ status: "interrupted", execution: "lost", outcome: "uncertain", recovery: "Inspect AWS; never replay this apply.", lastSeq: 2 })];
  await service.listOperations();
  assert.deepEqual(service.activeJobs(), source.jobs);
  assert.equal(events.some(entry => entry.event === "deploy-changed"), true);
});

test("discovery failures stay visible and prevent treating unknown independent work as idle", async t => {
  const { service, source } = fixture(t);
  assert.equal(service.hasUnobservedOperations(), true);
  await service.listOperations();
  source.problem = new Error("Operation journal unavailable.");
  await assert.rejects(service.listOperations(), /journal unavailable/);
  assert.equal(service.hasUnobservedOperations(), true);
  await assert.rejects(service.perform({ kind: "deps-install", params: {} }), /journal unavailable/);
  source.problem = undefined;
  source.jobs = [operation({ status: "interrupted", execution: "lost", outcome: "uncertain" })];
  await assert.rejects(service.perform({ kind: "deps-install", params: {} }), /still owns this checkout/);
  assert.equal(service.hasUnobservedOperations(), false);
});

test("terminal independent jobs invalidate their profile observations before subscribers can refresh", async t => {
  const invalidated: (string | undefined)[] = [];
  const { service, source } = fixture(t, (event, data) => {
    if (event === "deploy-job" && (data as JobView).status !== "running")
      assert.equal(invalidated.at(-1), (data as JobView).params.profile);
    if (event === "deploy-changed") assert.equal(invalidated.at(-1), (data as { profile?: string }).profile);
  });
  t.mock.method(service.observer, "invalidate", (profile?: string) => { invalidated.push(profile); });
  await service.listOperations();
  source.jobs = [operation()];
  await service.listOperations();
  assert.equal(invalidated.length, 0, "running work does not expire observations on each job projection");
  source.jobs = [operation({ status: "succeeded", execution: "finished", outcome: "confirmed" })];
  await service.listOperations();
  assert.deepEqual(invalidated, ["fixture"]);
  await service.listOperations();
  assert.deepEqual(invalidated, ["fixture"], "repeated discovery of unchanged terminal work does not invalidate again");
});

test("terminal Studio-owned jobs also invalidate observations before their completion event", async t => {
  const invalidated: (string | undefined)[] = [];
  const { service } = fixture(t, (event, data) => {
    if (event === "deploy-job" && (data as JobView).status !== "running")
      assert.deepEqual(invalidated, ["fixture"]);
  });
  t.mock.method(service.observer, "invalidate", (profile?: string) => { invalidated.push(profile); });
  await service.listOperations();
  const job = service.jobs.start({ kind: "export", title: "Fixture export", params: { profile: "fixture" }, locks: [], steps: [] });
  assert.equal((await service.jobs.wait(job.id)).status, "succeeded");
  assert.deepEqual(invalidated, ["fixture"]);
});

test("plan cleanup waits for recovered runner ownership and retains its unfinished directory", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  const planId = "plan-fixture-active";
  const directory = service.plans.path(planId);
  mkdirSync(directory, { recursive: true });
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(directory, stale, stale);
  let finish!: (jobs: JobView[]) => void;
  source.read = () => new Promise(resolve => { finish = resolve; });
  const listing = service.listPlans();
  assert.equal(existsSync(directory), true);
  finish([operation({ planId })]);
  await listing;
  assert.equal(existsSync(directory), true);
});

test("durably accepted submission remains successful when the subsequent observation fails", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  const accepted = operation({ execution: "accepted" });
  source.submit = async () => { source.problem = new Error("Coordinator observation disconnected after acceptance."); return accepted; };
  const request: OperationRequest = { kind: "deploy-plan", params: {}, requestKey: "retained-client-intent" };
  assert.deepEqual(await service.perform(request), accepted);
  assert.deepEqual(source.submitted, [request]);
  assert.equal(service.activeJobs().some(job => job.id === accepted.id), true);
});

test("a durable cancellation receipt is returned even when refreshing its projection fails", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  source.problem = new Error("Coordinator observation disconnected after cancellation.");
  const receipt = await service.cancelOperation("runner-fixture");
  assert.equal(receipt.cancelRequested, true);
  assert.deepEqual(source.cancelled, ["runner-fixture"]);
});

test("concurrent local dependency work cannot pass an in-flight independent admission", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  let finish!: (job: JobView) => void;
  source.submit = () => new Promise(resolve => { finish = resolve; });
  const independent = service.perform({ kind: "deploy-plan", params: {} });
  const dependency = service.perform({ kind: "deps-install", params: {} });
  // Let the first request enter the asynchronous IPC boundary.
  await Promise.resolve();
  source.jobs = [operation()];
  finish(source.jobs[0]!);
  await independent;
  await assert.rejects(dependency, /still owns this checkout/);
});

test("local startup cannot pass an in-flight independent admission", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  let finish!: (job: JobView) => void;
  source.submit = () => new Promise(resolve => { finish = resolve; });
  const independent = service.perform({ kind: "deploy-plan", params: {} });
  const local = service.perform({ kind: "local-start", params: {} });
  await Promise.resolve();
  source.jobs = [operation()]; finish(source.jobs[0]!);
  await independent;
  await assert.rejects(local, /still owns this checkout/);
});

test("development mutation admission sees host sessions while template synthesis remains available", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  t.mock.method(service.dockerStatus, "read", async () => ({ docker: { engine: "stopped", desktop: true } }) as any);
  let finish!: () => void;
  const watch = service.jobs.start({ kind: "local-watch", title: "Source watch", params: {}, locks: ["local-watch"], steps: [{ label: "watch", run: () => new Promise<void>(resolve => { finish = resolve; }) }] });
  try {
    await assert.rejects(service.perform({ kind: "destroy", params: { deployment: "fixture-dev", mode: "dev", profile: "fixture" } }), /Stop local runtime/);
    assert.equal(source.submitted.length, 0);
    const deployment = service.targets().find(target => target.mode === "dev")!.name;
    await service.perform({ kind: "deploy-plan", params: { deployment, profile: "fixture", review: "template" } });
    assert.equal(source.submitted.length, 1);
  } finally { finish(); await service.jobs.wait(watch.id); }
});

test("disposing Studio closes its observer without sending a cancellation to independent work", async t => {
  const { service, source } = fixture(t);
  source.jobs = [operation()];
  await service.listOperations();
  await service.dispose();
  assert.equal(source.closes, 1);
  assert.deepEqual(source.cancelled, []);
});

test("unmigrated local jobs remain discoverable, cancellable and replayable through shared Activity", async t => {
  const { service, source, events } = fixture(t);
  await service.listOperations();
  let finish!: () => void;
  const local = service.jobs.start({ kind: "docker-start", title: "Fixture host action", params: {}, locks: ["fixture-host"], steps: [{
    label: "Controlled host action",
    run: async context => { context.log("Legacy local output"); await new Promise<void>(resolve => { finish = resolve; }); },
  }] });
  assert.equal((await service.listOperations()).some(job => job.id === local.id), true);
  assert.equal((await service.operationLog(local.id)).lines[0]?.text, "Legacy local output");
  await assert.rejects(service.perform({ kind: "deploy-plan", params: {} }), /local workspace operation is running/);
  await service.cancelOperation(local.id);
  finish();
  const finished = await service.jobs.wait(local.id);
  assert.equal(finished.status, "cancelled");
  assert.equal(events.some(entry => entry.event === "operation-job" && (entry.data as JobView).id === local.id), true);
  assert.equal(events.some(entry => entry.event === "operation-log" && (entry.data as { id: string }).id === local.id), true);
  assert.deepEqual(source.cancelled, []);
  assert.deepEqual(source.submitted, []);
});

test("a discovery started before acceptance cannot erase acknowledged independent ownership", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  let finish!: (jobs: JobView[]) => void;
  source.read = () => new Promise(resolve => { finish = resolve; });
  const staleDiscovery = service.listOperations();
  const accepted = await service.perform({ kind: "deploy-plan", params: {}, requestKey: "accepted-after-discovery" });
  finish([]);
  await staleDiscovery;
  assert.equal(service.activeJobs().some(job => job.id === accepted.id), true);
});

test("a stale discovery cannot revert an acknowledged cancellation request", async t => {
  const { service, source } = fixture(t);
  await service.listOperations();
  source.jobs = [operation()];
  await service.listOperations();
  let finish!: (jobs: JobView[]) => void;
  source.read = () => new Promise(resolve => { finish = resolve; });
  const staleDiscovery = service.listOperations();
  await service.cancelOperation("runner-fixture");
  finish([operation()]);
  await staleDiscovery;
  assert.equal(service.activeJobs()[0]?.cancelRequested, true);
});
