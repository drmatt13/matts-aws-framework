import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { integrateApprovedAgentProposal } from "../server/agent-runtime/approved-integration";
import { listAgentIntegrationRecovery } from "../server/agent-runtime/integration";
import { freezeAgentProposal, prepareAgentWorkspace, readSourceManifest } from "../server/agent-runtime/workspace";
import { sourceCoordinationState } from "../server/edits/source-gate";

async function fixture(copyDependencies = true) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-approved-integration-"))), root = path.join(directory, "project");
  const dependency = path.join(root, "node_modules/fixture/index.js"), source = path.join(root, "source.ts");
  mkdirSync(path.dirname(dependency), { recursive: true });
  writeFileSync(dependency, "module.exports = 'validated dependency';\n"); writeFileSync(source, "original source\n");
  const workspace = await prepareAgentWorkspace(root, { storageDirectory: path.join(directory, "tasks"), copyDependencies });
  writeFileSync(path.join(workspace.workingDirectory, "source.ts"), "approved source\n");
  const proposal = await freezeAgentProposal(workspace);
  return { root, source, dependency, workspace, proposal, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("validated installed dependency identity admits exact source integration", async () => {
  const f = await fixture();
  try {
    const result = await integrateApprovedAgentProposal(f.workspace, f.proposal, f.proposal.digest);
    assert.equal(result.status, "applied"); assert.equal(readSourceManifest(f.root).digest, f.proposal.candidateDigest);
    assert.equal(readFileSync(f.dependency, "utf8"), "module.exports = 'validated dependency';\n");
  } finally { f.cleanup(); }
});

test("installed dependency drift before approval writes no source and creates no integration record", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.dependency, "module.exports = 'a concurrent npm install';\n");
    await assert.rejects(integrateApprovedAgentProposal(f.workspace, f.proposal, f.proposal.digest), /dependencies changed/);
    assert.equal(readFileSync(f.source, "utf8"), "original source\n"); assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
    assert.equal(sourceCoordinationState(f.root).status, "ready");
  } finally { f.cleanup(); }
});

test("dependency drift during installed validation restores source and preserves the external dependency change", async () => {
  const f = await fixture();
  try {
    const result = await integrateApprovedAgentProposal(f.workspace, f.proposal, f.proposal.digest, { afterInstall: async () => {
      assert.equal(readFileSync(f.source, "utf8"), "approved source\n");
      writeFileSync(f.dependency, "external dependency update\n");
    } });
    assert.equal(result.status, "restored"); assert.equal(readFileSync(f.source, "utf8"), "original source\n");
    assert.equal(readFileSync(f.dependency, "utf8"), "external dependency update\n");
    assert.equal(sourceCoordinationState(f.root).status, "ready"); assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
  } finally { f.cleanup(); }
});

test("missing or mismatched protected dependency evidence cannot be approved", async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(integrateApprovedAgentProposal(f.workspace, f.proposal, f.proposal.digest), /no captured installed dependency identity/);
    await assert.rejects(integrateApprovedAgentProposal({ ...f.workspace, dependencyDigest: "0".repeat(64) }, f.proposal, f.proposal.digest), /no longer matches/);
    assert.equal(readFileSync(f.source, "utf8"), "original source\n");
  } finally { f.cleanup(); }
});
