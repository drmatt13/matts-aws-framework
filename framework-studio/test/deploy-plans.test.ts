import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PlanStore } from "../server/deploy/plans";

/** Plan directories Studio cleans up, and the ones it must leave alone. */

const root = path.resolve(__dirname, "..", "..");

function store() {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const state = mkdtempSync(path.join(root, ".cache", "studio-plans-"));
  return { state, plans: new PlanStore(state) };
}

function aged(directory: string) {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(directory, old, old);
}

test("a plan directory a running job is still writing is never cleared away, however old", () => {
  const { state, plans } = store();
  try {
    const running = path.join(plans.directory, "my-aws-app-prod-running1");
    const abandoned = path.join(plans.directory, "my-aws-app-prod-abandon1");
    for (const directory of [running, abandoned]) { mkdirSync(path.join(directory, "assembly"), { recursive: true }); aged(directory); }
    plans.list((key) => key === "my-aws-app-prod-running1");
    assert.equal(existsSync(running), true, "still being written");
    assert.equal(existsSync(abandoned), false, "a failed synth an hour ago is litter");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("a plan that prepared change sets before stopping is kept and listed as unfinished", () => {
  const { state, plans } = store();
  try {
    const directory = path.join(plans.directory, "my-aws-app-prod-stopped1");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "preparing.json"), JSON.stringify({ version: 1, planId: "plan-x-abcdef", createdAt: "2026-10-17T12:00:00Z", identity: { deployment: "my-aws-app-prod", mode: "prod", account: "734849394764", region: "us-east-1" }, stacks: [] }));
    aged(directory);
    plans.removeUnfinished("my-aws-app-prod-stopped1");
    assert.deepEqual(plans.list().map((plan) => [plan.key, plan.status]), [["my-aws-app-prod-stopped1", "unfinished"]]);
    assert.equal(existsSync(directory), true);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
