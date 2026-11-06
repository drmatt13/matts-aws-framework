import assert from "./support/assert";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { AGENT_MAX_COPY_BYTES, AGENT_MIN_FREE_BYTES, assertAgentStorageCapacity, assertWorkspaceBaseline, assertWorkspaceDependencies, freezeAgentProposal, loadAgentProposal, loadAgentWorkspace, prepareAgentWorkspace, readDependencyDigest, readProposalBlob, readSourceManifest } from "../server/agent-runtime/workspace";

function fixture() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-agent-workspace-"))), root = path.join(base, "project"), storageDirectory = path.join(base, "tasks");
  mkdirSync(root);
  const write = (name: string, contents: string | Buffer) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); return file; };
  return { base, root, storageDirectory, write, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

test("private copy admission keeps a free-space margin and refuses excessive allocation", () => {
  assertAgentStorageCapacity(1000, AGENT_MIN_FREE_BYTES + 1000);
  assert.throws(() => assertAgentStorageCapacity(1000, AGENT_MIN_FREE_BYTES + 999), /1 GiB/);
  assert.throws(() => assertAgentStorageCapacity(AGENT_MAX_COPY_BYTES + 1, Number.MAX_SAFE_INTEGER), /8 GiB/);
  assert.throws(() => assertAgentStorageCapacity(1000, Number.NaN), /could not be established/);
});

test("excessive sparse runtime input fails before copy and preserves original source and task evidence", async () => {
  const f = fixture();
  try {
    f.write("source.ts", "saved source\n");
    const file = f.write("node_modules/oversized/sparse.bin", ""); truncateSync(file, AGENT_MAX_COPY_BYTES + 1);
    await assert.rejects(prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, taskId: "disk-refused" }), /8 GiB/);
    assert.equal(readFileSync(path.join(f.root, "source.ts"), "utf8"), "saved source\n");
    assert.equal(existsSync(path.join(f.storageDirectory, "disk-refused/working")), true);
    assert.equal(existsSync(path.join(f.storageDirectory, "disk-refused/working/node_modules")), false);
  } finally { f.dispose(); }
});

test("special executable permission bits are refused instead of silently changing their meaning", { skip: process.platform === "win32" }, context => {
  const f = fixture();
  try {
    const file = f.write("special.txt", "not executable code\n"); chmodSync(file, 0o4644);
    if (!(statSync(file).mode & 0o7000)) { context.skip("This filesystem strips special permission bits."); return; }
    assert.throws(() => readSourceManifest(f.root), /Special source permission bits/);
  }
  finally { f.dispose(); }
});

test("workspace captures saved modified/untracked source and instructions without Git state, credentials or hooks", async () => {
  const f = fixture();
  try {
    f.write(".git/HEAD", "ref: refs/heads/user-branch\n");
    f.write("tracked.ts", "// saved edits beyond HEAD\n");
    f.write("untracked/new.ts", "export const value = 42;\n");
    f.write("ignored-but-required.txt", "not all ignored files are disposable\n");
    f.write(".agents/skills/example/SKILL.md", "source instructions\n");
    for (const file of [".env", "cdk-app/.env.prod", ".npmrc", ".aws/credentials", ".cache/private.json", ".framework/local/resources.json", ".claude/settings.json", ".claude/hooks/run.sh"]) f.write(file, "private data");
    f.write(".env.example", "PUBLIC_NAME=example\n");
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, taskId: "capture", copyDependencies: false });
    assert.deepEqual(Object.keys(workspace.baseline.files), [".agents/skills/example/SKILL.md", ".env.example", "ignored-but-required.txt", "tracked.ts", "untracked/new.ts"]);
    assert.equal(readFileSync(path.join(workspace.workingDirectory, "tracked.ts"), "utf8"), "// saved edits beyond HEAD\n");
    assert.equal(existsSync(path.join(workspace.workingDirectory, ".git")), false);
    assert.equal(readFileSync(path.join(f.root, ".git/HEAD"), "utf8"), "ref: refs/heads/user-branch\n");
    assert.deepEqual(loadAgentWorkspace(workspace.directory), workspace);
    assert.ok(workspace.storageEstimate!.requiredBytes > 0);
    assert.ok(workspace.storageEstimate!.availableBytes >= workspace.storageEstimate!.requiredBytes + AGENT_MIN_FREE_BYTES);
    assertWorkspaceBaseline(workspace);
    f.write("unrelated.ts", "new saved file\n");
    assert.throws(() => assertWorkspaceBaseline(workspace), /Saved project source changed/);
  } finally { f.dispose(); }
});

test("private dependencies rebase workspace and binary links; candidate writes never touch live dependencies", async () => {
  const f = fixture();
  try {
    f.write("packages/example/index.ts", "export const value = 'live';\n");
    f.write("node_modules/tool/bin/run.js", "console.log('tool');\n");
    mkdirSync(path.join(f.root, "node_modules/@repo"));
    symlinkSync("../../packages/example", path.join(f.root, "node_modules/@repo/example"), "dir");
    mkdirSync(path.join(f.root, "node_modules/.bin"));
    symlinkSync(path.join(f.root, "node_modules/tool/bin/run.js"), path.join(f.root, "node_modules/.bin/tool"), "file");
    f.write("packages/database/src/generated/contract.json", "{\"generated\":true}\n");
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory });
    const candidatePackage = path.join(workspace.workingDirectory, "packages/example/index.ts");
    assert.equal(realpathSync(path.join(workspace.workingDirectory, "node_modules/@repo/example")), path.dirname(candidatePackage));
    assert.equal(realpathSync(path.join(workspace.workingDirectory, "node_modules/.bin/tool")), path.join(workspace.workingDirectory, "node_modules/tool/bin/run.js"));
    writeFileSync(candidatePackage, "export const value = 'candidate';\n");
    writeFileSync(path.join(workspace.workingDirectory, "node_modules/tool/bin/run.js"), "changed\n");
    assert.equal(readFileSync(path.join(f.root, "packages/example/index.ts"), "utf8"), "export const value = 'live';\n");
    assert.equal(readFileSync(path.join(f.root, "node_modules/tool/bin/run.js"), "utf8"), "console.log('tool');\n");
    assert.equal(existsSync(path.join(workspace.workingDirectory, "packages/database/src/generated/contract.json")), true);
    assert.equal("packages/database/src/generated/contract.json" in workspace.baseline.files, false);
    await assert.rejects(assertWorkspaceDependencies(workspace), /changed installed dependency code/);
  } finally { f.dispose(); }
});

test("dependency validation ignores only known caches and generated database outputs", async () => {
  const f = fixture();
  try {
    f.write("node_modules/tool/index.js", "module.exports = 1;\n");
    f.write("packages/database/src/generated/contract.json", "{}\n");
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory });
    mkdirSync(path.join(workspace.workingDirectory, "node_modules/.cache/tool"), { recursive: true });
    writeFileSync(path.join(workspace.workingDirectory, "node_modules/.cache/tool/cache.json"), "cache");
    writeFileSync(path.join(workspace.workingDirectory, "packages/database/src/generated/contract.json"), "{\"generated\":true}\n");
    await assertWorkspaceDependencies(workspace);
    mkdirSync(path.join(workspace.workingDirectory, "node_modules/tool/.cache"));
    writeFileSync(path.join(workspace.workingDirectory, "node_modules/tool/.cache/runtime.js"), "module.exports = 2;\n");
    await assert.rejects(assertWorkspaceDependencies(workspace), /changed installed dependency code/);
  } finally { f.dispose(); }
});

test("bounded dependency hashing preserves persisted digest order, modes and large-file bytes", async () => {
  const f = fixture();
  try {
    const entries: unknown[] = [], digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    for (const [name, bytes] of [["node_modules/example/a/file.js", "nested"], ["node_modules/example/a.js", "sibling"], ["node_modules/example/large.bin", Buffer.alloc(2 * 1024 * 1024 + 1, 42)]] as const) {
      const file = f.write(name, bytes); entries.push([name, "file", digest(bytes), statSync(file).mode & 0o777]);
    }
    f.write("node_modules/.cache/ignored", "runtime cache");
    assert.equal(await readDependencyDigest(f.root), digest(JSON.stringify(entries)));
  } finally { f.dispose(); }
});

test("workspace metadata fails closed and special object-key filenames remain ordinary source", async () => {
  const f = fixture();
  try {
    f.write("__proto__", "ordinary filename\n");
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, copyDependencies: false });
    assert.equal(Object.hasOwn(workspace.baseline.files, "__proto__"), true);
    writeFileSync(path.join(workspace.workingDirectory, "toString"), "new file\n");
    const proposal = await freezeAgentProposal(workspace);
    assert.equal(proposal.changes[0]!.before, null);
    assert.deepEqual(loadAgentProposal(proposal.directory), proposal);
    writeFileSync(path.join(workspace.directory, "workspace.json"), JSON.stringify({ ...workspace, baseline: { ...workspace.baseline, files: { "../outside": workspace.baseline.files.__proto__ } } }));
    assert.throws(() => loadAgentWorkspace(workspace.directory), /invalid source path/);
    writeFileSync(path.join(workspace.directory, "workspace.json"), "null");
    assert.throws(() => loadAgentWorkspace(workspace.directory), /Invalid agent workspace/);
  } finally { f.dispose(); }
});

test("freeze retains exact add/modify/delete/binary/mode bytes independently of later agent edits", async () => {
  const f = fixture();
  try {
    f.write("modified.ts", "before\n"); f.write("deleted.ts", "delete me\n"); f.write("binary.png", Buffer.from([0, 255, 128])); f.write("run.sh", "echo test\n");
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, copyDependencies: false });
    writeFileSync(path.join(workspace.workingDirectory, "modified.ts"), "after\n");
    writeFileSync(path.join(workspace.workingDirectory, "new.ts"), "created\n");
    rmSync(path.join(workspace.workingDirectory, "deleted.ts"));
    writeFileSync(path.join(workspace.workingDirectory, "binary.png"), Buffer.from([0, 254, 129]));
    if (process.platform !== "win32") chmodSync(path.join(workspace.workingDirectory, "run.sh"), 0o755);
    const proposal = await freezeAgentProposal(workspace);
    assert.deepEqual(loadAgentProposal(proposal.directory), proposal);
    assert.equal(proposal.baselineDigest, workspace.baseline.digest);
    assert.notEqual(proposal.candidateDigest, proposal.baselineDigest);
    assert.equal(proposal.changes.find(change => change.path === "new.ts")!.before, null);
    assert.equal(proposal.changes.find(change => change.path === "deleted.ts")!.after, null);
    const binary = proposal.changes.find(change => change.path === "binary.png")!;
    assert.deepEqual(readProposalBlob(proposal, binary.before!.hash), Buffer.from([0, 255, 128]));
    assert.deepEqual(readProposalBlob(proposal, binary.after!.hash), Buffer.from([0, 254, 129]));
    const modified = proposal.changes.find(change => change.path === "modified.ts")!;
    writeFileSync(path.join(workspace.workingDirectory, "modified.ts"), "later unreviewed bytes\n");
    assert.equal(readProposalBlob(proposal, modified.after!.hash).toString(), "after\n");
    assert.equal(readProposalBlob(proposal, modified.before!.hash).toString(), "before\n");
    if (process.platform !== "win32") assert.equal(proposal.changes.find(change => change.path === "run.sh")!.after!.mode, 0o755);
    assertWorkspaceBaseline(workspace);
  } finally { f.dispose(); }
});

test("workspace refuses external dependency links, source links, hardlinks, occupied tasks and live storage", async () => {
  const f = fixture();
  try {
    f.write("source.ts", "source\n");
    await assert.rejects(prepareAgentWorkspace(f.root, { storageDirectory: path.join(f.root, ".cache/tasks") }), /outside the authoritative/);
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, taskId: "same", copyDependencies: false });
    await assert.rejects(prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, taskId: "same", copyDependencies: false }), /EEXIST/);
    symlinkSync(path.join(f.root, "source.ts"), path.join(f.root, "linked.ts"));
    assert.throws(() => readSourceManifest(f.root), /Linked or special/);
    rmSync(path.join(f.root, "linked.ts"));
    linkSync(path.join(f.root, "source.ts"), path.join(f.root, "hard.ts"));
    assert.throws(() => readSourceManifest(f.root), /Hard-linked source/);
    rmSync(path.join(f.root, "hard.ts"));
    mkdirSync(path.join(f.root, "node_modules"));
    const external = path.join(f.base, "external"); mkdirSync(external); writeFileSync(path.join(external, "secret"), "private");
    symlinkSync(external, path.join(f.root, "node_modules/external"), "dir");
    await assert.rejects(prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, taskId: "escape" }), /leaves the project/);
    assert.equal(existsSync(path.join(workspace.workingDirectory, "source.ts")), true);
  } finally { f.dispose(); }
});

test("proposal metadata and blob tampering invalidate review; private files cannot become changes", async () => {
  const f = fixture();
  try {
    f.write("source.ts", "original\n");
    const workspace = await prepareAgentWorkspace(f.root, { storageDirectory: f.storageDirectory, copyDependencies: false });
    writeFileSync(path.join(workspace.workingDirectory, "source.ts"), "proposal\n");
    writeFileSync(path.join(workspace.workingDirectory, ".env"), "SECRET=never-import\n");
    const proposal = await freezeAgentProposal(workspace), change = proposal.changes[0]!;
    assert.deepEqual(proposal.changes.map(change => change.path), ["source.ts"]);
    const blob = path.join(proposal.directory, "blobs", change.after!.hash);
    if (process.platform !== "win32") assert.equal(statSync(blob).mode & 0o777, 0o400);
    chmodSync(blob, 0o600); writeFileSync(blob, "tampered");
    assert.throws(() => readProposalBlob(proposal, change.after!.hash), /proposal blob changed/);
    assert.throws(() => loadAgentProposal(proposal.directory), /proposal blob changed/);
    const metadata = path.join(proposal.directory, "proposal.json"); chmodSync(metadata, 0o600);
    writeFileSync(metadata, JSON.stringify({ ...proposal, taskId: "different" }));
    assert.throws(() => loadAgentProposal(proposal.directory), /Invalid agent proposal/);
  } finally { f.dispose(); }
});
