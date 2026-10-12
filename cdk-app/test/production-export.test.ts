import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv } from "node:util";
import { CLIENT_SECTION_HEADING } from "../../scripts/environment-export";
import { collectProductionOutputs, renderProductionEnvironment } from "../../scripts/production-export";
import { replaceGeneratedEnvironment } from "../../scripts/local-export";
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

test("production export groups outputs into sections and ends with the client-app block", () => {
  const websocket = stack("WebSocketApiStack", { WebSocketAPIEndpoint: "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod" });
  const rendered = renderProductionEnvironment(collectProductionOutputs([...deployed(), websocket], "example"));
  const headings = [...rendered.matchAll(/^# (?!BEGIN|END|Generated|The same)(.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings, ["Deployment", "Cognito / OAuth", "Frontend / CloudFront", "APIs", CLIENT_SECTION_HEADING]);
  const client = rendered.slice(rendered.indexOf(`# ${CLIENT_SECTION_HEADING}`), rendered.indexOf("# END GENERATED CDK OUTPUTS"));
  assert.deepEqual([...client.matchAll(/^([A-Z_]+)=/gm)].map(match => match[1]), [
    "VITE_API_GATEWAY_URL", "VITE_LOCAL_WS_URL", "VITE_API_GATEWAY_WS_URL", "VITE_WS_TESTER_URL",
    "VITE_AWS_REGION", "VITE_USER_POOL_ID", "VITE_USER_POOL_CLIENT_ID", "VITE_COGNITO_DOMAIN",
  ]);
  assert.equal(rendered.match(/^VITE_/gm)?.length, 8, "every VITE_ name is written once, in the client-app block");
  assert.equal(parseEnv(rendered).WEBSOCKET_API_URL, "wss://websocket.execute-api.eu-west-2.amazonaws.com/prod");
});

test("production export refuses incomplete, mismatched, or unfinished deployments", () => {
  assert.throws(() => collectProductionOutputs(deployed().slice(0, 1), "example"), /Required production output/);
  assert.throws(() => collectProductionOutputs([stack("CognitoStack", {}, "dev")], "example"), /requires a production/);
  assert.throws(() => collectProductionOutputs([...deployed(), stack("OtherStack", {}, "dev")], "example"), /disagree/);
  const pending = deployed(); pending[0] = { ...pending[0], StackStatus: "UPDATE_IN_PROGRESS" };
  assert.throws(() => collectProductionOutputs(pending, "example"), /completed deployment/);
  assert.throws(() => collectProductionOutputs([...deployed(), stack("WebSocketApiStack", {})], "example"), /no endpoint/);
});

test("root production export replaces the managed dev block and preserves unrelated assignments", () => {
  const result = collectProductionOutputs(deployed(), "example");
  const devBlock = "# BEGIN GENERATED CDK OUTPUTS\nLOCAL_API_DEV_SERVER_HOST_PORT=8080\nUSER_POOL_ID=dev-pool\n# END GENERATED CDK OUTPUTS\n";
  const rendered = renderProductionEnvironment(result, "CUSTOM_SETTING=keep\n" + devBlock);
  const values = parseEnv(rendered);
  assert.equal(values.CUSTOM_SETTING, "keep");
  assert.equal(values.USER_POOL_ID, "eu-west-2_pool");
  assert.equal(values.VITE_USER_POOL_ID, "eu-west-2_pool");
  assert.equal(values.VITE_API_GATEWAY_URL, "https://example.cloudfront.net");
  assert.equal(values.FRONTEND_WEBSITE_BUCKET_NAME, "website-bucket");
  assert.equal(values.VITE_WS_TESTER_URL, "");
  assert.equal(values.LOCAL_API_DEV_SERVER_HOST_PORT, undefined);
  assert.equal(renderProductionEnvironment(result, rendered), rendered);
  assert.throws(() => renderProductionEnvironment(result, "VITE_USER_POOL_ID=authored\n"), /authored keys/);
  const restored = parseEnv(replaceGeneratedEnvironment(rendered, devBlock, ["LOCAL_API_DEV_SERVER_HOST_PORT", "USER_POOL_ID"]));
  assert.equal(restored.CUSTOM_SETTING, "keep");
  assert.equal(restored.USER_POOL_ID, "dev-pool");
  assert.equal(restored.VITE_USER_POOL_ID, undefined);
});
