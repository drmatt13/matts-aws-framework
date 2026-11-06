import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskClient } from "../server/agent-runtime/client";
import { agentEndpoint, callAgentHost, type AgentHostInfo } from "../server/agent-runtime/ipc";
import { readAgentRuntimeUpgrade } from "../server/agent-runtime/runtime-upgrade";
import { identityAlive } from "../server/operations/identity";

test("client starts an owned host and recovers a stopped ready host from its retained release", async t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-client-startup-")));
  const root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root); writeFileSync(path.join(root, "package.json"), '{"name":"disposable-client-startup"}');
  writeFileSync(path.join(root, "saved.ts"), "export const saved = true;\n");
  const client = new AgentTaskClient(root, state), endpoint = agentEndpoint(root, state);
  async function stop(info: AgentHostInfo): Promise<void> {
    assert.ok(info.identity); assert.ok(info.releaseDigest);
    await callAgentHost(endpoint, "/runtime/drain", { requestId: randomUUID(), targetDigest: info.releaseDigest, expectedToken: info.identity.token });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (identityAlive(info.identity) === false) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("The exact owned fixture host did not finish its drain.");
  }
  t.after(async () => {
    client.close();
    try { await stop(await callAgentHost<AgentHostInfo>(endpoint, "/ping", undefined, 500)); }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await client.ping();
  assert.ok(first.identity); assert.ok(first.releaseDigest); assert.equal(first.root, root);
  const requestId = randomUUID();
  assert.equal((await client.restartHost(requestId)).phase, "ready");
  await stop(first);
  // A changed checkout must not select a new runtime during ordinary reconnect.
  mkdirSync(path.join(root, "framework-studio/server/agent-runtime"), { recursive: true });
  writeFileSync(path.join(root, "framework-studio/server/agent-runtime/host.ts"), 'throw new Error("not explicitly activated");\n');
  const recovered = await client.ping();
  assert.notEqual(recovered.pid, first.pid); assert.equal(recovered.releaseDigest, first.releaseDigest);
  const retained = readAgentRuntimeUpgrade(root, state);
  assert.equal(retained?.requestId, requestId); assert.equal(retained?.phase, "ready");
  assert.equal(retained?.launchedIdentity?.pid, recovered.pid); assert.equal(retained?.launchPending, undefined);
  assert.equal(readFileSync(path.join(root, "saved.ts"), "utf8"), "export const saved = true;\n");
  assert.deepEqual(await client.list(), { tasks: [] });
});
