import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { clientEnvironment as defaults } from "../../framework-config/client-environment";
import { resolveClientEnvironmentMappings } from "../../scripts/client-environment-export";
import { defineResources, listResourceDeclarations, resource, type ResourceDeclarationInput } from "@repo/framework/config";
import { client, enableWebSocketApi } from "../../framework-config/resources/inputs";
import type { ClientEnvironmentBinding, ClientEnvironmentMappings } from "../../scripts/client-environment-mapping";
import type { DeploymentStack } from "../../scripts/resource-export";

function stack(name: string, mode: "dev" | "prod", outputs: Record<string, string> = {}): DeploymentStack {
  return { StackName: `example-${name}`, StackId: `arn:aws:cloudformation:eu-west-2:111122223333:stack/example-${name}/id`, StackStatus: "UPDATE_COMPLETE", Outputs: [
    { Description: "framework:deployment:v1", OutputValue: JSON.stringify({ version: 1, deployment: "example", mode, account: "111122223333", region: "eu-west-2" }) },
    ...Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
  ] };
}
function deployed(mode: "dev" | "prod"): DeploymentStack[] {
  return [stack("CognitoStack", mode, { UserPoolId: "eu-west-2_pool", UserPoolClientId: "client", UserPoolDomainUrl: "https://example.auth.eu-west-2.amazoncognito.com/" }),
    stack("FrontendWebsiteS3Stack", mode, { CloudFrontUrl: "https://example.cloudfront.net", FrontendWebsiteBucketName: "website", CloudFrontId: "distribution" }),
    ...(mode === "dev" ? [stack("DevLambdaReplayStack", mode, { ReplayBucketName: "replay", ReplayQueueUrl: "https://sqs.eu-west-2.amazonaws.com/111122223333/replay", ReplayQueueArn: "arn:aws:sqs:eu-west-2:111122223333:replay" })] : [])];
}
const ports = { ENABLE_WEBSOCKET_API: "true", LOCAL_API_DEV_SERVER_HOST_PORT: "8080", LOCAL_WS_DEV_SERVER_HOST_PORT: "8081", WS_TESTER_HOST_PORT: "3001", LOCAL_INVOCATION_RUNNER_HOST_PORT: "8090", POSTGRES_HOST_PORT: "5432", PGADMIN_HOST_PORT: "5050" };
const mappings = (binding: ClientEnvironmentBinding): ClientEnvironmentMappings => ({ VITE_CUSTOM: binding });
/** The application's own input declarations, plus any a test adds, resolved for one graph as the exporter receives them. */
const catalog = (mode: "dev" | "prod", entries: ResourceDeclarationInput = {}) => ({ declarations: listResourceDeclarations(defineResources({ enableWebSocketApi, client, ...entries }, { mode })) });

test("default client mappings preserve endpoint, identity and per-mode behavior", () => {
  const dev = resolveClientEnvironmentMappings(defaults, { deployment: "example", stacks: deployed("dev"), inputs: ports, ...catalog("dev") });
  assert.equal(dev.VITE_API_GATEWAY_URL, "http://localhost:8080");
  assert.equal(dev.VITE_LOCAL_WS_URL, "ws://localhost:8081");
  assert.equal(dev.VITE_WS_TESTER_URL, "http://localhost:3001");
  assert.equal(dev.VITE_API_GATEWAY_WS_URL, "");
  assert.equal(dev.VITE_AWS_REGION, "eu-west-2");
  assert.equal(dev.VITE_COGNITO_DOMAIN, "https://example.auth.eu-west-2.amazoncognito.com");
  // One local recipe serves both graphs; production declares none of its ports, so it is blank there.
  const prod = resolveClientEnvironmentMappings(defaults, { deployment: "example", stacks: deployed("prod"), inputs: { PROD_DEPLOYMENT: "true" }, ...catalog("prod") });
  assert.equal(prod.VITE_API_GATEWAY_URL, "https://example.cloudfront.net");
  assert.equal(prod.VITE_LOCAL_WS_URL, "");
  assert.equal(prod.VITE_WS_TESTER_URL, "");
  assert.deepEqual(Object.keys(dev), Object.keys(prod));
  assert.equal(resolveClientEnvironmentMappings(defaults, { deployment: "example", stacks: deployed("dev"), inputs: { ...ports, VITE_API_GATEWAY_URL: "https://app.example.com" }, ...catalog("dev") }).VITE_API_GATEWAY_URL, "https://app.example.com");
  assert.throws(() => resolveClientEnvironmentMappings(defaults, { deployment: "example", stacks: deployed("dev"), inputs: { ...ports, WS_TESTER_HOST_PORT: "" }, ...catalog("dev") }), /Set WS_TESTER_HOST_PORT/, "a required development port still stops the export");
});

test("custom references resolve inputs and defaults, fallbacks, regions, empty values and omitted fields", () => {
  const custom: ClientEnvironmentMappings = {
    VITE_INPUT: { dev: { kind: "input", name: "PUBLIC_SETTING" }, prod: { kind: "empty" } },
    VITE_DEFAULT: { dev: { kind: "input", name: "PUBLIC_DEFAULT" }, prod: { kind: "empty" } },
    VITE_OUTPUT: { dev: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolDomainCloudFrontEndpoint", "UserPoolId"] }, prod: { kind: "empty" } },
    VITE_REGION: { dev: { kind: "region", stack: "CognitoStack" }, prod: { kind: "empty" } },
    VITE_EMPTY: { kind: "empty" },
    VITE_OPTIONAL: { kind: "input", name: "UNSET" },
    VITE_ELSEWHERE: { kind: "input", name: "PRODUCTION_ONLY" },
  };
  const entries = (unset = resource.fromEnv("UNSET")) => ({ publicSetting: resource.fromEnv("PUBLIC_SETTING").required(), publicDefault: resource.fromEnv("PUBLIC_DEFAULT").default("fallback"), unset, productionOnly: resource.fromEnv("PRODUCTION_ONLY").only("prod") });
  const context = { deployment: "example", stacks: deployed("dev"), inputs: { PUBLIC_SETTING: "custom", PUBLIC_DEFAULT: " ", PRODUCTION_ONLY: "never read in development" } };
  const result = resolveClientEnvironmentMappings(custom, { ...context, ...catalog("dev", entries()) });
  assert.deepEqual(result, { VITE_INPUT: "custom", VITE_DEFAULT: "fallback", VITE_OUTPUT: "eu-west-2_pool", VITE_REGION: "eu-west-2", VITE_EMPTY: "", VITE_OPTIONAL: "", VITE_ELSEWHERE: "" }, "an optional input with nothing to read, or one outside this graph, is written blank");
  assert.throws(() => resolveClientEnvironmentMappings(custom, { ...context, ...catalog("dev", entries(resource.fromEnv("UNSET").required())) }), /Set UNSET in cdk-app\/\.env\.dev/);
  assert.equal(resolveClientEnvironmentMappings(custom, { ...context, ...catalog("dev", entries()), getContext: (key) => key === "publicSetting" ? "from-context" : undefined }).VITE_INPUT, "from-context", "persistent CDK context overrides the file, as it did during synthesis");
});

test("optional outputs are empty only for absent stacks; invalid inputs and private outputs fail without values in errors", () => {
  const context = { deployment: "example", stacks: deployed("dev"), inputs: {}, ...catalog("dev", { publicMissing: resource.fromEnv("PUBLIC_MISSING").required(), internal: resource.secret("INTERNAL_VALUE"), publicPort: resource.fromEnv("PUBLIC_PORT"), publicUrl: resource.fromEnv("PUBLIC_URL") }) };
  const optional = mappings({ kind: "output", stack: "WebSocketApiStack", outputs: ["WebSocketAPIEndpoint"], optional: true });
  assert.equal(resolveClientEnvironmentMappings(optional, context).VITE_CUSTOM, "");
  assert.throws(() => resolveClientEnvironmentMappings(optional, { ...context, stacks: [...context.stacks, stack("WebSocketApiStack", "dev")] }), /has no value/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "input", name: "PUBLIC_MISSING" }), context), /Set PUBLIC_MISSING/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "input", name: "INTERNAL_VALUE" }), { ...context, inputs: { INTERNAL_VALUE: "secret-sentinel" } }), (error: Error) => /Secret inputs/.test(error.message) && !error.message.includes("secret-sentinel"));
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "output", stack: "CognitoStack", outputs: ["SigningKey"] }), context), /public stack output/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "output", stack: "constructor", outputs: ["prototype"] }), context), /public stack output/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "endpoint", port: "PUBLIC_PORT", protocol: "http" }), { ...context, inputs: { PUBLIC_PORT: "99999" } }), /port between/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "endpoint", port: "PUBLIC_PORT", protocol: "http", override: "PUBLIC_URL" }), { ...context, inputs: { PUBLIC_PORT: "8080", PUBLIC_URL: "https://user:secret-sentinel@example.com" } }), (error: Error) => /without embedded credentials/.test(error.message) && !error.message.includes("secret-sentinel"));
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "empty" }), { ...context, inputs: { PROD_DEPLOYMENT: "true" } }), /must match the development deployment/);
});

test("export CLI reads saved custom mappings and the deployed mode's file, and preserves files on failure", () => {
  const root = path.resolve(__dirname, "../..");
  const cache = path.join(root, ".cache/client-environment-export-tests"); mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, "case-"));
  try {
    for (const directory of ["framework-config", "cdk-app", "client-app"]) mkdirSync(path.join(fixture, directory));
    const custom = mappings({ kind: "input", name: "ENABLE_WEBSOCKET_API" });
    writeFileSync(path.join(fixture, "framework.config.ts"), 'import { defineResources, resource } from "@repo/framework/config"; import { PROD_DEPLOYMENT } from "@repo/framework/config/source"; export default { resources: defineResources({ enableWebSocketApi: resource.fromEnv("ENABLE_WEBSOCKET_API").enum("true", "false").default("true"), localPort: PROD_DEPLOYMENT ? undefined : resource.fromEnv("LOCAL_WS_DEV_SERVER_HOST_PORT") }) };');
    writeFileSync(path.join(fixture, "framework-config/client-environment.ts"), `export const clientEnvironment = ${JSON.stringify(custom)} as const;`);
    writeFileSync(path.join(fixture, "cdk-app/.env.dev"), "PROD_DEPLOYMENT=false\nENABLE_WEBSOCKET_API=true\n");
    writeFileSync(path.join(fixture, "cdk-app/.env.prod"), "PROD_DEPLOYMENT=true\nENABLE_WEBSOCKET_API=false\n");
    const fake = path.join(fixture, "fake-aws.cjs");
    writeFileSync(fake, `process.stdout.write(${JSON.stringify(JSON.stringify({ Stacks: deployed("prod") }))});`);
    const env: NodeJS.ProcessEnv = { ...process.env, FRAMEWORK_AWS_CLI: fake };
    delete env.NODE_TEST_CONTEXT; delete env.FRAMEWORK_INPUTS_FILE; delete env.CDK_APP_NAME; delete env.AWS_REGION; delete env.AWS_DEFAULT_REGION;
    const run = () => spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/export-cdk-outputs.mjs"), "--deployment", "example", "--region", "eu-west-2"], { cwd: fixture, env, encoding: "utf8", timeout: 30_000 });
    const result = run(); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const destination = path.join(fixture, "client-app/.env.production.local");
    assert.equal(parseEnv(readFileSync(destination, "utf8")).VITE_CUSTOM, "false");
    const original = readFileSync(destination, "utf8");
    const outputFile = path.join(fixture, ".framework/prod/outputs.json");
    const originalOutputs = readFileSync(outputFile, "utf8");
    writeFileSync(path.join(fixture, "framework-config/client-environment.ts"), `export const clientEnvironment = ${JSON.stringify(mappings({ kind: "input", name: "LOCAL_WS_DEV_SERVER_HOST_PORT" }))} as const;`);
    const unavailable = run(); assert.ifError(unavailable.error); assert.equal(unavailable.status, 1); assert.match(unavailable.stderr, /Declare LOCAL_WS_DEV_SERVER_HOST_PORT/);
    assert.equal(readFileSync(destination, "utf8"), original);
    writeFileSync(path.join(fixture, "framework-config/client-environment.ts"), `export const clientEnvironment = ${JSON.stringify(custom)} as const;`);
    writeFileSync(path.join(fixture, "cdk-app/.env.prod"), "PROD_DEPLOYMENT=true\nENABLE_WEBSOCKET_API=invalid\n");
    const failed = run(); assert.ifError(failed.error); assert.equal(failed.status, 1); assert.match(failed.stderr, /declared choices/);
    assert.equal(readFileSync(destination, "utf8"), original);
    assert.equal(readFileSync(outputFile, "utf8"), originalOutputs);
  } finally { assert.ok(path.resolve(fixture).startsWith(cache + path.sep)); rmSync(fixture, { recursive: true }); }
});

test("client conditions resolve per environment, inherit defaults, and reject undeclared or secret parameters", () => {
  const context = { deployment: "example", stacks: deployed("dev"), inputs: { ...ports, ENABLE_WEBSOCKET_API: "false" }, ...catalog("dev", { internal: resource.secret("INTERNAL_VALUE") }) };
  assert.equal(resolveClientEnvironmentMappings(defaults, context).VITE_LOCAL_WS_URL, "");
  assert.equal(resolveClientEnvironmentMappings(defaults, { ...context, inputs: ports }).VITE_LOCAL_WS_URL, "ws://localhost:8081");
  assert.equal(resolveClientEnvironmentMappings(defaults, { ...context, inputs: { ...ports, ENABLE_WEBSOCKET_API: " TRUE " } }).VITE_LOCAL_WS_URL, "ws://localhost:8081", "input enums normalize like framework resource resolution");
  const { ENABLE_WEBSOCKET_API: _flag, ...missing } = ports;
  assert.equal(resolveClientEnvironmentMappings(defaults, { ...context, inputs: missing }).VITE_LOCAL_WS_URL, "ws://localhost:8081", "the declared default applies");
  const undefaulted = catalog("dev", { enableWebSocketApi: resource.fromEnv("ENABLE_WEBSOCKET_API").enum("true", "false") });
  assert.throws(() => resolveClientEnvironmentMappings(defaults, { ...context, inputs: missing, ...undefaulted }), /input parameter/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "input", name: "UNDECLARED" }), { ...context, inputs: { UNDECLARED: "hidden" } }), /Declare UNDECLARED/);
  assert.throws(() => resolveClientEnvironmentMappings(mappings({ kind: "empty", when: { input: "INTERNAL_VALUE", equals: "true" } }), context), /Secret inputs/);
});
