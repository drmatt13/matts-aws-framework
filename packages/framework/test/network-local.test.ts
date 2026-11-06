import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { endpointServiceForHost } from "../src/config/network";
import { invokeLocalNodeLambda, LambdaWorkerPool } from "../src/local/lambda-process";
import { webSocketConnections } from "../src/runtime/websocket";

type FakeDataStack = {
  readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } };
};
// As in a dev deployment: the database is absent from the AWS graph, and runs under Compose.
const resources = defineResources({ rds: (false as boolean) ? resource.stack<FakeDataStack>() : undefined });
const config = (network = fixtureVpc): FrameworkConfig =>
  defineFrameworkConfig({ networks: [network],
    resources,
    database: { resource: resources.rds.database, vpc: network },
    defaults: {
      lambda: {
        runtime: "nodejs24", packaging: "zip", architecture: "arm64",
        memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true },
      },
    },
    http: [{
      "/orders": { directory: "/lambda_functions/http_functions/orders", methods: ["GET"], vpc: network, database: true },
      "/plain": { directory: "/lambda_functions/http_functions/plain", methods: ["GET"] },
      "/inside": { vpc: network, directory: "/lambda_functions/http_functions/inside", methods: ["GET"], subnet: "private" },
      "/sealed": { vpc: network, directory: "/lambda_functions/http_functions/sealed", methods: ["GET"], subnet: "isolated" },
    }],
    webSocket: [], events: [], services: [],
    tasks: [{ job: { database: true, cloud: { vpc: network, subnet: "public" } } }],
    tools: [{ lookup: { vpc: network, database: true } }],
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

test("local workloads use default SDK endpoints regardless of their AWS subnet", async () => {
  for (const target of ["lambda:orders", "lambda:inside", "lambda:sealed", "lambda:plain", "lambda:lookup", "task:job"]) {
    assert.equal((await environmentOf(target)).AWS_USE_DUALSTACK_ENDPOINT, undefined, target);
  }
  const natOnly = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false, natGateway: true });
  assert.equal((await environmentOf("lambda:inside", natOnly)).AWS_USE_DUALSTACK_ENDPOINT, undefined);
});

test("local reader and direct declarations keep Compose and the resolved pool settings", async () => {
  const base = config();
  const withReaders = defineFrameworkConfig({ networks: [fixtureVpc],
    ...base, defaults: { ...base.defaults, database: { pool: { maxConnections: 4 } } },
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

test("private and isolated local handlers can resolve IPv4 when Docker hides IPv6 DNS records", async () => {
  const root = findRepositoryRoot(__dirname);
  const parent = path.join(root, ".cache");
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, "local-network-"));
  const handler = path.join(fixture, "cdk-app/lambda_functions/http_functions/probe");
  mkdirSync(handler, { recursive: true });
  writeFileSync(path.join(handler, "index.ts"), `import dns from "node:dns";
// Docker Desktop may filter AAAA records even though the remote service has IPv6.
dns.resolve6 = (_hostname, callback) => callback(Object.assign(new Error("No AAAA records"), { code: "ENODATA" }));
export async function lambdaHandler() {
  const ipv6 = await new Promise(resolve => dns.resolve6("example.invalid", error => resolve(error?.code)));
  // TEST-NET-3 requires no outbound connection. The old local VPC guard rejected
  // this public IPv4 lookup before consulting the normal system resolver.
  const ipv4 = await new Promise((resolve, reject) => dns.lookup("203.0.113.10", { family: 4 }, (error, address) => error ? reject(error) : resolve(address)));
  return { ipv6, ipv4, dualStack: process.env.AWS_USE_DUALSTACK_ENDPOINT ?? null };
}`);
  const pool = new LambdaWorkerPool({ repositoryRoot: fixture, maxWarm: 2, idleSeconds: 30 });
  try {
    for (const subnet of ["private", "isolated"] as const) {
      const built = defineFrameworkConfig({
        networks: [fixtureVpc], defaults: config().defaults,
        http: [{ "/probe": { directory: "/lambda_functions/http_functions/probe", methods: ["GET"], vpc: fixtureVpc, subnet } }],
        webSocket: [], events: [], services: [],
      });
      for (const workers of [undefined, pool]) {
        const result = await invokeLocalNodeLambda(built, "lambda:probe", {}, {
          repositoryRoot: fixture, environment: {}, authored: {}, pool: workers,
        });
        assert.deepEqual(result, { ipv6: "ENODATA", ipv4: "203.0.113.10", dualStack: null }, `${subnet}, ${workers ? "warm" : "cold"}`);
      }
    }
  } finally {
    pool.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the framework owns AWS_USE_DUALSTACK_ENDPOINT, and primaryDatabase is no longer a local resource", () => {
  const base = { networks: [fixtureVpc], defaults: { lambda: { runtime: "nodejs24", packaging: "zip" } }, http: [], webSocket: [], events: [], services: [] };
  assert.throws(
    () => defineFrameworkConfig({ ...base, http: [{ "/a": { directory: "/lambda_functions/http_functions/a", methods: ["GET"], environment: { AWS_USE_DUALSTACK_ENDPOINT: "true" } } }] } as never),
    /The framework sets it on AWS Lambdas in a VPC whose subnet sends IPv6 out/,
  );
  assert.throws(
    () => defineFrameworkConfig({ ...base, tasks: [{ job: { cloud: { vpc: fixtureVpc }, local: { resources: ["primaryDatabase"] } } }] } as never),
    /requests local resource "primaryDatabase"\. A task reaches the database the way every workload does, in both lanes: declare database: true/,
  );
});

test("AWS endpoint hostnames map to their regional service", () => {
  assert.equal(endpointServiceForHost("secretsmanager.us-east-1.amazonaws.com"), "secretsmanager");
  assert.equal(endpointServiceForHost("api.ecr.us-east-1.amazonaws.com"), "ecr.api");
  assert.equal(endpointServiceForHost("123456789012.dkr.ecr.us-east-1.amazonaws.com"), "ecr.dkr");
  assert.equal(endpointServiceForHost("abc123.execute-api.eu-west-2.amazonaws.com"), "execute-api");
  assert.equal(endpointServiceForHost("my-bucket.s3.dualstack.us-east-1.amazonaws.com"), "s3");
  assert.equal(endpointServiceForHost("dynamodb.us-east-1.api.aws"), "dynamodb");
  assert.equal(endpointServiceForHost("api.github.com"), undefined);
  assert.equal(endpointServiceForHost("sts.amazonaws.com"), undefined, "a global endpoint has no regional endpoint service");

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
