import assert from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

/**
 * node:assert/strict, with comparisons that stay cheap when they fail. Every Studio
 * test imports assert from here (bounded-assert.test.ts sweeps for it).
 *
 * A failing comparison makes node:assert render both operands at depth 1000 with
 * getters, then line-diff the text while keeping a copy of the diff's working row per
 * edit step. A live DOM node reaches its whole document and, through React's fiber,
 * the snapshot behind it, so one failing `assert.equal(element, null)` committed
 * ~100 GB within a minute and took every other process on the machine down with it.
 *
 * Operands that render within LINE_BUDGET lines keep node:assert's own message. Larger
 * ones are decided by the same comparison and reported by their first difference and
 * a bounded preview. The callable form, `ok`, `match` and `throws` are node:assert's.
 */
const LINE_BUDGET = 2_000;
const comparisons = {
  equal: { names: ["equal", "strictEqual"], holds: Object.is, relation: "Expected values to be strictly equal:" },
  notEqual: { names: ["notEqual", "notStrictEqual"], holds: (actual: unknown, expected: unknown) => !Object.is(actual, expected), relation: 'Expected "actual" to be strictly unequal to "expected":' },
  deepEqual: { names: ["deepEqual", "deepStrictEqual"], holds: isDeepStrictEqual, relation: "Expected values to be strictly deep-equal:" },
  notDeepEqual: { names: ["notDeepEqual", "notDeepStrictEqual"], holds: (actual: unknown, expected: unknown) => !isDeepStrictEqual(actual, expected), relation: 'Expected "actual" not to be strictly deep-equal to "expected":' },
} as const;
type Comparison = keyof typeof comparisons;
type Compare = (actual: unknown, expected: unknown, message?: string | Error) => void;

const isNode = (value: unknown): value is Node => {
  try { return typeof value === "object" && value !== null && typeof (value as Node).nodeType === "number" && typeof (value as Node).nodeName === "string"; }
  catch { return false; }
};

/** Whether node:assert's rendering of `value` stays within LINE_BUDGET lines. */
function bounded(value: unknown): boolean {
  let remaining = LINE_BUDGET;
  const seen = new Set<object>();
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") {
      for (let index = item.indexOf("\n"); index !== -1 && remaining >= 0; index = item.indexOf("\n", index + 1)) remaining -= 1;
      return --remaining >= 0;
    }
    if (item === null || typeof item !== "object" && typeof item !== "function") return --remaining >= 0;
    if (--remaining < 0 || isNode(item)) return false;
    if (seen.has(item)) return true;
    seen.add(item);
    if (item instanceof Map) { for (const [key, entry] of item) if (!visit(key) || !visit(entry)) return false; }
    else if (item instanceof Set) { for (const entry of item) if (!visit(entry)) return false; }
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable) continue;
      // node:assert reads getters; what one returns is unknown, so count it as unbounded.
      if (!("value" in descriptor) || !visit(descriptor.value)) return false;
    }
    return true;
  };
  return visit(value);
}

function preview(value: unknown): string {
  const text = isNode(value)
    ? (value as Partial<Element>).outerHTML ?? `${value.nodeName} ${JSON.stringify(value.textContent?.slice(0, 200))}`
    : inspect(value, { depth: 2, maxArrayLength: 10, maxStringLength: 200, breakLength: 120 });
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !isNode(value)
  && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Where two unequal structures first diverge. */
function difference(actual: unknown, expected: unknown, at = "", seen = new Set<object>()): string {
  if (plain(actual) && plain(expected) && Array.isArray(actual) === Array.isArray(expected) && !seen.has(actual)) {
    seen.add(actual);
    for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
      if (!isDeepStrictEqual(actual[key], expected[key])) return difference(actual[key], expected[key], `${at}${Array.isArray(actual) ? `[${key}]` : `.${key}`}`, seen);
    }
  }
  return `${at || "the root"}: actual ${preview(actual)}, expected ${preview(expected)}`;
}

/** The first line on which two unequal texts differ. */
function textDifference(actual: string, expected: string): string {
  let index = 0;
  while (index < actual.length && actual[index] === expected[index]) index += 1;
  const start = actual.lastIndexOf("\n", index - 1) + 1;
  const line = (text: string) => JSON.stringify(text.slice(start).split("\n", 1)[0]!.slice(0, 200));
  return `line ${actual.slice(0, start).split("\n").length}: actual ${line(actual)}, expected ${line(expected)}`;
}

function failure(comparison: Comparison, actual: unknown, expected: unknown, message: string | undefined, stackStartFn: Compare): Error {
  const first = comparison === "deepEqual" ? difference(actual, expected)
    : comparison === "equal" && typeof actual === "string" && typeof expected === "string" ? textDifference(actual, expected) : undefined;
  const lines = [
    message ? `${message}\n` : comparisons[comparison].relation,
    `The operands are too large for node:assert to diff${first ? `; they first differ at ${first}` : "."}`,
    `actual:   ${preview(actual)}`,
    `expected: ${preview(expected)}`,
  ];
  // A "fail" operator keeps node:assert from diffing a supplied message's operands.
  return Object.assign(new assert.AssertionError({ message: lines.join("\n"), operator: "fail", stackStartFn }), { operator: comparisons[comparison].names[1] });
}

for (const [comparison, { names, holds }] of Object.entries(comparisons) as [Comparison, (typeof comparisons)[Comparison]][]) {
  const original = assert[names[0]] as Compare;
  const compare: Compare = (actual, expected, message) => {
    if (bounded(actual) && bounded(expected)) {
      // Node distinguishes an omitted message from an explicit undefined one.
      try { if (message === undefined) original(actual, expected); else original(actual, expected, message); }
      catch (error) { if (error instanceof assert.AssertionError) Error.captureStackTrace(error, compare); throw error; }
      return;
    }
    if (holds(actual, expected)) return;
    if (message instanceof Error) throw message;
    throw failure(comparison, actual, expected, message, compare);
  };
  for (const name of names) Object.assign(assert, { [name]: compare });
}

export default assert;
