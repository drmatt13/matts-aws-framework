import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "node:util";
import { CLIENT_SECTION_HEADING, clientEnvironment, renderGeneratedBlock } from "../../scripts/environment-export";
import { localClientEndpoints, localExportValues } from "../../scripts/local-export";
import { collectProductionOutputs } from "../../scripts/production-export";
import { type DeploymentStack } from "../../scripts/resource-export";

const ports = {
  LOCAL_API_DEV_SERVER_HOST_PORT: "8080",
  LOCAL_WS_DEV_SERVER_HOST_PORT: "8081",
  LOCAL_INVOCATION_RUNNER_HOST_PORT: "8090",
  WS_TESTER_HOST_PORT: "3001",
  POSTGRES_HOST_PORT: "5432",
  PGADMIN_HOST_PORT: "5050",
};
const cognito = {
  region: "us-east-1",
  userPoolId: "us-east-1_pool",
  userPoolClientId: "client",
  cognitoDomainUrl: "https://example.auth.us-east-1.amazoncognito.com",
};
function devClient(authored: Record<string, string>, apiGatewayWebSocketUrl = "") {
  const values = localExportValues({ ...ports, ...authored }, { repositoryRoot: process.cwd() });
  return clientEnvironment({ ...cognito, ...localClientEndpoints({ ...ports, ...authored }, values), apiGatewayWebSocketUrl });
}

test("development client endpoints follow the authored host ports and what the deployment holds", () => {
  // Compose runs local-ws-dev-server whatever DEPLOY_PROD_WEBSOCKET_API says; the
  // flag only decides whether AWS holds a WebSocket API, which export reads.
  for (const flag of [{}, { DEPLOY_PROD_WEBSOCKET_API: "false" }, { DEPLOY_PROD_WEBSOCKET_API: "true" }] as Record<string, string>[]) {
    const client = devClient(flag);
    assert.equal(client.VITE_LOCAL_WS_URL, "ws://localhost:8081", JSON.stringify(flag));
    assert.equal(client.VITE_API_GATEWAY_WS_URL, "", JSON.stringify(flag));
    assert.equal(client.VITE_WS_TESTER_URL, "http://localhost:3001");
  }
  const both = devClient({ LOCAL_WS_DEV_SERVER_HOST_PORT: "9081", WS_TESTER_HOST_PORT: "4001" }, "wss://abc.execute-api.us-east-1.amazonaws.com/prod");
  assert.equal(both.VITE_LOCAL_WS_URL, "ws://localhost:9081");
  assert.equal(both.VITE_API_GATEWAY_WS_URL, "wss://abc.execute-api.us-east-1.amazonaws.com/prod");
  assert.equal(both.VITE_WS_TESTER_URL, "http://localhost:4001");
  assert.equal(both.VITE_API_GATEWAY_URL, "http://localhost:8080");
  assert.equal(devClient({ VITE_API_GATEWAY_URL: "http://192.168.1.5:8080" }).VITE_API_GATEWAY_URL, "http://192.168.1.5:8080");
  assert.equal(localExportValues(ports, { repositoryRoot: process.cwd() }).has("VITE_API_GATEWAY_URL"), false, "the proxy target belongs to the client-app block only");
});

test("development and production write the same client-app names in the same order", () => {
  const stack = (suffix: string, values: Record<string, string>): DeploymentStack => ({
    StackName: `example-${suffix}`,
    StackId: `arn:aws:cloudformation:us-east-1:111122223333:stack/example-${suffix}/id`,
    StackStatus: "UPDATE_COMPLETE",
    Outputs: [
      { Description: "framework:deployment:v1", OutputValue: JSON.stringify({ version: 1, deployment: "example", mode: "prod", account: "111122223333", region: "us-east-1" }) },
      ...Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    ],
  });
  const production = collectProductionOutputs([
    stack("CognitoStack", { UserPoolId: "pool", UserPoolClientId: "client", UserPoolDomainUrl: cognito.cognitoDomainUrl }),
    stack("FrontendWebsiteS3Stack", { FrontendWebsiteBucketName: "bucket", CloudFrontUrl: "https://example.cloudfront.net", CloudFrontId: "distribution" }),
  ], "example");
  assert.deepEqual(Object.keys(devClient({})), Object.keys(production.client));
});

test("generated blocks omit empty sections, keep empty values, quote literals, and refuse a name twice", () => {
  const { block, names } = renderGeneratedBlock(["Header line."], [
    { heading: "Absent", values: { NOT_DEPLOYED: undefined } },
    { heading: "Controls", values: { LOCAL_BROWSER_ORIGINS: "http://localhost:3000,http://localhost:3001", PRICE: "$5" } },
    { heading: CLIENT_SECTION_HEADING, values: { VITE_WS_TESTER_URL: "" } },
  ]);
  assert.deepEqual(names, ["LOCAL_BROWSER_ORIGINS", "PRICE", "VITE_WS_TESTER_URL"]);
  assert.doesNotMatch(block, /Absent|NOT_DEPLOYED/);
  assert.match(block, /^# BEGIN GENERATED CDK OUTPUTS\n# Header line\.\n\n# Controls\n/);
  assert.match(block, /\n\n# Client app: copy this block into client-app\/\.env\nVITE_WS_TESTER_URL=\n# END GENERATED CDK OUTPUTS\n$/);
  assert.equal(parseEnv(block).LOCAL_BROWSER_ORIGINS, "http://localhost:3000,http://localhost:3001");
  assert.match(block, /^PRICE="\\\$5"$/m);
  assert.throws(() => renderGeneratedBlock([], [
    { heading: "One", values: { VITE_API_GATEWAY_URL: "http://localhost:8080" } },
    { heading: "Two", values: { VITE_API_GATEWAY_URL: "http://localhost:8080" } },
  ]), /VITE_API_GATEWAY_URL is exported twice/);
});

test("client settings are validated before anything is written", () => {
  const endpoints = { apiUrl: "http://localhost:8080", localWebSocketUrl: "", apiGatewayWebSocketUrl: "", webSocketTesterUrl: "" };
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, cognitoDomainUrl: "http://example.com" }), /HTTPS origin/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, localWebSocketUrl: "http://localhost:8081" }), /VITE_LOCAL_WS_URL must use ws: or wss:/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, apiGatewayWebSocketUrl: "https://example.com" }), /VITE_API_GATEWAY_WS_URL must use ws: or wss:/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, apiUrl: "localhost:8080" }), /VITE_API_GATEWAY_URL must use http: or https:/);
  assert.equal(clientEnvironment({ ...cognito, ...endpoints, cognitoDomainUrl: "https://auth.example.com/" }).VITE_COGNITO_DOMAIN, "https://auth.example.com");
});
