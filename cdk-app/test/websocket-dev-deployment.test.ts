import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, type FrameworkConfig } from "@repo/framework/config";
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

function devWorkloads(deployWebSocketApi: boolean) {
  const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config: framework, mode: "dev", deployment: "example", readers: { env: {} } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const workloads = createFrameworkWorkloads(app, {
    env,
    stackId: (name) => `example-${name}`,
    config: framework,
    cloud: { mode: "dev" },
    cognito: { userPool, userPoolClient: userPool.addClient("Client") },
    readers: { env: {} },
    frontendUrls: [],
    deployWebSocketApi,
  });
  finalizeFrameworkResources(app);
  return workloads;
}

test("DEPLOY_PROD_WEBSOCKET_API builds the WebSocket API and its handlers in a dev deployment, and nothing else routed", () => {
  const workloads = devWorkloads(true);
  assert.ok(workloads.webSocketApi && workloads.webSocketHandlers);
  assert.equal(workloads.httpHandlers, undefined);
  assert.equal(workloads.httpApi, undefined);

  for (const reference of ["lambda:ws-connect-route", "lambda:ws-authorizer", "lambda:ws-default-route"] as const) {
    assert.ok(workloads.targets.get(reference), `${reference} is built`);
  }
  assert.deepEqual(workloads.skippedTargets.withoutWebSocketApi, []);
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

test("without it, a dev deployment builds neither, and says why", () => {
  const workloads = devWorkloads(false);
  assert.equal(workloads.webSocketApi, undefined);
  assert.equal(workloads.webSocketHandlers, undefined);
  assert.deepEqual(
    [...workloads.skippedTargets.withoutWebSocketApi].sort(),
    ["lambda:ws-authorizer", "lambda:ws-connect-route", "lambda:ws-default-route"],
  );
  assert.deepEqual(workloads.skippedTargets.notInThisDeployment, ["lambda:verify-session"]);
});
