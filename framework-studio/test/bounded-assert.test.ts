import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import assert from "./support/assert";

// Unbounded, node:assert renders each failing operand below at depth 1000 and keeps a
// copy of its diff row per edit step; every one of them reached tens of gigabytes.
const require = createRequire(import.meta.url);
const rows = Array.from({ length: 20_000 }, (_, index) => ({ id: `row-${index}`, lines: [`${index}`] }));
const brief = (pattern: RegExp) => (error: Error) => {
  assert.match(error.message, pattern);
  assert.ok(error.message.length < 4_000, `the message is ${error.message.length} characters`);
  return true;
};

test("a failing comparison with a live DOM node fails at once with a readable preview", () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<!doctype html><body>${"<section><p>row</p></section>".repeat(2_000)}<select aria-label="Deploy"><option>Controlled by owning resources</option></select></body>`);
  const select = dom.window.document.querySelector("select");
  // React keeps each rendered element's fiber on it, which reaches the props and state
  // above it: in Studio, the whole snapshot.
  Object.assign(select, { __reactFiber$test: { return: { memoizedProps: { rows } } } });
  try {
    assert.throws(() => assert.equal(select, null, "managed availability has no independent deployment override"),
      brief(/^managed availability has no independent deployment override[\s\S]*<select aria-label="Deploy">/));
    assert.equal(select, select);
    assert.notEqual(select, dom.window.document.body);
    assert.throws(() => assert.notEqual(select, select), brief(/strictly unequal/));
  } finally { dom.window.close(); }
});

test("large structures and texts decide like node:assert and name their first difference", () => {
  assert.throws(() => assert.deepEqual(rows, []), brief(/strictly deep-equal/));
  const changed = structuredClone(rows);
  changed[12_345]!.lines[0] = "changed";
  assert.deepEqual(rows, structuredClone(rows));
  assert.notDeepEqual(rows, changed);
  assert.throws(() => assert.deepEqual(changed, rows), brief(/\[12345\]\.lines\[0\]: actual 'changed', expected '12345'/));
  const source = rows.map((row) => row.id).join("\n");
  assert.throws(() => assert.equal(source.replace("row-777\n", "row-seven\n"), source), brief(/line 778: actual "row-seven", expected "row-777"/));
  assert.throws(() => assert.equal(source, ""), brief(/strictly equal/));
});

test("small failing comparisons keep node:assert's own diff and point at their caller", () => {
  assert.throws(() => assert.deepEqual({ kind: "service", lanes: ["dev"] }, { kind: "service", lanes: ["prod"] }), (error: Error) => {
    assert.match(error.message, /Expected values to be strictly deep-equal:[\s\S]*'prod'/);
    assert.match(error.stack!.split("\n").find((line) => line.trimStart().startsWith("at "))!, /bounded-assert\.test\.ts/);
    return true;
  });
});

test("every Studio test asserts through the bounded module", () => {
  const offenders = readdirSync(__dirname, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && path.normalize(file) !== path.join("support", "assert.ts"))
    .filter((file) => /from\s+["'](?:node:)?assert(?:\/strict)?["']|require\(\s*["'](?:node:)?assert/.test(readFileSync(path.join(__dirname, file), "utf8")));
  assert.deepEqual(offenders, [], "import assert from ./support/assert: node:assert's unbounded diff of a DOM node or large value can exhaust the machine's memory");
});
