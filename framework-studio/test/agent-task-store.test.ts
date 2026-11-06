import assert from "./support/assert";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentRuntimeError, AgentTaskStore } from "../server/agent-runtime/store";
import type { ExecutionIdentity } from "../shared/operations";

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-agent-store-"));
  const root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root);
  const stores: AgentTaskStore[] = [];
  const open = () => { const store = new AgentTaskStore(state, root); stores.push(store); return store; };
  const close = (store: AgentTaskStore) => { store.close(); stores.splice(stores.indexOf(store), 1); };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { root, state, directory, open, close };
}
const request = { requestKey: "request-12345678", provider: "codex", prompt: "Repair the handler and run its tests." };
const errorStatus = (status: number) => (error: unknown) => error instanceof AgentRuntimeError && error.status === status;

test("accepted intent and event cursors survive observer/store replacement without duplicate tasks", t => {
  const f = fixture(t), first = f.open();
  const task = first.accept(request);
  first.transition(task.id, "preparing"); first.transition(task.id, "running");
  first.append(task.id, "command", { command: "node --test", status: "started" });
  f.close(first);
  const second = f.open();
  assert.equal(second.accept(request).id, task.id);
  assert.equal(second.list().length, 1);
  assert.deepEqual(second.events(task.id, 2).events.map(event => event.seq), [3, 4]);
  assert.throws(() => second.accept({ ...request, prompt: "Different intent" }), errorStatus(409));
});

test("approval binds the exact current proposal and cannot be fabricated or replayed", t => {
  const store = fixture(t).open(), task = store.accept(request);
  assert.throws(() => store.approve(task.id, "invented"), errorStatus(409));
  store.transition(task.id, "preparing"); store.transition(task.id, "running"); store.transition(task.id, "validating");
  store.patch(task.id, { proposalDirectory: "/private/task/proposal" }, { proposalDigest: "a".repeat(64) });
  store.transition(task.id, "awaiting_review");
  assert.throws(() => store.approve(task.id, "b".repeat(64)), errorStatus(409));
  assert.equal(store.approve(task.id, "a".repeat(64)).status, "integrating");
  assert.ok(store.approved(task.id, "a".repeat(64)));
  assert.throws(() => store.approve(task.id, "a".repeat(64)), errorStatus(409));
  assert.throws(() => store.cancel(task.id), errorStatus(409));
});

test("restart reconciliation interrupts execution and marks interrupted import for recovery", t => {
  const store = fixture(t).open();
  const running = store.accept(request), applying = store.accept({ ...request, requestKey: "request-other123" });
  for (const task of [running, applying]) { store.transition(task.id, "preparing"); store.transition(task.id, "running"); }
  store.transition(applying.id, "validating");
  store.patch(applying.id, {}, { proposalDigest: "c".repeat(64) });
  store.transition(applying.id, "awaiting_review"); store.approve(applying.id, "c".repeat(64));
  store.recoverInterrupted();
  assert.equal(store.get(running.id)?.view.status, "interrupted");
  assert.equal(store.get(applying.id)?.view.status, "recovery_required");
  assert.throws(() => store.transition(applying.id, "running"), errorStatus(409));
});

test("an uncertain host identity cannot be stolen and known death permits recovery", t => {
  const store = fixture(t).open();
  const owner: ExecutionIdentity = { pid: 101, uid: 501, started: "start", token: "first" };
  const other = { ...owner, token: "other" };
  assert.ok(store.claimHost(owner));
  assert.equal(store.claimHost(other, () => undefined), false);
  assert.equal(store.claimHost(other, () => true), false);
  assert.equal(store.claimHost(other, () => false), true);
  store.releaseHost(owner);
  assert.equal(store.claimHost(owner, () => true), false);
  store.releaseHost(other);
  assert.ok(store.claimHost(owner));
});

test("events remain valid JSON after credential redaction and oversized events fail before persistence", t => {
  const store = fixture(t).open(), task = store.accept(request);
  const event = store.append(task.id, "diagnostic", { password: "sentinel-private", message: "password=sentinel-private", nested: { authorization: "Bearer private" } });
  assert.equal(JSON.stringify(event).includes("sentinel-private"), false);
  assert.equal(event.data.password, "[redacted]");
  assert.throws(() => store.append(task.id, "message", { text: "x".repeat(70_000) }), errorStatus(413));
  assert.equal(store.events(task.id).events.length, 2);
});

test("state rejects wrong roots, checkout-local storage and symbolic links", t => {
  const f = fixture(t), store = f.open(); f.close(store);
  const other = path.join(f.directory, "other"); mkdirSync(other);
  assert.throws(() => new AgentTaskStore(f.state, other), errorStatus(409));
  assert.throws(() => new AgentTaskStore(path.join(f.root, "state"), f.root), errorStatus(422));
  const link = path.join(f.directory, "link"); symlinkSync(f.state, link);
  assert.throws(() => new AgentTaskStore(link, f.root), errorStatus(422));
});

test("task input cannot add process paths, policy overrides or malformed cursors", t => {
  const store = fixture(t).open();
  for (const value of [{ ...request, cwd: "/" }, { ...request, provider: "custom" }, { ...request, model: "--unsafe" }, { ...request, prompt: "" }]) assert.throws(() => store.accept(value), errorStatus(400));
  const task = store.accept(request);
  assert.throws(() => store.events(task.id, -1), errorStatus(400));
});
