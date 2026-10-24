import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, defineResources, resource, deployInputsFrom, type DeployInputs, type FrameworkConfig } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { createFrameworkWorkloads } from "../lib/framework/framework-composition";
import { finalizeFrameworkResources, initializeFrameworkResources } from "../lib/framework/framework-resources";

const env = { account: "111122223333", region: "us-east-1" };
const cognitoEnvironment = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };

const framework: FrameworkConfig = defineFrameworkConfig({ networks: [fixtureVpc],
  defaults,
  http: [{ "/verify-session": { directory: "/lambda_functions/http_functions/verify-session", methods: ["GET"] } }],
  webSocket: [{
    $connect: {
      directory: "/lambda_functions/websocket_functions/ws-connect-route",
      authorizer: { directory: "/lambda_functions/websocket_functions/ws-authorizer", environment: cognitoEnvironment },
    },
    $default: { directory: "/lambda_functions/websocket_functions/ws-default-route", cloud: { manageConnections: true } },
  }],
  events: [],
  services: [],
} as never);

function devWorkloads(config: FrameworkConfig = framework, inputs?: DeployInputs) {
  const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config, mode: "dev", deployment: "example", readers: { env: {} } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const workloads = createFrameworkWorkloads(app, {
    env,
    stackId: (name) => `example-${name}`,
    config,
    cloud: { mode: "dev", inputs },
    cognito: { userPool, userPoolClient: userPool.addClient("Client") },
    readers: { env: {} },
    frontendUrls: [],
  });
  finalizeFrameworkResources(app);
  return workloads;
}

test("The framework always builds the WebSocket API and its handlers in a dev deployment, and nothing else routed", () => {
  const workloads = devWorkloads();
  assert.ok(workloads.webSocketApi && workloads.webSocketHandlers);
  assert.equal(workloads.httpHandlers, undefined);
  assert.equal(workloads.httpApi, undefined);

  for (const reference of ["lambda:ws-connect-route", "lambda:ws-authorizer", "lambda:ws-default-route"] as const) {
    assert.ok(workloads.targets.get(reference), `${reference} is built`);
  }
  assert.deepEqual(workloads.skippedTargets.conditionNotMet, []);
  assert.deepEqual(workloads.skippedTargets.notInThisDeployment, ["lambda:verify-session"]);

  const api = Template.fromStack(workloads.webSocketApi);
  api.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
  api.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
  // manageConnections is granted in a dev deployment too.
  api.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: [{ Action: "execute-api:ManageConnections", Effect: "Allow" }] },
  });
  assert.ok(Object.keys(api.findOutputs("WebSocketAPIEndpoint")).length === 1);
});

test("explicitly disabled WebSocket handlers build no gateway or orphan authorizer", () => {
  const config = defineFrameworkConfig({ ...framework, webSocket: [{
    $connect: { ...framework.webSocket.$connect, deploy: "none", authorizer: { ...framework.webSocket.$connect.authorizer!, deploy: "none" } },
    $default: { ...framework.webSocket.$default, deploy: "none" },
  }] } as never);
  const workloads = devWorkloads(config);
  assert.equal(workloads.webSocketApi, undefined);
  assert.equal(workloads.webSocketHandlers, undefined);
  assert.equal(workloads.skippedTargets.disabled.length, 3);
});

test("a condition removes the WebSocket route, handler and connection-management permission together", () => {
  const resources = defineResources({ realtime: resource.fromEnv("REALTIME").enum("enabled", "disabled") });
  const config = defineFrameworkConfig({ ...framework, resources, webSocket: [{
    $connect: framework.webSocket.$connect,
    $default: { ...framework.webSocket.$default, deploy: { when: { resource: resources.realtime, equals: "enabled" } } },
  }] } as never);
  const workloads = devWorkloads(config, deployInputsFrom({ env: { REALTIME: "disabled" } }));
  assert.ok(workloads.webSocketApi && workloads.webSocketHandlers);
  assert.equal(workloads.targets.get("lambda:ws-default-route"), undefined);
  assert.deepEqual(workloads.skippedTargets.conditionNotMet, ["lambda:ws-default-route"]);
  Template.fromStack(workloads.webSocketApi).resourceCountIs("AWS::ApiGatewayV2::Route", 1);
  Template.fromStack(workloads.webSocketApi).resourceCountIs("AWS::IAM::Policy", 0);
});

test("an enabled authorizer without an enabled route creates no orphan Lambda or API", () => {
  const config = defineFrameworkConfig({ ...framework, webSocket: [{
    $connect: { ...framework.webSocket.$connect, deploy: "none" },
    $default: { ...framework.webSocket.$default, deploy: "none" },
  }] } as never);
  const workloads = devWorkloads(config);
  assert.equal(workloads.webSocketApi, undefined);
  assert.equal(workloads.webSocketHandlers, undefined);
  assert.ok(workloads.skippedTargets.notInThisDeployment.includes("lambda:ws-authorizer"));
});
