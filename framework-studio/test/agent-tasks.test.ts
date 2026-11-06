import assert from "./support/assert";
import { test } from "node:test";
import type { CodingEvent, CodingProposal, CodingTask } from "../shared/agent-runtime";
import { codingActivationProblem, codingApprovalProblem, codingDiffLines, codingEventText, codingProgressItems, codingValidationChoice, mergeCodingEvents } from "../src/coding-presentation";

const task: CodingTask = { id: "task", provider: "codex", prompt: "Improve a handler", status: "awaiting_review", createdAt: "now", updatedAt: "now", lastSeq: 4, proposalDigest: "reviewed", cancelRequested: false };
const proposal: CodingProposal = { id: "proposal", taskId: "task", digest: "reviewed", baselineDigest: "base", candidateDigest: "candidate", createdAt: "now", activation: "none", limitations: [], changes: [{ path: "handler.ts", kind: "modify", beforeHash: "before", afterHash: "after", beforeMode: 0o644, afterMode: 0o644, binary: false, diff: "" }], validation: [{ command: "npm run verify", status: "passed", candidateDigest: "candidate" }] };

test("explicit validation choices preserve selected scope and reject escaping test paths", () => {
  assert.deepEqual(codingValidationChoice("project", "ignored"), { plan: { kind: "project" } });
  assert.deepEqual(codingValidationChoice("framework", ""), { plan: { kind: "framework" } });
  assert.deepEqual(codingValidationChoice("tests", " test/a.test.ts\ntest/b.test.ts\ntest/a.test.ts\n"), { plan: { kind: "tests", paths: ["test/a.test.ts", "test/b.test.ts"] } });
  for (const value of ["", "../external.ts", "/outside.ts", "--experimental-flag", "test/../escape.ts", Array.from({ length: 21 }, (_, at) => `test/${at}.ts`).join("\n")]) assert.ok(codingValidationChoice("tests", value).problem);
});

test("source approval requires exact task, proposal and validated candidate identities", () => {
  assert.equal(codingApprovalProblem(task, proposal), undefined);
  assert.match(codingApprovalProblem(task, { ...proposal, digest: "other" })!, /no longer matches/);
  assert.match(codingApprovalProblem(task, { ...proposal, taskId: "other-task" })!, /no longer matches/);
  assert.match(codingApprovalProblem({ ...task, status: "conflicted" }, proposal)!, /not awaiting/);
  assert.match(codingApprovalProblem(task, { ...proposal, validation: [{ ...proposal.validation[0]!, candidateDigest: "older" }] })!, /exact proposed files/);
  assert.match(codingApprovalProblem(task, { ...proposal, validation: [] })!, /validation/);
  assert.match(codingApprovalProblem(task, { ...proposal, validation: [{ ...proposal.validation[0]!, status: "failed" }] })!, /validation/);
  assert.equal(codingApprovalProblem(task, { ...proposal, activation: "restart_required" }), undefined);
  assert.match(codingApprovalProblem(task, { ...proposal, activation: "dependency_install_required" })!, /separate installation/);
});

test("Studio activation requires applied reviewed source and a separate restart decision", () => {
  const runtimeProposal: CodingProposal = { ...proposal, activation: "restart_required" };
  const applied: CodingTask = { ...task, status: "completed", sourceOutcome: "applied", activation: "restart_required" };
  assert.equal(codingActivationProblem(applied, runtimeProposal), undefined);
  assert.ok(codingActivationProblem(task, runtimeProposal));
  assert.ok(codingActivationProblem({ ...applied, sourceOutcome: "kept" }, runtimeProposal));
  assert.ok(codingActivationProblem(applied, { ...runtimeProposal, digest: "other" }));
  assert.ok(codingActivationProblem({ ...applied, runtimeActivation: { status: "starting", detail: "Starting" } }, runtimeProposal));
  assert.ok(codingActivationProblem({ ...applied, runtimeActivation: { status: "ready", detail: "Ready" } }, runtimeProposal));
  assert.equal(codingActivationProblem({ ...applied, runtimeActivation: { status: "failed", detail: "Failed" } }, runtimeProposal), undefined);
});

test("progress joins adjacent text deltas while preserving command and item boundaries", () => {
  const event = (seq: number, text: string, itemId?: string): CodingEvent => ({ seq, taskId: "task", at: "now", type: "message", data: { text, ...(itemId ? { itemId } : {}) } });
  const events: CodingEvent[] = [event(1, "Investigating", "one"), event(2, " the ", "one"), event(3, "handler.", "one"), { seq: 4, taskId: "task", at: "now", type: "command", data: { command: "npm test" } }, event(5, "Validation", "two"), event(6, " passed.", "two"), event(7, "New turn", "three")];
  assert.deepEqual(codingProgressItems(events).map(item => [item.seq, item.text]), [[1, "Investigating the handler."], [4, "npm test"], [5, "Validation passed."], [7, "New turn"]]);
  assert.equal(codingProgressItems([event(1, "Claude"), event(2, " message")])[0]!.text, "Claude message");
  const bounded = codingProgressItems(Array.from({ length: 100 }, (_, at) => event(at, "x".repeat(1000))));
  assert.equal(bounded.length, 1); assert.equal(bounded[0]!.text.length, 32000); assert.ok(bounded[0]!.text.startsWith("…"));
});

test("reconnected progress deduplicates sequence numbers and retains bounded newest evidence", () => {
  const event = (seq: number): CodingEvent => ({ seq, taskId: "task", at: "now", type: "message", data: { text: `event ${seq}` } });
  assert.deepEqual(mergeCodingEvents([event(1), event(2)], [event(3), event(2)]).map(item => item.seq), [1, 2, 3]);
  const merged = mergeCodingEvents(Array.from({ length: 1000 }, (_, at) => event(at)), [event(1000)]);
  assert.equal(merged.length, 1000); assert.equal(merged[0]!.seq, 1); assert.equal(merged.at(-1)!.seq, 1000);
});

test("unified source review keeps hunk positions, additions, deletions and newline markers", () => {
  const lines = codingDiffLines("--- a/file.ts\n+++ b/file.ts\n@@ -2,2 +2,2 @@\n context\n-before\n+after\n\\ No newline at end of file\n@@ -9,0 +10,1 @@\n+new\n");
  assert.deepEqual(lines, [
    { kind: "context", text: "context", oldLine: 2, newLine: 2, hunk: "@@ -2,2 +2,2 @@" },
    { kind: "remove", text: "before", oldLine: 3 }, { kind: "add", text: "after", newLine: 3 },
    { kind: "context", text: "\\ No newline at end of file" }, { kind: "add", text: "new", newLine: 10, hunk: "@@ -9,0 +10,1 @@" },
  ]);
  assert.equal(codingEventText({ seq: 1, taskId: "task", at: "now", type: "command", data: { command: ["npm", "test"], exitCode: 1 } }), "npm test (exit 1)");
  assert.equal(codingEventText({ seq: 1, taskId: "task", at: "now", type: "validation", data: { output: "2 tests passed" } }), "2 tests passed");
  assert.equal(codingEventText({ seq: 1, taskId: "task", at: "now", type: "command", data: { command: ["npm", "test"], stderr: "validation failed", exitCode: 1 } }), "npm test\nvalidation failed (exit 1)");
  assert.equal(codingEventText({ seq: 1, taskId: "task", at: "now", type: "state", data: { status: "awaiting_review" } }), "awaiting review");
});
