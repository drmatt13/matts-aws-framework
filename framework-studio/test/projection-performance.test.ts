import assert from "node:assert/strict";
import test from "node:test";
import { createTargetAvailability, getFrameworkTargets, isTargetDeployed, isTargetEnabled, type FrameworkConfig } from "@repo/framework/config";
import { projectModel, targetLanes } from "../server/model/project";
import { lambdaSpec, withLambdaSpecs } from "../server/model/lambda-spec";

function fixture(size = 4): FrameworkConfig {
  return {
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: Object.fromEntries(Array.from({ length: size }, (_, index) => [`/fixture-${index}`, { directory: `/lambda_functions/http_functions/fixture-${index}`, methods: ["GET"], deploy: ["both", "local-only", "cloud-only", "none"][index % 4] }])),
    webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {},
  } as FrameworkConfig;
}

test("projection availability matches standalone canonical rules and complete lane bytes", () => {
  const config = fixture(), targets = getFrameworkTargets(config), availability = createTargetAvailability(config);
  for (const mode of ["dev", "prod"] as const) for (const webSocketApi of [false, true]) {
    const options = { mode, webSocketApi };
    const model = projectModel(config, options);
    assert.equal(model.status, "ok");
    assert.deepEqual(model.edges.map(edge => [edge.relation, edge.from, edge.to]), targets.map(target => ["routes", `route:http:/fixture-${target.id.slice("fixture-".length)}`, target.reference]));
    for (const target of targets) {
      assert.equal(availability.enabled(target.kind, target.id, "local"), isTargetEnabled(config, target.kind, target.id, "local"));
      assert.equal(availability.deployed(target.kind, target.id, mode, options), isTargetDeployed(config, target.kind, target.id, mode, options));
      assert.equal(JSON.stringify(model.targets.find(item => item.ref === target.reference)!.lanes), JSON.stringify(targetLanes(config, target, options)), "complete projected lanes equal the old standalone-predicate path");
    }
  }
});

test("large projections perform bounded normalization and fresh operations observe mutations", () => {
  const config = fixture(100), http = config.http;
  let enumerations = 0;
  Object.defineProperty(config, "http", { value: new Proxy(http, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } }) });
  const before = projectModel(config, { mode: "dev", webSocketApi: false });
  assert.ok(enumerations < 30, `whole-config discovery must be bounded, got ${enumerations}`);
  // Direct per-field lookups do not enumerate the declaration list. Complete
  // declaration discovery must stay constant as target count grows.
  const smaller = fixture(10), smallHttp = smaller.http;
  let smallEnumerations = 0;
  Object.defineProperty(smaller, "http", { value: new Proxy(smallHttp, { ownKeys(target) { smallEnumerations++; return Reflect.ownKeys(target); } }) });
  projectModel(smaller, { mode: "dev", webSocketApi: false });
  assert.equal(enumerations, smallEnumerations, "complete declaration discovery must not scale with target count");
  Object.assign(config.defaults.lambda, { memorySize: 512 });
  Object.assign(http["/fixture-0"], { deploy: "cloud-only" });
  const after = projectModel(config, { mode: "dev", webSocketApi: false });
  assert.equal(before.targets[0]!.compute.kind === "lambda" && before.targets[0]!.compute.memorySize, 128);
  assert.equal(after.targets[0]!.compute.kind === "lambda" && after.targets[0]!.compute.memorySize, 512);
  assert.equal(after.targets[0]!.lanes.local, false);
});

test("batch Lambda spec scope restores earlier state after failure and stays fresh next time", () => {
  const config = fixture(1);
  assert.equal(lambdaSpec(config, "fixture-0").memorySize, 128);
  Object.assign(config.defaults.lambda, { memorySize: 256 });
  assert.throws(() => withLambdaSpecs(config, () => { assert.equal(lambdaSpec(config, "fixture-0").memorySize, 256); throw new Error("controlled projection failure"); }), /controlled projection failure/);
  Object.assign(config.defaults.lambda, { memorySize: 512 });
  withLambdaSpecs(config, () => assert.equal(lambdaSpec(config, "fixture-0").memorySize, 512));
  assert.throws(() => withLambdaSpecs(config, () => lambdaSpec(config, "not-declared")), /not declared/);
});
