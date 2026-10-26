import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "./support/assert";
import { test } from "node:test";
import { defineFrameworkConfig, getFrameworkTargets, deployLanes, DEPLOY_SETTINGS, type FrameworkConfig } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { targetLanes } from "../server/model/project";
import type { Lanes } from "../shared/model";
import { DEPLOYMENT_BADGES, deploymentBadge, deploymentSettingLabel, deploymentSummary, environments, previewDeploymentLanes } from "../src/deployment";

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
  assert.equal(deploymentSettingLabel("cloud-only", { dev: true, prod: true }), "Dev + Prod", "WebSocket AWS handlers serve both deployment graphs");
  assert.equal(deploymentSettingLabel("both", { local: true, dev: false, prod: false }), "Dev only", "local execution is available without an AWS deployment");
  assert.equal(deploymentSettingLabel("cloud-only", { dev: false, prod: false }), "Off");
  assert.equal(deploymentSettingLabel("cloud-only", { dev: false, prod: true }), "Prod only");
  assert.equal(deploymentSettingLabel("cloud-only", { dev: true, prod: false }), "Dev only");
  assert.equal(deploymentSettingLabel("both", { dev: true, prod: false }), "Dev only");
});

test("deployment draft previews match the framework projection for every setting and role", () => {
  for (const setting of ["both", "local-only", "cloud-only", "none"] as const) {
    const config = defineFrameworkConfig({ networks: [fixtureVpc], defaults,
      http: [{ "/preview": { directory: "/lambda_functions/http_functions/preview", methods: ["POST"], deploy: setting } }],
      webSocket: [{ "$connect": { directory: "/lambda_functions/websocket_functions/preview-connect", deploy: setting } }],
      events: [], services: [],
    }) as unknown as FrameworkConfig;
    for (const target of getFrameworkTargets(config)) {
      const actual = targetLanes(config, target, { mode: "dev" });
      const preview = previewDeploymentLanes({ role: target.role, lanes: lanes(false, false, false) }, setting, Object.fromEntries(DEPLOY_SETTINGS.map(setting => [setting, deployLanes(target.role, setting)])));
      for (const key of ["local", "cloud", "dev", "prod"] as const) assert.equal(preview[key], actual[key], `${target.role} ${setting}: ${key}`);
    }
  }
});
