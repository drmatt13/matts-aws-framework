import { applicationVpc as fixtureVpc } from "../../../framework-config/networks/application";
import assert from "node:assert/strict";
import test from "node:test";
import { assertRequirementsMet, defineFrameworkConfig, defineResources, getFrameworkTargets, referenceForGraph, resolveInput, resource, resolveCloudValues, type ResourceReference } from "../src/config";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { defaults } from "../../../framework-config/defaults";

test("catalog required flags become consumer requirements for parameters and secret ARN projections", async () => {
  const prefix = resource.fromEnv("REQUIRED_INPUT");
  const resources = defineResources({ input: prefix.required(), optional: prefix, key: resource.secret("REQUIRED_KEY").required() });
  assert.equal(resources.optional.required, undefined, "builder prefixes are immutable");
  assert.equal(resources.key.arn.required, true);
  const config = defineFrameworkConfig({ networks: [fixtureVpc], resources, defaults, http: [{ "/fixture": { directory: "/lambda_functions/http_functions/required-fixture", methods: ["GET"], environment: { INPUT: resources.input, KEY_ARN: resources.key.arn } } }], webSocket: [], events: [], services: [] });
  const target = getFrameworkTargets(config)[0]!;
  assert.deepEqual(target.cloud.requirements.map((rule) => rule.require[0]!.path), [["input"], ["key"]]);
  assert.throws(() => assertRequirementsMet(target.cloud.requirements, { select: () => undefined, supplied: () => false }, "fixture"), /required/);
  const arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:fixture-AbCdEf";
  const resolve = (reference: ResourceReference) => reference.kind === "secret" ? { secretArn: arn } : reference.secretArn ? arn : "provided";
  assert.equal(resolveCloudValues(target, resolve, "fixture").environment.INPUT, "provided");
  const localConfig = defineFrameworkConfig({ networks: [fixtureVpc], resources, defaults, http: [{ "/fixture": { directory: "/lambda_functions/http_functions/required-fixture", methods: ["GET"], environment: { INPUT: resources.input } } }], webSocket: [], events: [], services: [] });
  await assert.rejects(resolveLocalWorkloadEnvironment(localConfig, target.reference, { repositoryRoot: ".", authored: {}, environment: {} }), /required/);
  assert.equal((await resolveLocalWorkloadEnvironment(localConfig, target.reference, { repositoryRoot: ".", authored: { REQUIRED_INPUT: "provided" }, environment: {} })).INPUT, "provided");
});

test("an input states how the two graphs differ, and each graph resolves its own answer", async () => {
  const catalog = () => ({
    port: resource.fromEnv("FIXTURE_PORT").only("dev").required(),
    key: resource.secret("FIXTURE_KEY").required("prod"),
    provider: resource.fromEnv("FIXTURE_PROVIDER").enum("local", "cloud").default({ dev: "local", prod: "cloud" }),
    shared: resource.fromEnv("FIXTURE_SHARED").default("same").required(),
  });
  const dev = defineResources(catalog(), { mode: "dev" });
  const prod = defineResources(catalog(), { mode: "prod" });
  assert.equal(dev.port.absent, undefined);
  assert.equal(dev.port.required, true);
  assert.equal(prod.port.absent, true, ".only(\"dev\") leaves production without it");
  assert.equal(prod.port.required, undefined, "an absent input requires nothing");
  assert.equal(prod.port.fromEnv, "FIXTURE_PORT", "an absent input keeps its identity for readers of the other graph");
  assert.equal(dev.key.required, undefined);
  assert.equal(prod.key.required, true);
  assert.equal(prod.key.arn.required, true, "the ARN projection follows its secret's graph");
  assert.equal(dev.provider.default, "local");
  assert.equal(prod.provider.default, "cloud");
  assert.equal(prod.provider.optional, false);
  assert.deepEqual(prod.provider.modes, { dev: { present: true, required: false, default: "local" }, prod: { present: true, required: false, default: "cloud" } });
  assert.equal(dev.shared.modes, undefined, "a declaration that is the same in both graphs carries no per-graph copy");
  assert.deepEqual(dev.shared, prod.shared);

  // A workload reads one graph's answer; production never sees a development-only input.
  const config = (resources: typeof dev) => defineFrameworkConfig({ networks: [fixtureVpc], resources, defaults, http: [{ "/fixture": { directory: "/lambda_functions/http_functions/required-fixture", methods: ["GET"], environment: { PORT: resources.port, KEY_ARN: resources.key.arn } } }], webSocket: [], events: [], services: [] });
  const devTarget = getFrameworkTargets(config(dev))[0]!;
  const prodTarget = getFrameworkTargets(config(prod))[0]!;
  assert.deepEqual(devTarget.cloud.requirements.map((rule) => rule.require[0]!.path), [["port"]]);
  assert.deepEqual(prodTarget.cloud.requirements.map((rule) => rule.require[0]!.path), [["key"]]);
  assert.equal((await resolveLocalWorkloadEnvironment(config(dev), devTarget.reference, { repositoryRoot: ".", authored: { FIXTURE_PORT: "8080" }, environment: {} })).PORT, "8080");
  const arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:fixture-AbCdEf";
  const resolve = (reference: ResourceReference) => reference.secretArn ? arn : "8080";
  const deployed = resolveCloudValues(prodTarget, resolve, "fixture").environment;
  assert.equal(deployed.PORT, undefined, "production never sees a development-only input");
  assert.equal(deployed.KEY_ARN, arn);
});

test("per-graph settings are refused where they contradict, and a catalog that differs by graph must name its graph", () => {
  assert.throws(() => defineResources({ port: resource.fromEnv("FIXTURE_PORT").only("dev").required("prod") }, { mode: "dev" }), /only\("dev"\), so it has no prod graph to be required in/);
  assert.throws(() => defineResources({ port: resource.fromEnv("FIXTURE_PORT").default({ prod: "1" }).only("dev") }, { mode: "dev" }), /given a default/);
  assert.throws(() => resource.fromEnv("FIXTURE_PORT").only("staging" as "dev"), /takes "dev" or "prod"/);
  assert.throws(() => resource.fromEnv("FIXTURE_PROVIDER").enum("a", "b").default({ dev: "c" as "a" }), /not one of a, b/);
  assert.throws(() => resource.fromEnv("FIXTURE_PROVIDER").default({ dev: "c" }).enum("a", "b"), /not one of a, b/);
  assert.throws(() => resource.fromEnv("FIXTURE_PROVIDER").default({} as { dev: string }), /one per graph/);
  assert.throws(() => resource.fromEnv("FIXTURE_PROVIDER").default({ dev: " " }), /blank/);
  assert.throws(() => defineResources({ port: resource.fromEnv("FIXTURE_PORT").only("dev") }), /FRAMEWORK_MODE/);
  assert.doesNotThrow(() => defineResources({ port: resource.fromEnv("FIXTURE_PORT").default("1").required() }), "a catalog the same in both graphs needs no mode");
  assert.equal(defineResources({ port: resource.fromEnv("FIXTURE_PORT").only("dev").default("1") }, { mode: "dev" }).port.default, "1", "a plain default applies wherever the input is");
});

test("one resolver states every input's outcome per graph, and never borrows the other graph's", () => {
  const catalog = (mode: "dev" | "prod") => defineResources({
    port: resource.fromEnv("FIXTURE_PORT").only("dev").required(),
    key: resource.fromEnv("FIXTURE_FLAG").enum("on", "off").default({ dev: "on" }).required("prod"),
    plain: resource.fromEnv("FIXTURE_PLAIN"),
  }, { mode });
  const dev = catalog("dev"), prod = catalog("prod");
  const files = { dev: { FIXTURE_PORT: "8080", FIXTURE_FLAG: " " }, prod: { FIXTURE_PORT: "9090", FIXTURE_PLAIN: "x" } };
  assert.deepEqual(resolveInput(dev.port, { env: files.dev }), { state: "supplied", value: "8080" });
  assert.deepEqual(resolveInput(prod.port, { env: files.prod }), { state: "not-applicable" }, "a line in a file the input is not declared for is never read");
  assert.deepEqual(resolveInput(dev.key, { env: files.dev }), { state: "fallback", value: "on" }, "a blank line counts as unset");
  assert.deepEqual(resolveInput(prod.key, { env: files.prod }), { state: "missing" }, "development's default never answers for production");
  assert.deepEqual(resolveInput(prod.key, { env: { FIXTURE_FLAG: "ON" } }), { state: "supplied", value: "on" });
  assert.deepEqual(resolveInput(prod.key, { env: { FIXTURE_FLAG: "maybe" } }), { state: "invalid", value: "maybe" });
  assert.deepEqual(resolveInput(prod.key, { env: { FIXTURE_FLAG: "off" }, getContext: (key) => key === "fixtureFlag" ? "on" : undefined }), { state: "supplied", value: "on" }, "a -c override wins over the file");
  assert.deepEqual(resolveInput(dev.plain, { env: files.dev }), { state: "unresolved" });
  // A reference resolved for one graph can be read as the other graph resolves it.
  assert.deepEqual(resolveInput(referenceForGraph(dev.key, "prod"), { env: files.prod }), resolveInput(prod.key, { env: files.prod }));
  assert.deepEqual(resolveInput(referenceForGraph(dev.port, "prod"), { env: files.prod }), { state: "not-applicable" });
  assert.equal(referenceForGraph(dev.plain, "prod"), dev.plain, "a declaration the same in both graphs is already each graph's answer");
});
