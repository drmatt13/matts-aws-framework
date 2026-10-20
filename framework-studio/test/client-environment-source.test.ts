import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMappings, rewriteClientMappings, validateClientMappings } from "../server/client-environment-source";
import { clientMappingsError, type ClientEnvironmentMappings } from "../shared/client-environment";
import type { ModeModel } from "../shared/model";

const text = '// header retained\nexport const clientEnvironment = {\n  // field retained\n  VITE_FIRST: { dev: { kind: "input", name: "PUBLIC_REGION" }, prod: { kind: "empty" } },\n  VITE_SECOND: { dev: { kind: "region", stack: "CognitoStack" }, prod: { kind: "empty" } }\n} as const;\n';

test("mapping source changes round trip additions, removal, URL controls and per-mode toggles without touching unrelated source", () => {
  const original = parseClientMappings(text).mappings;
  const next: ClientEnvironmentMappings = { VITE_FIRST: { ...original.VITE_FIRST!, dev: { kind: "endpoint", protocol: "https", host: "app.localhost", port: "LOCAL_API_DEV_SERVER_HOST_PORT", enabled: false } }, VITE_THIRD: { dev: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolId"], optional: true }, prod: { kind: "empty" } } };
  const after = rewriteClientMappings(text, next);
  assert.equal(JSON.stringify(parseClientMappings(after).mappings), JSON.stringify(next));
  assert.ok(after.startsWith("// header retained"));
  assert.ok(after.includes("// field retained"));
  assert.ok(!after.includes("VITE_SECOND"));
  assert.equal(rewriteClientMappings(text, original), text, "unchanged drafts preserve every byte");
  const added = rewriteClientMappings(text, { ...original, VITE_THIRD: next.VITE_THIRD! });
  assert.equal(JSON.stringify(parseClientMappings(added).mappings), JSON.stringify({ ...original, VITE_THIRD: next.VITE_THIRD! }), "adding after a property without a trailing comma is valid");
  const empty = rewriteClientMappings(text, {});
  assert.deepEqual(Object.keys(parseClientMappings(empty).mappings), []);
});

test("client references reject expressions, duplicate names, unknown values, secrets and private outputs", () => {
  for (const source of ['export const clientEnvironment = { ...other };', 'export const clientEnvironment = { VITE_X: call() };', 'export const clientEnvironment = { VITE_X: {}, VITE_X: {} };']) assert.throws(() => parseClientMappings(source));
  assert.match(clientMappingsError({ VITE_X: { dev: { kind: "literal", value: "private-sentinel" }, prod: { kind: "empty" } } })!, /supported reference/);
  assert.match(clientMappingsError({ NOT_BROWSER: { dev: { kind: "empty" }, prod: { kind: "empty" } } })!, /VITE_/);
  assert.match(clientMappingsError({ VITE_X: { dev: { kind: "input", name: "OPENAI_API_KEY" }, prod: { kind: "empty" } } })!, /public CDK input/);
  const model: ModeModel = { mode: "dev", status: "ok", targets: [], routes: [], workflows: [], diagnostics: [], fields: {}, evaluatedInMs: 0, edges: [], resources: [{ id: "resource:private", kind: "secret", path: ["private"], fromEnv: "INTERNAL_VALUE", absent: false }] };
  assert.throws(() => validateClientMappings({ VITE_X: { dev: { kind: "input", name: "INTERNAL_VALUE" }, prod: { kind: "empty" } } }, [model]), /secret inputs/);
  assert.throws(() => validateClientMappings({ VITE_X: { dev: { kind: "output", stack: "CognitoStack", outputs: ["PrivateSigningKey"] }, prod: { kind: "empty" } } }, [model]), /public stack output/);
});
