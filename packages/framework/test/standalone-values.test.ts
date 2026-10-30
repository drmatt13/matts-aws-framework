import assert from "node:assert/strict";
import test from "node:test";
import { defineResources, resource, referenceForGraph, resolveInput, resolveResourceReference, resolveResourceFromEnv, deployInputsFrom } from "../src/config";
import { assertDeploySetting } from "../src/config/deploy";

test("standalone values resolve without environment, context, or a lane's linked resolver", () => {
  const resources = defineResources({ enabled: resource.value("true", { tags: { area: "realtime" } }).enum("true", "false") });
  assert.equal(resources.enabled.authoredValue, "true");
  assert.equal(resources.enabled.fromEnv, undefined);
  assert.equal(resources.enabled.default, undefined);
  assert.equal(resources.enabled.optional, false);
  assert.deepEqual(resources.enabled.tags, { area: "realtime" });
  const readers = { getContext: () => { throw new Error("Unexpected context read"); }, env: { ENABLED: "false" } };
  assert.deepEqual(resolveInput(resources.enabled, readers), { state: "supplied", value: "true" });
  assert.equal(resolveResourceFromEnv(resources.enabled, readers, "fixture"), "true");
  assert.equal(resolveResourceReference(resources.enabled, () => { throw new Error("Unexpected linked resolver"); }, "fixture"), "true");
  assert.doesNotThrow(() => assertDeploySetting({ when: { resource: resources.enabled, equals: "true" } }, "fixture"));
  assert.equal(deployInputsFrom(readers).holds({ resource: resources.enabled, equals: "true" }, "fixture"), true);
  assert.equal(deployInputsFrom(readers).holds({ resource: resources.enabled, equals: "false" }, "fixture"), false);
});

test("standalone graph values and presence stay independent without defaults", () => {
  const declaration = resource.value({ dev: "off", prod: "on" }).enum("on", "off");
  const dev = defineResources({ enabled: declaration }, { mode: "dev" }).enabled;
  assert.equal(dev.authoredValue, "off");
  assert.equal(referenceForGraph(dev, "prod").authoredValue, "on");
  assert.equal(referenceForGraph(dev, "prod").default, undefined);
  const onlyDev = defineResources({ enabled: resource.value({ dev: "on" }).only("dev") }, { mode: "prod" }).enabled;
  assert.equal(onlyDev.absent, true);
  assert.equal(onlyDev.authoredValue, undefined);
  assert.deepEqual(resolveInput(onlyDev, {}), { state: "not-applicable" });
  assert.equal(resolveResourceFromEnv(onlyDev, {}, "fixture"), undefined);
  assert.equal(referenceForGraph(onlyDev, "dev").authoredValue, "on");
  assert.throws(() => defineResources({ enabled: resource.value({ dev: "on" }) }, { mode: "prod" }), /needs a standalone value/);
  assert.throws(() => defineResources({ enabled: declaration }), /catalog has to know/);
});

test("standalone declarations reject blank, incompatible and fallback-only policies", () => {
  assert.throws(() => resource.value(" "), /non-blank/);
  assert.throws(() => resource.value({} as never), /resource.value/);
  assert.throws(() => resource.value({ staging: "yes" } as never), /resource.value/);
  assert.throws(() => resource.value("other").enum("on", "off"), /not one of/);
  assert.throws(() => (resource.value("on") as unknown as { default(value: string): unknown }).default("off"), /value, not a default/);
  assert.throws(() => (resource.value("on") as unknown as { required(): unknown }).required(), /already declares its value/);
  const typeChecks = () => {
    // @ts-expect-error Standalone inputs have a value, never a fallback.
    resource.value("on").default("off");
    // @ts-expect-error A standalone value needs no external requirement policy.
    resource.value("on").required();
  };
  assert.equal(typeof typeChecks, "function");
});
