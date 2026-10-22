import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig, defineNetwork, defineResources, getFrameworkTargets,
  MAX_DECLARATION_TAGS, mergeTags, resource, validateTags, workflow, succeed,
} from "@repo/framework/config";

const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } } } as const;

test("tags are immutable AWS string metadata, with protected ownership and useful diagnostics", () => {
  const authored = { area: "Billing / invoices", empty: "", "owner:team": "Finance" };
  assert.deepEqual(validateTags(authored), authored);
  assert.ok(Object.isFrozen(validateTags(authored)));
  for (const key of ["aws:x", "AWS:x", "framework:deployment", "Framework:owner", "ManagedBy"]) assert.throws(() => validateTags({ [key]: "changed" }, "events.job"), /events.job.*reserved/);
  assert.throws(() => validateTags(JSON.parse('{"__proto__":"discarded-by-object-literals"}')), /__proto__.*TypeScript object literal/);
  for (const value of [{ area: 12 }, { area: null }, { area: { secretArn: "x" } }, { area: "line\nbreak" }, { ["x".repeat(129)]: "x" }, { area: "x".repeat(257) }]) assert.throws(() => validateTags(value));
  assert.throws(() => validateTags(Object.fromEntries(Array.from({ length: MAX_DECLARATION_TAGS + 1 }, (_, i) => [`key${i}`, "x"]))), /at most 46/);
  assert.deepEqual(mergeTags("member", { area: "platform", owner: "infra" }, { area: "billing" }), { area: "billing", owner: "infra" });
});

test("stack and input declarations preserve own versus effective tags and typed member paths", () => {
  type Data = { readonly bucket: { readonly node: { readonly id: string; readonly path: string }; readonly bucketName: string }; readonly endpoint: string };
  const catalog = defineResources({
    data: resource.stack<Data>({ tags: { area: "data", owner: "infra" }, members: { bucket: { tags: { area: "billing" } }, endpoint: { tags: { purpose: "configuration" } } } }),
    setting: resource.fromEnv("SETTING", { tags: { area: "models" } }).default("default"),
    secret: resource.secret("SECRET", { tags: { area: "billing" } }),
  });
  const path: readonly ["data", "bucket"] = catalog.data.bucket.path;
  assert.deepEqual(path, ["data", "bucket"]);
  assert.deepEqual(catalog.data.bucket.tags, { area: "billing" });
  assert.deepEqual(catalog.data.bucket.effectiveTags, { area: "billing", owner: "infra" });
  assert.deepEqual(catalog.data.endpoint.effectiveTags, { area: "data", owner: "infra", purpose: "configuration" });
  assert.deepEqual(catalog.secret.arn.tags, { area: "billing" });
  assert.deepEqual(catalog.secret.value.tags, { area: "billing" });
  assert.deepEqual(catalog.setting.tags, { area: "models" });
  // @ts-expect-error A stack's member metadata uses actual public field names.
  resource.stack<Data>({ members: { missing: { tags: {} } } });
});

test("route aliases agree before compute is tagged; tags never enter target identity", () => {
  const route = { directory: "/lambda_functions/http_functions/shared", methods: ["GET"], tags: { area: "billing" } } as const;
  const config = defineFrameworkConfig({ defaults, http: [{ "/first": route }, { "/second": route }], webSocket: [], services: [], events: [] });
  const key: "/first" | "/second" = "/first" as keyof typeof config.http;
  assert.equal(key, "/first");
  assert.equal(getFrameworkTargets(config).length, 1);
  assert.deepEqual(getFrameworkTargets(config)[0]!.tags, { area: "billing" });
  assert.throws(() => defineFrameworkConfig({ defaults, http: [{ "/first": route }, { "/second": { ...route, tags: { area: "other" } } }], webSocket: [], services: [], events: [] }), /conflicting tags.*sharing compute/);
  assert.throws(() => defineFrameworkConfig({ defaults, http: [{ "/first": route }, { "/first": route }], webSocket: [], services: [], events: [] }), /declares.*twice/);
});

test("network and workflow tags remain declaration metadata", () => {
  assert.deepEqual(defineNetwork({ id: "one", cidr: "10.0.0.0/16", zones: 2, tags: { area: "platform" } }).tags, { area: "platform" });
  const graph = workflow(() => succeed(), { timeoutSeconds: 30, tags: { area: "billing" } });
  const config = defineFrameworkConfig({ defaults, http: [], webSocket: [], services: [], events: [], workflows: [{ billing: graph }] });
  assert.deepEqual(getFrameworkTargets(config)[0]!.tags, { area: "billing" });
});
