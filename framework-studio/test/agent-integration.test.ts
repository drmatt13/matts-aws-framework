import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { agentIntegrationReceipt, integrateAgentProposal, listAgentIntegrationRecovery, recoverAgentIntegration } from "../server/agent-runtime/integration";
import { freezeAgentProposal, prepareAgentWorkspace, readSourceManifest } from "../server/agent-runtime/workspace";
import { assertSourcePublicationEpoch, recoverSourceGate, restrictedSourceEvaluationRequired, sourceCoordinationState, sourcePublicationEpoch, withSourceRead, withSourceWrite, withSourceWriteSync } from "../server/edits/source-gate";
import { writeSourceChange } from "../server/edits/io";
import { SourceJournal } from "../server/edits/journal";
import { JobManager } from "../server/deploy/jobs";

function fixture() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-agent-integration-"))), root = path.join(base, "project"), storageDirectory = path.join(base, "tasks");
  mkdirSync(root);
  const write = (name: string, bytes: string | Buffer) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); return file; };
  return { root, base, storageDirectory, write, dispose: () => rmSync(base, { recursive: true, force: true }) };
}
async function proposalFor(f: ReturnType<typeof fixture>) {
  f.write("a.ts", "original a\n"); f.write("b.ts", "original b\n");
  const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, copyDependencies: false });
  writeFileSync(path.join(workspace.workingDirectory, "a.ts"), "agent a\n");
  writeFileSync(path.join(workspace.workingDirectory, "b.ts"), "agent b\n");
  return freezeAgentProposal(workspace);
}

test("approved exact source integration preserves dirty/untracked baseline, binary bytes and modes without Git writes", async () => {
  const f = fixture();
  try {
    f.write(".git/HEAD", "untouched Git state\n"); f.write("dirty.ts", "saved user edit\n"); f.write("untracked.ts", "user addition\n"); f.write("removed.ts", "remove this\n"); f.write("asset.bin", Buffer.from([0, 128, 255]));
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, copyDependencies: false });
    writeFileSync(path.join(workspace.workingDirectory, "dirty.ts"), "approved source\n");
    writeFileSync(path.join(workspace.workingDirectory, "asset.bin"), Buffer.from([255, 0, 129]));
    for (const name of ["__proto__", "toString"]) writeFileSync(path.join(workspace.workingDirectory, name), "ordinary new source file\n");
    rmSync(path.join(workspace.workingDirectory, "removed.ts"));
    mkdirSync(path.join(workspace.workingDirectory, "new")); writeFileSync(path.join(workspace.workingDirectory, "new/run.sh"), "echo candidate\n");
    chmodSync(path.join(workspace.workingDirectory, "new/run.sh"), 0o755);
    const proposal = await freezeAgentProposal(workspace);
    // A provider changing its working copy later cannot change what is approved.
    writeFileSync(path.join(workspace.workingDirectory, "dirty.ts"), "late unreviewed bytes\n");
    const result = await integrateAgentProposal(proposal, proposal.digest);
    assert.equal(result.status, "applied");
    assert.equal(restrictedSourceEvaluationRequired(f.root), true, "accepted source cannot regain privileged graph evaluation");
    assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
    assert.equal(readFileSync(path.join(f.root, "dirty.ts"), "utf8"), "approved source\n");
    assert.equal(readFileSync(path.join(f.root, "untracked.ts"), "utf8"), "user addition\n");
    assert.deepEqual(readFileSync(path.join(f.root, "asset.bin")), Buffer.from([255, 0, 129]));
    for (const name of ["__proto__", "toString"]) assert.equal(readFileSync(path.join(f.root, name), "utf8"), "ordinary new source file\n");
    assert.equal(existsSync(path.join(f.root, "removed.ts")), false);
    assert.equal(statSync(path.join(f.root, "new/run.sh")).mode & 0o777, 0o755);
    assert.equal(readFileSync(path.join(f.root, ".git/HEAD"), "utf8"), "untouched Git state\n");
    assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
    assert.equal((await integrateAgentProposal(proposal, proposal.digest)).journalId, result.journalId, "idempotent retry does not reapply");
  } finally { f.dispose(); }
});

test("approval mismatch, stale unrelated source and colliding new paths cause zero writes", async () => {
  const f = fixture();
  try {
    const proposal = await proposalFor(f), before = readSourceManifest(f.root).digest;
    await assert.rejects(integrateAgentProposal(proposal, "0".repeat(64)), /exact frozen proposal/);
    assert.equal(readSourceManifest(f.root).digest, before);
    f.write("unrelated.ts", "new user work\n");
    await assert.rejects(integrateAgentProposal(proposal, proposal.digest), /Saved source changed/);
    assert.equal(readFileSync(path.join(f.root, "a.ts"), "utf8"), "original a\n");
    assert.equal(readFileSync(path.join(f.root, "unrelated.ts"), "utf8"), "new user work\n");
    assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
  } finally { f.dispose(); }
  const other = fixture();
  try {
    other.write("keep.ts", "baseline\n");
    const workspace = await prepareAgentWorkspace(other.root, { storageDirectory: other.storageDirectory, copyDependencies: false });
    writeFileSync(path.join(workspace.workingDirectory, "new.ts"), "agent addition\n");
    const proposal = await freezeAgentProposal(workspace);
    other.write("new.ts", "user independently created this\n");
    await assert.rejects(integrateAgentProposal(proposal, proposal.digest), /Saved source changed/);
    assert.equal(readFileSync(path.join(other.root, "new.ts"), "utf8"), "user independently created this\n");
  } finally { other.dispose(); }
});

test("failure after each replacement restores only written bytes and leaves no reviewable partial state", async () => {
  for (const failAt of [0, 1]) {
    const f = fixture();
    try {
      const proposal = await proposalFor(f);
      const result = await integrateAgentProposal(proposal, proposal.digest, { afterWrite(index) { if (index === failAt) throw new Error("injected I/O boundary failure"); } });
      assert.equal(result.status, "restored");
      assert.equal(restrictedSourceEvaluationRequired(f.root), true, "restoration does not implicitly trust code that briefly reached the checkout");
      assert.equal(readSourceManifest(f.root).digest, proposal.baselineDigest);
      assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
      assert.doesNotThrow(() => sourcePublicationEpoch(f.root));
    } finally { f.dispose(); }
  }
});

test("rollback preserves later external edits and blocks Studio writers until fingerprint-bound recovery", async () => {
  const f = fixture();
  try {
    const proposal = await proposalFor(f);
    const result = await integrateAgentProposal(proposal, proposal.digest, { afterWrite(index) { if (!index) { f.write("a.ts", "later user save\n"); throw new Error("injected failure"); } } });
    assert.equal(result.status, "conflicted");
    assert.equal(readFileSync(path.join(f.root, "a.ts"), "utf8"), "later user save\n");
    assert.equal(readFileSync(path.join(f.root, "b.ts"), "utf8"), "original b\n");
    assert.throws(() => writeSourceChange(f.root, path.join(f.root, "b.ts"), "original b\n", "must not write\n"), /recovery/i);
    assert.throws(() => sourcePublicationEpoch(f.root), /recovery/i);
    const pending = listAgentIntegrationRecovery(f.root)[0]!;
    assert.equal(pending.files.find(file => file.path === "a.ts")!.state, "conflicted");
    await assert.rejects(recoverAgentIntegration(f.root, pending.id, "KEEP CURRENT SOURCE", "wrong"), /Source changed/);
    assert.equal((await recoverAgentIntegration(f.root, pending.id, "RESTORE SOURCE")).status, "conflicted");
    assert.equal((await recoverAgentIntegration(f.root, pending.id, "KEEP CURRENT SOURCE", pending.fingerprint)).status, "kept");
    assert.equal(agentIntegrationReceipt(f.root, proposal.digest)?.status, "kept");
    assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
    assert.equal(readFileSync(path.join(f.root, "a.ts"), "utf8"), "later user save\n");
    assert.doesNotThrow(() => sourcePublicationEpoch(f.root));
  } finally { f.dispose(); }
});

test("legacy source journal ownership excludes an agent importer and a gate excludes old writers", async () => {
  const f = fixture();
  try {
    const proposal = await proposalFor(f), journal = new SourceJournal(f.root);
    mkdirSync(path.join(f.root, "framework-config")); f.write("framework-config/example.ts", "before\n");
    const id = journal.begin("existing writer", [{ file: path.join(f.root, "framework-config/example.ts"), before: "before\n", after: "after\n" }]);
    await assert.rejects(integrateAgentProposal(proposal, proposal.digest), /source transaction|source recovery/);
    journal.finish(id, "restored");
    let release!: () => void;
    const active = withSourceWrite(f.root, () => new Promise<void>(resolve => { release = resolve; }));
    try {
      assert.throws(() => writeSourceChange(f.root, path.join(f.root, "a.ts"), "original a\n", "wrong\n"), /source writer/);
      assert.throws(() => journal.begin("contender", []), /Source integration/);
    } finally { release(); await active; }
  } finally { f.dispose(); }
});

test("a restarted importer recovers a killed process journal without replaying the task", async () => {
  const f = fixture();
  try {
    const proposal = await proposalFor(f);
    const module = pathToFileURL(path.resolve(__dirname, "../server/agent-runtime/integration.ts")).href;
    const script = `import {integrateAgentProposal} from ${JSON.stringify(module)}; await integrateAgentProposal(${JSON.stringify(proposal)}, ${JSON.stringify(proposal.digest)}, {afterWrite(){process.exit(0)}});`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", cwd: path.resolve(__dirname, "../.."), timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(path.join(f.root, "a.ts"), "utf8"), "agent a\n");
    assert.equal(readFileSync(path.join(f.root, "b.ts"), "utf8"), "original b\n");
    const recovery = listAgentIntegrationRecovery(f.root)[0]!;
    assert.equal(recovery.status, "applying");
    await assert.rejects(integrateAgentProposal(proposal, proposal.digest), /recovery|interrupted/);
    assert.throws(() => recoverSourceGate(f.root, "RECOVER SOURCE WRITES"), /recorded source transaction/);
    assert.equal((await recoverAgentIntegration(f.root, recovery.id, "RESTORE SOURCE")).status, "restored");
    assert.equal(sourceCoordinationState(f.root).status, "ready");
    assert.equal(readSourceManifest(f.root).digest, proposal.baselineDigest);
    assert.deepEqual(listAgentIntegrationRecovery(f.root), []);
  } finally { f.dispose(); }
});

test("publication epochs reject concurrent integration and expired async contexts cannot bypass ownership", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "before\n");
    const before = sourcePublicationEpoch(f.root);
    withSourceWriteSync(f.root, () => writeSourceChange(f.root, path.join(f.root, "a.ts"), "before\n", "after\n"));
    assert.throws(() => assertSourcePublicationEpoch(f.root, before), /discarded/);
    let late!: () => void, completed!: () => void, lateError: unknown;
    const finished = new Promise<void>(resolve => { completed = resolve; });
    await withSourceWrite(f.root, async () => {
      // The continuation inherits the original AsyncLocalStorage owner, but
      // executes after that owner's lease was released.
      void new Promise<void>(resolve => { late = resolve; }).then(() => {
        try { withSourceWriteSync(f.root, () => {}); } catch (error) { lateError = error; }
        completed();
      });
    });
    let release!: () => void;
    const active = withSourceWrite(f.root, () => new Promise<void>(resolve => { release = resolve; }));
    try { late(); await finished; assert.match(String(lateError), /source writer/); } finally { release(); await active; }
  } finally { f.dispose(); }
});

test("source symlink substitution after proposal capture is refused without writing outside checkout", async () => {
  const f = fixture();
  try {
    const proposal = await proposalFor(f), outside = path.join(f.base, "outside.ts");
    writeFileSync(outside, "protected outside\n");
    rmSync(path.join(f.root, "a.ts")); symlinkSync(outside, path.join(f.root, "a.ts"));
    await assert.rejects(integrateAgentProposal(proposal, proposal.digest), /Linked|source path|symbolic/i);
    assert.equal(readFileSync(outside, "utf8"), "protected outside\n");
  } finally { f.dispose(); }
});

test("source-consuming jobs cannot start a command inside an import and readers cannot upgrade to writers", async () => {
  const f = fixture(), jobs = new JobManager({ directory: path.join(f.root, ".cache/jobs"), emit() {} });
  try {
    f.write("a.ts", "original\n");
    let release!: () => void;
    const active = withSourceWrite(f.root, () => new Promise<void>(resolve => { release = resolve; }));
    let executed = false;
    try {
      const job = jobs.start({ kind: "framework-check", title: "fixture", params: {}, locks: [], sourceReservation: { root: f.root, mode: "read" }, steps: [{ label: "must not consume partial source", run: async () => { executed = true; } }] });
      assert.equal((await jobs.wait(job.id)).status, "failed");
      assert.equal(executed, false);
    } finally { release(); await active; }
    await withSourceRead(f.root, async () => {
      assert.throws(() => writeSourceChange(f.root, path.join(f.root, "a.ts"), "original\n", "invalid upgrade\n"), /cannot upgrade/);
      assert.doesNotThrow(() => sourcePublicationEpoch(f.root));
    });
    assert.equal(readFileSync(path.join(f.root, "a.ts"), "utf8"), "original\n");
  } finally { await jobs.dispose(); f.dispose(); }
});

test("a failed installed-candidate check restores the proposal before source publication", async () => {
  const f = fixture();
  try {
    const proposal = await proposalFor(f);
    const result = await integrateAgentProposal(proposal, proposal.digest, { afterInstall: async () => {
      assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
      throw new Error("installed candidate failed validation");
    } });
    assert.equal(result.status, "restored");
    assert.equal(readSourceManifest(f.root).digest, proposal.baselineDigest);
    assert.equal(agentIntegrationReceipt(f.root, proposal.digest)?.status, "restored");
    assert.equal(sourceCoordinationState(f.root).status, "ready");
  } finally { f.dispose(); }
});
