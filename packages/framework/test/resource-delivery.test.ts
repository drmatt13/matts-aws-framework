import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import { defineFrameworkConfig, defineNetwork, defineResources, resource, resourceAttributeKey, parseResourceManifest, getFrameworkTargets, type FrameworkConfig, type ResourceManifest } from "../src/config";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { invokeLocalNodeLambda } from "../src/local/lambda-process";
import { defaults } from "../../../framework-config/defaults";

interface VaultStack { readonly linked: { readonly secretArn: string; grantRead(...args: never[]): unknown } }
const resources = defineResources({ one: resource.cdk<IQueue>(), two: resource.cdk<IQueue>(), input: resource.fromEnv().default("default-value"), key: resource.secret(), vault: resource.stack<VaultStack>() });
const identity = { version: 1, mode: "dev", deployment: "example", account: "111122223333", region: "eu-west-2" } as const;
const manifest: ResourceManifest = { ...identity, attributes: {
  [resourceAttributeKey(resources.one.queueUrl)]: "queue-one",
  [resourceAttributeKey(resources.two.queueUrl)]: "queue-two",
  [resourceAttributeKey(resources.vault.linked.value)]: "arn:aws:secretsmanager:eu-west-2:111122223333:secret:linked-AbCdEf",
}, integrations: {} };
function config(): FrameworkConfig {
  const environment = { RESOURCE: resources.one.queueUrl, INPUT: resources.input };
  // The app's defaults put containers in private subnets, which need the NAT gateway.
  return defineFrameworkConfig({ resources, defaults, network: defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: true }),
    http: [{ "/one": { directory: "/lambda_functions/http_functions/one", methods: ["POST"], auth: true, environment }, "/two": { directory: "/lambda_functions/http_functions/two", methods: ["POST"], auth: true, environment: { RESOURCE: resources.two.queueUrl } } }],
    webSocket: [{ $default: { directory: "/lambda_functions/websocket_functions/socket", environment } }],
    services: [{ "/service/*": { directory: "/ecs_containers/services/service", methods: "*", auth: true, port: 5000, environment, secrets: { API_KEY: resources.key, PASSWORD: resources.vault.linked.field("password") } } }],
    events: [{ event: { directory: "/lambda_functions/event_functions/event", environment } }],
    tasks: [{ task: { directory: "/ecs_containers/tasks/task", environment } }], workflows: [],
  } as never);
}

test("native references serialize deterministically without construct/runtime values", () => {
  assert.equal(JSON.stringify(resources.one.queueUrl), JSON.stringify(resources.one.queueUrl));
  assert.deepEqual(JSON.parse(JSON.stringify(resources.one)).path, ["one"]);
  assert.throws(() => String(resources.one), /reference is not a value/);
  assert.throws(() => (resources.one.grant as Function)({ bad: () => {} }), /JSON arguments/);
});

test("all local compute lanes resolve their own declared names, defaults and secrets", async () => {
  let reads = 0;
  for (const target of getFrameworkTargets(config())) {
    const env = await resolveLocalWorkloadEnvironment(config(), target.reference, { repositoryRoot: ".", manifest, authored: { KEY: "authored-key" }, environment: { UNDECLARED: "never-copy", AWS_REGION: identity.region }, readSecret: async () => { reads++; return '{"password":"field-value"}'; } });
    assert.equal(env.RESOURCE, target.id === "two" ? "queue-two" : "queue-one");
    assert.equal(env.UNDECLARED, undefined);
    if (target.id !== "two") assert.equal(env.INPUT, "default-value");
    if (target.kind === "service") { assert.equal(env.API_KEY, "authored-key"); assert.equal(env.PASSWORD, "field-value"); }
  }
  assert.equal(reads, 1);
});

test("manifest identity, mode, missing values and secret fields fail before launch", async () => {
  assert.throws(() => parseResourceManifest(JSON.stringify({ ...manifest, mode: "prod" })), /production/);
  assert.throws(() => parseResourceManifest(JSON.stringify(manifest), { account: "999999999999" }), /differs/);
  assert.throws(() => parseResourceManifest(JSON.stringify({ ...manifest, attributes: { bad: "${Token[TOKEN.42]}" } })), /unresolved/);
  await assert.rejects(resolveLocalWorkloadEnvironment(config(), "lambda:one", { repositoryRoot: ".", manifest: { ...manifest, attributes: {} }, authored: {} }), /missing.*manifest/);
  await assert.rejects(resolveLocalWorkloadEnvironment(config(), "service:service", { repositoryRoot: ".", manifest, authored: {}, readSecret: async () => "{}" }), /secret field is missing/);
});

test("concurrent Node handlers read isolated values during module initialization", async () => {
  const root = path.resolve(__dirname, "../../..");
  const cache = path.join(root, ".cache"); mkdirSync(cache, { recursive: true });
  const fixture = mkdtempSync(path.join(cache, "resource-handlers-"));
  try {
    for (const id of ["one", "two"]) {
      const directory = path.join(fixture, "cdk-app/lambda_functions/http_functions", id); mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "index.ts"), 'const initialized = process.env.RESOURCE; export async function lambdaHandler() { await new Promise(r => setTimeout(r, 20)); return { initialized, runtime: process.env.RESOURCE }; }');
    }
    const options = { repositoryRoot: fixture, manifest, authored: {} };
    const values = await Promise.all([invokeLocalNodeLambda(config(), "lambda:one", {}, options), invokeLocalNodeLambda(config(), "lambda:two", {}, options)]);
    assert.deepEqual(values, [{ initialized: "queue-one", runtime: "queue-one" }, { initialized: "queue-two", runtime: "queue-two" }]);
    assert.equal(process.env.RESOURCE, undefined);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
