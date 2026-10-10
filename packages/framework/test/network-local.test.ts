import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  defineFrameworkConfig,
  defineNetwork,
  defineResources,
  resource,
  type FrameworkConfig,
} from "../src/config/index";
import { findRepositoryRoot } from "../src/config/source";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { ipv6EgressRefusal, isPrivateAddress, type EgressResolver } from "../src/local/egress-guard";
import { localLambdaEgress } from "../src/local/lambda-process";
import { webSocketConnections } from "../src/runtime/websocket";

type FakeDataStack = {
  readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } };
};
// As in a dev deployment: the database is absent from the AWS graph, and runs under Compose.
const resources = defineResources({ rds: (false as boolean) ? resource.stack<FakeDataStack>() : undefined });
const connected = { database: true };

const config = (network?: ReturnType<typeof defineNetwork>): FrameworkConfig =>
  defineFrameworkConfig({
    ...(network ? { network } : {}),
    resources,
    database: resources.rds.database,
    defaults: {
      lambda: {
        runtime: "nodejs24", packaging: "zip", architecture: "arm64",
        memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true },
      },
    },
    http: [{
      "/orders": { directory: "/lambda_functions/http_functions/orders", methods: ["GET"], ...connected },
      "/plain": { directory: "/lambda_functions/http_functions/plain", methods: ["GET"] },
      "/inside": { directory: "/lambda_functions/http_functions/inside", methods: ["GET"], vpc: true },
    }],
    webSocket: [], events: [], services: [],
    tasks: [{ job: { ...connected, cloud: { subnet: "public" } } }],
    tools: [{ lookup: { ...connected } }],
  } as never);

const environmentOf = (target: string) =>
  resolveLocalWorkloadEnvironment(config(), target as never, {
    repositoryRoot: findRepositoryRoot(__dirname),
    environment: {},
    authored: {},
  });

test("only a workload that declares database: true gets the Compose stand-in, with no IAM", async () => {
  assert.ok((await environmentOf("lambda:orders")).PRIMARY_DATABASE_URL);
  assert.equal((await environmentOf("lambda:orders")).PRIMARY_DATABASE_AUTH, undefined, "locally it is a password URL");
  assert.ok((await environmentOf("lambda:lookup")).PRIMARY_DATABASE_URL, "a tool that declares it gets it");
  assert.ok((await environmentOf("task:job")).PRIMARY_DATABASE_URL, "a task that declares it gets it");
  assert.equal((await environmentOf("lambda:plain")).PRIMARY_DATABASE_URL, undefined);
  assert.equal((await environmentOf("lambda:inside")).PRIMARY_DATABASE_URL, undefined, "vpc: true is not database access");
});

test("a Lambda in the VPC calls AWS's dual-stack endpoints; containers and Lambdas outside it do not", async () => {
  assert.equal((await environmentOf("lambda:orders")).AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.equal((await environmentOf("lambda:inside")).AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.equal((await environmentOf("lambda:plain")).AWS_USE_DUALSTACK_ENDPOINT, undefined);
  assert.equal((await environmentOf("task:job")).AWS_USE_DUALSTACK_ENDPOINT, undefined);
});

test("a Lambda in the VPC is held to IPv6 egress unless the network has a NAT gateway", () => {
  assert.equal(localLambdaEgress(config(), "lambda:orders"), "ipv6");
  assert.equal(localLambdaEgress(config(), "lambda:inside"), "ipv6");
  assert.equal(localLambdaEgress(config(), "lambda:plain"), undefined);
  assert.equal(localLambdaEgress(config(defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: true })), "lambda:orders"), undefined);
});

test("the framework owns AWS_USE_DUALSTACK_ENDPOINT, and primaryDatabase is no longer a local resource", () => {
  const base = { defaults: { lambda: { runtime: "nodejs24", packaging: "zip" } }, http: [], webSocket: [], events: [], services: [] };
  assert.throws(
    () => defineFrameworkConfig({ ...base, http: [{ "/a": { directory: "/lambda_functions/http_functions/a", methods: ["GET"], environment: { AWS_USE_DUALSTACK_ENDPOINT: "true" } } }] } as never),
    /The framework sets it on every Lambda in the VPC/,
  );
  assert.throws(
    () => defineFrameworkConfig({ ...base, tasks: [{ job: { local: { resources: ["primaryDatabase"] } } }] } as never),
    /requests local resource "primaryDatabase"\. A task reaches the database the way every workload does, in both lanes: declare database: true/,
  );
});

const resolver = (addresses: Record<string, readonly string[]>, ipv6: readonly string[] = []): EgressResolver => ({
  lookupAll: async (hostname) => addresses[hostname] ?? [],
  hasIpv6: async (hostname) => ipv6.includes(hostname),
});

test("the guard passes what the private subnets reach and refuses what they cannot", async () => {
  const dns = resolver(
    {
      postgres: ["172.18.0.2"],
      localhost: ["127.0.0.1", "::1"],
      "cognito-idp.us-east-1.amazonaws.com": ["3.211.120.116", "2600:1f18:257:8002::1"],
      "ecs.us-east-1.api.aws": ["52.0.0.1"],
      "api.github.com": ["140.82.112.6"],
    },
    ["ecs.us-east-1.api.aws"],
  );
  assert.equal(await ipv6EgressRefusal("postgres", dns), undefined, "a Compose service is on the private network");
  assert.equal(await ipv6EgressRefusal("localhost", dns), undefined);
  assert.equal(await ipv6EgressRefusal("cognito-idp.us-east-1.amazonaws.com", dns), undefined);
  assert.equal(await ipv6EgressRefusal("ecs.us-east-1.api.aws", dns), undefined, "IPv6 published in DNS but hidden from getaddrinfo on an IPv4-only laptop");
  assert.match((await ipv6EgressRefusal("api.github.com", dns)) ?? "", /api\.github\.com has no IPv6 address/);
  assert.match((await ipv6EgressRefusal("140.82.112.6", dns)) ?? "", /is an IPv4 address/);
  assert.equal(await ipv6EgressRefusal("2600:1f18::1", dns), undefined);
});

test("private addresses are recognized in both families", () => {
  for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "3.211.120.116", "2600:1f18::1"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("installed in a handler's process, the guard refuses an IPv4-only host before any connection", () => {
  // DNS is stubbed so the test needs no network: the guard's own resolution
  // is what is under test, not the internet's.
  const script = `
    const dns = require("node:dns");
    const answers = { postgres: ["172.18.0.2"], "api.github.com": ["140.82.112.6"], "sts.us-east-1.api.aws": ["52.0.0.1"] };
    dns.lookup = (host, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      const all = (answers[host] || []).map((address) => ({ address, family: 4 }));
      if (typeof options === "object" && options.all) return done(null, all);
      return done(null, all[0].address, 4);
    };
    dns.resolve6 = (host, callback) => callback(null, host === "sts.us-east-1.api.aws" ? ["2600::1"] : []);
    const { installIpv6EgressGuard } = require(${JSON.stringify(path.join(__dirname, "../src/local/egress-guard.ts"))});
    installIpv6EgressGuard("orders");
    const results = {};
    let pending = 3;
    for (const host of ["postgres", "api.github.com", "sts.us-east-1.api.aws"]) {
      dns.lookup(host, {}, (error, address) => {
        results[host] = error ? error.code + ": " + error.message : address;
        if (--pending === 0) console.log(JSON.stringify(results));
      });
    }
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const results = JSON.parse(run.stdout.trim()) as Record<string, string>;
  assert.equal(results.postgres, "172.18.0.2");
  assert.equal(results["sts.us-east-1.api.aws"], "52.0.0.1");
  assert.match(results["api.github.com"] ?? "", /^ENETUNREACH: api\.github\.com has no IPv6 address, .*orders runs in the VPC \(vpc: true or database: true\), so in AWS it is in the private subnets/);
});

test("the WebSocket push client keeps its own endpoint when the SDK is set to dual-stack", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    AWS_USE_DUALSTACK_ENDPOINT: "true",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
  });
  delete process.env.LOCAL_WEBSOCKET_CONNECTIONS_URL;
  try {
    const connections = webSocketConnections({ requestContext: { domainName: "push.example.invalid", stage: "prod" } });
    // The request fails on the network, which is the point: it got that far.
    // Without useDualstackEndpoint: false the SDK refuses before sending.
    await assert.rejects(connections.send("abc", "hi"), (error: Error) => !/Dualstack and custom endpoint/.test(error.message));
  } finally {
    process.env = saved;
  }
});
