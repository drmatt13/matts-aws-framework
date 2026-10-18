import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DeploymentInterrupt } from "../../scripts/deployment-interrupt";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { kills: string[]; kill(signal?: string): boolean };
  child.kills = [];
  child.kill = (signal = "SIGTERM") => { child.kills.push(signal); return true; };
  return child;
}
function harness() {
  const spawned: ReturnType<typeof fakeChild>[] = [];
  const exits: number[] = [];
  const interrupt = new DeploymentInterrupt({
    spawn: () => { const child = fakeChild(); spawned.push(child); return child as unknown as ChildProcess; },
    exit: (code) => { exits.push(code); },
    log: () => {},
  });
  return { interrupt, spawned, exits };
}

test("a step that exits cleanly resolves", async () => {
  const { interrupt, spawned } = harness();
  const step = interrupt.run("tool.js", [], ".");
  spawned[0]!.emit("exit", 0);
  await step;
});

test("an interrupt while no step is running stops the next step before it starts", async () => {
  const { interrupt, spawned } = harness();
  interrupt.handle("SIGINT");
  await assert.rejects(interrupt.run("cdk.js", ["deploy"], "."), /Deployment was interrupted/);
  assert.equal(spawned.length, 0);
  assert.throws(() => interrupt.assertContinuing(), /Deployment was interrupted/);
});

test("an interrupt during a step stops it and fails it as interrupted", async () => {
  const { interrupt, spawned } = harness();
  const step = interrupt.run("cdk.js", ["synth"], ".");
  interrupt.handle("SIGINT");
  assert.deepEqual(spawned[0]!.kills, ["SIGINT"]);
  spawned[0]!.emit("exit", 1);
  await assert.rejects(step, /Deployment was interrupted/);
});

test("a second interrupt kills the running step, cleans up and exits", () => {
  const { interrupt, spawned, exits } = harness();
  let cleaned = 0;
  interrupt.cleanups.add(() => { cleaned += 1; });
  void interrupt.run("cdk.js", ["deploy"], ".").catch(() => {});
  interrupt.handle("SIGINT");
  interrupt.handle("SIGINT");
  assert.deepEqual(spawned[0]!.kills, ["SIGINT", "SIGKILL"]);
  assert.equal(cleaned, 1);
  assert.deepEqual(exits, [130]);
});
