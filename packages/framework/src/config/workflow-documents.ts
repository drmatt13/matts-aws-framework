/**
 * JSON documents, as DynamoDB stores them.
 *
 * DynamoDB does not hold JSON: it holds attribute values, where a string is
 * `{"S": "x"}` and a number is `{"N": "1"}` — a *string*, because DynamoDB's
 * numbers are decimal and JSON's are binary floating point. Every path into the
 * table crosses that boundary, and there are two of them: the compiled Step
 * Functions state and the local AWS SDK call.
 *
 * Both are written here, side by side, because the failure this file exists to
 * prevent is the quiet one — two marshallers that agree about `{"name": "a"}`
 * and disagree about an empty list, a null, or a nested map, so a workflow
 * stores one shape locally and another in production. The JSONata text below is
 * the compiled lane's implementation and the functions are the local lane's;
 * `workflow-documents.test.ts` runs a document through both and compares.
 *
 * ## What is in the JSON-document API, and what is not
 *
 * Strings, numbers, booleans, null, lists and maps. Deliberately *not* binary
 * values, string/number sets, or numbers whose decimal precision matters —
 * those have no faithful JSON representation, so an API that claims to carry
 * them would be lying about at least one direction. A workflow needing them
 * uses an application Lambda with the SDK, where the representation is visible.
 *
 * Pure and browser-safe.
 */

/** One DynamoDB attribute value, in the subset this API carries. */
export type AttributeValue =
  | { readonly S: string }
  | { readonly N: string }
  | { readonly BOOL: boolean }
  | { readonly NULL: true }
  | { readonly L: readonly AttributeValue[] }
  | { readonly M: Readonly<Record<string, AttributeValue>> };

export type AttributeMap = Readonly<Record<string, AttributeValue>>;

export class DocumentMarshallingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DocumentMarshallingError";
  }
}

/**
 * A JSON value as an attribute value.
 *
 * `undefined` is refused rather than dropped: a member that silently disappears
 * on the way into a table is the kind of difference nobody notices until a read
 * comes back without it.
 */
export function marshalValue(value: unknown, path = "$"): AttributeValue {
  if (value === null) return { NULL: true };
  switch (typeof value) {
    case "string":
      return { S: value };
    case "boolean":
      return { BOOL: value };
    case "number":
      if (!Number.isFinite(value)) {
        throw new DocumentMarshallingError(
          `${path} is ${String(value)}, which DynamoDB cannot store. Only finite numbers are supported.`,
        );
      }
      return { N: String(value) };
    default:
      break;
  }
  if (Array.isArray(value)) {
    return { L: value.map((entry, index) => marshalValue(entry, `${path}[${index}]`)) };
  }
  if (typeof value === "object") {
    return { M: marshalDocument(value as Record<string, unknown>, path) };
  }
  throw new DocumentMarshallingError(
    `${path} is ${typeof value}, which is not part of the JSON document API. Use strings, numbers, booleans, null, arrays and objects.`,
  );
}

export function marshalDocument(
  document: Readonly<Record<string, unknown>>,
  path = "$",
): AttributeMap {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new DocumentMarshallingError(`${path} must be a JSON object.`);
  }
  const result: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined) {
      throw new DocumentMarshallingError(
        `${path}.${key} is undefined. JSON has no undefined; write null if the absence is deliberate, or omit the member.`,
      );
    }
    result[key] = marshalValue(value, `${path}.${key}`);
  }
  return result;
}

export function unmarshalValue(value: AttributeValue, path = "$"): unknown {
  if ("S" in value) return value.S;
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("N" in value) {
    const parsed = Number(value.N);
    if (!Number.isFinite(parsed)) {
      throw new DocumentMarshallingError(
        `${path} holds the number ${value.N}, which does not survive as a JSON number.`,
      );
    }
    return parsed;
  }
  if ("L" in value) {
    return value.L.map((entry, index) => unmarshalValue(entry, `${path}[${index}]`));
  }
  if ("M" in value) return unmarshalDocument(value.M, path);
  throw new DocumentMarshallingError(
    `${path} holds an attribute type outside the JSON document API: ${Object.keys(value).join(", ")}. Binary values, sets and precision-sensitive numbers are read with the SDK in an application Lambda.`,
  );
}

export function unmarshalDocument(
  attributes: AttributeMap,
  path = "$",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = unmarshalValue(value, `${path}.${key}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The same rules, as JSONata
//
// The compiled lane cannot call the functions above: the value being marshalled
// only exists while the execution runs. These are the same rules expressed as
// recursive JSONata, which is what the state actually evaluates.
//
// The recursion is real recursion — a function bound in a block referring to
// itself — and it is why a nested map or a list of maps is handled rather than
// only the one level a template could have covered.
// ---------------------------------------------------------------------------

/**
 * Marshals the JSONata expression `body` into an attribute *map*.
 *
 * An unsupported type produces nothing, which makes the whole expression
 * undefined and fails the state with `States.QueryEvaluationError` — the same
 * refusal {@link marshalValue} raises, under AWS's own error name.
 */
export function marshalDocumentExpression(body: string): string {
  return `(${MARSHAL_DEFINITION}; $__wf_marshal(${body}).M)`;
}

/** Marshals `body` into a single attribute value. */
export function marshalValueExpression(body: string): string {
  return `(${MARSHAL_DEFINITION}; $__wf_marshal(${body}))`;
}

/** Reads an attribute map back as a JSON document. */
export function unmarshalDocumentExpression(body: string): string {
  return `(${UNMARSHAL_DEFINITION}; $__wf_unmarshal({"M": ${body}}))`;
}

/**
 * The counted guards are not decoration.
 *
 * A JSONata member that evaluates to nothing is *dropped*, not reported: an
 * attribute type outside this API — a binary value, a set — would have quietly
 * disappeared from the document while the local lane refused it outright. That
 * is precisely the silent divergence this module exists to prevent, and a test
 * caught it. Comparing the member count before and after turns a vanished
 * member into an expression that produces nothing, which fails the state with
 * `States.QueryEvaluationError`.
 */
const MARSHAL_DEFINITION = [
  "$__wf_marshal := function($v) {",
  '  $type($v) = "string" ? {"S": $v}',
  '  : $type($v) = "number" ? {"N": $string($v)}',
  '  : $type($v) = "boolean" ? {"BOOL": $v}',
  '  : $type($v) = "null" ? {"NULL": true}',
  '  : $type($v) = "array" ? ($l := [$map($v, function($e) { $__wf_marshal($e) })]; $count($l) = $count($v) ? {"L": $l})',
  '  : $type($v) = "object" ? ($m := $merge([{}, $each($v, function($e, $k) { {$k: $__wf_marshal($e)} })]); $count($keys($m)) = $count($keys($v)) ? {"M": $m})',
  "}",
].join(" ");

const UNMARSHAL_DEFINITION = [
  "$__wf_unmarshal := function($v) {",
  "  $exists($v.S) ? $v.S",
  "  : $exists($v.N) ? $number($v.N)",
  "  : $exists($v.BOOL) ? $v.BOOL",
  "  : $exists($v.NULL) ? null",
  "  : $exists($v.L) ? ($l := [$map($v.L, function($e) { $__wf_unmarshal($e) })]; $count($l) = $count($v.L) ? $l)",
  '  : $exists($v.M) ? ($m := $merge([{}, $each($v.M, function($e, $k) { {$k: $__wf_unmarshal($e)} })]); $count($keys($m)) = $count($keys($v.M)) ? $m)',
  "}",
].join(" ");
