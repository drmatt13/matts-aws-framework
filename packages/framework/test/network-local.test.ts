import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
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
import { egressFix, egressRefusal, isPrivateAddress, type EgressPolicy, type EgressResolver } from "../src/local/egress-guard";
import { endpointServiceForHost } from "../src/config/network";
import { localLambdaEgress } from "../src/local/lambda-process";
import { webSocketConnections } from "../src/runtime/websocket";

type FakeDataStack = {
  readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } };
};
// As in a dev deployment: the database is absent from the AWS graph, and runs under Compose.
const resources = defineResources({ rds: (false as boolean) ? resource.stack<FakeDataStack>() : undefined });
const connected = { vpc: fixtureVpc, database: true };

const config = (network?: ReturnType<typeof defineNetwork>): FrameworkConfig =>
  defineFrameworkConfig({ networks: [fixtureVpc],
    ...(network ? { networks: [network] } : {}),
    resources,
    database: { resource: resources.rds.database, vpc: fixtureVpc },
    defaults: {
      lambda: {
        runtime: "nodejs24", packaging: "zip", architecture: "arm64",
        memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true },
      },
    },
    http: [{
      "/orders": { directory: "/lambda_functions/http_functions/orders", methods: ["GET"], ...connected },
      "/plain": { directory: "/lambda_functions/http_functions/plain", methods: ["GET"] },
      "/inside": { vpc: fixtureVpc, directory: "/lambda_functions/http_functions/inside", methods: ["GET"], subnet: "private" },
      "/sealed": { vpc: fixtureVpc, directory: "/lambda_functions/http_functions/sealed", methods: ["GET"], subnet: "isolated" },
    }],
    webSocket: [], events: [], services: [],
    tasks: [{ job: { database: true, cloud: { vpc: fixtureVpc, subnet: "public" } } }],
    tools: [{ lookup: { ...connected } }],
  } as never);

const environmentOf = (target: string, network?: ReturnType<typeof defineNetwork>) =>
  resolveLocalWorkloadEnvironment(config(network), target as never, {
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
  assert.equal((await environmentOf("lambda:inside")).PRIMARY_DATABASE_URL, undefined, "a subnet is not database access");
});

test("a Lambda calls AWS's dual-stack endpoints only where IPv6 leaves its subnet; containers and Lambdas outside the VPC never do", async () => {
  assert.equal((await environmentOf("lambda:orders")).AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.equal((await environmentOf("lambda:inside")).AWS_USE_DUALSTACK_ENDPOINT, "true");
  assert.equal((await environmentOf("lambda:sealed")).AWS_USE_DUALSTACK_ENDPOINT, undefined, "nothing leaves the isolated subnets, so it calls the names the endpoints answer");
  assert.equal((await environmentOf("lambda:plain")).AWS_USE_DUALSTACK_ENDPOINT, undefined);
  assert.equal((await environmentOf("task:job")).AWS_USE_DUALSTACK_ENDPOINT, undefined);
  const natOnly = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false, natGateway: true });
  assert.equal((await environmentOf("lambda:inside", natOnly)).AWS_USE_DUALSTACK_ENDPOINT, undefined, "only IPv4 leaves, through the NAT gateway");
});

test("local reader and direct declarations keep Compose and the resolved pool settings", async () => {
  const base = config();
  const withReaders = defineFrameworkConfig({ networks: [fixtureVpc],
    ...base, defaults: { vpc: fixtureVpc, ...base.defaults, database: { pool: { maxConnections: 4 } } },
    http: [{
      "/orders": { vpc: fixtureVpc, directory: "/lambda_functions/http_functions/orders", methods: ["GET"], database: { readers: true, connection: "direct", pool: { idleTimeoutMs: 1000 } } },
    }],
  });
  const env = await resolveLocalWorkloadEnvironment(withReaders, "lambda:orders", {
    repositoryRoot: findRepositoryRoot(__dirname), environment: {}, authored: {},
  });
  assert.match(env.PRIMARY_DATABASE_URL!, /postgres:5432/);
  assert.equal(env.PRIMARY_DATABASE_AUTH, undefined);
  assert.equal(env.PRIMARY_DATABASE_READ_URLS, "[]");
  assert.deepEqual(JSON.parse(env.PRIMARY_DATABASE_POOL_OPTIONS!), {
    maxConnections: 4, connectionTimeoutMs: 20000, idleTimeoutMs: 1000,
  });
  assert.equal((await environmentOf("lambda:orders")).PRIMARY_DATABASE_READ_URLS, undefined);
});

test("a Lambda in the VPC is held to its subnet's egress, which a NAT gateway opens to everything", () => {
  const endpoints = ["s3", "dynamodb"];
  assert.deepEqual(localLambdaEgress(config(), "lambda:orders"), { subnet: "private", ipv6: true, endpoints });
  assert.deepEqual(localLambdaEgress(config(), "lambda:inside"), { subnet: "private", ipv6: true, endpoints });
  assert.deepEqual(localLambdaEgress(config(), "lambda:sealed"), { subnet: "isolated", ipv6: false, endpoints });
  assert.equal(localLambdaEgress(config(), "lambda:plain"), undefined);
  const nat = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, natGateway: true, interfaceEndpoints: ["secretsmanager"] });
  assert.equal(localLambdaEgress(config(nat), "lambda:orders"), undefined);
  assert.deepEqual(localLambdaEgress(config(nat), "lambda:sealed"), { subnet: "isolated", ipv6: false, endpoints: [...endpoints, "secretsmanager"] }, "NAT never reaches the isolated subnets");
});

test("the framework owns AWS_USE_DUALSTACK_ENDPOINT, and primaryDatabase is no longer a local resource", () => {
  const base = { networks: [fixtureVpc], defaults: { lambda: { runtime: "nodejs24", packaging: "zip" } }, http: [], webSocket: [], events: [], services: [] };
  assert.throws(
    () => defineFrameworkConfig({ ...base, http: [{ "/a": { directory: "/lambda_functions/http_functions/a", methods: ["GET"], environment: { AWS_USE_DUALSTACK_ENDPOINT: "true" } } }] } as never),
    /The framework sets it, in both lanes, on every Lambda in the VPC whose subnet sends IPv6 out/,
  );
  assert.throws(
    () => defineFrameworkConfig({ ...base, tasks: [{ job: { cloud: { vpc: fixtureVpc }, local: { resources: ["primaryDatabase"] } } }] } as never),
    /requests local resource "primaryDatabase"\. A task reaches the database the way every workload does, in both lanes: declare database: true/,
  );
});

const resolver = (addresses: Record<string, readonly string[]>, ipv6: readonly string[] = []): EgressResolver => ({
  lookupAll: async (hostname) => addresses[hostname] ?? [],
  hasIpv6: async (hostname) => ipv6.includes(hostname),
});

const ipv6Out: EgressPolicy = { subnet: "private", ipv6: true, endpoints: ["s3", "dynamodb"] };
const endpointsOnly: EgressPolicy = { subnet: "isolated", ipv6: false, endpoints: ["s3", "dynamodb", "secretsmanager", "ecr.api"] };

test("where IPv6 leaves, the guard passes private names, IPv6 names and endpoints, and refuses IPv4-only hosts", async () => {
  const dns = resolver(
    {
      postgres: ["172.18.0.2"],
      localhost: ["127.0.0.1", "::1"],
      "cognito-idp.us-east-1.amazonaws.com": ["3.211.120.116", "2600:1f18:257:8002::1"],
      "ecs.us-east-1.api.aws": ["52.0.0.1"],
      "api.github.com": ["140.82.112.6"],
      "my-bucket.s3.us-east-1.amazonaws.com": ["52.216.0.1"],
    },
    ["ecs.us-east-1.api.aws"],
  );
  assert.equal(await egressRefusal("postgres", ipv6Out, dns), undefined, "a Compose service is on the private network");
  assert.equal(await egressRefusal("localhost", ipv6Out, dns), undefined);
  assert.equal(await egressRefusal("cognito-idp.us-east-1.amazonaws.com", ipv6Out, dns), undefined);
  assert.equal(await egressRefusal("ecs.us-east-1.api.aws", ipv6Out, dns), undefined, "IPv6 published in DNS but hidden from getaddrinfo on an IPv4-only laptop");
  assert.equal(await egressRefusal("my-bucket.s3.us-east-1.amazonaws.com", ipv6Out, dns), undefined, "the S3 gateway endpoint carries IPv4");
  assert.match((await egressRefusal("api.github.com", ipv6Out, dns)) ?? "", /api\.github\.com has no IPv6 address, and only IPv6 and the network's endpoints leave the VPC's private subnets/);
  assert.match((await egressRefusal("140.82.112.6", ipv6Out, dns)) ?? "", /is a public IPv4 address/);
  assert.equal(await egressRefusal("2600:1f18::1", ipv6Out, dns), undefined);
});

test("where nothing leaves, the guard passes only private names and the network's endpoints", async () => {
  const dns = resolver(
    {
      postgres: ["172.18.0.2"],
      "secretsmanager.eu-west-2.amazonaws.com": ["3.8.0.1"],
      "api.ecr.eu-west-2.amazonaws.com": ["3.8.0.2"],
      "cognito-idp.eu-west-2.amazonaws.com": ["3.8.0.3", "2a05:d01c::1"],
    },
    ["cognito-idp.eu-west-2.amazonaws.com"],
  );
  assert.equal(await egressRefusal("postgres", endpointsOnly, dns), undefined);
  assert.equal(await egressRefusal("secretsmanager.eu-west-2.amazonaws.com", endpointsOnly, dns), undefined);
  assert.equal(await egressRefusal("api.ecr.eu-west-2.amazonaws.com", endpointsOnly, dns), undefined, "ecr.api's hostname spells its name backwards");
  assert.match(
    (await egressRefusal("cognito-idp.eu-west-2.amazonaws.com", endpointsOnly, dns)) ?? "",
    /cognito-idp\.eu-west-2\.amazonaws\.com is outside the VPC, and nothing leaves the VPC's isolated subnets but the network's endpoints/,
    "IPv6 does not leave the isolated subnets either",
  );
  assert.match((await egressRefusal("2600:1f18::1", endpointsOnly, dns)) ?? "", /is outside the VPC/);
});

test("a refused AWS host names the endpoint that would reach it", () => {
  assert.equal(endpointServiceForHost("secretsmanager.us-east-1.amazonaws.com"), "secretsmanager");
  assert.equal(endpointServiceForHost("api.ecr.us-east-1.amazonaws.com"), "ecr.api");
  assert.equal(endpointServiceForHost("123456789012.dkr.ecr.us-east-1.amazonaws.com"), "ecr.dkr");
  assert.equal(endpointServiceForHost("abc123.execute-api.eu-west-2.amazonaws.com"), "execute-api");
  assert.equal(endpointServiceForHost("my-bucket.s3.dualstack.us-east-1.amazonaws.com"), "s3");
  assert.equal(endpointServiceForHost("dynamodb.us-east-1.api.aws"), "dynamodb");
  assert.equal(endpointServiceForHost("api.github.com"), undefined);
  assert.equal(endpointServiceForHost("sts.amazonaws.com"), undefined, "a global endpoint has no regional endpoint service");

  assert.match(egressFix("cognito-idp.eu-west-2.amazonaws.com", endpointsOnly), /^Add "cognito-idp" to interfaceEndpoints in the selected VPC declaration \(about \$7\.30 a month per zone\), or give it subnet: "private"\.$/);
  assert.match(egressFix("dynamodb.eu-west-2.amazonaws.com", { ...endpointsOnly, endpoints: [] }), /^Turn on gatewayEndpoints\.dynamodb in the selected VPC declaration \(free\)/);
  assert.match(egressFix("api.github.com", ipv6Out), /^Call it from a Lambda outside the VPC \(subnet: "none"\), or give the private subnets IPv4 with natGateway: true/);
  assert.match(egressFix("api.github.com", { ...ipv6Out, ipv6: false }), /turn on egressOnlyInternetGateway \(free\) or natGateway/);
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
    const { installEgressGuard } = require(${JSON.stringify(path.join(__dirname, "../src/local/egress-guard.ts"))});
    installEgressGuard("orders", { subnet: "private", ipv6: true, endpoints: ["s3", "dynamodb"] });
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
  assert.match(results["api.github.com"] ?? "", /^ENETUNREACH: api\.github\.com has no IPv6 address, .*orders has subnet: "private", so in AWS it cannot reach api\.github\.com\. Call it from a Lambda outside the VPC/);
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
