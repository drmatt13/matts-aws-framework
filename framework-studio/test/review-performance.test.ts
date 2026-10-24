import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionSignature } from "../server/edits/batch";
import type { ModelEdge } from "../shared/model";

const grant: ModelEdge = { id: "grant:lambda:read->resource:store.bucket#0", relation: "grant", from: "lambda:read", to: "resource:store.bucket", provenance: "declared", label: 'grantRead("tenant/*")', detail: 'resources.store.bucket.grantRead("tenant/*")' };

test("source evidence cannot turn an unchanged binding into a type-check dependency", () => {
  const enriched: ModelEdge = { ...grant, evidence: [{ role: "declared", location: { file: "framework-config/http.ts", line: 2, column: 1, start: 10, end: 20 }, excerpt: 'bindings: [resources.store.bucket.grantRead("…")]' }] };
  assert.equal(connectionSignature({ edges: [grant] }), connectionSignature({ edges: [enriched] }));
  assert.equal(connectionSignature({ edges: [enriched] }), connectionSignature({ edges: [{ ...enriched, evidence: [] }] }));
});

test("binding identity, destination, permission, scope and invocation changes still require validation", () => {
  const baseline = connectionSignature({ edges: [grant] });
  for (const change of [{ to: "resource:other.bucket" }, { label: 'grantWrite("tenant/*")' }, { detail: 'resources.store.bucket.grantRead("other/*")' }, { relation: "runsTask" as const }, { from: "lambda:other" }, { provenance: "derived" as const }]) {
    assert.notEqual(connectionSignature({ edges: [{ ...grant, ...change }] }), baseline);
  }
  assert.notEqual(connectionSignature({ edges: [] }), baseline);
  assert.notEqual(connectionSignature({ edges: [grant, { ...grant, id: "second" }] }), baseline);
});

test("native source inferences remain separate from declared binding validation", () => {
  assert.equal(connectionSignature({ edges: [grant] }), connectionSignature({ edges: [grant, { ...grant, id: "native", provenance: "source" }] }));
});
