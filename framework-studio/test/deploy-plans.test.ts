import assert from "./support/assert";
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

test("live deployment journals remain active; stopped and unreadable outcomes stay visible for recovery", () => {
  const { state, plans } = store();
  const key = "my-aws-app-review1";
  const directory = plans.path(key);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "plan.json"), JSON.stringify({ planId: "plan-x-abcdef", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), status: "ready", review: "template", identity: { deployment: "my-aws-app", mode: "dev", account: "734849394764", region: "us-east-1" } }));
    const journal = path.join(directory, "operation.json");
    writeFileSync(journal, JSON.stringify({ pid: process.pid, stage: "applying infrastructure", secretUpdates: ["API_KEY"] }));
    assert.equal(new PlanStore(state).read(key)?.result, undefined, "another store must not mark the current process interrupted");
    writeFileSync(journal, JSON.stringify({ pid: 999_999_999, stage: "applying infrastructure", secretUpdates: ["API_KEY"] }));
    assert.equal(plans.read(key)?.result?.status, "interrupted");
    assert.deepEqual(plans.read(key)?.result?.secretUpdates, ["API_KEY"]);
    writeFileSync(journal, "broken");
    assert.equal(plans.read(key)?.result?.status, "unverified");
    writeFileSync(path.join(directory, "result.json"), "broken");
    assert.equal(plans.list()[0]?.applied, "unverified", "corrupt results must not hide an uncertain release from history");
  } finally { rmSync(state, { recursive: true, force: true }); }
});
