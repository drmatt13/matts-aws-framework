import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { OperationStore, canonicalRequest } from "../server/operations/store";
import { identityAlive, processIdentity } from "../server/operations/identity";
import { StreamingRedactor, redactText } from "../server/operations/redaction";
import { summaryText } from "../server/deploy/jobs";
import type { ExecutionIdentity, OperationIntent } from "../shared/operations";

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return { version: 1, workspace: "workspace-a", request: { kind: "deploy-apply", params: { plan: "review-a" } }, locks: ["deployment:a"], consumptionKey: "review-a", view: { kind: "deploy-apply", title: "Apply reviewed deployment", params: { plan: "review-a" } }, ...overrides };
}
function scratch(): string { return mkdtempSync(path.join(os.tmpdir(), "studio-operation-store-")); }
function owner(token: string): ExecutionIdentity { return { pid: 123, uid: 501, started: "fixture-start", token }; }
const conflict = (error: unknown) => (error as { status?: number }).status === 409;

test("a state directory binds one checkout and rejects foreign execution intents", () => {
  const directory = scratch(); let store = new OperationStore(directory);
  try {
    store.accept(intent(), "existing");
    assert.throws(() => store.bindWorkspace("workspace-b"), conflict);
    store.bindWorkspace("workspace-a");
    store.close(); store = new OperationStore(directory);
    store.bindWorkspace("workspace-a");
    assert.throws(() => store.bindWorkspace("workspace-b"), conflict);
    assert.throws(() => store.accept(intent({ workspace: "workspace-b", locks: [], consumptionKey: undefined }), "foreign"), conflict);
    assert.equal(store.list().length, 1);
    assert.equal(store.findRequest("existing")?.view.execution, "accepted");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("acceptance, request identities and consumed reviews survive store restart", () => {
  const directory = scratch();
  let store = new OperationStore(directory);
  try {
    const first = store.accept(intent(), "request-a");
    store.close(); store = new OperationStore(directory);
    assert.equal(store.accept(intent(), "request-a").id, first.id);
    assert.equal(store.findRequest("request-a")?.view.id, first.id);
    assert.throws(() => store.accept(intent({ request: { kind: "deploy-apply", params: { plan: "review-b" } } }), "request-a"), conflict);
    const token = store.dispatch(first.id)!;
    assert.equal(store.claim(first.id, token, owner(token)), true);
    store.update(first.id, { execution: "finished", status: "succeeded", outcome: "confirmed" });
    assert.throws(() => store.accept(intent(), "new-request"), conflict, "new request cannot reuse consumed review");
    assert.equal(store.accept(intent(), "request-a").status, "succeeded");
    assert.equal(store.isConsumed("review-a"), true);
    assert.equal(canonicalRequest({ kind: "export", params: { b: "b", a: "a" }, requestKey: "one" }), canonicalRequest({ kind: "export", params: { a: "a", b: "b" }, requestKey: "two" }));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("resource scope claims are atomic across coordinator connections", () => {
  const directory = scratch();
  const first = new OperationStore(directory), second = new OperationStore(directory);
  try {
    const accepted = first.accept(intent({ consumptionKey: undefined }), "one");
    assert.throws(() => second.accept(intent({ consumptionKey: undefined }), "two"), conflict);
    assert.equal(second.list().length, 1, "conflict leaves no half-accepted operation");
    first.update(accepted.id, { execution: "finished", status: "failed", outcome: "unverified" });
    assert.ok(second.accept(intent({ consumptionKey: undefined }), "two"));
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("dispatch and authenticated worker claim can only occur once", () => {
  const directory = scratch(); const store = new OperationStore(directory);
  try {
    const job = store.accept(intent(), "dispatch");
    const token = store.dispatch(job.id)!;
    assert.ok(token);
    assert.equal(store.dispatch(job.id), undefined);
    assert.equal(store.claim(job.id, "wrong-token", owner("wrong-token")), false);
    assert.equal(store.claim(job.id, token, owner("wrong-owner-token")), false);
    assert.equal(store.claim(job.id, token, owner(token)), true);
    assert.equal(store.claim(job.id, token, owner(token)), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("ambiguous dispatch and absent workers retain locks and cannot be replayed", () => {
  const directory = scratch(); let now = 1_000;
  const store = new OperationStore(directory, { now: () => now, alive: () => false });
  try {
    const job = store.accept(intent(), "ambiguous"); store.dispatch(job.id);
    now += 15_001; store.reconcile();
    assert.equal(store.get(job.id)?.view.execution, "lost");
    assert.equal(store.get(job.id)?.view.outcome, "uncertain");
    assert.equal(store.dispatch(job.id), undefined);
    assert.throws(() => store.accept(intent({ consumptionKey: "another-review" }), "new"), conflict);
    assert.throws(() => store.update(job.id, { execution: "running" }), conflict);
    const other = store.accept(intent({ locks: ["deployment:b"], consumptionKey: "review-b" }), "other");
    const token = store.dispatch(other.id)!; store.claim(other.id, token, owner(token)); store.reconcile();
    assert.equal(store.get(other.id)?.view.execution, "lost");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unavailable identity inspection does not declare a healthy worker dead", () => {
  const directory = scratch(); let liveness: boolean | undefined;
  const store = new OperationStore(directory, { alive: () => liveness });
  try {
    const job = store.accept(intent(), "unknown-probe"), token = store.dispatch(job.id)!;
    store.claim(job.id, token, owner(token)); store.reconcile();
    assert.equal(store.get(job.id)?.view.execution, "running");
    assert.match(store.get(job.id)?.view.observationProblem ?? "", /temporarily unavailable/);
    liveness = true; store.reconcile();
    assert.equal(store.get(job.id)?.view.observationProblem, undefined);
    store.update(job.id, { execution: "finished", status: "succeeded", outcome: "confirmed" });
    store.reconcile(); assert.equal(store.get(job.id)?.view.outcome, "confirmed");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("domain reconciliation records confirmed effects without pretending lost execution succeeded", () => {
  const directory = scratch(); let now = 1_000;
  const store = new OperationStore(directory, { now: () => now });
  try {
    const job = store.accept(intent(), "reconcile"); store.dispatch(job.id);
    now += 15_001; store.reconcile();
    store.reconcileConfirmed(job.id, { outcome: "confirmed", summary: "The domain journal confirms the exact deployment completed." });
    const observed = store.get(job.id)!.view;
    assert.equal(observed.execution, "lost"); assert.equal(observed.status, "interrupted"); assert.equal(observed.outcome, "confirmed");
    assert.throws(() => store.reconcileConfirmed(job.id, { outcome: "confirmed", summary: "Repeated observation" }), conflict);
    assert.equal(store.dispatch(job.id), undefined);
    assert.throws(() => store.accept(intent(), "same-review-new-key"), conflict);
    assert.throws(() => store.accept(intent({ consumptionKey: "review-next" }), "new-reviewed-operation"), conflict, "verified infrastructure does not prove descendant execution or local export stopped");
    const other = store.accept(intent({ locks: ["deployment:b"], consumptionKey: "review-b" }), "finished-uncertain");
    store.update(other.id, { execution: "finished", status: "failed", outcome: "uncertain" });
    store.reconcileConfirmed(other.id, { outcome: "confirmed", summary: "External completion observed." });
    store.append(other.id, "Additional observed completion evidence", "info");
    assert.throws(() => store.accept(intent({ locks: ["deployment:b"], consumptionKey: "review-b-next" }), "after-observation"), conflict, "later metadata/log writes cannot release a reconciliation hold");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("log cursors commit with log data and failed writes leave no phantom line", () => {
  const directory = scratch(); const store = new OperationStore(directory);
  const raw = new DatabaseSync(path.join(directory, "operations.sqlite"));
  try {
    const job = store.accept(intent(), "logs");
    assert.equal(store.append(job.id, "one", "out").seq, 1);
    raw.exec("CREATE TRIGGER fail_log BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END;");
    assert.throws(() => store.append(job.id, "lost", "out"), /injected disk write failure/);
    assert.equal(store.get(job.id)?.view.lastSeq, 1);
    raw.exec("DROP TRIGGER fail_log");
    assert.equal(store.append(job.id, "two", "out").seq, 2);
    assert.equal(store.append(job.id, "three", "err").seq, 3);
    assert.deepEqual(store.log(job.id, 1, 1).lines.map(line => line.text), ["two"]);
    assert.deepEqual(store.log(job.id, 2).lines.map(line => line.text), ["three"]);
    assert.equal(store.log(job.id, 3).job.lastSeq, 3);
    assert.equal(store.log(job.id, 3).lines.length, 0);
  } finally { raw.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("acceptance rolls back when any durable resource claim fails", () => {
  const directory = scratch(); const store = new OperationStore(directory);
  const raw = new DatabaseSync(path.join(directory, "operations.sqlite"));
  try {
    raw.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON resource_locks BEGIN SELECT RAISE(ABORT, 'injected acceptance storage failure'); END;");
    assert.throws(() => store.accept(intent(), "fail"), /injected acceptance storage failure/);
    assert.equal(store.list().length, 0); assert.equal(store.findRequest("fail"), undefined); assert.equal(store.isConsumed("review-a"), false);
    raw.exec("DROP TRIGGER fail_accept");
    assert.equal(store.accept(intent(), "fail").execution, "accepted");
  } finally { raw.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("structured observation event cursors persist and failed writes do not skip events", () => {
  const directory = scratch(); let store = new OperationStore(directory);
  const raw = new DatabaseSync(path.join(directory, "operations.sqlite"));
  try {
    const job = store.accept(intent(), "events");
    store.event(job.id, "deploy-stacks", { deployment: "fixture", stacks: [{ name: "fixture-a", status: "UPDATE_IN_PROGRESS" }] });
    raw.exec("CREATE TRIGGER fail_event BEFORE INSERT ON event_cursors BEGIN SELECT RAISE(ABORT, 'injected event cursor failure'); END;");
    assert.throws(() => store.event(job.id, "deploy-event", { event: { status: "UPDATE_COMPLETE" } }), /injected event cursor failure/);
    assert.equal(store.events(job.id).lastSeq, 1); assert.equal(store.events(job.id).events.length, 1);
    raw.exec("DROP TRIGGER fail_event");
    store.event(job.id, "deploy-event", { event: { status: "UPDATE_COMPLETE" } });
    store.close(); store = new OperationStore(directory);
    const replay = store.events(job.id, 1);
    assert.equal(replay.lastSeq, 2);
    assert.deepEqual(replay.events, [{ seq: 2, event: "deploy-event", data: { event: { status: "UPDATE_COMPLETE" } } }]);
    assert.equal(store.events(job.id, 2).events.length, 0);
    assert.throws(() => store.event(job.id, "arbitrary" as "deploy-event", {}), /Unsupported operation event/);
    raw.prepare("DELETE FROM events WHERE operation_id = ? AND seq = 2").run(job.id);
    assert.throws(() => store.events(job.id), /event evidence is unreadable/);
  } finally { raw.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("missing log records and malformed owner identity are explicit evidence failures", () => {
  const directory = scratch(); const store = new OperationStore(directory);
  const raw = new DatabaseSync(path.join(directory, "operations.sqlite"));
  try {
    const job = store.accept(intent(), "missing-evidence"), token = store.dispatch(job.id)!;
    store.claim(job.id, token, owner(token));
    store.append(job.id, "first", "out"); store.append(job.id, "second", "out");
    raw.prepare("DELETE FROM logs WHERE operation_id = ? AND seq = 1").run(job.id);
    assert.throws(() => store.log(job.id), /log evidence is unreadable/);
    raw.prepare("UPDATE operations SET owner = ? WHERE id = ?").run("{}", job.id);
    assert.throws(() => store.reconcile(), /unreadable execution evidence/);
  } finally { raw.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("replay byte budgets paginate large logs and events without losing cursors", () => {
  const directory = scratch(); const store = new OperationStore(directory);
  try {
    const job = store.accept(intent(), "bounded-replay");
    const long = "x".repeat(70 * 1024);
    for (let index = 0; index < 80; index++) store.append(job.id, long, "out");
    const first = store.log(job.id);
    assert.ok(first.lines.length > 0 && first.lines.length < 80);
    assert.ok(Buffer.byteLength(JSON.stringify(first.lines)) < 4 * 1024 * 1024);
    assert.ok(first.lines.every(line => line.text.endsWith("[log line truncated]")));
    const second = store.log(job.id, first.lines.at(-1)!.seq);
    assert.equal(first.lines.length + second.lines.length, 80); assert.equal(second.lines.at(-1)?.seq, 80);
    for (let index = 0; index < 24; index++) store.event(job.id, "deploy-event", { detail: "x".repeat(200 * 1024) });
    const events = store.events(job.id);
    assert.ok(events.events.length > 0 && events.events.length < 24);
    assert.ok(Buffer.byteLength(JSON.stringify(events.events)) < 4 * 1024 * 1024);
    assert.equal(store.events(job.id, events.events.at(-1)!.seq).events.at(-1)?.seq, 24);
    assert.throws(() => store.event(job.id, "deploy-event", { detail: "x".repeat(300 * 1024) }), /size limit/);
    assert.equal(store.events(job.id).lastSeq, 24);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unreadable records and incompatible schema fail explicitly without replay", () => {
  const directory = scratch(); let store: OperationStore | undefined = new OperationStore(directory);
  const raw = new DatabaseSync(path.join(directory, "operations.sqlite"));
  try {
    const job = store.accept(intent(), "corrupt");
    raw.prepare("UPDATE operations SET view = ? WHERE id = ?").run("{torn", job.id);
    assert.throws(() => store!.list(), /unreadable execution evidence/);
    assert.throws(() => store!.reconcile(), /unreadable execution evidence/);
    store.close(); store = undefined;
    raw.exec("PRAGMA user_version = 999");
    assert.throws(() => new OperationStore(directory), /schema 999 is unsupported/);
  } finally { raw.close(); store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("storage is private and rejects a database symlink", () => {
  const directory = scratch(); const store = new OperationStore(directory); store.close();
  try {
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(directory, "operations.sqlite")).mode & 0o777, 0o600);
    }
    rmSync(path.join(directory, "operations.sqlite"));
    writeFileSync(path.join(directory, "other"), "private");
    symlinkSync(path.join(directory, "other"), path.join(directory, "operations.sqlite"));
    assert.throws(() => new OperationStore(directory), /regular file/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a cancelled accepted operation is never dispatched", () => {
  const directory = scratch(); const store = new OperationStore(directory);
  try {
    const job = store.accept(intent(), "cancel");
    store.requestCancel(job.id); assert.equal(store.dispatch(job.id), undefined);
    assert.equal(store.get(job.id)?.view.status, "cancelled");
    assert.equal(store.get(job.id)?.view.outcome, "confirmed");
    assert.equal(store.requestCancel(job.id).status, "cancelled");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("process identity rejects a reused PID start time and another owner", context => {
  let identity: ExecutionIdentity;
  try { identity = processIdentity("worker-token"); } catch { context.skip("Host sandbox does not permit ps; runner process suite requires host process inspection."); return; }
  assert.equal(identityAlive(identity), true);
  assert.equal(identityAlive({ ...identity, started: "another-process-start" }), false);
  assert.equal(identityAlive({ ...identity, uid: identity.uid + 1 }), false);
  assert.equal(identityAlive({ ...identity, pid: -1 }), undefined);
  const previous = process.env.TZ;
  try { process.env.TZ = "Pacific/Honolulu"; assert.equal(identityAlive(identity), true, "observer timezone does not change process identity"); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("redaction withholds secrets across every streaming and UTF-8 boundary", () => {
  const secrets = ["private-☃-value", "quoted\"secret", "a b&value"];
  const input = `before ${secrets[0]} ${JSON.stringify(secrets[1]).slice(1, -1)} ${encodeURIComponent(secrets[2])} after\n`;
  const bytes = Buffer.from(input);
  for (let split = 0; split <= bytes.length; split++) {
    const emitted: string[] = []; const redactor = new StreamingRedactor(secrets, value => emitted.push(value));
    redactor.push(bytes.subarray(0, split)); redactor.push(bytes.subarray(split)); redactor.flush();
    assert.equal(emitted.join(""), "before [redacted] [redacted] [redacted] after\n", `split ${split}`);
  }
  assert.equal(redactText("AWS_SESSION_TOKEN=unknown-token password: 'also private'", []), "AWS_SESSION_TOKEN=[redacted] password: [redacted]");
  assert.equal(redactText('password: "escaped\\"private" tail', []), 'password: [redacted] tail');
  assert.equal(redactText("client_secret='escaped\\'private' tail", []), "client_secret=[redacted] tail");
});

test("computed summary counts stay readable while string values retain complete redaction", () => {
  const redact = (text: string) => redactText(text, ["6", "fixture-private"]);
  assert.equal(summaryText(["Synthesis ready: ", 65, " resource changes to review."], redact), "Synthesis ready: 65 resource changes to review.");
  assert.equal(summaryText(["Secret 6: fixture-", "private; count ", 65], redact), "Secret [redacted]: [redacted]; count 65");
  assert.equal(summaryText("Synthesis ready: 65 resource changes to review.", redact), "Synthesis ready: [redacted]5 resource changes to review.", "freeform values never acquire the computed-count exception");
  assert.equal(redact("6"), "[redacted]", "even a one-character actual private value stays protected");
});

test("redaction recognizes credential assignments split between writes and bounds long output", () => {
  const emitted: string[] = []; const redactor = new StreamingRedactor([], value => emitted.push(value));
  redactor.push("AWS_SECRET_ACCESS_KEY=part"); assert.equal(emitted.length, 0);
  redactor.push("-two\nAuthorization: Bearer token-123\n"); redactor.flush();
  assert.equal(emitted.join(""), "AWS_SECRET_ACCESS_KEY=[redacted]\nAuthorization: Bearer [redacted]\n");
  redactor.push("x".repeat(100_000)); redactor.push("tail\nnext\n"); redactor.flush();
  assert.ok(emitted.join("").endsWith("[oversized output omitted]\nnext\n"));
});
