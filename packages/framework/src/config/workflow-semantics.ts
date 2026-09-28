import type {
  WorkflowBindingId,
  WorkflowCondition,
  WorkflowNodeId,
  WorkflowOperand,
  WorkflowOperation,
  WorkflowReference,
  WorkflowTerm,
} from "./workflow-ast";

/**
 * What the vocabulary *means*, written once.
 *
 * The ASL compiler and the local interpreter are two projections of one graph;
 * this is the third thing they share, and the most dangerous one to duplicate.
 * Reference resolution and condition evaluation are where two implementations
 * drift silently: a comparison that one treats as `false` and the other as a
 * failure produces a workflow that passes locally and fails in production,
 * months later, on one branch.
 *
 * Browser-safe and pure.
 *
 * The compiler reads these rules to emit JSONata, and the interpreter reads them
 * to evaluate directly. Neither evaluates JSONata — there is no expression
 * engine here to keep in agreement with AWS's, only a closed set of operations
 * whose meaning is stated once and projected twice.
 */

/** AWS's own error names, which retry and catch clauses may name. */
export const WORKFLOW_ERROR_NAMES = {
  all: "States.ALL",
  timeout: "States.Timeout",
  taskFailed: "States.TaskFailed",
  runtime: "States.Runtime",
  dataLimitExceeded: "States.DataLimitExceeded",
  permissions: "States.Permissions",
  /** A callback step whose worker stopped reporting. */
  heartbeatTimeout: "States.HeartbeatTimeout",
  /**
   * A JSONata expression that could not be evaluated.
   *
   * JSON has no way to represent an undefined value, so reading a field that is
   * not there is an error rather than a missing member — which is why the
   * compiler guards every field whose absence is ordinary rather than
   * exceptional.
   */
  queryEvaluation: "States.QueryEvaluationError",
} as const;

/**
 * `States.Runtime` is deliberately terminal: AWS does not retry it, and a
 * graph that could would be retrying a bug in its own definition.
 */
export const NON_RETRYABLE_ERRORS: readonly string[] = [
  WORKFLOW_ERROR_NAMES.runtime,
];

/** A failure with an ASL error name, which retry and catch match on. */
export class WorkflowStateError extends Error {
  public constructor(
    public readonly errorName: string,
    public readonly cause: string,
  ) {
    super(`${errorName}: ${cause}`);
    this.name = "WorkflowStateError";
  }

  /** The `{ error, cause }` shape an `attempt` handler receives. */
  public toCatchOutput(): { readonly error: string; readonly cause: string } {
    return { error: this.errorName, cause: this.cause };
  }
}

/** Whether a retry or catch clause's error list matches a raised error. */
export function errorMatches(
  errors: readonly string[],
  errorName: string,
): boolean {
  if (errors.includes(errorName)) return true;
  return (
    errors.includes(WORKFLOW_ERROR_NAMES.all) &&
    !NON_RETRYABLE_ERRORS.includes(errorName)
  );
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

export interface Resolution {
  readonly found: boolean;
  readonly value: unknown;
}

const MISSING: Resolution = { found: false, value: undefined };

/**
 * Where an interpreter finds the values a reference names.
 *
 * Supplied rather than assumed, because scoping belongs to the executor: a
 * parallel branch and a map iteration each have their own, and what is visible
 * from one is precisely the question this interface lets the caller answer.
 */
export interface WorkflowValues {
  readonly input: unknown;
  readonly node: (id: WorkflowNodeId) => Resolution;
  readonly mapBinding: (map: WorkflowNodeId, field: "item" | "index") => Resolution;
  readonly error: (attempt: WorkflowNodeId) => Resolution;
  /**
   * The element of an enclosing `project` or `filter`.
   *
   * Layered by expression evaluation rather than supplied by the executor: the
   * binding lives inside one expression, so nothing outside it should be able
   * to answer for it.
   */
  readonly element?: (binding: WorkflowBindingId) => Resolution;
}

/** The same values, with one expression element bound over them. */
export function withElement(
  values: WorkflowValues,
  binding: WorkflowBindingId,
  element: unknown,
): WorkflowValues {
  return {
    ...values,
    element: (candidate) =>
      candidate === binding
        ? { found: true, value: element }
        : (values.element?.(candidate) ?? MISSING),
  };
}

/** Reads one path step, distinguishing a present `null` from an absent member. */
function readStep(value: unknown, segment: string | number): Resolution {
  if (value === null || value === undefined) return MISSING;
  if (typeof segment === "number") {
    if (!Array.isArray(value) || segment >= value.length) return MISSING;
    return { found: true, value: value[segment] };
  }
  if (typeof value !== "object" || Array.isArray(value)) return MISSING;
  const record = value as Record<string, unknown>;
  // `in` rather than a truthiness check: a present `null` and an absent member
  // are different answers, and `exists`/`isNull` depend on the difference.
  return segment in record
    ? { found: true, value: record[segment] }
    : MISSING;
}

/** Walks a property path over a resolved value. */
function readPath(
  start: Resolution,
  path: readonly (string | number)[],
): Resolution {
  let current = start;
  for (const segment of path) {
    if (!current.found) return MISSING;
    current = readStep(current.value, segment);
  }
  return current;
}

/** Resolves a reference against real values, reporting whether it resolved. */
export function resolveReference(
  reference: WorkflowReference,
  values: WorkflowValues,
): Resolution {
  const source = reference.source;
  let current: Resolution;
  switch (source.kind) {
    case "input":
      current = { found: true, value: values.input };
      break;
    case "node":
      current = values.node(source.node);
      break;
    case "mapBinding":
      current = values.mapBinding(source.map, source.field);
      break;
    case "elementBinding":
      current = values.element?.(source.binding) ?? MISSING;
      break;
    default:
      current = values.error(source.attempt);
  }

  return readPath(current, reference.path);
}

/** Resolves a read or a computation, reporting whether it resolved. */
export function resolveTerm(term: WorkflowTerm, values: WorkflowValues): Resolution {
  if (term.kind === "reference") return resolveReference(term, values);
  return readPath(evaluateOperation(term, values), term.path);
}

// ---------------------------------------------------------------------------
// Operations
//
// The evaluation half of `expr`. Its projection into JSONata lives in the ASL
// compiler, beside the condition compiler, for the same reason: the two lanes
// are two readings of one closed set of operations, and neither evaluates the
// other's representation.
//
// Every operator is total in the same way in both lanes. An operand that is
// absent makes the operation absent, which fails at the payload boundary; an
// operand of the wrong type is a query-evaluation error, because that is what
// the compiled expression produces.
// ---------------------------------------------------------------------------

function evaluationError(where: string): WorkflowStateError {
  return new WorkflowStateError(WORKFLOW_ERROR_NAMES.queryEvaluation, where);
}

function numeric(
  resolved: readonly Resolution[],
  operator: string,
): readonly number[] | undefined {
  const values: number[] = [];
  for (const entry of resolved) {
    if (!entry.found) return undefined;
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      throw evaluationError(
        `expr.${operator} needs finite numbers, and was given ${JSON.stringify(entry.value) ?? "undefined"}.`,
      );
    }
    values.push(entry.value);
  }
  return values;
}

function arithmetic(
  operator: "add" | "subtract" | "multiply" | "divide",
  resolved: readonly Resolution[],
): Resolution {
  const numbers = numeric(resolved, operator);
  if (numbers === undefined) return MISSING;
  const [left = 0, right = 0] = numbers;
  const result =
    operator === "add"
      ? left + right
      : operator === "subtract"
        ? left - right
        : operator === "multiply"
          ? left * right
          : left / right;
  // JSONata has no infinity, and the compiled expression guards the result so
  // an out-of-range one becomes nothing. Raising here says the same thing.
  if (!Number.isFinite(result)) {
    throw evaluationError(
      `expr.${operator} produced a value that is not a finite number.`,
    );
  }
  return { found: true, value: result };
}

function evaluateOperation(
  operation: WorkflowOperation,
  values: WorkflowValues,
): Resolution {
  const resolveOperand = (operand: unknown): Resolution =>
    resolveStructure(operand, values);
  const operands = (): readonly Resolution[] =>
    operation.operands.map(resolveOperand);

  switch (operation.operator) {
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return arithmetic(operation.operator, operands());

    case "concat": {
      const parts: string[] = [];
      for (const entry of operands()) {
        if (!entry.found) return MISSING;
        if (typeof entry.value !== "string") {
          throw evaluationError(
            `expr.concat joins strings, and was given ${typeof entry.value}.`,
          );
        }
        parts.push(entry.value);
      }
      return { found: true, value: parts.join("") };
    }

    case "coalesce": {
      const resolved = operands();
      for (const entry of resolved) {
        if (entry.found && entry.value !== null) return entry;
      }
      // The last operand is the declared fallback, and it stands even when it
      // is itself null or absent — coalesce chooses, it does not invent.
      return resolved[resolved.length - 1] ?? MISSING;
    }

    case "ifElse": {
      const condition = operation.condition;
      if (condition === undefined) return MISSING;
      const chosen = evaluateCondition(condition, values)
        ? operation.operands[0]
        : operation.operands[1];
      return resolveOperand(chosen);
    }

    case "length": {
      const [value] = operands();
      if (value === undefined || !value.found) return MISSING;
      if (typeof value.value === "string") {
        return { found: true, value: value.value.length };
      }
      if (Array.isArray(value.value)) {
        return { found: true, value: value.value.length };
      }
      throw evaluationError(
        "expr.length measures a string or an array, and was given neither.",
      );
    }

    case "at": {
      const [array, index] = operands();
      if (array === undefined || index === undefined) return MISSING;
      if (!array.found || !index.found) return MISSING;
      if (!Array.isArray(array.value)) {
        throw evaluationError("expr.at reads an element of an array.");
      }
      if (typeof index.value !== "number" || !Number.isInteger(index.value)) {
        throw evaluationError("expr.at takes a whole-number index.");
      }
      // Out of range is absent rather than an error, so expr.coalesce can
      // answer for it. The compiled expression yields nothing in the same case.
      return index.value >= 0 && index.value < array.value.length
        ? { found: true, value: array.value[index.value] }
        : MISSING;
    }

    case "project":
    case "filter": {
      const [array] = operands();
      const lambda = operation.lambda;
      if (array === undefined || !array.found || lambda === undefined) return MISSING;
      if (!Array.isArray(array.value)) {
        throw evaluationError(
          `expr.${operation.operator} walks an array, and was given something else.`,
        );
      }
      if (operation.operator === "filter") {
        const predicate = lambda.predicate;
        if (predicate === undefined) return MISSING;
        const kept = array.value.filter((element) =>
          evaluateCondition(predicate, withElement(values, lambda.binding, element)),
        );
        return { found: true, value: kept };
      }
      const projected = array.value.map((element) => {
        const scoped = withElement(values, lambda.binding, element);
        const result = resolveStructure(lambda.body, scoped);
        if (!result.found) {
          throw evaluationError(
            "expr.project produced no value for an element. Every element has to produce one.",
          );
        }
        return result.value;
      });
      return { found: true, value: projected };
    }

    default: {
      const merged: Record<string, unknown> = {};
      for (const entry of operands()) {
        if (!entry.found) return MISSING;
        if (
          entry.value === null ||
          typeof entry.value !== "object" ||
          Array.isArray(entry.value)
        ) {
          throw evaluationError("expr.merge combines JSON objects.");
        }
        Object.assign(merged, entry.value);
      }
      return { found: true, value: merged };
    }
  }
}

/**
 * One operand position, resolved.
 *
 * An operand is an ordinary payload position: a literal, a symbolic value, or
 * a structure of both. A structure whose members do not all resolve is absent
 * rather than partially built, because that is what the compiled object
 * constructor produces.
 */
function resolveStructure(value: unknown, values: WorkflowValues): Resolution {
  const term = termIn(value);
  if (term !== undefined) return resolveTerm(term, values);

  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (const entry of value) {
      const resolved = resolveStructure(entry, values);
      if (!resolved.found) return MISSING;
      entries.push(resolved.value);
    }
    return { found: true, value: entries };
  }
  if (value === null || typeof value !== "object") {
    return { found: true, value };
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const resolved = resolveStructure(entry, values);
    if (!resolved.found) return MISSING;
    result[key] = resolved.value;
  }
  return { found: true, value: result };
}

/** The term a symbolic value carries, read without importing the builder. */
function termIn(value: unknown): WorkflowTerm | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as Record<symbol, unknown>)[
    Symbol.for("framework.workflow.reference")
  ];
  return carried === undefined ? undefined : (carried as WorkflowTerm);
}

/** A term as an author would recognise it, for a diagnostic. */
export function describeTerm(term: WorkflowTerm): string {
  const root =
    term.kind === "operation"
      ? `expr.${term.operator}(...)`
      : term.source.kind === "input"
        ? "input"
        : term.source.kind === "node"
          ? `the result of step ${term.source.node}`
          : term.source.kind === "mapBinding"
            ? `the map ${term.source.field}`
            : term.source.kind === "elementBinding"
              ? "the current element"
              : "the caught error";
  const path = term.path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`))
    .join("");
  return `${root}${path}`;
}

/**
 * Resolves a reference, failing when the value is not there.
 *
 * This is the rule both lanes follow, and it is AWS's rather than JavaScript's.
 * JSON has no undefined, so a compiled `$var.field` over a missing member is
 * `States.QueryEvaluationError` — not a member that quietly disappears from the
 * payload. The local lane used to drop it, which made "works locally, fails in
 * the cloud" the default outcome for a typo. Reading a value that may be absent
 * is written, deliberately, with `expr.coalesce` or a presence test.
 *
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html
 */
export function resolveTermOrFail(
  term: WorkflowTerm,
  values: WorkflowValues,
  where: string,
): unknown {
  const resolved = resolveTerm(term, values);
  if (resolved.found) return resolved.value;
  throw new WorkflowStateError(
    WORKFLOW_ERROR_NAMES.queryEvaluation,
    `${where} reads ${describeTerm(term)}, which is not present. A missing value is an error rather than an absent field; use expr.coalesce(...) or a presence test if it is genuinely optional.`,
  );
}

/**
 * A payload, with every reference replaced by the value it names.
 *
 * Strict: an unresolved reference fails the state rather than vanishing, which
 * is what the compiled expression does. An explicit `null` stays `null`.
 */
export function resolvePayload(
  value: unknown,
  values: WorkflowValues,
  termIn_: (candidate: unknown) => WorkflowTerm | undefined,
  where = "This step",
): unknown {
  const term = termIn_(value);
  if (term !== undefined) {
    return resolveTermOrFail(term, values, where);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolvePayload(entry, values, termIn_, where));
  }
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = resolvePayload(entry, values, termIn_, where);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function operandValue(operand: WorkflowOperand, values: WorkflowValues): Resolution {
  return "literal" in operand
    ? { found: true, value: operand.literal }
    : resolveTerm(operand, values);
}

/**
 * Evaluates one condition.
 *
 * Guard behavior is deliberate and matches what the compiler emits: a
 * comparison against a missing member, or against a value of the wrong type, is
 * `false` rather than an error. That is what lets an ordered list of rules be
 * written without a presence test in front of every one — and it is why the
 * compiled JSONata carries an explicit `$type` guard, since JSONata would
 * otherwise raise on `"abc" >= 80`.
 *
 * `and`/`or` short-circuit, as AWS's do.
 */
export function evaluateCondition(
  condition: WorkflowCondition,
  values: WorkflowValues,
): boolean {
  switch (condition.kind) {
    case "and":
      return condition.operands.every((operand) => evaluateCondition(operand, values));
    case "or":
      return condition.operands.some((operand) => evaluateCondition(operand, values));
    case "not":
      return !evaluateCondition(condition.operand, values);
    case "exists":
      return resolveTerm(condition.value, values).found;
    case "isNull": {
      const resolved = resolveTerm(condition.value, values);
      return resolved.found && resolved.value === null;
    }
    default: {
      const left = operandValue(condition.left, values);
      const right = operandValue(condition.right, values);
      if (!left.found || !right.found) return false;

      switch (condition.comparator) {
        // No coercion: "1" is not 1, and true is not "true". JSONata agrees,
        // so this needs no guard on either side.
        case "eq":
          return sameValue(left.value, right.value);
        case "ne":
          return !sameValue(left.value, right.value);
        case "contains":
        case "startsWith":
        case "endsWith": {
          if (typeof left.value !== "string" || typeof right.value !== "string") {
            return false;
          }
          if (condition.comparator === "contains") {
            return left.value.includes(right.value);
          }
          return condition.comparator === "startsWith"
            ? left.value.startsWith(right.value)
            : left.value.endsWith(right.value);
        }
        default: {
          if (typeof left.value !== "number" || typeof right.value !== "number") {
            return false;
          }
          switch (condition.comparator) {
            case "gt":
              return left.value > right.value;
            case "gte":
              return left.value >= right.value;
            case "lt":
              return left.value < right.value;
            default:
              return left.value <= right.value;
          }
        }
      }
    }
  }
}

/**
 * Structural equality, independent of the order object members were written in.
 *
 * `JSON.stringify` comparison was the obvious implementation and the wrong one:
 * it makes `{a:1,b:2}` and `{b:2,a:1}` unequal, and member order is an accident
 * of how a payload was assembled. JSONata compares structurally, so a graph
 * would have agreed with itself locally and disagreed in AWS depending on which
 * step produced the object.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => sameValue(entry, right[index]));
  }

  const leftEntries = left as Record<string, unknown>;
  const rightEntries = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftEntries);
  const rightKeys = Object.keys(rightEntries);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightEntries, key) &&
      sameValue(leftEntries[key], rightEntries[key]),
  );
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * AWS's state payload budget, enforced in the local lane too.
 *
 * A graph that only exceeds it in production is a graph the local lane was
 * never really testing.
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html
 */
export const WORKFLOW_PAYLOAD_CHARACTER_LIMIT = 262_144;

/** The execution-history budget, likewise enforced locally. */
export const WORKFLOW_HISTORY_EVENT_LIMIT = 25_000;

export function assertPayloadWithinLimit(value: unknown, where: string): void {
  const encoded = JSON.stringify(value ?? null) ?? "null";
  if (encoded.length > WORKFLOW_PAYLOAD_CHARACTER_LIMIT) {
    throw new WorkflowStateError(
      WORKFLOW_ERROR_NAMES.dataLimitExceeded,
      `${where} produced ${encoded.length} characters, over the ${WORKFLOW_PAYLOAD_CHARACTER_LIMIT}-character state payload limit.`,
    );
  }
}

/**
 * A task's input must be a JSON document.
 *
 * The cloud lane stringifies it with JSONata's `$string`, which returns a string
 * argument *unchanged* where the old `States.JsonToString` intrinsic produced a
 * quoted JSON string. Objects and arrays agree under both; scalars do not. The
 * rule is stated here and enforced in both lanes rather than left as a
 * difference that would only appear for a workflow passing a bare string.
 */
export function assertTaskInputIsDocument(value: unknown, where: string): void {
  if (value === null || typeof value !== "object") {
    throw new WorkflowStateError(
      WORKFLOW_ERROR_NAMES.runtime,
      `${where} passes ${value === null ? "null" : typeof value} as its task input. A task receives a JSON object or array, because the input travels as one JSON document in an environment variable.`,
    );
  }
}
