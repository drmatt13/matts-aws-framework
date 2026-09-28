import assert from "node:assert/strict";
import test from "node:test";
import jsonata from "jsonata";
import {
  DocumentMarshallingError,
  marshalDocument,
  marshalDocumentExpression,
  marshalValue,
  marshalValueExpression,
  unmarshalDocument,
  unmarshalDocumentExpression,
  type AttributeMap,
} from "@repo/framework/config";

/**
 * The DynamoDB document boundary, checked in both directions and both lanes.
 *
 * The same document is marshalled by the local functions and by the JSONata the
 * compiler emits, and the two results are compared. That is the only check that
 * actually holds the property this file exists for: a workflow must store the
 * same shape whether it ran on a laptop or as a state machine.
 */

async function evaluate(expression: string, doc: unknown): Promise<unknown> {
  const result = await jsonata(expression).evaluate({}, { doc });
  return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as unknown);
}

const DOCUMENTS: readonly Record<string, unknown>[] = [
  { name: "a" },
  { count: 0, negative: -12.5 },
  { flag: true, off: false },
  { missing: null },
  { items: [] },
  { items: [1, "two", true, null] },
  { nested: { deep: { deeper: "value" } } },
  { listOfMaps: [{ id: "a" }, { id: "b" }] },
  { empty: {} },
  { "content-type": "application/json", "0": "numeric-looking key" },
  { unicode: "naïve — ✓", quoted: 'he said "hi"' },
];

for (const document of DOCUMENTS) {
  const label = JSON.stringify(document);

  test(`both lanes marshal ${label} the same way`, async () => {
    const local = marshalDocument(document);
    const compiled = await evaluate(marshalDocumentExpression("$doc"), document);
    assert.deepEqual(compiled, local);
  });

  test(`both lanes read ${label} back unchanged`, async () => {
    const attributes = marshalDocument(document);
    assert.deepEqual(unmarshalDocument(attributes), document);
    const compiled = await evaluate(
      unmarshalDocumentExpression("$doc"),
      attributes,
    );
    assert.deepEqual(compiled, document);
  });
}

test("a single value marshals the same way in both lanes", async () => {
  for (const value of ["text", 7, true, null, [1, 2], { a: 1 }]) {
    const local = marshalValue(value);
    const compiled = await evaluate(marshalValueExpression("$doc"), value);
    assert.deepEqual(compiled, local);
  }
});

test("a number is stored as a string, because DynamoDB numbers are decimal", () => {
  assert.deepEqual(marshalValue(1.5), { N: "1.5" });
  assert.equal(unmarshalDocument({ n: { N: "1.5" } } as AttributeMap).n, 1.5);
});

test("an undefined member is refused rather than silently dropped", () => {
  assert.throws(
    () => marshalDocument({ present: 1, absent: undefined }),
    DocumentMarshallingError,
  );
});

test("a non-finite number is refused in the local lane", () => {
  assert.throws(() => marshalValue(Number.POSITIVE_INFINITY), DocumentMarshallingError);
  assert.throws(() => marshalValue(Number.NaN), DocumentMarshallingError);
});

test("an unsupported type produces nothing in the compiled lane, which fails the state", async () => {
  // A function has no JSON form, so the local lane refuses it outright; the
  // compiled expression cannot receive one at all, and an attribute type
  // outside the document API produces nothing when read back.
  assert.throws(() => marshalValue(() => undefined), DocumentMarshallingError);
  const compiled = await evaluate(unmarshalDocumentExpression("$doc"), {
    binary: { B: "abc" },
  });
  assert.equal(compiled, undefined);
});

test("an attribute type outside the document API is refused with a reason", () => {
  assert.throws(
    () => unmarshalDocument({ file: { B: "abc" } } as unknown as AttributeMap),
    /Binary values, sets and precision-sensitive numbers/,
  );
});
