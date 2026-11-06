import assert from "./support/assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freezeStructuredProposal, type ReviewedStructuredSource } from "../server/agent-runtime/structured-proposal";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import { prepareAgentWorkspace, readSourceManifest } from "../server/agent-runtime/workspace";

function fixture() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-structured-proposal-"))), root = path.join(base, "project");
  mkdirSync(root); writeFileSync(path.join(root, "framework.config.ts"), "before\n");
  const review: ReviewedStructuredSource = { planId: "fixture-plan", revision: "fixture-revision", changes: [{ path: "framework.config.ts", before: "before\n", after: "after\n" }, { path: "new.ts", before: null, after: "created\n" }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } } };
  return { base, root, review, prepare: () => prepareAgentWorkspace(root, { storageDirectory: path.join(base, "tasks"), copyDependencies: false }), dispose: () => rmSync(base, { recursive: true, force: true }) };
}
test("structured source uses the same frozen review and exact-digest integration in a disposable checkout", async () => {
  const f = fixture();
  try {
    const workspace = await f.prepare(), proposal = await freezeStructuredProposal(workspace, f.review);
    assert.equal(readFileSync(path.join(f.root, "framework.config.ts"), "utf8"), "before\n");
    assert.equal(proposal.changes.length, 2);
    const metadata = JSON.parse(readFileSync(path.join(proposal.directory, "structured-review.json"), "utf8"));
    assert.equal(metadata.planId, f.review.planId); assert.equal(metadata.proposalDigest, proposal.digest);
    await assert.rejects(integrateAgentProposal(proposal, "different-review"), /exact frozen proposal/);
    assert.equal(readSourceManifest(f.root).digest, workspace.baseline.digest);
    const result = await integrateAgentProposal(proposal, proposal.digest);
    assert.equal(result.status, "applied"); assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
  } finally { f.dispose(); }
});
test("structured handoff refuses failed modes, stale bytes and escaped paths before any private staging", async () => {
  const f = fixture();
  try {
    const workspace = await f.prepare(), baseline = workspace.baseline.digest;
    await assert.rejects(freezeStructuredProposal(workspace, { ...f.review, preflight: { ...f.review.preflight, prod: { mode: "prod", ok: false, diagnostics: [] } } }), /Both declaration modes/);
    await assert.rejects(freezeStructuredProposal(workspace, { ...f.review, changes: [{ ...f.review.changes[0]!, before: "stale\n" }] }), /changed since/);
    await assert.rejects(freezeStructuredProposal(workspace, { ...f.review, changes: [{ path: "../escape.ts", before: null, after: "outside" }] }), /invalid source path/);
    await assert.rejects(freezeStructuredProposal(workspace, { ...f.review, changes: [...f.review.changes, f.review.changes[0]!] }), /duplicate/);
    assert.equal(readSourceManifest(workspace.workingDirectory).digest, baseline); assert.equal(readSourceManifest(f.root).digest, baseline);
    writeFileSync(path.join(f.root, "user-edit.ts"), "saved concurrently");
    await assert.rejects(freezeStructuredProposal(workspace, f.review), /Saved project source changed/);
    assert.equal(readSourceManifest(workspace.workingDirectory).digest, baseline);
  } finally { f.dispose(); }
});
