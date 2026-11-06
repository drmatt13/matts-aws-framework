import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskStore } from "../server/agent-runtime/store";
import { agentEndpoint, callAgentHost, type AgentHostInfo } from "../server/agent-runtime/ipc";
import { pinAgentRuntime } from "../server/agent-runtime/runtime-release";
import { readAgentRuntimeRelease, releaseHash, type AgentRuntimeRelease } from "../server/agent-runtime/runtime-release-manifest";
import { AgentRuntimeUpgradeController, readAgentRuntimeUpgradeHistory, type RuntimeLaunchReceipt, type UpgradeHost } from "../server/agent-runtime/runtime-upgrade";
import { identityAlive } from "../server/operations/identity";

function hostLifecycle(root: string, state: string, children: ChildProcess[], stderr: string[]) {
  const socket = agentEndpoint(root, state);
  const inspect = async (): Promise<UpgradeHost | undefined> => {
    try {
      const info = await callAgentHost<AgentHostInfo>(socket, "/ping", undefined, 500);
      assert.equal(info.root, root); assert.equal(info.state, state); assert.ok(info.identity); assert.ok(info.releaseDigest);
      return { protocol: info.version, identity: info.identity, releaseDigest: info.releaseDigest };
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
  };
  const launch = async (release: AgentRuntimeRelease): Promise<RuntimeLaunchReceipt> => {
    const child = spawn(process.execPath, [release.entry, root, state, release.directory], { cwd: release.directory, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "ignore", "pipe"] });
    const index = children.length; children.push(child); stderr.push(""); child.stderr!.on("data", value => { stderr[index] += String(value); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) return { exited: true };
      const host = await inspect();
      if (host) { assert.equal(host.identity.pid, child.pid); return { identity: host.identity }; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Disposable host did not return identity: ${stderr[index]}`);
  };
  return { socket, inspect, launch };
}

function retainHostVariant(state: string, target: AgentRuntimeRelease, hostBytes: Buffer): AgentRuntimeRelease {
  const contents = Object.fromEntries(["host.cjs", "projector.cjs", "tether.mjs"].map(name => [name, name === "host.cjs" ? hostBytes : readFileSync(path.join(target.directory, name))]));
  const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, releaseHash(bytes)]));
  const digest = releaseHash(JSON.stringify({ version: 1, protocol: target.protocol, files })), directory = path.join(state, "releases", digest);
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(path.join(directory, name), bytes, { mode: 0o400 });
  writeFileSync(path.join(directory, "release.json"), JSON.stringify({ version: 1, protocol: target.protocol, files, digest }), { mode: 0o400 });
  return readAgentRuntimeRelease(directory);
}

test("private IPC upgrade drains the exact pinned host and retains review, approval and event records", async t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-upgrade-ipc-"))), root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root); writeFileSync(path.join(root, "package.json"), '{"name":"disposable-runtime-upgrade"}');
  writeFileSync(path.join(root, "source.ts"), "saved source remains unchanged\n");
  const children: ChildProcess[] = [], stderr: string[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGTERM"); await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await pinAgentRuntime(root, state);
  // A separately hashed private release forces a real handoff without editing
  // any repository source or running a native coding provider.
  const contents = Object.fromEntries(["host.cjs", "projector.cjs", "tether.mjs"].map(name => [name, Buffer.concat([readFileSync(path.join(target.directory, name)), name === "host.cjs" ? Buffer.from("\n// previous disposable release\n") : Buffer.alloc(0)])]));
  const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, releaseHash(bytes)]));
  const digest = releaseHash(JSON.stringify({ version: 1, protocol: target.protocol, files })), oldDirectory = path.join(state, "releases", digest);
  mkdirSync(oldDirectory, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(path.join(oldDirectory, name), bytes, { mode: 0o400 });
  writeFileSync(path.join(oldDirectory, "release.json"), JSON.stringify({ version: 1, protocol: target.protocol, files, digest }), { mode: 0o400 });
  const previous = readAgentRuntimeRelease(oldDirectory);
  const store = new AgentTaskStore(state, root);
  const seed = (key: string) => {
    const task = store.accept({ requestKey: key, provider: "codex", prompt: "Retained fixture task; no provider is invoked." });
    for (const status of ["preparing", "running", "validating", "awaiting_review"] as const) store.transition(task.id, status);
    return task.id;
  };
  const reviewId = seed("retained_review_task"), appliedId = seed("retained_applied_task"), proposalDigest = "a".repeat(64);
  store.patch(appliedId, {}, { proposalDigest }); store.approve(appliedId, proposalDigest); store.transition(appliedId, "completed");
  const eventsBefore = store.events(appliedId).events; store.close();
  const { socket, launch, inspect } = hostLifecycle(root, state, children, stderr);
  await launch(previous);
  let old: UpgradeHost | undefined;
  for (let attempt = 0; attempt < 100; attempt++) { old = await inspect(); if (old) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(old, `Disposable host did not start: ${stderr.join("\n")}`); assert.equal(old.releaseDigest, previous.digest);
  const controller = new AgentRuntimeUpgradeController(root, state, {
    pin: async () => ({ release: target, protocol: target.protocol }), inspect, launch,
    drain: async (host, intent) => { await callAgentHost(socket, "/runtime/drain", { requestId: intent.requestId, targetDigest: intent.targetDigest, expectedToken: host.identity.token }); },
  });
  const result = await controller.request(randomUUID());
  assert.equal(result.phase, "ready"); assert.equal(children.length, 2); assert.equal(identityAlive(old.identity), false);
  const ready = await inspect(); assert.equal(ready?.releaseDigest, target.digest); assert.equal(ready?.identity.pid, children[1]!.pid);
  const retained = new AgentTaskStore(state, root);
  try {
    assert.equal(retained.get(reviewId)?.view.status, "awaiting_review"); assert.equal(retained.get(appliedId)?.view.status, "completed");
    assert.equal(retained.approved(appliedId, proposalDigest), true); assert.deepEqual(retained.events(appliedId).events, eventsBefore);
  } finally { retained.close(); }
  assert.equal(readFileSync(path.join(root, "source.ts"), "utf8"), "saved source remains unchanged\n");
});

test("private IPC failed startup can explicitly select corrected pinned bytes without editing task state", async t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-upgrade-recovery-"))), root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root); writeFileSync(path.join(root, "package.json"), '{"name":"disposable-runtime-recovery"}');
  writeFileSync(path.join(root, "source.ts"), "retained dirty source\n");
  const children: ChildProcess[] = [], stderr: string[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGTERM"); await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const corrected = await pinAgentRuntime(root, state);
  const broken = retainHostVariant(state, corrected, Buffer.from("process.exit(23);\n"));
  const store = new AgentTaskStore(state, root);
  const task = store.accept({ requestKey: "retained_recovery_task", provider: "codex", prompt: "Retain this review without running any provider." });
  for (const status of ["preparing", "running", "validating", "awaiting_review"] as const) store.transition(task.id, status);
  const eventsBefore = store.events(task.id).events; store.close();
  const { socket, launch, inspect } = hostLifecycle(root, state, children, stderr);
  await launch(corrected); const previous = await inspect(); assert.ok(previous);
  const drain = async (host: UpgradeHost, intent: { requestId: string; targetDigest: string }) => {
    await callAgentHost(socket, "/runtime/drain", { requestId: intent.requestId, targetDigest: intent.targetDigest, expectedToken: host.identity.token });
  };
  const failedId = randomUUID(), correctedId = randomUUID();
  const failing = new AgentRuntimeUpgradeController(root, state, { pin: async () => ({ release: broken, protocol: broken.protocol }), inspect, launch, drain, attempts: 40, wait: async () => { await new Promise(resolve => setTimeout(resolve, 25)); } });
  await assert.rejects(failing.request(failedId), /did not become ready/);
  assert.equal(children[1]!.exitCode, 23); assert.equal(failing.status()?.phase, "failed");
  assert.equal(identityAlive(previous.identity), false); assert.equal(await inspect(), undefined);
  // A new observer recovers through the public API. It neither rewrites SQLite
  // nor repairs the failed pinned release or repository to accomplish recovery.
  let pins = 0;
  const recovery = new AgentRuntimeUpgradeController(root, state, { pin: async () => { pins++; return { release: corrected, protocol: corrected.protocol }; }, inspect, launch, drain });
  const ready = await recovery.replaceFailed(correctedId, failedId);
  assert.equal(ready.phase, "ready"); assert.equal(ready.replacesRequestId, failedId);
  assert.equal((await inspect())?.releaseDigest, corrected.digest); assert.equal(children.length, 3);
  assert.equal((await recovery.replaceFailed(correctedId, failedId)).phase, "ready"); assert.equal(pins, 1);
  await assert.rejects(recovery.request(failedId), /retained history/);
  const history = readAgentRuntimeUpgradeHistory(root, state);
  assert.equal(history.length, 1); assert.equal(history[0]?.targetDigest, broken.digest); assert.equal(history[0]?.phase, "failed");
  const retained = new AgentTaskStore(state, root);
  try { assert.equal(retained.get(task.id)?.view.status, "awaiting_review"); assert.deepEqual(retained.events(task.id).events, eventsBefore); }
  finally { retained.close(); }
  assert.equal(readFileSync(path.join(root, "source.ts"), "utf8"), "retained dirty source\n");
});
