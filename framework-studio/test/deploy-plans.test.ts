import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PlanStore } from "../server/deploy/plans";
import { buildOperation, type OperationContext } from "../server/deploy/registry";

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

function synthesisStore() {
  const { state } = store();
  const checkout = path.join(state, "checkout");
  mkdirSync(path.join(checkout, "cdk-app/lambda_functions/event_functions/example"), { recursive: true });
  writeFileSync(path.join(checkout, "framework.config.ts"), "export default {};\n");
  writeFileSync(path.join(checkout, "cdk-app/.env.dev"), "PRIVATE_INPUT=fixture-private-input\n");
  const handler = path.join(checkout, "cdk-app/lambda_functions/event_functions/example/index.ts");
  writeFileSync(handler, "export const handler = () => 1;\n");
  const config = path.join(state, "aws-config"), credentials = path.join(state, "aws-credentials");
  writeFileSync(config, "[profile dev]\nregion=us-east-1\n");
  writeFileSync(credentials, "[dev]\naws_access_key_id=fixture-private-credential\n");
  const env = { ...process.env, AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials };
  const plans = new PlanStore(state, checkout, env);
  const key = "my-aws-app-current1";
  const before = () => plans.captureSynthesis("dev", "dev");
  const save = () => {
    mkdirSync(plans.path(key), { recursive: true });
    writeFileSync(path.join(plans.path(key), "plan.json"), JSON.stringify({
      planId: "plan-current-abcdef", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "ready", review: "template", profile: "dev", target: { inputsFile: path.join(checkout, "cdk-app/.env.dev") },
      identity: { deployment: "my-aws-app-dev", mode: "dev", account: "734849394764", region: "us-east-1" },
    }));
  };
  return { state, checkout, plans, key, before, save, handler, credentials, env };
}

test("reusable synthesis covers handler bytes, private inputs and connection changes without exposing fingerprints", () => {
  const f = synthesisStore();
  try {
    const before = f.before(); f.save(); f.plans.recordSynthesis(f.key, before);
    assert.deepEqual(f.plans.read(f.key)?.synthesis, { current: true });
    assert.deepEqual(f.plans.list()[0]?.synthesis, { current: true });
    const original = "export const handler = () => 1;\n";
    writeFileSync(f.handler, "export const handler = () => 2;\n");
    assert.equal(f.plans.read(f.key)?.synthesis?.current, false, "implementation changes matter even without a declaration graph change");
    writeFileSync(f.handler, original);
    assert.equal(f.plans.read(f.key)?.synthesis?.current, true);
    writeFileSync(path.join(f.checkout, "cdk-app/.env.dev"), "PRIVATE_INPUT=changed-private-input\n");
    assert.equal(f.plans.read(f.key)?.synthesis?.current, false);
    writeFileSync(path.join(f.checkout, "cdk-app/.env.dev"), "PRIVATE_INPUT=fixture-private-input\n");
    writeFileSync(f.credentials, "[dev]\naws_access_key_id=changed-private-credential\n");
    assert.equal(f.plans.read(f.key)?.synthesis?.current, false);
    const publicEvidence = JSON.stringify({ plan: f.plans.read(f.key), summaries: f.plans.list() });
    assert.doesNotMatch(publicEvidence, /fingerprint|fixture-private-input|fixture-private-credential|changed-private/);
  } finally { rmSync(f.state, { recursive: true, force: true }); }
});

test("sources changed during synthesis never produce a reusable assembly, even after source is restored", () => {
  const f = synthesisStore();
  try {
    const before = f.before();
    writeFileSync(f.handler, "export const handler = () => 2;\n");
    f.save(); f.plans.recordSynthesis(f.key, before);
    assert.match(f.plans.read(f.key)?.synthesis?.reason ?? "", /during synthesis/);
    writeFileSync(f.handler, "export const handler = () => 1;\n");
    assert.equal(f.plans.read(f.key)?.synthesis?.current, false);
  } finally { rmSync(f.state, { recursive: true, force: true }); }
});

test("synthesis freshness follows the host's explicit inputs override", () => {
  const f = synthesisStore();
  try {
    const inputs = path.join(f.state, "explicit-inputs.env");
    writeFileSync(inputs, "PRIVATE_INPUT=explicit-private-input\n");
    const plans = new PlanStore(f.state, f.checkout, { ...f.env, FRAMEWORK_INPUTS_FILE: inputs });
    const before = plans.captureSynthesis("dev", "dev");
    f.save(); plans.recordSynthesis(f.key, before);
    assert.equal(plans.read(f.key)?.synthesis?.current, true);
    writeFileSync(inputs, "PRIVATE_INPUT=changed-explicit-input\n");
    assert.equal(plans.read(f.key)?.synthesis?.current, false);
  } finally { rmSync(f.state, { recursive: true, force: true }); }
});

test("normal deployment rejects stale synthesis while explicit saved-assembly recovery stays available", async () => {
  const f = synthesisStore();
  try {
    const before = f.before(); f.save(); f.plans.recordSynthesis(f.key, before);
    const context = { plans: f.plans, env: f.env, profiles: async () => [{ name: "dev" }], jobs: { holder: () => undefined }, probeDocker: async () => ({ engine: "stopped" }), local: { assertStopped: async () => {} } } as unknown as OperationContext;
    const request = { kind: "deploy-apply" as const, params: { plan: f.key, profile: "dev", currentSource: true } };
    assert.equal((await buildOperation(context, request)).params.currentSource, true);
    writeFileSync(f.handler, "export const handler = () => 2;\n");
    await assert.rejects(buildOperation(context, request), /sources or connection changed/);
    assert.equal((await buildOperation(context, { ...request, params: { plan: f.key, profile: "dev" } })).kind, "deploy-apply");
    assert.equal(existsSync(path.join(f.plans.path(f.key), "operation.json")), false, "refusal performs no deployment attempt");
  } finally { rmSync(f.state, { recursive: true, force: true }); }
});
