import assert from "./support/assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AGENT_RUNTIME_VERSION } from "../shared/agent-runtime";
import { AgentRuntimeUpgradeController, pendingAgentRuntimeRelease, readAgentRuntimeUpgrade, readAgentRuntimeUpgradeHistory, type RuntimeUpgradeHooks, type UpgradeHost } from "../server/agent-runtime/runtime-upgrade";
import { readAgentRuntimeRelease, releaseHash } from "../server/agent-runtime/runtime-release-manifest";
import { AgentRuntimeError } from "../server/agent-runtime/store";

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-runtime-upgrade-"))), root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root); mkdirSync(state, { mode: 0o700 });
  const release = (label: string, protocol: number = AGENT_RUNTIME_VERSION) => {
    const contents = { "host.cjs": `// ${label}`, "projector.cjs": "// fixture projector", "tether.mjs": "// fixture tether" };
    const files = Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, releaseHash(text)]));
    const digest = releaseHash(JSON.stringify({ version: 1, protocol, files }));
    const target = path.join(state, "releases", digest); mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(contents)) writeFileSync(path.join(target, name), text, { mode: 0o400 });
    writeFileSync(path.join(target, "release.json"), JSON.stringify({ version: 1, protocol, files, digest }), { mode: 0o400 });
    return readAgentRuntimeRelease(target);
  };
  const previous = release("previous"), target = release("target");
  const old: UpgradeHost = { protocol: AGENT_RUNTIME_VERSION, releaseDigest: previous.digest, identity: { pid: 101, uid: 501, started: "first", token: "old-host" } };
  const next: UpgradeHost = { protocol: AGENT_RUNTIME_VERSION, releaseDigest: target.digest, identity: { pid: 102, uid: 501, started: "second", token: "new-host" } };
  let current: UpgradeHost | undefined = old, oldAlive = true, launches = 0, drains = 0, pins = 0, ownerId = 0;
  const hooks: RuntimeUpgradeHooks = {
    owner: () => ({ pid: 201, uid: 501, started: "observer", token: `observer-${++ownerId}` }),
    alive: identity => identity.token === old.identity.token ? oldAlive : identity.token === next.identity.token ? current === next : false,
    pin: async () => { pins++; return { release: target, protocol: target.protocol }; },
    inspect: async () => current,
    drain: async () => { drains++; current = undefined; oldAlive = false; },
    launch: async value => { launches++; assert.equal(value.digest, target.digest); current = next; return { identity: next.identity }; },
    wait: async () => {}, attempts: 3,
  };
  return { root, state, old, next, previous, target, release, hooks, get current() { return current; }, set current(value: UpgradeHost | undefined) { current = value; }, set oldAlive(value: boolean) { oldAlive = value; }, get launches() { return launches; }, get drains() { return drains; }, get pins() { return pins; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("explicit runtime upgrade pins before drain and duplicate requests launch one exact release", async () => {
  const f = fixture();
  try {
    const order: string[] = [], controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks,
      pin: async () => { order.push("pin"); return f.hooks.pin(); },
      drain: async (host, intent) => { assert.equal(readAgentRuntimeUpgrade(f.root, f.state)?.targetDigest, f.target.digest); order.push("drain"); return f.hooks.drain(host, intent); },
      launch: async release => { assert.equal(f.current, undefined); order.push("launch"); return f.hooks.launch(release); },
    });
    const first = controller.request("upgrade_request_1"), duplicate = controller.request("upgrade_request_1");
    assert.equal(first, duplicate); assert.equal((await first).phase, "ready");
    assert.deepEqual(order, ["pin", "drain", "launch"]); assert.equal(f.launches, 1);
    assert.equal((await controller.request("upgrade_request_1")).phase, "ready"); assert.equal(f.pins, 1);
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive), /previously launched agent host/);
  } finally { f.cleanup(); }
});

test("busy drain refusal retains the current host and retry keeps the fixed target", async () => {
  const f = fixture();
  try {
    let busy = true;
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, drain: async (host, intent) => { if (busy) throw new AgentRuntimeError(409, "Finish active provider work before upgrading."); return f.hooks.drain(host, intent); } });
    await assert.rejects(controller.request("upgrade_busy_1"), /active provider/);
    assert.equal(controller.status()?.phase, "failed"); assert.equal(f.current, f.old); assert.equal(f.launches, 0);
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive), /explicit retry/);
    await assert.rejects(controller.request("different_request"), /retained runtime upgrade/);
    busy = false; assert.equal((await controller.request("upgrade_busy_1")).phase, "ready"); assert.equal(f.pins, 1);
  } finally { f.cleanup(); }
});

test("pin failure and incompatible target protocol never drain the current host", async () => {
  const f = fixture();
  try {
    const broken = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, pin: async () => { throw new Error("source changed during pin"); } });
    await assert.rejects(broken.request("upgrade_broken_1"), /source changed/);
    assert.equal(broken.status(), undefined); assert.equal(f.drains, 0);
    const incompatible = f.release("incompatible", AGENT_RUNTIME_VERSION + 1);
    const mismatch = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, pin: async () => ({ release: incompatible, protocol: incompatible.protocol }) });
    await assert.rejects(mismatch.request("upgrade_protocol_1"), /protocol is incompatible/);
    assert.equal(mismatch.status(), undefined); assert.equal(f.drains, 0); assert.equal(f.current, f.old);
  } finally { f.cleanup(); }
});

test("unverifiable old host death prevents replacement and keeps task records", async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.state, "retained-proposal"), "review evidence");
    let drained = false;
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks,
      drain: async () => { drained = true; f.current = undefined; },
      alive: identity => identity.token === f.old.identity.token ? drained ? undefined : true : false,
    });
    await assert.rejects(controller.request("upgrade_unknown_1"), /cannot be reconciled/);
    assert.equal(f.launches, 0); assert.equal(controller.status()?.phase, "failed");
  } finally { f.cleanup(); }
});

test("failed replacement cannot silently select fresh source on normal reconnect", async () => {
  const f = fixture();
  try {
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => ({ exited: true }) });
    await assert.rejects(controller.request("upgrade_startup_1"), /did not become ready/);
    assert.equal(controller.status()?.targetDigest, f.target.digest);
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive), /explicit retry/);
    const retry = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, pin: async () => { throw new Error("must reuse pinned bytes"); } });
    assert.equal((await retry.request("upgrade_startup_1")).phase, "ready");
  } finally { f.cleanup(); }
});

test("interrupted observer reconnect selects only its recorded target after old identity is dead", async () => {
  const f = fixture();
  try {
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => ({ exited: true }) });
    await assert.rejects(controller.request("upgrade_interrupted_1"));
    const intent = controller.status()!;
    const db = new DatabaseSync(path.join(f.state, "tasks.sqlite"));
    db.prepare("UPDATE runtime_upgrade SET intent=?,owner=? WHERE singleton=1").run(JSON.stringify({ ...intent, phase: "starting" }), JSON.stringify({ pid: 301, uid: 501, started: "dead observer", token: "dead-observer" })); db.close();
    assert.equal(pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive)?.digest, f.target.digest);
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, () => undefined), /owned by another observer/);
    const retry = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, pin: async () => { throw new Error("must not recompile"); } });
    assert.equal((await retry.request("upgrade_interrupted_1")).phase, "ready");
  } finally { f.cleanup(); }
});

test("wrong replacement identity or release is never marked ready", async () => {
  const f = fixture();
  try {
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => { f.current = { ...f.next, releaseDigest: f.previous.digest }; return { identity: f.next.identity }; } });
    await assert.rejects(controller.request("upgrade_wrong_1"), /did not match/);
    assert.equal(controller.status()?.phase, "failed");
  } finally { f.cleanup(); }
});

test("explicit failed-target replacement archives the failure and binds all retries to the same pair", async () => {
  const f = fixture();
  try {
    const failedId = "upgrade_failed_source", replacementId = "upgrade_fixed_source";
    const failed = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => ({ exited: true }) });
    await assert.rejects(failed.request(failedId), /did not become ready/);
    const evidence = failed.status()!, fixed = f.release("corrected source");
    const host: UpgradeHost = { ...f.next, releaseDigest: fixed.digest, identity: { ...f.next.identity, token: "fixed-host" } };
    let pins = 0, launches = 0, failStartup = true;
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks,
      alive: identity => identity.token === host.identity.token ? f.current === host : f.hooks.alive!(identity),
      pin: async () => { pins++; return { release: fixed, protocol: fixed.protocol }; },
      launch: async release => { launches++; assert.equal(release.digest, fixed.digest); if (!failStartup) { f.current = host; return { identity: host.identity }; } return { exited: true }; },
    });
    const first = controller.replaceFailed(replacementId, failedId);
    assert.equal(first, controller.replaceFailed(replacementId, failedId));
    await assert.rejects(controller.replaceFailed(replacementId, "different_failed_id"), /different request payload/);
    await assert.rejects(first, /did not become ready/);
    assert.equal(controller.status()?.replacesRequestId, failedId);
    assert.deepEqual(readAgentRuntimeUpgradeHistory(f.root, f.state), [evidence]);
    await assert.rejects(controller.request(replacementId), /same runtime upgrade request/);
    await assert.rejects(controller.replaceFailed(replacementId, "different_failed_id"), /same runtime upgrade request/);
    failStartup = false;
    assert.equal((await controller.replaceFailed(replacementId, failedId)).phase, "ready");
    assert.equal((await controller.replaceFailed(replacementId, failedId)).phase, "ready");
    assert.equal(pins, 1); assert.equal(launches, 2);
    await assert.rejects(controller.request(failedId), /retained history/);
    assert.equal(pins, 1); assert.equal(controller.status()?.requestId, replacementId);
    assert.deepEqual(readAgentRuntimeUpgradeHistory(f.root, f.state), [evidence]);
  } finally { f.cleanup(); }
});

test("failed-target replacement pin failure preserves the original failed intent and history", async () => {
  const f = fixture();
  try {
    const failed = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => ({ exited: true }) });
    await assert.rejects(failed.request("upgrade_failed_pin"));
    const evidence = failed.status();
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, pin: async () => { throw new Error("corrected source changed during pin"); } });
    await assert.rejects(controller.replaceFailed("upgrade_retry_pin", "upgrade_failed_pin"), /source changed/);
    assert.deepEqual(controller.status(), evidence);
    assert.deepEqual(readAgentRuntimeUpgradeHistory(f.root, f.state), []);
    await assert.rejects(controller.replaceFailed("upgrade_retry_pin", "different_failed_id"), /inspected failed/);
  } finally { f.cleanup(); }
});

test("failed-target replacement can drain the still-running previous host after a busy refusal", async () => {
  const f = fixture();
  try {
    const failed = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, drain: async () => { throw new AgentRuntimeError(409, "Host is busy."); } });
    await assert.rejects(failed.request("upgrade_busy_failed"));
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, f.hooks);
    assert.equal((await controller.replaceFailed("upgrade_busy_fixed", "upgrade_busy_failed")).phase, "ready");
    assert.equal(f.drains, 1); assert.equal(f.launches, 1);
    assert.equal(readAgentRuntimeUpgradeHistory(f.root, f.state)[0]?.requestId, "upgrade_busy_failed");
  } finally { f.cleanup(); }
});

test("a late-ready failed target is reconciled and never silently replaced", async () => {
  for (const afterPin of [false, true]) {
    const f = fixture();
    try {
      const failed = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => ({ exited: true }) });
      await assert.rejects(failed.request("upgrade_late_failed"));
      if (!afterPin) f.current = f.next;
      let pins = 0;
      const fixed = f.release("newer fixed source");
      const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, pin: async () => { pins++; f.current = f.next; return { release: fixed, protocol: fixed.protocol }; } });
      await assert.rejects(controller.replaceFailed("upgrade_late_fixed", "upgrade_late_failed"), /failed target is now ready/);
      assert.equal(controller.status()?.requestId, "upgrade_late_failed"); assert.equal(controller.status()?.phase, "ready");
      assert.equal(controller.status()?.targetDigest, f.target.digest); assert.equal(f.current, f.next);
      assert.equal(pins, afterPin ? 1 : 0); assert.equal(f.launches, 0);
      assert.deepEqual(readAgentRuntimeUpgradeHistory(f.root, f.state), []);
    } finally { f.cleanup(); }
  }
});

test("an unresponsive retained host claim must be provably dead before failed-target replacement", async () => {
  const f = fixture();
  try {
    const failed = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => ({ exited: true }) });
    await assert.rejects(failed.request("upgrade_claim_failed"));
    const evidence = failed.status();
    const identity = { ...f.next.identity, token: "still-starting-host" };
    const db = new DatabaseSync(path.join(f.state, "tasks.sqlite"));
    db.prepare("INSERT INTO metadata(key,value) VALUES('host',?)").run(JSON.stringify(identity)); db.close();
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, alive: value => value.token === identity.token ? true : f.hooks.alive!(value) });
    await assert.rejects(controller.replaceFailed("upgrade_claim_fixed", "upgrade_claim_failed"), /retained agent host identity/);
    assert.deepEqual(controller.status(), evidence); assert.equal(f.pins, 1);
    assert.deepEqual(readAgentRuntimeUpgradeHistory(f.root, f.state), []);
  } finally { f.cleanup(); }
});

test("superseded ready upgrade identities remain historical and cannot pin new source on replay", async () => {
  const f = fixture();
  try {
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, f.hooks);
    await controller.request("upgrade_ready_first"); const first = controller.status()!;
    await controller.request("upgrade_ready_second");
    assert.deepEqual(readAgentRuntimeUpgradeHistory(f.root, f.state), [first]);
    await assert.rejects(controller.request("upgrade_ready_first"), /retained history/);
    assert.equal(f.pins, 2); assert.equal(f.launches, 1);
  } finally { f.cleanup(); }
});

test("an observer lost during spawn cannot create duplicate hosts on retry or replacement", async () => {
  const f = fixture();
  try {
    let launches = 0;
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks, launch: async () => { launches++; throw new Error("observer lost before child receipt"); } });
    await assert.rejects(controller.request("upgrade_spawn_unknown"), /observer lost/);
    assert.equal(controller.status()?.launchPending, true);
    const db = new DatabaseSync(path.join(f.state, "tasks.sqlite"));
    db.prepare("UPDATE runtime_upgrade SET intent=? WHERE singleton=1").run(JSON.stringify({ ...controller.status(), phase: "starting" })); db.close();
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive), /launch outcome is unknown/);
    await assert.rejects(controller.request("upgrade_spawn_unknown"), /launch outcome is unknown/);
    await assert.rejects(controller.replaceFailed("upgrade_spawn_replace", "upgrade_spawn_unknown"), /launch outcome is unknown/);
    assert.equal(launches, 1); assert.equal(f.pins, 1);
    // A matching, positively identified endpoint can reconcile the pending
    // outcome even when the observer died before saving its launch receipt.
    f.current = f.next;
    assert.equal((await controller.request("upgrade_spawn_unknown")).phase, "ready");
    assert.equal(controller.status()?.launchPending, undefined); assert.equal(launches, 1);
  } finally { f.cleanup(); }
});

test("recorded early-start identities block duplicate launch until death is proven", async () => {
  const f = fixture();
  try {
    let childAlive: boolean | undefined = true, launches = 0;
    const starting = { ...f.next.identity, token: "launcher-owned-token" };
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks,
      alive: identity => identity.token === starting.token ? childAlive : f.hooks.alive!(identity),
      launch: async () => { launches++; if (launches === 2) { f.current = f.next; childAlive = true; } return { identity: starting }; },
    });
    await assert.rejects(controller.request("upgrade_early_start"), /did not become ready/);
    assert.deepEqual(controller.status()?.launchedIdentity, starting);
    await assert.rejects(controller.request("upgrade_early_start"), /previously launched agent host/);
    await assert.rejects(controller.replaceFailed("upgrade_early_replace", "upgrade_early_start"), /previously launched agent host/);
    childAlive = undefined;
    await assert.rejects(controller.request("upgrade_early_start"), /previously launched agent host/);
    assert.equal(launches, 1);
    childAlive = false;
    assert.equal((await controller.request("upgrade_early_start")).phase, "ready");
    assert.equal(launches, 2); assert.equal(f.pins, 1);
  } finally { f.cleanup(); }
});

test("a matching release on a different process cannot satisfy a recorded launch", async () => {
  const f = fixture();
  try {
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks,
      launch: async () => { f.current = f.next; return { identity: { ...f.next.identity, pid: f.next.identity.pid + 1 } }; },
    });
    await assert.rejects(controller.request("upgrade_process_mismatch"), /recorded launched process/);
    assert.equal(controller.status()?.phase, "failed");
  } finally { f.cleanup(); }
});

test("ordinary restart selects the last activated bytes only after its host is provably dead", async () => {
  const f = fixture();
  try {
    assert.equal(pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive), undefined);
    const controller = new AgentRuntimeUpgradeController(f.root, f.state, f.hooks);
    await controller.request("upgrade_retained_ready");
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive), /previously launched agent host/);
    assert.throws(() => pendingAgentRuntimeRelease(f.root, f.state, () => undefined), /previous agent host/);
    f.current = undefined;
    const selected = pendingAgentRuntimeRelease(f.root, f.state, f.hooks.alive);
    assert.equal(selected?.digest, f.target.digest); assert.equal(f.pins, 1);
    const restarted: UpgradeHost = { ...f.next, identity: { ...f.next.identity, pid: 103, started: "third", token: "restarted-host" } };
    let launches = 0;
    const observer = new AgentRuntimeUpgradeController(f.root, f.state, { ...f.hooks,
      pin: async () => { throw new Error("ordinary restart cannot activate edited source"); },
      alive: identity => identity.token === restarted.identity.token ? f.current === restarted : f.hooks.alive!(identity),
      launch: async release => { assert.equal(release.digest, f.target.digest); launches++; f.current = restarted; return { identity: restarted.identity }; },
    });
    const ready = await observer.request("upgrade_retained_ready");
    assert.equal(ready.phase, "ready"); assert.deepEqual(ready.launchedIdentity, restarted.identity);
    assert.equal((await observer.request("upgrade_retained_ready")).phase, "ready"); assert.equal(launches, 1);
    assert.equal(controller.status()?.phase, "ready");
  } finally { f.cleanup(); }
});
