import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig, defineResources, resource, deployInputsFrom, getFrameworkTargets,
  getCloudTargets, getLocalTargets, getHttpRoutes, getWebSocketRoutesIn, getWebSocketAuthorizerIn,
  createTargetAvailability, isTargetEnabled, getEventReplayManifest, runsTask, type FrameworkConfig, type FrameworkConfigInput,
} from "../src/config/index";
import { defaults } from "../../../framework-config/defaults";
import { applicationVpc } from "../../../framework-config/networks/application";

const resources = defineResources({ enabled: resource.fromEnv("ENABLED").enum("yes", "no"), defaulted: resource.fromEnv("DEFAULTED").enum("yes", "no").default("no"), secret: resource.secret("SECRET") });
const when = { resource: resources.enabled, equals: "yes" };
const on = deployInputsFrom({ env: { ENABLED: "YES" } });
const off = deployInputsFrom({ env: { ENABLED: "no" } });
const unset = deployInputsFrom({ env: {} });
const config = (overrides: Partial<FrameworkConfigInput> = {}): FrameworkConfig => defineFrameworkConfig({ defaults, networks: [applicationVpc], resources, http: [], webSocket: [], events: [], services: [], ...overrides } as never);
const route = { directory: "/test/fixtures/conditional", methods: ["GET"], deploy: { when } };

test("conditions resolve context, authored environment, defaults, canonical enums and optional absence", () => {
  assert.equal(on.holds(when, "fixture"), true);
  assert.equal(off.holds(when, "fixture"), false);
  assert.equal(unset.holds(when, "fixture"), false);
  assert.equal(deployInputsFrom({ env: { ENABLED: "no" }, getContext: () => " yes " }).holds(when, "fixture"), true);
  assert.equal(unset.holds({ resource: resources.defaulted, equals: "no" }, "fixture"), true);
  assert.throws(() => deployInputsFrom({ env: { ENABLED: "invalid-private-value" } }).holds(when, "fixture"), /must be one of/);
  const text = defineResources({ input: resource.fromEnv("INPUT") });
  assert.throws(() => deployInputsFrom({ env: { INPUT: "${Token[TOKEN.123]}" } }).holds({ resource: text.input, equals: "yes" }, "fixture"), /concrete input/);
});

test("normalization never reads inputs, and every conditional query requires its lane", () => {
  const built = config({ http: [{ "/conditional": route }] } as never);
  assert.equal(getFrameworkTargets(built).length, 1);
  assert.throws(() => getHttpRoutes(built, "local"), /explicit deployment inputs/);
  assert.throws(() => isTargetEnabled(built, "lambda", "conditional", "cloud"), /explicit deployment inputs/);
  assert.equal(getLocalTargets(built, ["http"], on).length, 1);
  assert.equal(getCloudTargets(built, ["http"], "prod", { inputs: off }).length, 0);
  assert.equal(getHttpRoutes(built, "local", unset).length, 0);
  assert.equal(getLocalTargets(built, ["http"], "unconditioned").length, 1);
  const available = createTargetAvailability(built);
  assert.equal(available.enabled("lambda", "conditional", "local", on), true);
  assert.equal(available.deployed("lambda", "conditional", "prod", { inputs: off }), false);
});

test("selectors must be declared, present fromEnv strings and equals must be canonical", () => {
  for (const deploy of ["typo", { when: { resource: resources.secret, equals: "yes" } }, { when: { resource: resources.secret.arn, equals: "yes" } }, { when: { ...when, equals: "YES" } }, { when: { ...when, equals: "" } }, { when, other: true }]) {
    assert.throws(() => config({ http: [{ "/conditional": { ...route, deploy } }] } as never), /deploy/);
  }
  const unrelated = defineResources({ other: resource.fromEnv("OTHER") });
  assert.throws(() => config({ http: [{ "/conditional": { ...route, deploy: { when: { resource: unrelated.other, equals: "yes" } } } }] } as never), /not declared|absent|catalog/);
});

test("shared routes compare condition data rather than object identity", () => {
  const alias = { ...route, deploy: { when: { resource: resources.enabled, equals: "yes" } } };
  assert.equal(getFrameworkTargets(config({ http: [{ "/first": route, "/second": alias }] } as never)).length, 1);
  assert.throws(() => config({ http: [{ "/first": route, "/second": { ...alias, deploy: { when: { ...when, equals: "no" } } } }] } as never), /deploy settings agree/);
});

test("a conditional destination accepts only callers with the same condition", () => {
  const tasks = [{ worker: { directory: "/test/fixtures/worker", deploy: { when }, cloud: { vpc: applicationVpc } } }];
  const caller = { ...route, cloud: { bindings: [runsTask("worker")] } };
  assert.doesNotThrow(() => config({ http: [{ "/call": caller }], tasks } as never));
  assert.throws(() => config({ http: [{ "/call": { ...caller, deploy: "both" } }], tasks } as never), /identical condition/);
  assert.throws(() => config({ http: [{ "/call": { ...caller, deploy: { when: { ...when, equals: "no" } } } }], tasks } as never), /identical condition/);
  assert.doesNotThrow(() => config({ http: [{ "/call": caller }], tasks: [{ worker: { ...tasks[0]!.worker, deploy: "both" } }] } as never));
});

test("WebSocket conditions filter routes and keep every active route behind its authorizer", () => {
  const websocket = { $connect: { directory: "/test/fixtures/connect", deploy: { when }, authorizer: { directory: "/test/fixtures/authorizer", deploy: { when }, environment: { USER_POOL_ID: "pool", USER_POOL_CLIENT_ID: "client" } } }, $default: { directory: "/test/fixtures/default", deploy: { when } } };
  const built = config({ webSocket: [websocket] } as never);
  assert.deepEqual(Object.keys(getWebSocketRoutesIn(built, "cloud", on)), ["$connect", "$default"]);
  assert.deepEqual(getWebSocketRoutesIn(built, "local", off), {});
  assert.equal(getWebSocketAuthorizerIn(built, "local", unset), undefined);
  assert.equal(getWebSocketAuthorizerIn(built, "cloud", on), "lambda:authorizer");
  assert.throws(() => config({ webSocket: [{ ...websocket, $default: { ...websocket.$default, deploy: "both" } }] } as never), /inside \$connect/);
  assert.throws(() => config({ webSocket: [{ ...websocket, $connect: { ...websocket.$connect, deploy: "both" } }] } as never), /inside its authorizer/);
});

test("tools inherit a shared condition, and retain the union for different agent conditions", () => {
  const agent = { directory: "/agents/first", deploy: { when }, tools: ["conditional-tool"] };
  const built = config({ agents: [{ first: agent }], tools: [{ "conditional-tool": { directory: "/test/fixtures/conditional-tool" } }] } as never);
  assert.equal(getCloudTargets(built, ["agent", "tool"], "prod", { inputs: off }).length, 0);
  assert.equal(getCloudTargets(built, ["agent", "tool"], "prod", { inputs: on }).length, 2);
  const shared = config({ agents: [{ first: agent, second: { ...agent, directory: "/agents/second", deploy: { when: { ...when, equals: "no" } } } }], tools: [{ "conditional-tool": { directory: "/test/fixtures/conditional-tool" } }] } as never);
  assert.equal(getCloudTargets(shared, ["tool"], "prod", { inputs: off }).length, 1);
});

test("event deployment filters both AWS graphs, local execution and replay", () => {
  for (const deploy of ["none", "local-only", "cloud-only", "both", { when }] as const) {
    const built = config({ events: [{ event: { directory: "/test/fixtures/event", deploy, localReplay: true } }] } as never);
    for (const mode of ["dev", "prod"] as const) {
      assert.equal(getCloudTargets(built, ["event"], mode, { inputs: on }).length, deploy === "none" || deploy === "local-only" ? 0 : 1);
    }
    assert.equal(Object.keys(getEventReplayManifest(built, on)).length, deploy === "both" || typeof deploy !== "string" ? 1 : 0);
    if (typeof deploy !== "string") {
      assert.equal(getCloudTargets(built, ["event"], "dev", { inputs: off }).length, 0);
      assert.equal(getLocalTargets(built, ["event"], off).length, 0);
      assert.deepEqual(getEventReplayManifest(built, off), {});
    }
  }
});

test("networked AWS events cannot disable the local lane required for replay", () => {
  const event = { directory: "/test/fixtures/event", subnet: "private", vpc: applicationVpc, localReplay: true };
  assert.throws(() => config({ events: [{ event: { ...event, deploy: "cloud-only" } }] } as never), /enable the local deployment lane/);
  assert.doesNotThrow(() => config({ events: [{ event: { ...event, deploy: "local-only", localReplay: undefined } }] } as never));
});

test("explicit tool deployment overrides inference and keeps active callers valid", () => {
  const tools = [{ tool: { directory: "/test/fixtures/tool", deploy: { when } } }];
  const built = config({ tools } as never);
  assert.equal(getLocalTargets(built, ["tool"], on).length, 1);
  assert.equal(getCloudTargets(built, ["tool"], "prod", { inputs: off }).length, 0);
  assert.throws(() => config({ tools, agents: [{ caller: { directory: "/agents/caller", tools: ["tool"] } }] } as never), /identical condition/);
  assert.doesNotThrow(() => config({ tools, agents: [{ caller: { directory: "/agents/caller", tools: ["tool"], deploy: { when } } }] } as never));
});
