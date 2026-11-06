import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pinAgentRuntime } from "../server/agent-runtime/runtime-release";
import { readAgentRuntimeRelease } from "../server/agent-runtime/runtime-release-manifest";
import { agentEndpoint, callAgentHost, type AgentHostInfo } from "../server/agent-runtime/ipc";

test("pinned host starts with no source loader/dependencies and refuses a modified release", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-pinned-runtime-")), root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), '{"name":"disposable"}');
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child!.once("close", resolve)); child.kill("SIGTERM"); await done; }
    rmSync(directory, { recursive: true, force: true });
  });
  const release = await pinAgentRuntime(root, state);
  assert.equal(readAgentRuntimeRelease(release.directory).digest, release.digest);
  assert.ok(!release.directory.startsWith(root + path.sep));
  // This source could now be replaced by an approved self-edit. The host must
  // execute its captured bundle, not consult a checkout loader at startup.
  mkdirSync(path.join(root, "framework-studio/server/agent-runtime"), { recursive: true });
  writeFileSync(path.join(root, "framework-studio/server/agent-runtime/host.ts"), 'throw new Error("changed live host");');
  child = spawn(process.execPath, [release.entry, root, state, release.directory], { cwd: directory, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
  let info: AgentHostInfo | undefined;
  for (let i = 0; i < 100; i++) {
    try { info = await callAgentHost<AgentHostInfo>(agentEndpoint(root, state), "/ping", undefined, 200); break; } catch { /* Wait only for this owned fixture. */ }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(info, `Pinned host failed: ${stderr}`); assert.equal(info.pid, child.pid);
  assert.deepEqual(await callAgentHost(agentEndpoint(root, state), "/tasks"), { tasks: [] });
  const closed = new Promise(resolve => child!.once("close", resolve)); child.kill("SIGTERM"); await closed;
  chmodSync(release.projector.file, 0o600); writeFileSync(release.projector.file, `${readFileSync(release.projector.file, "utf8")}\n// tampered`);
  assert.throws(() => readAgentRuntimeRelease(release.directory), /bytes changed/);
});
