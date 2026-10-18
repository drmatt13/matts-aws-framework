import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "node:util";
import { collectProductionOutputs, renderProductionClientFile } from "../../scripts/production-export";
import { type DeploymentStack } from "../../scripts/resource-export";

function stack(suffix: string, values: Record<string, string>, mode = "prod"): DeploymentStack {
  return {
    StackName: `example-${suffix}`,
    StackId: `arn:aws:cloudformation:eu-west-2:111122223333:stack/example-${suffix}/id`,
    StackStatus: "UPDATE_COMPLETE",
    Outputs: [
      { Description: "framework:deployment:v1", OutputValue: JSON.stringify({ version: 1, deployment: "example", mode, account: "111122223333", region: "eu-west-2" }) },
      ...Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    ],
  };
}
function deployed() {
  return [
    stack("CognitoStack", { UserPoolId: "eu-west-2_pool", UserPoolClientId: "client", UserPoolDomainUrl: "https://example.auth.eu-west-2.amazoncognito.com", SecretArn: "never-export-this" }),
    stack("FrontendWebsiteS3Stack", { FrontendWebsiteBucketName: "website-bucket", CloudFrontUrl: "https://example.cloudfront.net", CloudFrontId: "distribution", CloudFrontDomainName: "example.cloudfront.net" }),
    stack("RdsStack", { Password: "never-export-this", RdsDatabaseEndpoint: "private-db" }),
  ];
}

test("production export supplies only public settings and clears development-only endpoints", () => {
  const result = collectProductionOutputs(deployed(), "example");
  assert.equal(result.document.mode, "prod");
  assert.equal(result.client.VITE_COGNITO_DOMAIN, "https://example.auth.eu-west-2.amazoncognito.com");
  assert.equal(result.client.VITE_AWS_REGION, "eu-west-2");
  // CloudFront serves /api on the local server's paths; the HTTP API does not.
  assert.equal(result.client.VITE_API_GATEWAY_URL, "https://example.cloudfront.net");
  assert.equal(result.client.VITE_LOCAL_WS_URL, "");
  assert.equal(result.client.VITE_API_GATEWAY_WS_URL, "");
  assert.equal(result.client.VITE_WS_TESTER_URL, "");
  assert.doesNotMatch(JSON.stringify(result), /never-export-this|private-db/);
  const websocket = collectProductionOutputs([...deployed(), stack("WebSocketApiStack", { WebSocketAPIEndpoint: "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod" })], "example");
  assert.equal(websocket.document.outputs.WEBSOCKET_API_URL, "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod");
  assert.equal(websocket.client.VITE_API_GATEWAY_WS_URL, "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod");
  assert.equal(websocket.client.VITE_LOCAL_WS_URL, "");
  assert.equal(websocket.client.VITE_WS_TESTER_URL, "");
});

test("production export writes the settings Vite reads for a build, and nothing else", () => {
  const websocket = stack("WebSocketApiStack", { WebSocketAPIEndpoint: "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod" });
  const rendered = renderProductionClientFile(collectProductionOutputs([...deployed(), websocket], "example"));
  assert.match(rendered, /from the production deployment example/);
  assert.match(rendered, /vite build/);
  assert.deepEqual([...rendered.matchAll(/^([A-Z_]+)=/gm)].map(match => match[1]), [
    "VITE_API_GATEWAY_URL", "VITE_LOCAL_WS_URL", "VITE_API_GATEWAY_WS_URL", "VITE_WS_TESTER_URL",
    "VITE_AWS_REGION", "VITE_USER_POOL_ID", "VITE_USER_POOL_CLIENT_ID", "VITE_COGNITO_DOMAIN",
  ]);
  const values = parseEnv(rendered);
  assert.equal(values.VITE_USER_POOL_ID, "eu-west-2_pool");
  assert.equal(values.VITE_API_GATEWAY_WS_URL, "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod");
  assert.equal(values.VITE_LOCAL_WS_URL, "");
});

test("production export refuses incomplete, mismatched, or unfinished deployments", () => {
  assert.throws(() => collectProductionOutputs(deployed().slice(0, 1), "example"), /Required production output/);
  assert.throws(() => collectProductionOutputs([stack("CognitoStack", {}, "dev")], "example"), /requires a production/);
  assert.throws(() => collectProductionOutputs([...deployed(), stack("OtherStack", {}, "dev")], "example"), /disagree/);
  const pending = deployed(); pending[0] = { ...pending[0], StackStatus: "UPDATE_IN_PROGRESS" };
  assert.throws(() => collectProductionOutputs(pending, "example"), /completed deployment/);
  assert.throws(() => collectProductionOutputs([...deployed(), stack("WebSocketApiStack", {})], "example"), /no endpoint/);
});

