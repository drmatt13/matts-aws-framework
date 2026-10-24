import assert from "node:assert/strict";
import { test } from "node:test";
import { createTargetAvailability, defineFrameworkConfig, getCloudTargets, getFrameworkTargets, invokeLambda, sequence, workflow, type DeployToken, type TargetRole } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { applicationVpc } from "../../framework-config/networks/application";
import { projectModel } from "../server/model/project";

const settings = ["both", "local-only", "cloud-only", "none"] as const;
const roles: readonly TargetRole[] = ["http", "webSocket", "webSocketAuthorizer", "event", "service", "task", "workflow", "agent", "tool"];
function fixture() {
  return defineFrameworkConfig({
    defaults, networks: [applicationVpc],
    http: [Object.fromEntries(settings.map((deploy, index) => [`/matrix-${index}`, { directory: `/test/fixtures/matrix-http-${index}`, methods: ["GET"], deploy }]))],
    webSocket: [{
      $connect: { directory: "/test/fixtures/matrix-connect", authorizer: { directory: "/test/fixtures/matrix-authorizer", environment: { USER_POOL_ID: "fixture-pool", USER_POOL_CLIENT_ID: "fixture-client" } } },
      ...Object.fromEntries(settings.map((deploy, index) => [`matrix${index}`, { directory: `/test/fixtures/matrix-ws-${index}`, deploy }])),
    }],
    events: [{ "matrix-event": { directory: "/test/fixtures/matrix-event" } }],
    services: [Object.fromEntries(settings.map((deploy, index) => [`/matrix-service-${index}`, { directory: `/test/fixtures/matrix-service-${index}`, methods: ["GET"], deploy, cloud: { vpc: applicationVpc } }]))],
    tasks: [Object.fromEntries(settings.map((deploy, index) => [`matrix-task-${index}`, { directory: `/test/fixtures/matrix-task-${index}`, deploy, cloud: { vpc: applicationVpc } }]))],
    workflows: [Object.fromEntries(settings.map((deploy, index) => [`matrix-workflow-${index}`, workflow(() => sequence(invokeLambda("matrix-event")), { deploy, timeoutSeconds: 60 })]))],
    tools: [{ shared: {}, "local-tool": {}, "cloud-tool": {}, "none-tool": {}, unused: {} }],
    agents: [Object.fromEntries(settings.map((deploy, index) => [`matrix-agent-${index}`, { deploy, tools: ["shared", ...([[], ["local-tool"], ["cloud-tool"], ["none-tool"]][index]!)] }]))],
  } as never);
}

test("operation availability preserves every role, deploy token and WebSocket graph mode", () => {
  const config = fixture(), targets = getFrameworkTargets(config), availability = createTargetAvailability(config);
  assert.deepEqual([...new Set(targets.map(target => target.role))].sort(), [...roles].sort());
  const local = (deploy: unknown) => deploy === "both" || deploy === "local-only";
  const cloud = (deploy: unknown) => deploy === "both" || deploy === "cloud-only";
  const ws = (role: string) => role === "webSocket" || role === "webSocketAuthorizer";
  for (const mode of ["dev", "prod"] as const) {
    const model = projectModel(config, { mode });
    assert.equal(model.status, "ok", JSON.stringify(model.diagnostics));
    const deployed = (target: typeof targets[number]) => cloud(target.deploy) && (mode === "prod" || target.role === "event" || ws(target.role));
    assert.deepEqual(getCloudTargets(config, roles, mode, {}).map(target => target.reference), targets.filter(deployed).map(target => target.reference));
    for (const target of targets) {
      const lanes = model.targets.find(item => item.ref === target.reference)!.lanes;
      assert.equal(availability.enabled(target.kind, target.id, "local"), local(target.deploy), target.reference);
      assert.equal(availability.enabled(target.kind, target.id, "cloud"), cloud(target.deploy), target.reference);
      assert.equal(availability.deployed(target.kind, target.id, mode, {}), deployed(target), target.reference);
      assert.deepEqual([lanes.local, lanes.cloud, lanes.dev, lanes.prod], [local(target.deploy), cloud(target.deploy), cloud(target.deploy) && (target.role === "event" || ws(target.role)), cloud(target.deploy)], target.reference);
    }
  }
  for (const [id, deploy] of [["shared", "both"], ["local-tool", "local-only"], ["cloud-tool", "cloud-only"], ["none-tool", "none"], ["unused", "none"]])
    assert.equal(targets.find(target => target.reference === `lambda:${id}`)!.deploy, deploy);
  assert.equal(availability.enabled("lambda", "missing", "local"), true);
  assert.equal(availability.enabled("lambda", "missing", "cloud"), true);
  assert.equal(availability.deployed("lambda", "missing", "dev"), false);
  assert.equal(availability.deployed("lambda", "missing", "prod"), true);
});
