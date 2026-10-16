import assert from "node:assert/strict";
import { test } from "node:test";
import type { Lanes } from "../shared/model";
import { DEPLOYMENT_BADGES, deploymentBadge, deploymentSettingLabel, deploymentSummary, environments } from "../src/deployment";

function lanes(local: boolean, dev: boolean, prod: boolean): Lanes {
  return { deploy: "both", origin: "default", cloud: prod, local, dev, prod };
}

test("local development and AWS production form two enabled environments without a badge", () => {
  const actual = lanes(true, false, true);
  assert.deepEqual(environments(actual), { dev: true, prod: true });
  assert.equal(deploymentBadge(actual), undefined);
  assert.equal(deploymentSummary(actual), "Runs in development and production.");
});

test("AWS-invoked workloads and WebSocket handlers also stay unmarked when available in both", () => {
  assert.equal(deploymentBadge(lanes(false, true, true)), undefined);
  assert.equal(deploymentBadge(lanes(true, true, true)), undefined);
});

test("exception badges use actual environment availability, including disabled AWS WebSocket APIs", () => {
  assert.equal(deploymentBadge(lanes(false, false, true)), "prod");
  assert.equal(deploymentBadge(lanes(true, false, false)), "dev");
  assert.equal(deploymentBadge({ ...lanes(true, false, false), cloud: true }), "dev", "AWS intent does not override actual absence");
  assert.equal(deploymentBadge(lanes(false, true, false)), "dev");
  assert.equal(deploymentBadge(lanes(false, false, false)), "off");
  assert.deepEqual(Object.keys(DEPLOYMENT_BADGES), ["dev", "prod", "off"], "execution location is never a third deployment badge");
  assert.equal(deploymentSettingLabel("local-only"), "Dev only");
  assert.equal(deploymentSettingLabel("cloud-only"), "Prod only");
  assert.equal(deploymentSettingLabel("cloud-only", true), "Dev + Prod (AWS execution)", "WebSocket AWS handlers serve both deployment graphs");
  assert.equal(deploymentSettingLabel("both", false), "Dev only", "a disabled AWS WebSocket API leaves development execution only");
  assert.equal(deploymentSettingLabel("cloud-only", false), "Off (API disabled)");
});
