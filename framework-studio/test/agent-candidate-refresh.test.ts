import assert from "./support/assert";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { freezeAgentProposal, prepareAgentWorkspace } from "../server/agent-runtime/workspace";
import { refreshAgentCandidate } from "../server/agent-runtime/rebase";
import { AgentTaskService } from "../server/agent-runtime/service";
import { integrateAgentProposal } from "../server/agent-runtime/integration";

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-candidate-refresh-")), root = path.join(directory, "project"); mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  writeFileSync(path.join(root, "source.txt"), source);
  return { directory, root, source };
}

test("three-way refresh preserves separate developer edits in the same file and requires a new proposal identity", async t => {
  const f = fixture(t), workspace = await prepareAgentWorkspace(f.root, { storageDirectory: path.join(f.directory, "work"), copyDependencies: false });
  writeFileSync(path.join(workspace.workingDirectory, "source.txt"), f.source.replace("line 2\n", "agent change\n"));
  const proposal = await freezeAgentProposal(workspace);
  writeFileSync(path.join(f.root, "source.txt"), f.source.replace("line 18\n", "developer change\n"));
  const refreshed = await refreshAgentCandidate(workspace, proposal, path.join(f.directory, "refresh"), false);
  assert.deepEqual(refreshed.conflicts, []);
  const merged = readFileSync(path.join(refreshed.workspace.workingDirectory, "source.txt"), "utf8");
  assert.match(merged, /agent change/); assert.match(merged, /developer change/);
  assert.doesNotMatch(readFileSync(path.join(f.root, "source.txt"), "utf8"), /agent change/);
  const next = await freezeAgentProposal(refreshed.workspace);
  assert.notEqual(next.digest, proposal.digest); assert.notEqual(next.baselineDigest, proposal.baselineDigest);
});

test("overlapping edits and concurrent new paths stay conflicted without touching saved source", async t => {
  const f = fixture(t), workspace = await prepareAgentWorkspace(f.root, { storageDirectory: path.join(f.directory, "work"), copyDependencies: false });
  writeFileSync(path.join(workspace.workingDirectory, "source.txt"), "agent replacement\n");
  writeFileSync(path.join(workspace.workingDirectory, "new.txt"), "agent creation\n");
  const proposal = await freezeAgentProposal(workspace);
  writeFileSync(path.join(f.root, "source.txt"), "user replacement\n"); writeFileSync(path.join(f.root, "new.txt"), "user creation\n");
  const refreshed = await refreshAgentCandidate(workspace, proposal, path.join(f.directory, "refresh"), false);
  assert.deepEqual(refreshed.conflicts.map(conflict => conflict.path), ["new.txt", "source.txt"]);
  assert.equal(readFileSync(path.join(f.root, "source.txt"), "utf8"), "user replacement\n");
  assert.equal(readFileSync(path.join(f.root, "new.txt"), "utf8"), "user creation\n");
});

test("task refresh renews validation and rejects approval for the old candidate", async t => {
  const f = fixture(t); writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: { test: "fixture" } }));
  let validations = 0;
  const service = new AgentTaskService(f.root, path.join(f.directory, "state"), { copyDependencies: false,
    runProvider: async options => { writeFileSync(path.join(options.cwd, "source.txt"), f.source.replace("line 2\n", "agent change\n")); return { status: "completed" }; },
    validate: async () => { validations++; return { exitCode: 0 }; },
    integrate: async (_workspace, proposal, digest) => integrateAgentProposal(proposal, digest),
  });
  t.after(() => service.close()); service.start();
  const task = service.submit({ provider: "codex", requestKey: "refresh-fixture", prompt: "Change the first section." });
  const review = async () => {
    for (let i = 0; i < 100; i++) { if (service.get(task.id).status === "awaiting_review") return service.proposal(task.id); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(service.get(task.id).summary);
  };
  const before = await review();
  writeFileSync(path.join(f.root, "source.txt"), f.source.replace("line 18\n", "developer change\n"));
  await assert.rejects(service.approve(task.id, before.digest), /changed/);
  assert.equal(service.refresh(task.id, before.digest).status, "validating");
  const after = await review();
  assert.equal(validations, 2); assert.notEqual(after.digest, before.digest);
  await assert.rejects(service.approve(task.id, before.digest), /current proposal/);
  assert.equal((await service.approve(task.id, after.digest)).status, "integrating");
  for (let i = 0; i < 100 && service.get(task.id).status === "integrating"; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.get(task.id).sourceOutcome, "applied");
  assert.match(readFileSync(path.join(f.root, "source.txt"), "utf8"), /agent change/);
  assert.match(readFileSync(path.join(f.root, "source.txt"), "utf8"), /developer change/);
});
