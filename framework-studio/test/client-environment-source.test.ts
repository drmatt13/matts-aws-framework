import assert from "./support/assert";
import { test } from "node:test";
import { parseClientMappings, rewriteClientMappings, validateClientMappings } from "../server/client-environment-source";
import { clientMappingsError, type ClientEnvironmentMappings } from "../shared/client-environment";
import type { ModeModel } from "../shared/model";

const text = '// header retained\nexport const clientEnvironment = {\n  // field retained\n  VITE_FIRST: { dev: { kind: "input", name: "PUBLIC_REGION" }, prod: { kind: "empty" } },\n  VITE_SECOND: { dev: { kind: "region", stack: "CognitoStack" }, prod: { kind: "empty" } }\n} as const;\n';

test("mapping source changes round trip additions, removal, URL controls and shared recipes without touching unrelated source", () => {
  const original = parseClientMappings(text).mappings;
  const next: ClientEnvironmentMappings = { VITE_FIRST: { dev: { kind: "endpoint", protocol: "https", host: "app.localhost", port: "LOCAL_API_DEV_SERVER_HOST_PORT" }, prod: { kind: "empty" } }, VITE_THIRD: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolId"], optional: true } };
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
  // Written the way an author would: unquoted keys, one line per recipe when it fits.
  assert.match(after, /^  VITE_THIRD: \{ kind: "output", stack: "CognitoStack", outputs: \["UserPoolId"\], optional: true \},?$/m);
  assert.match(after, /^  VITE_FIRST: \{\n    dev: \{ kind: "endpoint", protocol: "https", host: "app\.localhost", port: "LOCAL_API_DEV_SERVER_HOST_PORT" \},\n    prod: \{ kind: "empty" \},\n  \}/m);
  assert.ok(!after.includes('"kind"'));
});

test("a field is one recipe or one per environment, and where it is generated is never a switch", () => {
  assert.equal(clientMappingsError({ VITE_X: { kind: "input", name: "PUBLIC_REGION" } }), undefined);
  assert.equal(clientMappingsError({ VITE_X: { dev: { kind: "input", name: "PUBLIC_REGION" }, prod: { kind: "empty" } } }), undefined);
  assert.match(clientMappingsError({ VITE_X: { dev: { kind: "empty" } } })!, /\{ dev, prod \}/);
  assert.match(clientMappingsError({ VITE_X: { kind: "input", name: "PUBLIC_REGION", enabled: false } })!, /Remove enabled/);
});

test("client references reject expressions, duplicate names, unknown values, secrets and private outputs", () => {
  for (const source of ['export const clientEnvironment = { ...other };', 'export const clientEnvironment = { VITE_X: call() };', 'export const clientEnvironment = { VITE_X: {}, VITE_X: {} };']) assert.throws(() => parseClientMappings(source));
  assert.match(clientMappingsError({ VITE_X: { dev: { kind: "literal", value: "private-sentinel" }, prod: { kind: "empty" } } })!, /supported reference/);
  assert.match(clientMappingsError({ NOT_BROWSER: { dev: { kind: "empty" }, prod: { kind: "empty" } } })!, /VITE_/);
  assert.match(clientMappingsError({ VITE_X: { dev: { kind: "input", name: "OPENAI_API_KEY" }, prod: { kind: "empty" } } })!, /public CDK input/);
  const model: ModeModel = { mode: "dev", status: "ok", targets: [], routes: [], workflows: [], diagnostics: [], fields: {}, evaluatedInMs: 0, edges: [], resources: [{ id: "resource:private", kind: "secret", path: ["private"], fromEnv: "INTERNAL_VALUE", absent: false }] };
  assert.throws(() => validateClientMappings({ VITE_X: { dev: { kind: "input", name: "INTERNAL_VALUE" }, prod: { kind: "empty" } } }, [model]), /secret inputs/);
  assert.throws(() => validateClientMappings({ VITE_X: { dev: { kind: "input", name: "UNDECLARED" }, prod: { kind: "empty" } } }, [model]), /declared public input parameter/);
  assert.match(clientMappingsError({ VITE_X: { dev: { kind: "empty", when: { input: "OPENAI_API_KEY", equals: "true" } }, prod: { kind: "empty" } } })!, /public input parameter/);
  assert.throws(() => validateClientMappings({ VITE_X: { dev: { kind: "output", stack: "CognitoStack", outputs: ["PrivateSigningKey"] }, prod: { kind: "empty" } } }, [model]), /public stack output/);
});

test("renaming a field preserves source order and comments, including simultaneous per-mode changes", () => {
  const original = parseClientMappings(text).mappings;
  const renamed: ClientEnvironmentMappings = {
    VITE_RENAMED: { dev: { kind: "input", name: "PUBLIC_REGION" }, prod: { kind: "region", stack: "CognitoStack" } },
    VITE_SECOND: original.VITE_SECOND!,
  };
  const rewritten = rewriteClientMappings(text, renamed);
  assert.equal(JSON.stringify(parseClientMappings(rewritten).mappings), JSON.stringify(renamed));
  assert.ok(rewritten.includes("// field retained\n  VITE_RENAMED:"));
  const namesOnly = rewriteClientMappings(text, { VITE_RENAMED: original.VITE_FIRST!, VITE_SECOND: original.VITE_SECOND! });
  assert.equal(namesOnly, text.replace("VITE_FIRST", "VITE_RENAMED"));
  const combined = { VITE_RENAMED: renamed.VITE_RENAMED!, VITE_ADDED: original.VITE_SECOND! };
  assert.equal(JSON.stringify(parseClientMappings(rewriteClientMappings(text, combined)).mappings), JSON.stringify(combined));
  const addedAfterRename = { ...renamed, VITE_ADDED: original.VITE_SECOND! };
  assert.equal(JSON.stringify(parseClientMappings(rewriteClientMappings(text, addedAfterRename)).mappings), JSON.stringify(addedAfterRename));
});
