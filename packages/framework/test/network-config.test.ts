import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig,
  defineNetwork,
  defineResources,
  getConnectsToBindings,
  normalizeFrameworkConfig,
  resolveLambdaTarget,
  resolveTaskTarget,
  resource,
  runsTask,
  validateFrameworkConfig,
  type FrameworkConfig,
} from "@repo/framework/config";

const lambdaDefaults = {
  runtime: "nodejs24", packaging: "zip", architecture: "arm64",
  memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true },
} as const;

type FakeDataStack = {
  readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } };
  readonly endpoint: string;
};
const resources = defineResources({ rds: resource.stack<FakeDataStack>(), apiKey: resource.secret() });
const absentResources = defineResources({ rds: (false as boolean) ? resource.stack<FakeDataStack>() : undefined });

function route(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = path.slice(1);
  return { [path]: { directory: `/lambda_functions/http_functions/${id}`, methods: ["GET"], ...extra } };
}

function config(input: Record<string, unknown>): FrameworkConfig {
  const network = Array.isArray(input.networks) ? input.networks[0] : fixtureVpc;
  return defineFrameworkConfig({ networks: [fixtureVpc],
    resources,
    database: { resource: resources.rds.database, vpc: network },
    defaults: { lambda: lambdaDefaults },
    http: [], webSocket: [], events: [], services: [],
    ...input,
  } as never);
}

const connected = { vpc: fixtureVpc, database: true };

test("defineNetwork takes a private /16 and two or three zones", () => {
  for (const cidr of ["10.0.0.0/16", "10.42.0.0/16", "172.20.0.0/16", "192.168.0.0/16"]) {
    assert.equal(defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr, zones: 2 }).cidr, cidr);
  }
  for (const cidr of ["10.0.0.0/24", "8.8.0.0/16", "10.300.0.0/16", "172.32.0.0/16", "10.0.1.0/16"]) {
    assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr, zones: 2 }), /a private \/16 for cidr/);
  }
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 1 as never }), /2 or 3 zones/);
});

test("defineNetwork defaults: IPv6 out, no NAT gateway, both gateway endpoints, no interface endpoints", () => {
  const network = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2 });
  assert.equal(network.egressOnlyInternetGateway, true);
  assert.equal(network.natGateway, false);
  assert.deepEqual(network.gatewayEndpoints, { s3: true, dynamodb: true });
  assert.deepEqual(network.interfaceEndpoints, []);
  const declared = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" },
    cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false, natGateway: true,
    gatewayEndpoints: { s3: true, dynamodb: false }, interfaceEndpoints: ["secretsmanager", "ecr.api"],
  });
  assert.equal(declared.egressOnlyInternetGateway, false);
  assert.equal(declared.natGateway, true);
  assert.deepEqual(declared.gatewayEndpoints, { s3: true, dynamodb: false });
  assert.deepEqual(declared.interfaceEndpoints, ["secretsmanager", "ecr.api"]);
});

test("defineNetwork refuses what it does not take, and names what it does", () => {
  const base = { cidr: "10.0.0.0/16", zones: 2 } as const;
  for (const value of [undefined, null, [], "application", Object.create({ id: "application", ...base })]) {
    assert.throws(() => defineNetwork(value as never), /takes a plain VPC declaration/);
  }
  assert.throws(() => defineNetwork({ ...base, nat: true } as never), /takes natGateway: true or false\. nat was its earlier name/);
  assert.throws(() => defineNetwork({ ...base, natGateways: 1 } as never), /does not take "natGateways"\. It takes id, name, cloud, cidr, zones, egressOnlyInternetGateway, natGateway/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, natGateway: "yes" as never }), /true or false for natGateway/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, egressOnlyInternetGateway: 1 as never }), /true or false for egressOnlyInternetGateway/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, gatewayEndpoints: { sqs: true } as never }), /gateway endpoints for s3 and dynamodb only\. Other services go in interfaceEndpoints/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, gatewayEndpoints: { s3: "on" as never } }), /gatewayEndpoints\.s3 is true or false/);
});

test("interfaceEndpoints takes AWS endpoint names, suggests the one meant, and leaves S3 and DynamoDB to the gateways", () => {
  const base = { cidr: "10.0.0.0/16", zones: 2 } as const;
  assert.doesNotThrow(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: ["ecr.api", "ecr.dkr", "logs", "states", "bedrock-agentcore"] }));
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: ["secretmanager" as never] }), /"secretmanager", which is not an AWS interface endpoint service\. Did you mean "secretsmanager"\?/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: ["ecr-dkr" as never] }), /Did you mean "ecr\.dkr"\?/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: ["s3" as never] }), /reaches s3 through its gateway endpoint, which is free: use gatewayEndpoints: \{ s3: true \}/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: ["dynamodb" as never] }), /gatewayEndpoints: \{ dynamodb: true \}/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: ["logs", "logs"] }), /lists "logs" twice/);
  assert.throws(() => defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, ...base, interfaceEndpoints: "logs" as never }), /a list of service names/);
});

test("network takes only what defineNetwork returns", () => {
  assert.throws(
    () => config({ networks: [{ cidr: "10.0.0.0/16", zones: 2 }] }),
    /networks takes imported defineNetwork declarations/,
  );
  assert.doesNotThrow(() => config({ networks: [defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2 })] }));
});

const withNat = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, natGateway: true });
const withoutNat = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2 });
const fargateEndpoints = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: ["ecr.api", "ecr.dkr", "logs"] });

function containers(defaultSubnet?: string, override?: string, network = withNat): FrameworkConfig {
  return config({
    networks: [network],
    defaults: { lambda: lambdaDefaults, container: { subnet: defaultSubnet } },
    tasks: [{ job: { cloud: { vpc: network, subnet: override } } }],
    services: [{ "/orders/*": {
      directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000,
      cloud: { vpc: network, subnet: override },
    } }],
  });
}

test("containers run in public subnets unless something says private", () => {
  const byDefault = containers();
  assert.equal(resolveTaskTarget(byDefault, "job").cloud.subnet, "public");
  assert.equal(normalizeFrameworkConfig(byDefault).targets.get("service:orders")?.cloud.service?.subnet, "public");

  const privateDefault = containers("private");
  assert.equal(resolveTaskTarget(privateDefault, "job").cloud.subnet, "private");
  assert.equal(normalizeFrameworkConfig(privateDefault).targets.get("service:orders")?.cloud.service?.subnet, "private");

  const override = containers("private", "public");
  assert.equal(resolveTaskTarget(override, "job").cloud.subnet, "public");
  assert.equal(normalizeFrameworkConfig(override).targets.get("service:orders")?.cloud.service?.subnet, "public");
});

test("a deployed private container starts through the NAT gateway or Fargate's endpoints, in every mode", () => {
  const refusal = /runs in a private subnet, and the selected VPC declaration gives the private subnets no IPv4 way out \(no NAT gateway\).*It needs the endpoints "ecr\.api", "ecr\.dkr" \(to pull its image\), "logs" \(to ship its logs\): add "ecr\.api", "ecr\.dkr", "logs" to interfaceEndpoints in the selected VPC declaration \(about \$43\.80 a month at 2 zones\), or set natGateway: true \(about \$32\.85 a month\), or give it cloud\.subnet: "public"/;
  assert.throws(() => normalizeFrameworkConfig(containers("private", undefined, withoutNat)), refusal);
  assert.throws(() => normalizeFrameworkConfig(config({ tasks: [{ job: { cloud: { vpc: fixtureVpc, subnet: "private" } } }] })), refusal, "no network declared is the default network, with no NAT");
  assert.doesNotThrow(() => normalizeFrameworkConfig(containers("private", undefined, fargateEndpoints)), "the endpoints Fargate starts through");
  assert.doesNotThrow(() => normalizeFrameworkConfig(containers("private", "public", withoutNat)));
  assert.doesNotThrow(() => normalizeFrameworkConfig(config({
    networks: [withoutNat],
    defaults: { lambda: lambdaDefaults, container: { subnet: "private" } },
    tasks: [{ job: { cloud: { vpc: withoutNat }, deploy: "local-only" } }],
  })), "a container AWS never runs needs nothing from its network");
});

test("a private container without NAT names every endpoint it lacks: image layers, secrets and the AWS calls it makes", () => {
  const noS3 = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, gatewayEndpoints: { s3: false }, interfaceEndpoints: ["ecr.api", "ecr.dkr", "logs"] });
  assert.throws(
    () => normalizeFrameworkConfig(config({ networks: [noS3], tasks: [{ job: { cloud: { vpc: noS3, subnet: "private" } } }] })),
    /It needs the endpoint "s3" \(its image layers\): set gatewayEndpoints\.s3: true, or set natGateway: true/,
  );
  assert.throws(
    () => normalizeFrameworkConfig(config({ networks: [fargateEndpoints], tasks: [{ job: { secrets: { API_KEY: resources.apiKey }, cloud: { vpc: fargateEndpoints, subnet: "private" } } }] })),
    /It needs the endpoint "secretsmanager" \(it reads a secret\): add "secretsmanager" to interfaceEndpoints in the selected VPC declaration \(about \$14\.60 a month at 2 zones\)/,
  );
  assert.throws(
    () => normalizeFrameworkConfig(config({
      networks: [fargateEndpoints],
      tasks: [{ job: { cloud: { vpc: fargateEndpoints, subnet: "private", bindings: [runsTask("other")] } }, other: { cloud: { vpc: fargateEndpoints } } }],
    })),
    /It needs the endpoint "ecs" \(it runs task:other\)/,
  );
  assert.doesNotThrow(() => normalizeFrameworkConfig(config({
    networks: [withNat],
    tasks: [{ job: { secrets: { API_KEY: resources.apiKey }, cloud: { vpc: withNat, subnet: "private", bindings: [runsTask("other")] } }, other: { cloud: { vpc: withNat } } }],
  })), "a NAT gateway reaches all of it");
});

test("an unknown subnet is refused, as a default and on a target, with the reason", () => {
  assert.throws(() => validateFrameworkConfig(config({ defaults: { lambda: lambdaDefaults, container: { subnet: "dmz" } } })), /defaults\.container\.subnet "dmz" is not a container's subnet\. A container runs in a "public" or a "private" subnet/);
  assert.throws(() => containers(undefined, "dmz"), /cloud\.subnet "dmz"/);
  assert.throws(() => containers(undefined, "none"), /cloud\.subnet "none"\. Fargate always runs in the VPC/);
  assert.throws(() => containers(undefined, "isolated"), /cloud\.subnet "isolated"\. Fargate always runs in the VPC/);
});

test("assignPublicIp is retired on services and tasks in favor of cloud.subnet", () => {
  assert.throws(
    () => config({ services: [{ "/orders/*": { directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000, cloud: { vpc: fixtureVpc, assignPublicIp: true } } }] }),
    /declares "assignPublicIp"\. A container's place in the network is cloud\.subnet/,
  );
  assert.throws(
    () => config({ tasks: [{ job: { cloud: { vpc: fixtureVpc, assignPublicIp: false } } }] }),
    /declares "assignPublicIp"\. A container's place in the network is cloud\.subnet/,
  );
});

test("database: true records the config's database, present or absent", () => {
  const present = normalizeFrameworkConfig(config({ http: [route("/orders", connected)] }));
  const [binding] = getConnectsToBindings(present.targets.get("lambda:orders")!.cloud.bindings);
  assert.deepEqual(binding?.resource.path, ["rds", "database"]);
  assert.equal(binding?.resource.absent, undefined);
  assert.deepEqual(getConnectsToBindings(present.targets.get("lambda:orders")!.cloud.bindings).length, 1);

  const absent = normalizeFrameworkConfig(config({
    resources: absentResources,
    database: { resource: absentResources.rds.database, vpc: fixtureVpc },
    http: [route("/orders", connected)],
  }));
  const [absentBinding] = getConnectsToBindings(absent.targets.get("lambda:orders")!.cloud.bindings);
  assert.deepEqual(absentBinding?.resource.path, ["rds", "database"]);
  assert.equal(absentBinding?.resource.absent, true);

  const plain = normalizeFrameworkConfig(config({ http: [route("/plain")] }));
  assert.equal(getConnectsToBindings(plain.targets.get("lambda:plain")!.cloud.bindings).length, 0, "no flag, no VPC");
});

test("database: true needs the config to name a database, and is only ever true", () => {
  assert.throws(
    () => config({ database: undefined, http: [route("/orders", connected)] }),
    /declares database: true, but the config names no database\. Import a defineDatabase\(\{ id, resource: resources\.<stack>\.<construct>, vpc: importedVpc \}\) declaration as database in framework\.config\.ts/,
  );
  assert.throws(() => config({ http: [route("/orders", { database: "yes" })] }), /declares database "yes"\. It is true, a database access object, or left out/);
  assert.throws(() => config({ database: "rds" }), /database takes an imported defineDatabase/);
  assert.throws(() => config({ database: { resource: resources.rds, vpc: fixtureVpc } }), /database takes an imported defineDatabase/);
  assert.throws(
    () => config({ resources: {}, http: [route("/orders", connected)] }),
    /the config's database, resources\.rds\.database, is not declared in its "resources" catalog/,
  );
});

test("the framework owns the database variables", () => {
  for (const name of ["PRIMARY_DATABASE_URL", "PRIMARY_DATABASE_AUTH"]) {
    assert.throws(
      () => config({ http: [route("/orders", { environment: { [name]: "postgresql://x" } })] }),
      new RegExp(`declares environment "${name}"\\. The framework sets it on a workload that declares database: true`),
    );
  }
});

test("only TypeScript Lambdas use the database; cross-language Lambdas stay outside the VPC", () => {
  assert.throws(
    () => config({ http: [route("/orders", { ...connected, runtime: "python3.13" })] }),
    /declares database: true\. It is a python3\.13 Lambda, and only TypeScript Lambdas run inside the VPC/,
  );
  assert.throws(
    () => config({ http: [route("/orders", { ...connected, packaging: "container" })] }),
    /It is a container Lambda, and only TypeScript Lambdas run inside the VPC/,
  );
});

test("an event that uses the database has to replay locally", () => {
  const event = (extra: Record<string, unknown>) => ({ "orders-created": { directory: "/lambda_functions/event_functions/orders-created", ...connected, ...extra } });
  assert.throws(() => config({ events: [event({})] }), /a dev deployment builds no database\. AWS invokes this event in a dev deployment too.*localReplay: true/);
  assert.doesNotThrow(() => config({ events: [event({ localReplay: true })] }));
});

test("reading the database's stack without database: true is refused", () => {
  const reader = route("/reports", { environment: { DATABASE_HOST: resources.rds.endpoint } });
  assert.throws(
    () => config({ http: [reader] }),
    /reads resources\.rds\.endpoint from the database's stack but does not declare database: true.*Declare database: true\./,
  );
  assert.doesNotThrow(() => config({ http: [route("/reports", { environment: { DATABASE_HOST: resources.rds.endpoint }, ...connected })] }));
});

test("subnet places a Lambda: the default, a section or an entry decides, and database: true lifts \"none\" to \"private\"", () => {
  const subnetOf = (built: FrameworkConfig, id: string) => resolveLambdaTarget(built, id).subnet;
  assert.equal(subnetOf(config({ http: [route("/plain")] }), "plain"), "none", "outside the VPC unless something says otherwise");
  assert.equal(subnetOf(config({ http: [route("/orders", { vpc: fixtureVpc, subnet: "private" })] }), "orders"), "private");
  assert.equal(subnetOf(config({ http: [route("/orders", { vpc: fixtureVpc, subnet: "isolated" })] }), "orders"), "isolated");
  assert.equal(subnetOf(config({ http: [route("/orders", connected)] }), "orders"), "private", "the database is in the VPC");
  assert.equal(subnetOf(config({ http: [route("/orders", { ...connected, subnet: "isolated" })] }), "orders"), "isolated", "the database is reachable from the isolated subnets");

  const everywhere = config({ networks: [fixtureVpc],
    defaults: { lambda: { ...lambdaDefaults, subnet: "private" } },
    http: [route("/orders", { vpc: fixtureVpc }), route("/webhook", { subnet: "none" })],
  });
  assert.equal(subnetOf(everywhere, "orders"), "private");
  assert.equal(subnetOf(everywhere, "webhook"), "none", "an entry overrides the default");
  assert.equal(subnetOf(config({ networks: [fixtureVpc], defaults: { lambda: lambdaDefaults, http: { subnet: "isolated" } }, http: [route("/orders", { vpc: fixtureVpc })] }), "orders"), "isolated", "so does a section");
});

test("subnet is none, private or isolated; boolean vpc is retired; a database user cannot leave the VPC", () => {
  assert.throws(() => config({ http: [route("/orders", { subnet: "public" })] }), /declares subnet "public"\. AWS gives a Lambda in a VPC no public IPv4 address, so a public subnet would only lose the NAT gateway: use "private"/);
  assert.throws(() => config({ http: [route("/orders", { subnet: "dmz" })] }), /declares subnet "dmz"\. A Lambda's subnet is "none" \(outside the VPC\), "private" or "isolated"/);
  assert.throws(() => config({ http: [route("/orders", { vpc: true })] }), /vpc takes an imported defineNetwork declaration; vpc: true is no longer supported/);
  assert.throws(
    () => validateFrameworkConfig(config({ defaults: { lambda: { ...lambdaDefaults, vpc: true } } })),
    /defaults\.lambda declares "vpc"/,
  );
  assert.throws(
    () => validateFrameworkConfig(config({ defaults: { lambda: lambdaDefaults, http: { vpc: true } } })),
    /defaults\.http declares "vpc"/,
  );
  assert.throws(
    () => validateFrameworkConfig(config({ defaults: { lambda: { ...lambdaDefaults, subnet: "public" } } })),
    /defaults\.lambda\.subnet is "public"\. AWS gives a Lambda in a VPC no public IPv4 address/,
  );
  assert.throws(
    () => config({ http: [route("/orders", { ...connected, subnet: "none" })] }),
    /declares database: true and subnet: "none".*assigned to a VPC.*"private" or "isolated"/,
  );
});

test("a Lambda in the VPC is held to the VPC's rules: TypeScript only, and an event replays locally", () => {
  assert.throws(
    () => config({ http: [route("/orders", { vpc: fixtureVpc, subnet: "private", runtime: "python3.13" })] }),
    /has subnet: "private"\. It is a python3\.13 Lambda, and only TypeScript Lambdas run inside the VPC: give it subnet: "none"/,
  );
  assert.doesNotThrow(
    () => config({ networks: [fixtureVpc], defaults: { lambda: { ...lambdaDefaults, subnet: "private" } }, http: [route("/orders", { subnet: "none", runtime: "python3.13" })] }),
    "a cross-language Lambda opts out of a VPC default",
  );
  const event = (extra: Record<string, unknown>) => ({ "orders-created": { vpc: fixtureVpc, directory: "/lambda_functions/event_functions/orders-created", subnet: "isolated", ...extra } });
  assert.throws(() => config({ events: [event({})] }), /has subnet: "isolated", and a dev deployment builds no network\. AWS invokes this event in a dev deployment too.*localReplay: true/);
  assert.doesNotThrow(() => config({ events: [event({ localReplay: true })] }));
});

test("a Lambda whose subnet has no way out needs an endpoint for every AWS call the framework makes for it", () => {
  const sealed = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false });
  const withEndpoints = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: ["secretsmanager", "ecs"] });
  const isolatedCalls = (vpc = fixtureVpc) => route("/orders", { vpc, subnet: "isolated", environment: { API_KEY: resources.apiKey.arn }, cloud: { bindings: [runsTask("job")] } });
  const tasks = (vpc = fixtureVpc) => [{ job: { cloud: { vpc } } }];
  assert.throws(
    () => config({ http: [isolatedCalls()], tasks: tasks() }),
    /has subnet: "isolated", which reaches nothing beyond the VPC but the network's endpoints\. It needs the endpoints "secretsmanager" \(it reads a secret\), "ecs" \(it runs task:job\): add "secretsmanager", "ecs" to interfaceEndpoints in the selected VPC declaration \(about \$29\.20 a month at 2 zones\), or give it subnet: "private"/,
  );
  assert.doesNotThrow(
    () => config({ networks: [withEndpoints], http: [isolatedCalls(withEndpoints)], tasks: tasks(withEndpoints) }),
  );
  const privateCalls = (vpc = fixtureVpc) => route("/orders", { vpc, subnet: "private", environment: { API_KEY: resources.apiKey.arn } });
  assert.doesNotThrow(() => config({ http: [privateCalls()] }), "IPv6 leaves the private subnets by default");
  assert.throws(
    () => config({ networks: [sealed], http: [privateCalls(sealed)] }),
    /has subnet: "private", and the selected VPC declaration gives the private subnets no way out.*"secretsmanager" \(it reads a secret\).*, or turn on egressOnlyInternetGateway, which is free/,
  );
  assert.doesNotThrow(() => config({ networks: [withNat], http: [privateCalls(withNat)] }), "IPv4 through NAT is a way out");
});

test("a WebSocket push from a subnet with no way out is refused: no endpoint reaches the management API", () => {
  assert.throws(
    () => config({ webSocket: [{ "send-message": { vpc: fixtureVpc, directory: "/lambda_functions/websocket_functions/send-message", subnet: "isolated", cloud: { manageConnections: true } } }] }),
    /pushes to WebSocket connections through API Gateway's management API, which no interface endpoint reaches.*Give it subnet: "private" or "none"/,
  );
});

test("the database's IAM login needs Secrets Manager from the private subnets", () => {
  const sealed = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false });
  assert.throws(
    () => config({ networks: [sealed], http: [route("/orders", { vpc: sealed, database: true, subnet: "isolated" })] }),
    /The database's IAM login is created on deploy by a function in the private subnets that reads the database's master secret.*Turn on egressOnlyInternetGateway, which is free, or add "secretsmanager" to interfaceEndpoints/,
  );
  const withSecrets = defineNetwork({ id: "application", cloud: { constructId: "NetworkStack" }, cidr: "10.0.0.0/16", zones: 2, egressOnlyInternetGateway: false, interfaceEndpoints: ["secretsmanager"] });
  assert.doesNotThrow(() => config({
    networks: [withSecrets],
    http: [route("/orders", { vpc: withSecrets, database: true, subnet: "isolated" })],
  }));
});

test("database access objects resolve pool defaults and retain network restrictions", () => {
  const built = config({ networks: [fixtureVpc], defaults: { lambda: lambdaDefaults, database: { pool: { maxConnections: 3 } } }, http: [route("/orders", { vpc: fixtureVpc, database: { readers: true, pool: { idleTimeoutMs: 1000 } } })] });
  const [binding] = getConnectsToBindings(normalizeFrameworkConfig(built).targets.get("lambda:orders")!.cloud.bindings);
  assert.equal(binding?.readers, true);
  assert.deepEqual(binding?.pool, { maxConnections: 3, connectionTimeoutMs: 20000, idleTimeoutMs: 1000 });
  assert.equal(resolveLambdaTarget(built, "orders").subnet, "private");
  for (const access of [{ readers: false }, { connection: "replica" }, { password: "forbidden" }, { pool: { maxConnections: 0 } }]) assert.throws(() => config({ http: [route("/orders", { database: access })] }));
  assert.throws(() => config({ http: [route("/orders", { vpc: fixtureVpc, database: { connection: "direct" }, subnet: "none" })] }), /subnet: "none"/);
  assert.throws(() => config({ http: [route("/orders", { vpc: fixtureVpc, database: { readers: true }, runtime: "python3.13" })] }), /only TypeScript/);
  for (const name of ["PRIMARY_DATABASE_READ_URLS", "PRIMARY_DATABASE_POOL_OPTIONS"]) assert.throws(() => config({ http: [route("/orders", { environment: { [name]: "manual" } })] }), /framework sets it/);
});
