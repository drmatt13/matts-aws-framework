import assert from "node:assert/strict";
import test from "node:test";
import { defineFrameworkConfig, defineNetwork, defineResources, getFrameworkTargets, normalizeFrameworkConfig, resource, resolveLambdaTarget, type FrameworkConfigInput } from "../src/config";
import { localLambdaEgress } from "../src/local/lambda-process";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";

const primary = defineNetwork({ id: "primary", cidr: "10.0.0.0/16", zones: 2 });
const sealed = defineNetwork({ id: "sealed", cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false });
const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const lambda = { directory: "/lambda_functions/http_functions/orders", methods: ["GET"] } as const;
const config = (input: Partial<FrameworkConfigInput> = {}) => defineFrameworkConfig({ networks: [primary, sealed], defaults, http: [], webSocket: [], events: [], services: [], ...input });

test("network registries have stable identities and allow overlapping independent CIDRs", () => {
  assert.deepEqual([...normalizeFrameworkConfig(config()).networks.keys()], ["primary", "sealed"]);
  assert.equal(normalizeFrameworkConfig(config({ networks: [sealed, primary] })).networks.get("primary"), primary);
  assert.throws(() => config({ networks: [primary, primary] }), /duplicate VPC id/);
  assert.throws(() => config({ networks: [primary, defineNetwork({ id: "other", cloud: { constructId: primary.cloud.constructId }, cidr: "10.2.0.0/16", zones: 2 })] }), /duplicate cloud.constructId/);
  assert.equal(config({ networks: [] }).networks.length, 0);
});

test("placement always requires a registered import, with no implicit network or defaults", () => {
  assert.throws(() => config({ defaults: { ...defaults, vpc: primary } } as never), /defaults.vpc is not supported.*explicitly on each workload/);
  assert.throws(() => config({ http: [{ "/orders": { ...lambda, subnet: "private" } }] }), /explicit imported vpc/);
  assert.throws(() => config({ tasks: [{ job: {} }] }), /explicit imported vpc/);
  assert.throws(() => config({ http: [{ "/orders": { ...lambda, vpc: defineNetwork({ id: "unknown", cidr: "10.2.0.0/16", zones: 2 }) } }] }), /not the declaration registered/);
  assert.throws(() => config({ http: [{ "/orders": { ...lambda, vpc: primary, subnet: "none" } }] }), /subnet: "none"/);
  const outside = config({ http: [{ "/orders": lambda }] });
  assert.equal(resolveLambdaTarget(outside, "orders").subnet, "none");
  assert.equal(getFrameworkTargets(outside)[0]!.vpc, undefined);
});

test("a second declaration cannot impersonate a registered VPC by reusing its identity", () => {
  const conflicting = defineNetwork({ id: sealed.id, cloud: sealed.cloud, cidr: "10.3.0.0/16", zones: 3, natGateway: true, tags: { owner: "other" } });
  const duplicate = defineNetwork({ id: sealed.id, cloud: sealed.cloud, cidr: sealed.cidr, zones: sealed.zones, egressOnlyInternetGateway: false });
  for (const vpc of [conflicting, duplicate]) {
    assert.throws(() => config({ http: [{ "/orders": { ...lambda, vpc } }] }), /not the declaration registered.*Import the same declaration/);
    assert.throws(() => config({ tasks: [{ job: { cloud: { vpc } } }] }), /not the declaration registered/);
    const resources = defineResources({ data: resource.stack<{ database: { node: { id: string; path: string }; connections: object } }>() });
    assert.throws(() => config({ resources, database: { resource: resources.data.database, vpc } }), /not the declaration registered/);
  }
});

test("an explicit VPC lifts Lambda placement to private and preserves isolated subnet choices", () => {
  const built = config({ http: [{ "/orders": { ...lambda, vpc: primary } }] });
  assert.equal(resolveLambdaTarget(built, "orders").subnet, "private");
  assert.equal(getFrameworkTargets(built)[0]!.vpc?.id, "primary");
  assert.equal(resolveLambdaTarget(config({ http: [{ "/orders": { ...lambda, vpc: sealed, subnet: "isolated" } }] }), "orders").subnet, "isolated");
});

test("a sibling VPC's endpoint never satisfies the selected VPC's requirements", () => {
  const privateNetwork = defineNetwork({ id: "private", cidr: "10.3.0.0/16", zones: 2, egressOnlyInternetGateway: false, interfaceEndpoints: ["secretsmanager"] });
  const resources = defineResources({ token: resource.secret("TOKEN") });
  assert.throws(() => config({ networks: [privateNetwork, sealed], resources, http: [{ "/orders": { ...lambda, vpc: sealed, environment: { TOKEN: resources.token.arn } } }] }), /secretsmanager/);
  assert.doesNotThrow(() => config({ networks: [privateNetwork, sealed], resources, http: [{ "/orders": { ...lambda, vpc: privateNetwork, environment: { TOKEN: resources.token.arn } } }] }));
});

test("private container startup cannot borrow another VPC's gateway or interface endpoints", () => {
  const ready = defineNetwork({ id: "ready", cidr: "10.4.0.0/16", zones: 2, interfaceEndpoints: ["ecr.api", "ecr.dkr", "logs"] });
  const noLayers = defineNetwork({ id: "no-layers", cidr: "10.5.0.0/16", zones: 2, gatewayEndpoints: { s3: false }, interfaceEndpoints: ready.interfaceEndpoints });
  const task = (vpc: typeof ready) => [{ job: { cloud: { vpc, subnet: "private" as const } } }];
  assert.throws(() => config({ networks: [ready, sealed], tasks: task(sealed) }), /ecr.api/);
  assert.throws(() => config({ networks: [ready, noLayers], tasks: task(noLayers) }), /s3/);
  assert.doesNotThrow(() => config({ networks: [ready, noLayers], tasks: task(ready) }));
});

test("database VPC boundaries are validated even when the database is absent in development", () => {
  type Data = { database: { node: { id: string; path: string }; connections: object } };
  for (const present of [false, true]) {
    const resources = defineResources({ data: present ? resource.stack<Data>() : undefined });
    const database = { resource: resources.data.database, vpc: primary };
    assert.throws(() => config({ resources, database, http: [{ "/orders": { ...lambda, vpc: sealed, database: true } }] }), /Cross-VPC database access/);
    assert.throws(() => config({ resources, database, http: [{ "/orders": { ...lambda, database: true } }] }), /explicit imported vpc/);
    assert.doesNotThrow(() => config({ resources, database, http: [{ "/orders": { ...lambda, vpc: primary, database: true } }] }));
  }
});

test("local egress and dual-stack environment use the workload's selected VPC", async () => {
  const built = config({ http: [{ "/orders": { ...lambda, vpc: primary }, "/sealed": { ...lambda, directory: "/lambda_functions/http_functions/sealed", vpc: sealed } }] });
  assert.equal(localLambdaEgress(built, "lambda:orders")?.ipv6, true);
  assert.equal(localLambdaEgress(built, "lambda:sealed")?.ipv6, false);
  const environment = async (target: "lambda:orders" | "lambda:sealed") => resolveLocalWorkloadEnvironment(built, target, { repositoryRoot: process.cwd(), environment: {}, authored: {} });
  assert.equal((await environment("lambda:orders")).AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.equal((await environment("lambda:sealed")).AWS_USE_DUALSTACK_ENDPOINT, undefined);
});
