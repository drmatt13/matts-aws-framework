import assert from "./support/assert";
import { test } from "node:test";
import type { DatabaseObservation, DatabaseSaveResult, DatabaseSourceReview, DatabaseValidation, DatabaseWorkbench } from "../shared/database-workbench";
import { DatabaseSession, type DatabaseSessionApi } from "../src/database-session";
import { parseDeclaredSchema } from "../server/database";

const source = '// use prisma-8\nmodel Entry {\n  id Uuid @id\n  title String @map("entry_title")\n}\n';
const changed = source.replace("title String", "title String?");
function validation(text = source, valid = true): DatabaseValidation {
  return { sourceHash: text, valid, diagnostics: valid ? [] : [{ from: text.length - 1, to: text.length, severity: "error", code: "PSL_PARSE", message: "Finish this model." }], schema: valid ? parseDeclaredSchema(text) : undefined, storageHash: text, executionHash: text, validatedAt: "2026-10-22T12:00:00Z" };
}
function workbench(text = source, revision = "baseline"): DatabaseWorkbench {
  return { source: text, revision, configRevision: "config", file: "packages/database/prisma/contract.prisma", validation: validation(text), capabilities: { dialect: "Prisma 8", semanticValidation: true, formatting: true, languageServer: false, notes: [] }, targets: [
    { id: "local:postgres", label: "Development PostgreSQL", available: true, detail: "Explicit local observation", identity: "local-identity" },
    { id: "production", label: "Production RDS", available: false, detail: "Private IAM connection", identity: "prod-identity" },
  ] };
}
function review(text = changed, revision = "baseline"): DatabaseSourceReview {
  return { reviewId: "review", file: "packages/database/prisma/contract.prisma", before: source, after: text, expectedRevision: revision, configRevision: "config", sourceHash: text, expiresAt: "2026-10-22T13:00:00Z", validation: validation(text), effects: ["Writes the authored schema only."] };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides: Partial<DatabaseSessionApi> = {}) {
  const calls = { review: [] as string[], saves: [] as string[] };
  const api: DatabaseSessionApi = { validate: async text => validation(text), review: async (text, revision) => { calls.review.push(text); return review(text, revision); }, save: async reviewId => { calls.saves.push(reviewId); return { saved: true, source: changed, revision: "saved", file: "packages/database/prisma/contract.prisma", refresh: "complete", message: "Source saved." }; }, ...overrides };
  const session = new DatabaseSession(api); session.sync(workbench()); return { session, calls };
}
function observation(targetId: DatabaseObservation["targetId"] = "local:postgres", targetIdentity = targetId === "production" ? "prod-identity" : "local-identity"): DatabaseObservation {
  return { id: "observation", targetId, targetIdentity, observedAt: "2026-10-22T12:00:00Z", savedRevision: "baseline", historyRevision: "history", baseline: { label: "Saved source" }, status: "observed", marker: { status: "matches" }, physical: { status: "matches", issues: [], warnings: [] }, migrationState: { status: "current", message: "At current contract" }, ledger: [], message: "Read only observation", limits: [] };
}

test("refresh recognizes saved draft bytes after an unconfirmed source response", async () => {
  const { session } = fixture({ save: async () => { throw new Error("Connection interrupted"); } });
  session.setSource(changed);
  await session.review();
  await session.save();
  assert.equal(session.dirty, true);
  session.sync(workbench(changed, "actually-saved"));
  assert.equal(session.dirty, false);
  assert.equal(session.conflict, false);
  assert.equal(session.getSnapshot().source, changed);
  assert.equal(session.getSnapshot().baseline?.revision, "actually-saved");
});

test("superseded validation responses cannot replace newer draft evidence or its last valid diagram", async () => {
  const first = deferred<DatabaseValidation>(), second = deferred<DatabaseValidation>();
  const signals: AbortSignal[] = [];
  let count = 0;
  const { session } = fixture({ validate: async (_source, signal) => { signals.push(signal!); return count++ ? second.promise : first.promise; } });
  const originalDiagram = session.getSnapshot().diagram;
  session.setSource(changed);
  const old = session.validate();
  session.setSource(changed + "model Broken {");
  assert.equal(signals[0]?.aborted, true);
  const latest = session.validate();
  second.resolve(validation(session.getSnapshot().source, false)); await latest;
  first.resolve(validation(changed)); await old;
  assert.equal(session.currentValid, false);
  assert.equal(session.getSnapshot().validation?.valid, false);
  assert.equal(session.getSnapshot().diagram, originalDiagram);
  assert.equal(session.getSnapshot().validating, false);
});

test("external source conflict preserves draft bytes and requires an explicit baseline decision", async () => {
  const { session, calls } = fixture();
  session.setSource(changed);
  const external = workbench(source.replace("title String", "title VarChar(200)"), "external");
  session.sync(external);
  assert.equal(session.getSnapshot().source, changed);
  assert.equal(session.conflict, true);
  await session.review(); assert.equal(calls.review.length, 0);
  session.useLatestBaseline();
  assert.equal(session.getSnapshot().source, changed);
  assert.equal(session.getSnapshot().baseline, external);
  assert.equal(session.conflict, false);
  await session.review(); assert.deepEqual(calls.review, [changed]);
  session.discard();
  assert.equal(session.getSnapshot().source, external.source);
  assert.equal(session.dirty, false);
});

test("review freezes editing and stale source refreshes supersede its pending result", async () => {
  const response = deferred<DatabaseSourceReview>();
  const { session, calls } = fixture({ review: async () => response.promise });
  session.setSource(changed);
  const reviewing = session.review();
  assert.equal(session.getSnapshot().busy, "review");
  session.setSource("ignored while busy"); session.discard(); session.closeReview();
  assert.equal(session.getSnapshot().source, changed);
  session.sync(workbench(source + "\n// external", "external"));
  response.resolve(review()); await reviewing;
  assert.equal(session.conflict, true);
  assert.equal(session.getSnapshot().review, undefined, "superseded review is never reopened");
  await session.save(); assert.equal(calls.saves.length, 0);
});

test("review and close are read-only; only explicit save consumes a reviewed id", async () => {
  const { session, calls } = fixture();
  session.setSource(changed);
  await session.review(); assert.equal(calls.saves.length, 0);
  session.closeReview(); assert.equal(session.getSnapshot().review, undefined);
  await session.save(); assert.equal(calls.saves.length, 0);
  await session.review(); await session.save();
  assert.deepEqual(calls.saves, ["review"]);
  assert.equal(session.dirty, false);
  assert.equal(session.getSnapshot().source, changed);
  assert.equal(session.getSnapshot().baseline?.revision, "saved");
  await session.save(); assert.equal(calls.saves.length, 1, "accepted review is consumed once");
});

test("successful source save remains successful when graph refresh is unavailable", async () => {
  const result: DatabaseSaveResult = { saved: true, source: changed, revision: "saved", file: "packages/database/prisma/contract.prisma", refresh: "unavailable", message: "Source saved; graph refresh unavailable. Retry refresh." };
  const pending = deferred<DatabaseSaveResult>();
  const { session } = fixture({ save: async () => pending.promise });
  session.setSource(changed); await session.review();
  const saving = session.save();
  session.setSource("ignored"); session.discard(); session.sync(workbench(source, "obsolete-snapshot"));
  assert.equal(session.getSnapshot().source, changed);
  pending.resolve(result);
  assert.equal(await saving, result);
  assert.equal(session.getSnapshot().baseline?.revision, "saved");
  assert.equal(session.getSnapshot().error, undefined);
  assert.equal(session.dirty, false);
});

test("save rejection preserves draft and clears its expired review without claiming an effect", async () => {
  const { session } = fixture({ save: async () => { throw new Error("Saved source changed. Nothing was written."); } });
  session.setSource(changed); await session.review(); await session.save();
  assert.equal(session.getSnapshot().source, changed);
  assert.equal(session.getSnapshot().baseline?.source, source);
  assert.equal(session.getSnapshot().review, undefined);
  assert.equal(session.getSnapshot().busy, undefined);
  assert.match(session.getSnapshot().error!, /Nothing was written/);
});

test("target-bound observations reject another target, changed identity, stale revision and superseded requests", () => {
  const { session } = fixture();
  const first = session.beginObservation("local:postgres");
  session.acceptObservation(first, observation("production"));
  assert.equal(session.getSnapshot().observation, undefined);
  session.acceptObservation(first, observation("local:postgres", "wrong-identity"));
  assert.equal(session.getSnapshot().observation, undefined);
  session.acceptObservation(first, { ...observation(), savedRevision: "old" });
  assert.equal(session.getSnapshot().observation, undefined);
  const second = session.beginObservation("production");
  session.acceptObservation(first, observation());
  assert.equal(session.getSnapshot().observation, undefined);
  session.acceptObservation(second, observation("production"));
  assert.equal(session.getSnapshot().observation?.targetId, "production");
  session.setSource(changed);
  assert.equal(session.getSnapshot().observation, undefined);
});

test("private connection identity changes invalidate observations even when authored source revision matches", () => {
  const { session } = fixture();
  const request = session.beginObservation("local:postgres");
  session.acceptObservation(request, observation());
  assert.ok(session.getSnapshot().observation);
  const current = workbench();
  session.sync({ ...current, targets: current.targets.map(target => target.id === "local:postgres" ? { ...target, identity: "new-local-identity" } : target) });
  assert.equal(session.getSnapshot().observation, undefined);
  session.acceptObservation(request, observation());
  assert.equal(session.getSnapshot().observation, undefined);
});

test("unreachable database evidence remains unknown instead of claiming a schema match", () => {
  const { session } = fixture();
  const result: DatabaseObservation = { ...observation(), status: "unreachable", marker: { status: "unknown" }, physical: { status: "unknown", issues: [], warnings: [] }, migrationState: { status: "unknown", message: "Database could not be reached." } };
  session.acceptObservation(session.beginObservation("local:postgres"), result);
  assert.equal(session.getSnapshot().observation?.physical.status, "unknown");
  assert.equal(session.getSnapshot().observation?.migrationState.status, "unknown");
});

test("configuration changes invalidate same-source semantic evidence while preserving an unsaved draft", async () => {
  const response = deferred<DatabaseValidation>();
  const { session } = fixture({ validate: async () => response.promise });
  const request = session.beginObservation("local:postgres"); session.acceptObservation(request, observation());
  session.setSource(changed); const validating = session.validate();
  const next = { ...workbench(), configRevision: "changed-config", validation: { ...validation(), storageHash: "new-config-storage" } };
  session.sync(next);
  assert.equal(session.getSnapshot().source, changed);
  assert.equal(session.getSnapshot().baseline, next);
  assert.equal(session.currentValid, false);
  assert.equal(session.getSnapshot().observation, undefined);
  response.resolve(validation(changed)); await validating;
  assert.equal(session.currentValid, false, "result produced against old configuration is superseded");
  assert.match(session.getSnapshot().error!, /configuration changed/);
  session.discard(); assert.equal(session.currentValid, true);
  assert.equal(session.getSnapshot().validation?.storageHash, "new-config-storage");
});
