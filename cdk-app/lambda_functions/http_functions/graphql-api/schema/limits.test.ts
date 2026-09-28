import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NoSchemaIntrospectionCustomRule,
  parse,
  specifiedRules,
  validate,
} from "graphql";
import manifest from "../../../../../client-app/src/api/generated/persisted-documents.json";
import {
  MAX_QUERY_ALIASES,
  MAX_QUERY_DEPTH,
  maxAliasesRule,
  maxDepthRule,
} from "../lib/hardening";
import { resolvePersistedDocument } from "../lib/persisted-documents";
import { schema } from "./index";

const rules = [
  ...specifiedRules,
  maxDepthRule(MAX_QUERY_DEPTH),
  maxAliasesRule(MAX_QUERY_ALIASES),
  NoSchemaIntrospectionCustomRule,
];
const errorsFor = (source: string) =>
  validate(schema, parse(source), rules).map((error) => error.message);

test("every operation the client ships passes the production limits", () => {
  for (const document of Object.values(manifest as Record<string, string>)) {
    assert.deepEqual(errorsFor(document), [], document);
  }
});

test("aliases beyond the limit are refused", () => {
  const aliased = Array.from(
    { length: MAX_QUERY_ALIASES + 1 },
    (_, index) => `a${index}: projects { id }`,
  ).join(" ");
  assert.match(errorsFor(`{ ${aliased} }`).join(), /aliases; the limit is/);
});

test("depth counts through fragments and stops at the limit", () => {
  // Shape only: the depth rule runs alone, so the fields need not exist.
  const depthErrors = (levels: number) => {
    let selection = "id";
    for (let level = 1; level < levels; level += 1) selection = `a { ${selection} }`;
    const source = `{ ...Deep } fragment Deep on Query { ${selection} }`;
    return validate(schema, parse(source), [maxDepthRule(MAX_QUERY_DEPTH)]);
  };
  assert.equal(depthErrors(MAX_QUERY_DEPTH).length, 0);
  assert.match(
    depthErrors(MAX_QUERY_DEPTH + 1).map((error) => error.message).join(),
    /11 levels deep; the limit is 10/,
  );
});

test("introspection is refused where the explorer is off", () => {
  assert.match(errorsFor("{ __schema { types { name } } }").join(), /introspection/i);
});

test("a persisted-documents-only server executes the manifest's copy", () => {
  const [hash, document] = Object.entries(manifest as Record<string, string>)[0]!;
  const resolved = resolvePersistedDocument(
    JSON.stringify({
      query: "{ somethingElse }",
      extensions: { persistedQuery: { version: 1, sha256Hash: hash.replace("sha256:", "") } },
    }),
  );
  assert.equal(JSON.parse(resolved!).query, document);
  assert.equal(resolvePersistedDocument(JSON.stringify({ query: "{ projects { id } }" })), null);
  assert.equal(resolvePersistedDocument("not json"), null);
});
