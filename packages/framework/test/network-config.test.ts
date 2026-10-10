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
const resources = defineResources({ rds: resource.stack<FakeDataStack>() });
const absentResources = defineResources({ rds: (false as boolean) ? resource.stack<FakeDataStack>() : undefined });

function route(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const id = path.slice(1);
  return { [path]: { directory: `/lambda_functions/http_functions/${id}`, methods: ["GET"], ...extra } };
}

function config(input: Record<string, unknown>): FrameworkConfig {
  return defineFrameworkConfig({
    resources,
    database: resources.rds.database,
    defaults: { lambda: lambdaDefaults },
    http: [], webSocket: [], events: [], services: [],
    ...input,
  } as never);
}

const connected = { database: true };

test("defineNetwork takes a private /16 and two or three zones", () => {
  for (const cidr of ["10.0.0.0/16", "10.42.0.0/16", "172.20.0.0/16", "192.168.0.0/16"]) {
    assert.equal(defineNetwork({ cidr, zones: 2 }).cidr, cidr);
  }
  for (const cidr of ["10.0.0.0/24", "8.8.0.0/16", "10.300.0.0/16", "172.32.0.0/16", "10.0.1.0/16"]) {
    assert.throws(() => defineNetwork({ cidr, zones: 2 }), /a private \/16 for cidr/);
  }
  assert.throws(() => defineNetwork({ cidr: "10.0.0.0/16", zones: 1 as never }), /2 or 3 zones/);
});

test("the NAT gateway is off unless the network turns it on", () => {
  assert.equal(defineNetwork({ cidr: "10.0.0.0/16", zones: 2 }).nat, false);
  assert.equal(defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: true }).nat, true);
  assert.throws(() => defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: "yes" as never }), /true or false for nat/);
});

test("network takes only what defineNetwork returns", () => {
  assert.throws(
    () => config({ network: { cidr: "10.0.0.0/16", zones: 2 } }),
    /network takes the value defineNetwork\(\.\.\.\) returns/,
  );
  assert.doesNotThrow(() => config({ network: defineNetwork({ cidr: "10.0.0.0/16", zones: 2 }) }));
});

const withNat = defineNetwork({ cidr: "10.0.0.0/16", zones: 2, nat: true });
const withoutNat = defineNetwork({ cidr: "10.0.0.0/16", zones: 2 });

function containers(defaultSubnet?: string, override?: string, network = withNat): FrameworkConfig {
  return config({
    network,
    defaults: { lambda: lambdaDefaults, container: { subnet: defaultSubnet } },
    tasks: [{ job: { cloud: { subnet: override } } }],
    services: [{ "/orders/*": {
      directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000,
      cloud: { subnet: override },
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

test("a deployed container in a private subnet needs the network's NAT gateway, in every mode", () => {
  const refusal = /runs in a private subnet, which has no IPv4 route out because framework-config\/network\.ts has no NAT gateway.*could not start.*nat: true/;
  assert.throws(() => normalizeFrameworkConfig(containers("private", undefined, withoutNat)), refusal);
  assert.throws(() => normalizeFrameworkConfig(config({ tasks: [{ job: { cloud: { subnet: "private" } } }] })), refusal, "no network declared is no NAT");
  assert.doesNotThrow(() => normalizeFrameworkConfig(containers("private", "public", withoutNat)));
  assert.doesNotThrow(() => normalizeFrameworkConfig(config({
    network: withoutNat,
    defaults: { lambda: lambdaDefaults, container: { subnet: "private" } },
    tasks: [{ job: { deploy: "local-only" } }],
  })), "a container AWS never runs needs nothing from its network");
});

test("an unknown subnet is refused, as a default and on a target", () => {
  assert.throws(() => validateFrameworkConfig(config({ defaults: { lambda: lambdaDefaults, container: { subnet: "dmz" } } })), /defaults\.container\.subnet "dmz" is not a subnet/);
  assert.throws(() => containers(undefined, "dmz"), /cloud\.subnet "dmz"/);
});

test("assignPublicIp is retired on services and tasks in favor of cloud.subnet", () => {
  assert.throws(
    () => config({ services: [{ "/orders/*": { directory: "/ecs_containers/services/orders", methods: ["GET"], port: 8000, cloud: { assignPublicIp: true } } }] }),
    /declares "assignPublicIp"\. A container's place in the network is cloud\.subnet/,
  );
  assert.throws(
    () => config({ tasks: [{ job: { cloud: { assignPublicIp: false } } }] }),
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
    database: absentResources.rds.database,
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
    /declares database: true, but the config names no database\. Add database: resources\.<stack>\.<construct> to framework\.config\.ts/,
  );
  assert.throws(() => config({ http: [route("/orders", { database: "yes" })] }), /declares database "yes"\. It is true or left out/);
  assert.throws(() => config({ database: "rds" }), /database takes the catalog construct workloads connect to/);
  assert.throws(() => config({ database: resources.rds }), /database takes the catalog construct workloads connect to/);
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

test("vpc: true runs a Lambda in the network; defaults.lambda.vpc sets it for every Lambda; database: true implies it", () => {
  const vpcOf = (built: FrameworkConfig, id: string) => resolveLambdaTarget(built, id).vpc;
  assert.equal(vpcOf(config({ http: [route("/plain")] }), "plain"), false, "outside the VPC unless something says otherwise");
  assert.equal(vpcOf(config({ http: [route("/orders", { vpc: true })] }), "orders"), true);
  assert.equal(vpcOf(config({ http: [route("/orders", connected)] }), "orders"), true, "the database is in the VPC");

  const everywhere = config({
    defaults: { lambda: { ...lambdaDefaults, vpc: true } },
    http: [route("/orders"), route("/webhook", { vpc: false })],
  });
  assert.equal(vpcOf(everywhere, "orders"), true);
  assert.equal(vpcOf(everywhere, "webhook"), false, "an entry overrides the default");
  assert.equal(vpcOf(config({ defaults: { lambda: lambdaDefaults, http: { vpc: true } }, http: [route("/orders")] }), "orders"), true, "so does a section");
});

test("vpc is true or false, and cannot take a database user out of the VPC", () => {
  assert.throws(() => config({ http: [route("/orders", { vpc: "yes" })] }), /declares vpc "yes"\. It is true or false/);
  assert.throws(
    () => validateFrameworkConfig(config({ defaults: { lambda: { ...lambdaDefaults, vpc: "yes" } } })),
    /defaults\.lambda\.vpc "yes" is not true or false/,
  );
  assert.throws(
    () => config({ http: [route("/orders", { ...connected, vpc: false })] }),
    /declares database: true and vpc: false\. The database is in the VPC.*remove vpc: false/,
  );
});

test("vpc: true holds a Lambda to the VPC's rules: TypeScript only, and an event replays locally", () => {
  assert.throws(
    () => config({ http: [route("/orders", { vpc: true, runtime: "python3.13" })] }),
    /has vpc: true\. It is a python3\.13 Lambda, and only TypeScript Lambdas run inside the VPC: give it vpc: false/,
  );
  assert.doesNotThrow(
    () => config({ defaults: { lambda: { ...lambdaDefaults, vpc: true } }, http: [route("/orders", { vpc: false, runtime: "python3.13" })] }),
    "a cross-language Lambda opts out of a VPC default",
  );
  const event = (extra: Record<string, unknown>) => ({ "orders-created": { directory: "/lambda_functions/event_functions/orders-created", vpc: true, ...extra } });
  assert.throws(() => config({ events: [event({})] }), /has vpc: true, and a dev deployment builds no network\. AWS invokes this event in a dev deployment too.*localReplay: true/);
  assert.doesNotThrow(() => config({ events: [event({ localReplay: true })] }));
});
