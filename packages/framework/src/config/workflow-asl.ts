/**
 * The workflow IR, lowered to Amazon States Language.
 *
 * ASL is a compiler target here, not a representation anyone authors or reads
 * back. The structured graph is flattened into states, transitions are wired,
 * names are generated, and every symbolic reference becomes a JSONata
 * expression over a workflow variable.
 *
 * Compiled here rather than assembled from CDK state constructs, for the reason
 * the previous compiler gave and which has not changed: the installed
 * `EcsRunTask` L2 emits a task-definition *family* by default, and its IAM
 * feature flag does not change that launch parameter. A family-qualified launch
 * would silently drift from the revision-pinned grant the task's own stack
 * applies. Emitting the definition directly keeps the launch and the grant
 * projections of the same specification.
 *
 * The corollary is that CDK infers no permissions from a definition string, so
 * the role is derived explicitly from the IR's own references. One place decides
 * what a graph may do, and it is the graph.
 *
 * Pure and browser-safe — every AWS value arrives through {@link AslResolver},
 * which is also what lets a test compile a graph with fixture ARNs.
 *
 * ## Why JSONata
 *
 * Each node's result is assigned to a generated variable and referenced by name.
 * That is what makes named parallel results, automatic joins and lexical scoping
 * expressible at all: the alternative, threading one document through
 * `ResultPath`, cannot reassemble a branch array into the object an author
 * declared without a reshaping state per join.
 *
 * Nothing evaluates JSONata in this repository. The compiler emits it one way,
 * and the local interpreter resolves the same structured references against its
 * own variable store — so there is no expression engine to keep in agreement.
 */

import {
  childrenOf,
  RETRYABLE_NODE_KINDS,
  type AttemptNode,
  type ChoiceNode,
  type InvocationNode,
  type MapNode,
  type ParallelNode,
  type WorkflowCondition,
  type WorkflowErrorSelector,
  type WorkflowNode,
  type WorkflowBindingId,
  type IntegrationNode,
  type WorkflowNodeId,
  type WorkflowOperand,
  type WorkflowOperation,
  type WorkflowPathStep,
  type WorkflowReference,
  type WorkflowRetryPolicy,
  type WorkflowTerm,
} from "./workflow-ast";
import {
  marshalDocumentExpression,
  marshalValueExpression,
  unmarshalDocumentExpression,
} from "./workflow-documents";
import type { IntegrationSpec } from "./workflow-integrations";
import { variableOf, type CompiledWorkflow } from "./workflow-normalize";

/** Where the compiler gets the AWS identities the IR only names. */
export interface AslResolver {
  /** The function ARN of a declared event Lambda. May be a CDK token. */
  readonly lambdaArn: (id: string) => string;
  /** The immutable launch specification of a declared task. */
  readonly taskLaunch: (id: string) => {
    readonly cluster: string;
    readonly taskDefinitionArn: string;
    readonly containerName: string;
    readonly platformVersion: string;
    readonly subnets: readonly string[];
    readonly securityGroups: readonly string[];
    readonly assignPublicIp: boolean;
  };
  /** The state machine ARN of a declared child workflow. */
  readonly workflowArn?: (id: string) => string;
  /**
   * The identifier a bound integration is reached by.
   *
   * One string, because that is all the four optimized integrations need: a
   * table name, a queue URL, a topic ARN or an event bus name. The binding that
   * produces it lives in application CDK beside the construct, and it is also
   * where the grant is applied — which is why the compiler asks for it once per
   * reference rather than deriving an ARN itself.
   */
  readonly integrationTarget?: (
    spec: IntegrationSpec,
    operation: string,
  ) => IntegrationResolution;
}

/**
 * What application CDK answers when the compiler asks about a reference.
 *
 * One field for the ordinary services, because a table name, a queue URL, a
 * topic ARN and a bus name are each the single thing their integration takes.
 * The advanced two need more: an HTTP call needs the endpoint *and* the
 * connection that authenticates it, and an explicit AWS operation needs the
 * parameters the binding fixed — the resource identity a runtime value must not
 * be able to replace.
 */
export interface IntegrationResolution {
  readonly target?: string;
  readonly connectionArn?: string;
  readonly endpoint?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** The optimized integrations the four supported services use. */
export const INTEGRATION_RESOURCES: Readonly<Record<string, string>> = {
  "table:get": "arn:aws:states:::dynamodb:getItem",
  "table:put": "arn:aws:states:::dynamodb:putItem",
  "table:update": "arn:aws:states:::dynamodb:updateItem",
  "table:delete": "arn:aws:states:::dynamodb:deleteItem",
  "queue:send": "arn:aws:states:::sqs:sendMessage",
  "topic:publish": "arn:aws:states:::sns:publish",
  "eventBus:put": "arn:aws:states:::events:putEvents",
  // The callback pattern. Standard workflows only, which the validator checks.
  "queue:request": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
  "topic:request": "arn:aws:states:::sns:publish.waitForTaskToken",
  "eventBus:request": "arn:aws:states:::events:putEvents.waitForTaskToken",
  "httpConnection:request": "arn:aws:states:::http:invoke",
};

/** The ECS integration that waits for the container to report a result. */
export const ECS_RUN_TASK_CALLBACK_RESOURCE =
  "arn:aws:states:::ecs:runTask.waitForTaskToken";

/**
 * The handle a worker is given, as the compiled graph builds it.
 *
 * It says which callback, and by what route. It deliberately carries no URL:
 * a worker that learned where to send a completion *from the message* would be
 * trusting the message, and the framework issues that destination through the
 * worker's own environment instead.
 *
 * The execution name and retry count are for a developer reading a message in
 * a queue. Nothing routes on them.
 */
function awsCallbackHandleExpression(): string {
  return [
    "{",
    '"version": 1,',
    '"delivery": "aws",',
    '"token": $states.context.Task.Token,',
    '"execution": $states.context.Execution.Name,',
    '"attempt": $states.context.State.RetryCount',
    "}",
  ].join(" ");
}

/** `{ payload, callback }` — the one shape a messaging worker receives. */
function callbackRequestExpression(payload: string): string {
  return `{"payload": ${payload}, "callback": ${awsCallbackHandleExpression()}}`;
}

/** The optimized `.sync` ECS integration: run, and wait for STOPPED. */
export const ECS_RUN_TASK_SYNC_RESOURCE = "arn:aws:states:::ecs:runTask.sync";

/**
 * The nested-execution integration.
 *
 * `:2` rather than plain `.sync` because it answers with parsed JSON rather than
 * a string, so a child's output is usable without a parse step the author would
 * have to know to write.
 */
export const STATES_START_EXECUTION_SYNC_RESOURCE =
  "arn:aws:states:::states:startExecution.sync:2";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// JSONata emission
//
// One place builds expression text, so quoting and escaping are tested here
// rather than discovered in a deployed state machine.
// ---------------------------------------------------------------------------

/** Wraps an expression in the delimiters ASL recognises. */
function jsonata(expression: string): string {
  return `{% ${expression} %}`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The shape ASL reads as a JSONata expression rather than as text. */
const EXPRESSION_SHAPED = /^\{%[\s\S]*%\}$/;

/** One path step, as JSONata spells it. */
function step(segment: WorkflowPathStep): string {
  if (typeof segment === "number") return `[${segment}]`;
  return IDENTIFIER.test(segment) ? `.${segment}` : `.\`${segment}\``;
}

/** A JSON literal, as a JSONata literal. */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}

/**
 * The root of a reference.
 *
 * The workflow input comes from the execution context rather than from a
 * variable, because it is the one value that must stay readable everywhere
 * including inside branches and map iterations, and the context object is the
 * only thing with that lifetime.
 *
 * A node referring to *itself* reads `$states.result`. Its own variable is not
 * an option: variable references resolve to their value on state entry, and
 * `Assign` and `Output` are computed in parallel from the same result — so a
 * state cannot read the variable it is in the middle of writing.
 */
function root(reference: WorkflowReference, current: WorkflowNodeId | undefined): string {
  const source = reference.source;
  switch (source.kind) {
    case "input":
      return "$states.context.Execution.Input";
    case "node":
      return source.node === current ? "$states.result" : `$${variableOf(source.node)}`;
    case "mapBinding":
      return `$${mapBindingVariable(source.map, source.field)}`;
    case "elementBinding":
      return `$${elementVariable(source.binding)}`;
    default:
      return `$${errorVariable(source.attempt)}`;
  }
}

/** The lambda parameter of a compiled `project` or `filter`. */
function elementVariable(binding: WorkflowBindingId): string {
  return `__wf_el_${binding}`;
}

/**
 * A fresh block-local name.
 *
 * Several operators bind their operand once so it is not evaluated twice —
 * `($v := ...; ...)`. JSONata scopes a block, so shadowing would be harmless,
 * but a distinct name keeps a nested expression readable in the console.
 */
let blockCounter = 0;
function blockVariable(): string {
  blockCounter += 1;
  return `__wf_v${blockCounter}`;
}

function mapBindingVariable(map: WorkflowNodeId, field: "item" | "index"): string {
  return `__wf_${field}_${map}`;
}

function errorVariable(attempt: WorkflowNodeId): string {
  return `__wf_err_${attempt}`;
}

function expressionOf(
  term: WorkflowTerm,
  current: WorkflowNodeId | undefined,
): string {
  const base =
    term.kind === "reference"
      ? root(term, current)
      : `(${operationExpression(term, current)})`;
  return base + term.path.map(step).join("");
}

// ---------------------------------------------------------------------------
// Operations
//
// The compiled half of `expr`. Its evaluation half is in `workflow-semantics`,
// beside `evaluateCondition`, and every rule stated in one has a counterpart
// here.
//
// Two JSONata behaviors decide most of the shapes below. An expression that
// evaluates to *nothing* makes the state fail with
// `States.QueryEvaluationError`, which is exactly the outcome wanted for an
// operand of the wrong type — so a guard that simply does not match is a
// faithful refusal rather than a silent wrong answer. And a sequence is not an
// array: `$map` over an empty array yields nothing, so an array-returning
// operator is wrapped in `[ ... ]` to keep an empty result an empty array.
// ---------------------------------------------------------------------------

function operationExpression(
  operation: WorkflowOperation,
  current: WorkflowNodeId | undefined,
): string {
  const compiled = operation.operands.map((operand) =>
    operandText(operand, current),
  );
  const [first = "null", second = "null"] = compiled;

  switch (operation.operator) {
    case "add":
    case "subtract":
    case "multiply":
    case "divide": {
      const operator =
        operation.operator === "add"
          ? "+"
          : operation.operator === "subtract"
            ? "-"
            : operation.operator === "multiply"
              ? "*"
              : "/";
      // The result is guarded rather than the operands: JSONata answers `null`
      // for an out-of-range result such as a division by zero, and a workflow
      // asking for arithmetic should not silently receive a null instead.
      const result = blockVariable();
      return `($${result} := (${first} ${operator} ${second}); $type($${result}) = "number" ? $${result})`;
    }

    case "concat": {
      // `&` coerces in JSONata, and `expr.concat` does not. The guard is what
      // makes a number operand the same error in both lanes.
      const guards = compiled.map((text) => `$type(${text}) = "string"`);
      return `(${guards.join(" and ")} ? (${compiled.join(" & ")}))`;
    }

    case "coalesce": {
      const fold = (index: number): string => {
        const text = compiled[index] as string;
        if (index === compiled.length - 1) return text;
        const name = blockVariable();
        return `($${name} := ${text}; $exists($${name}) and $${name} != null ? $${name} : ${fold(index + 1)})`;
      };
      return fold(0);
    }

    case "ifElse": {
      const condition =
        operation.condition === undefined
          ? "false"
          : compileCondition(operation.condition, current);
      return `($boolean(${condition}) ? ${first} : ${second})`;
    }

    case "length": {
      const name = blockVariable();
      return `($${name} := ${first}; $type($${name}) = "string" ? $length($${name}) : $type($${name}) = "array" ? $count($${name}))`;
    }

    case "at": {
      // `$value[0]` answers with the value itself when it is not an array —
      // JSONata treats a singleton as a one-element sequence — so the type
      // guard is what stops a scalar from quietly indexing as one.
      const name = blockVariable();
      return `($${name} := ${first}; $type($${name}) = "array" ? $${name}[${second}])`;
    }

    case "project":
    case "filter": {
      const lambda = operation.lambda;
      if (lambda === undefined) return "null";
      const element = `$${elementVariable(lambda.binding)}`;
      const name = blockVariable();
      const body =
        operation.operator === "project"
          ? `$map($${name}, function(${element}) { ${operandText(lambda.body, current)} })`
          : `$filter($${name}, function(${element}) { $boolean(${
              lambda.predicate === undefined
                ? "false"
                : compileCondition(lambda.predicate, current)
            }) })`;
      // Wrapped in `[ ... ]` so an empty result stays an empty array rather
      // than becoming nothing, and a one-element result stays an array.
      return `($${name} := ${first}; $type($${name}) = "array" ? [${body}])`;
    }

    default: {
      const guards = compiled.map((text) => `$type(${text}) = "object"`);
      return `(${guards.join(" and ")} ? $merge([${compiled.join(", ")}]))`;
    }
  }
}

/** One operand position, as a bare JSONata expression rather than ASL data. */
function operandText(value: unknown, current: WorkflowNodeId | undefined): string {
  const term = referenceIn(value);
  if (term !== undefined) return expressionOf(term, current);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => operandText(entry, current)).join(", ")}]`;
  }
  if (value === null || typeof value !== "object") return literal(value);
  const members = Object.entries(value as Json).map(
    ([key, entry]) => `${JSON.stringify(key)}: ${operandText(entry, current)}`,
  );
  return `{${members.join(", ")}}`;
}

function operandExpression(
  operand: WorkflowOperand,
  current: WorkflowNodeId | undefined,
): string {
  return "literal" in operand
    ? literal(operand.literal)
    : expressionOf(operand, current);
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * A payload, as an `Arguments` value.
 *
 * Literals stay literal and references become expression strings, so the emitted
 * ASL reads as the structure the author wrote rather than as one opaque
 * expression. A payload that *is* a reference compiles to a single expression
 * string, which `Arguments` accepts.
 */
function compilePayload(value: unknown, current: WorkflowNodeId | undefined): unknown {
  const reference = referenceIn(value);
  if (reference !== undefined) return jsonata(expressionOf(reference, current));

  // A literal that happens to look like an expression is still a literal.
  // ASL decides by shape — a string wrapped in the delimiters is evaluated —
  // so authored text such as "{% not mine %}" has to be emitted as an
  // expression *producing* that string, or the workflow would evaluate data.
  if (typeof value === "string" && EXPRESSION_SHAPED.test(value)) {
    return jsonata(literal(value));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => compilePayload(entry, current));
  }
  if (value === null || typeof value !== "object") return value;

  const result: Json = {};
  for (const [key, entry] of Object.entries(value as Json)) {
    result[key] = compilePayload(entry, current);
  }
  return result;
}

/** The term a symbolic value carries, read without importing the builder. */
function referenceIn(value: unknown): WorkflowTerm | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as Record<symbol, unknown>)[
    Symbol.for("framework.workflow.reference")
  ];
  return carried === undefined ? undefined : (carried as WorkflowTerm);
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const NUMERIC_COMPARATORS = new Set(["gt", "gte", "lt", "lte"]);
const OPERATORS: Readonly<Record<string, string>> = {
  eq: "=",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * A type guard around an ordered comparison.
 *
 * JSONata raises on `"abc" > 5` rather than answering false, and the framework's
 * documented Choice behavior is that a comparison against a value of the wrong
 * type simply does not match — which is what lets an ordered list of rules be
 * written without a presence test in front of every one. Preserving that is
 * worth the extra clause; losing it would change the meaning of existing graphs
 * silently.
 *
 * Equality needs no guard: JSONata does not coerce, so `"80" = 80` is already
 * false rather than an error.
 */
function guarded(
  comparator: string,
  left: WorkflowOperand,
  right: WorkflowOperand,
  current: WorkflowNodeId | undefined,
): string {
  const leftText = operandExpression(left, current);
  const rightText = operandExpression(right, current);
  const operator = OPERATORS[comparator] as string;

  if (!NUMERIC_COMPARATORS.has(comparator)) {
    return `(${leftText} ${operator} ${rightText})`;
  }

  const guards: string[] = [];
  for (const [operand, text] of [
    [left, leftText],
    [right, rightText],
  ] as const) {
    // A literal's type is already known, so only a reference needs checking.
    if (!("literal" in operand)) guards.push(`$type(${text}) = "number"`);
  }
  const all = [...guards, `${leftText} ${operator} ${rightText}`];
  return `(${all.join(" and ")})`;
}

function compileCondition(
  condition: WorkflowCondition,
  current: WorkflowNodeId | undefined,
): string {
  switch (condition.kind) {
    case "and":
      return `(${condition.operands.map((operand) => compileCondition(operand, current)).join(" and ")})`;
    case "or":
      return `(${condition.operands.map((operand) => compileCondition(operand, current)).join(" or ")})`;
    case "not":
      return `$not(${compileCondition(condition.operand, current)})`;
    case "exists":
      return `$exists(${expressionOf(condition.value, current)})`;
    case "isNull":
      return `(${expressionOf(condition.value, current)} = null)`;
    default: {
      const { comparator, left, right } = condition;
      if (comparator === "contains" || comparator === "startsWith" || comparator === "endsWith") {
        const value = operandExpression(left, current);
        const other = operandExpression(right, current);
        const call =
          comparator === "contains"
            ? `$contains(${value}, ${other})`
            : comparator === "startsWith"
              ? `($substring(${value}, 0, $length(${other})) = ${other})`
              : `($substring(${value}, $length(${value}) - $length(${other})) = ${other})`;
        return `($type(${value}) = "string" and ${call})`;
      }
      return guarded(comparator, left, right, current);
    }
  }
}

// ---------------------------------------------------------------------------
// Error selection
// ---------------------------------------------------------------------------

const ERROR_NAMES: Readonly<Record<string, readonly string[]>> = {
  any: ["States.ALL"],
  timeout: ["States.Timeout"],
};

function errorEquals(selector: WorkflowErrorSelector | undefined): readonly string[] {
  if (selector === undefined) return ERROR_NAMES.any as readonly string[];
  if (typeof selector === "string") {
    return (ERROR_NAMES[selector] ?? ["States.ALL"]) as readonly string[];
  }
  return selector;
}

function compileRetry(policy: WorkflowRetryPolicy): Json {
  return {
    ErrorEquals: [...errorEquals(policy.on)],
    MaxAttempts: policy.retries,
    ...(policy.intervalSeconds === undefined
      ? {}
      : { IntervalSeconds: policy.intervalSeconds }),
    ...(policy.backoffRate === undefined ? {} : { BackoffRate: policy.backoffRate }),
    ...(policy.maxDelaySeconds === undefined
      ? {}
      : { MaxDelaySeconds: policy.maxDelaySeconds }),
    ...(policy.jitter === undefined
      ? {}
      : { JitterStrategy: policy.jitter === "full" ? "FULL" : "NONE" }),
  };
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

/** State types that can fail, and so can carry `Retry` and `Catch`. */
const FALLIBLE = new Set(["Task", "Map", "Parallel"]);

/** Node kinds that lower to exactly one state a retry policy can sit on. */
const RETRYABLE = new Set<string>(RETRYABLE_NODE_KINDS);

interface Scope {
  /** Where states produced in this scope are written. */
  readonly states: Json;
}

interface LowerContext {
  readonly workflow: CompiledWorkflow;
  readonly resolver: AslResolver;
}

/**
 * Lowers one node, returning the name of the state execution enters it at.
 *
 * `next` is the state to continue to, or `undefined` to end. `aliases` are extra
 * variables this node's result must also be stored under — which is how a
 * `choice` or an `attempt` ends up holding whichever branch actually ran.
 */
function lower(
  node: WorkflowNode,
  next: string | undefined,
  scope: Scope,
  context: LowerContext,
  aliases: readonly WorkflowNodeId[] = [],
): string {
  const name = context.workflow.names.get(node.id) as string;

  switch (node.kind) {
    case "sequence": {
      // Right to left, so each step knows the state that follows it. The last
      // step carries the sequence's aliases, because it produces its result.
      let entry = next;
      for (let index = node.steps.length - 1; index >= 0; index -= 1) {
        const step_ = node.steps[index] as WorkflowNode;
        entry = lower(
          step_,
          entry,
          scope,
          context,
          index === node.steps.length - 1 ? aliases : [],
        );
      }
      return entry as string;
    }

    case "invocation":
      scope.states[name] = invocationState(node, next, aliases, context);
      return name;

    case "integration":
      scope.states[name] = integrationState(node, next, aliases, context);
      return name;

    case "choice": {
      // Every branch continues to the same place, which is the join the author
      // never had to write.
      const rules = node.rules.map((rule) => ({
        condition: compileCondition(rule.when, undefined),
        entry: lower(rule.then, next, scope, context, [node.id, ...aliases]),
      }));
      const fallback = lower(node.otherwise, next, scope, context, [node.id, ...aliases]);

      scope.states[name] = {
        Type: "Choice",
        // `$boolean(...)` around the whole rule, because a comparison whose
        // operand is absent evaluates to *nothing* in JSONata rather than to
        // false, and a Choice whose condition is nothing is a runtime error
        // instead of a rule that simply did not match. The framework's
        // documented behavior is that it does not match.
        Choices: rules.map((rule) => ({
          Condition: jsonata(`$boolean(${rule.condition})`),
          Next: rule.entry,
        })),
        Default: fallback,
      };
      return name;
    }

    case "parallel":
      scope.states[name] = parallelState(node, next, aliases, context);
      return name;

    case "map":
      scope.states[name] = mapState(node, next, aliases, context);
      return name;

    case "wait": {
      const seconds = node.seconds;
      const until = node.until;
      scope.states[name] = {
        Type: "Wait",
        ...(seconds !== undefined
          ? { Seconds: durationValue(seconds) }
          : { Timestamp: durationValue(until) }),
        // Assigned rather than skipped: a wait produces no value, and "no
        // value" is `null` in both lanes. Leaving the variable unwritten made
        // any reference to it a query-evaluation error in AWS alone.
        ...assignments(node.id, null, aliases),
        Output: null,
        ...flow(next),
      };
      return name;
    }

    case "retry": {
      // A retry policy lives on one state, and re-running a *block* is not
      // something ASL can express: there is no way back to the start of a chain.
      // Checked on the node rather than on the state it lowers to, because a
      // sequence lowers to a chain whose first state looks perfectly retryable.
      if (!RETRYABLE.has(node.body.kind)) {
        throw new Error(
          `retry() wraps ${describe(node.body)}, which is not one retryable step. AWS attaches a retry policy to a single task, map or parallel state, so wrap the individual step instead.`,
        );
      }
      const entry = lower(node.body, next, scope, context, aliases);
      (scope.states[entry] as Json).Retry = [compileRetry(node.policy)];
      return entry;
    }

    case "attempt": {
      // The handler continues where the protected block would have, so a caught
      // failure rejoins the flow rather than ending it.
      const handlerEntry = lower(node.handler, next, scope, context, [node.id, ...aliases]);

      const before = new Set(Object.keys(scope.states));
      const bodyEntry = lower(node.body, next, scope, context, [node.id, ...aliases]);

      const clause = {
        ErrorEquals: [...errorEquals(node.on)],
        Next: handlerEntry,
        Assign: {
          [errorVariable(node.id)]: {
            error: jsonata("$states.errorOutput.Error"),
            cause: jsonata("$states.errorOutput.Cause"),
          },
        },
      };

      // Attached to each fallible state the block produced rather than to a
      // wrapper. A single-branch Parallel would be the obvious lowering and is
      // the wrong one: it opens a new variable scope, so every value the block
      // produced would stop being readable the moment the block finished.
      for (const stateName of Object.keys(scope.states)) {
        if (before.has(stateName)) continue;
        const state = scope.states[stateName] as Json;
        if (!FALLIBLE.has(state.Type as string)) continue;
        // An inner attempt's clause stays first, so it wins for the errors it
        // names and this one catches the rest.
        state.Catch = [...((state.Catch as unknown[] | undefined) ?? []), clause];
      }
      return bodyEntry;
    }

    case "pass": {
      // The skipped arm of a one-armed `when`. Its result is `null`, stated
      // rather than implied: an omitted `Output` passes the previous state's
      // data through, which is not what "this optional work did not run" means.
      const result =
        node.result === undefined ? null : compilePayload(node.result, node.id);
      scope.states[name] = {
        Type: "Pass",
        Output: result,
        ...assignments(node.id, result, aliases),
        ...flow(next),
      };
      return name;
    }

    case "succeed": {
      // `Assign` is not available on Succeed, and nothing can read a variable
      // after it anyway: the execution, or the branch, is over.
      // An omitted `Output` would answer with whatever the previous state
      // left behind. `succeed()` with no value means no value, in both lanes.
      const output =
        node.result === undefined ? null : compilePayload(node.result, node.id);
      scope.states[name] = { Type: "Succeed", Output: output };
      return name;
    }

    case "fail":
      scope.states[name] = {
        Type: "Fail",
        Error: compilePayload(node.error, node.id),
        ...(node.cause === undefined
          ? {}
          : { Cause: compilePayload(node.cause, node.id) }),
      };
      return name;

    default: {
      scope.states[name] = { ...node.state, ...flow(next) };
      return name;
    }
  }
}

function describe(node: WorkflowNode): string {
  if (node.kind === "invocation") return `${node.invokes}:${node.target}`;
  if (node.kind === "integration") {
    return `${node.reference.kind}:${node.reference.id} ${node.operation}`;
  }
  return `a ${node.kind}`;
}

// ---------------------------------------------------------------------------
// Managed-service steps
//
// Each operation is one optimized integration, with its arguments built from
// the authored ones and its result normalized to the small documented shape the
// local lane also answers with. The AWS response shapes never reach a workflow:
// a graph reads `.messageId`, not `MessageId`, and never an attribute value.
// ---------------------------------------------------------------------------

function integrationState(
  node: IntegrationNode,
  next: string | undefined,
  aliases: readonly WorkflowNodeId[],
  context: LowerContext,
): Json {
  const resolve = context.resolver.integrationTarget;
  if (resolve === undefined) {
    throw new Error(
      `${describe(node)} needs an integration resolver. The compiler was given no way to resolve a bound resource.`,
    );
  }
  const resolution = resolve(node.reference, node.operation);
  const key = `${node.reference.kind}:${node.operation}`;
  // An explicit AWS operation has no fixed resource string: its integration is
  // named from the service and action the reference declares.
  const resource =
    node.reference.kind === "awsOperation"
      ? `arn:aws:states:::aws-sdk:${node.reference.service}:${node.reference.action}`
      : INTEGRATION_RESOURCES[key];
  if (resource === undefined) {
    throw new Error(
      `${describe(node)} has no compiled integration. ${key} is not one of ${Object.keys(INTEGRATION_RESOURCES).join(", ")}.`,
    );
  }

  const argumentsFor = node.arguments as Record<string, unknown> | undefined;
  const { args, output } = integrationShape(node, resolution, argumentsFor ?? {});

  return {
    Type: "Task",
    Resource: resource,
    Arguments: args,
    ...(node.timeoutSeconds === undefined
      ? {}
      : { TimeoutSeconds: node.timeoutSeconds }),
    ...(node.heartbeatSeconds === undefined
      ? {}
      : { HeartbeatSeconds: node.heartbeatSeconds }),
    ...assignments(node.id, output, aliases),
    Output: output,
    ...flow(next),
  };
}

/** A JSON document as one JSONata expression, for a position needing a string. */
function documentText(value: unknown, current: WorkflowNodeId): string {
  return operandText(value, current);
}

function integrationShape(
  node: IntegrationNode,
  resolution: IntegrationResolution,
  authored: Record<string, unknown>,
): { readonly args: unknown; readonly output: unknown } {
  const current = node.id;
  const compiled = (value: unknown): unknown => compilePayload(value, current);
  const target = resolution.target ?? "";

  switch (`${node.reference.kind}:${node.operation}`) {
    case "httpConnection:request": {
      const endpoint = resolution.endpoint;
      const connectionArn = resolution.connectionArn;
      if (endpoint === undefined || connectionArn === undefined) {
        throw new Error(
          `${describe(node)} needs the endpoint and the connection its binding fixes.`,
        );
      }
      const path = operandText(authored.path, current);
      return {
        args: {
          // The host comes from the binding and the path from the graph, joined
          // here: a workflow cannot send a request somewhere else by writing a
          // clever path, because the endpoint is not one of its inputs.
          ApiEndpoint: jsonata(`${literal(endpoint)} & ${path}`),
          Method: compiled(authored.method),
          Authentication: { ConnectionArn: connectionArn },
          ...(authored.headers === undefined
            ? {}
            : { Headers: compiled(authored.headers) }),
          ...(authored.query === undefined
            ? {}
            : { QueryParameters: compiled(authored.query) }),
          ...(authored.body === undefined
            ? {}
            : { RequestBody: compiled(authored.body) }),
        },
        output: jsonata(
          '{"statusCode": $states.result.StatusCode, "headers": $states.result.Headers, "body": $states.result.ResponseBody}',
        ),
      };
    }

    case "awsOperation:call": {
      // Fixed parameters last: a runtime value cannot replace the resource the
      // binding named, which is the whole reason its grant can be narrow.
      const fixed = resolution.parameters ?? {};
      const supplied = compiled(authored.parameters ?? {});
      return {
        args:
          Object.keys(fixed).length === 0
            ? (supplied as Json)
            : jsonata(
                `$merge([${operandText(authored.parameters ?? {}, current)}, ${literal(fixed)}])`,
              ),
        output: jsonata("$states.result"),
      };
    }

    case "table:get":
      return {
        args: {
          TableName: target,
          Key: jsonata(marshalDocumentExpression(documentText(authored.key, current))),
          ...(authored.consistentRead === undefined
            ? {}
            : { ConsistentRead: compiled(authored.consistentRead) }),
        },
        // Absent is `null` rather than a missing member: "there is no such item"
        // is an ordinary answer, and the local lane gives the same one.
        output: jsonata(
          `$exists($states.result.Item) ? ${unmarshalDocumentExpression("$states.result.Item")} : null`,
        ),
      };

    case "table:put":
      return {
        args: {
          TableName: target,
          Item: jsonata(marshalDocumentExpression(documentText(authored.item, current))),
          ...conditionArguments(authored.condition, current),
        },
        output: null,
      };

    case "table:delete":
      return {
        args: {
          TableName: target,
          Key: jsonata(marshalDocumentExpression(documentText(authored.key, current))),
          ...conditionArguments(authored.condition, current),
        },
        output: null,
      };

    case "table:update": {
      const update = updateArguments(
        (authored.set ?? {}) as Record<string, unknown>,
        (authored.remove ?? []) as readonly string[],
        current,
      );
      return {
        args: {
          TableName: target,
          Key: jsonata(marshalDocumentExpression(documentText(authored.key, current))),
          UpdateExpression: update.expression,
          ReturnValues: "ALL_NEW",
          ...mergeExpressionAttributes(update, conditionArguments(authored.condition, current)),
        },
        output: jsonata(unmarshalDocumentExpression("$states.result.Attributes")),
      };
    }

    case "queue:request":
      return {
        args: {
          QueueUrl: target,
          MessageBody: jsonata(
            `$string(${callbackRequestExpression(documentText(authored.message, current))})`,
          ),
        },
        // Whatever the worker sent back. Not an acknowledgment, and not a
        // decision inferred from the message having been accepted.
        output: jsonata("$states.result"),
      };

    case "topic:request":
      return {
        args: {
          TopicArn: target,
          Message: jsonata(
            `$string(${callbackRequestExpression(documentText(authored.message, current))})`,
          ),
        },
        output: jsonata("$states.result"),
      };

    case "eventBus:request":
      return {
        args: {
          Entries: [
            {
              EventBusName: target,
              Source: compiled(authored.source),
              DetailType: compiled(authored.detailType),
              Detail: jsonata(
                `$string(${callbackRequestExpression(documentText(authored.detail, current))})`,
              ),
            },
          ],
        },
        output: jsonata("$states.result"),
      };

    case "queue:send":
      return {
        args: {
          QueueUrl: target,
          MessageBody: jsonata(`$string(${documentText(authored.message, current)})`),
          ...(authored.groupId === undefined
            ? {}
            : { MessageGroupId: compiled(authored.groupId) }),
          ...(authored.deduplicationId === undefined
            ? {}
            : { MessageDeduplicationId: compiled(authored.deduplicationId) }),
          ...(authored.delaySeconds === undefined
            ? {}
            : { DelaySeconds: compiled(authored.delaySeconds) }),
        },
        output: jsonata('{"messageId": $states.result.MessageId}'),
      };

    case "topic:publish":
      return {
        args: {
          TopicArn: target,
          Message: jsonata(`$string(${documentText(authored.message, current)})`),
          ...(authored.subject === undefined
            ? {}
            : { Subject: compiled(authored.subject) }),
          ...(authored.groupId === undefined
            ? {}
            : { MessageGroupId: compiled(authored.groupId) }),
          ...(authored.deduplicationId === undefined
            ? {}
            : { MessageDeduplicationId: compiled(authored.deduplicationId) }),
        },
        output: jsonata('{"messageId": $states.result.MessageId}'),
      };

    default:
      return {
        args: {
          Entries: [
            {
              EventBusName: target,
              Source: compiled(authored.source),
              DetailType: compiled(authored.detailType),
              Detail: jsonata(`$string(${documentText(authored.detail, current)})`),
            },
          ],
        },
        // PutEvents answers 200 for a request whose entry was rejected, so the
        // entry's own outcome is what decides. A rejected entry makes this
        // expression produce nothing, which fails the state — on the state
        // itself, so a Retry or a surrounding attempt still applies to it.
        output: jsonata(
          '$states.result.FailedEntryCount = 0 ? {"eventId": $states.result.Entries[0].EventId}',
        ),
      };
  }
}

interface ExpressionAttributes {
  readonly names: Json;
  readonly values: Json;
}

/**
 * An update expression built from literal member names.
 *
 * The names are authored and therefore known at compile time; only the values
 * are symbolic. Every name goes through a placeholder because DynamoDB's
 * reserved-word list is long and surprising, and a workflow should not fail
 * because a field was called `status`.
 */
function updateArguments(
  set: Record<string, unknown>,
  remove: readonly string[],
  current: WorkflowNodeId,
): ExpressionAttributes & { readonly expression: string } {
  const names: Json = {};
  const values: Json = {};
  const assignments_: string[] = [];
  const removals: string[] = [];

  Object.entries(set).forEach(([attribute, value], index) => {
    const namePlaceholder = `#wfn${index}`;
    const valuePlaceholder = `:wfv${index}`;
    names[namePlaceholder] = attribute;
    values[valuePlaceholder] = jsonata(
      marshalValueExpression(operandText(value, current)),
    );
    assignments_.push(`${namePlaceholder} = ${valuePlaceholder}`);
  });

  remove.forEach((attribute, index) => {
    const namePlaceholder = `#wfr${index}`;
    names[namePlaceholder] = attribute;
    removals.push(namePlaceholder);
  });

  const clauses: string[] = [];
  if (assignments_.length > 0) clauses.push(`SET ${assignments_.join(", ")}`);
  if (removals.length > 0) clauses.push(`REMOVE ${removals.join(", ")}`);
  return { expression: clauses.join(" "), names, values };
}

/** A declared conditional write, as DynamoDB's own arguments. */
function conditionArguments(
  condition: unknown,
  current: WorkflowNodeId,
): Json {
  if (condition === null || typeof condition !== "object") return {};
  const declared = condition as {
    readonly expression: string;
    readonly names?: Readonly<Record<string, string>>;
    readonly values?: Readonly<Record<string, unknown>>;
  };
  const values: Json = {};
  for (const [placeholder, value] of Object.entries(declared.values ?? {})) {
    values[placeholder] = jsonata(marshalValueExpression(operandText(value, current)));
  }
  return {
    ConditionExpression: declared.expression,
    ...(declared.names === undefined
      ? {}
      : { ExpressionAttributeNames: { ...declared.names } }),
    ...(Object.keys(values).length === 0
      ? {}
      : { ExpressionAttributeValues: values }),
  };
}

/** Combines generated update placeholders with an authored condition's. */
function mergeExpressionAttributes(
  update: ExpressionAttributes,
  condition: Json,
): Json {
  const names = {
    ...update.names,
    ...((condition.ExpressionAttributeNames as Json | undefined) ?? {}),
  };
  const values = {
    ...update.values,
    ...((condition.ExpressionAttributeValues as Json | undefined) ?? {}),
  };
  return {
    ...(condition.ConditionExpression === undefined
      ? {}
      : { ConditionExpression: condition.ConditionExpression }),
    ...(Object.keys(names).length === 0 ? {} : { ExpressionAttributeNames: names }),
    ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }),
  };
}

function flow(next: string | undefined): Json {
  return next === undefined ? { End: true } : { Next: next };
}

function durationValue(value: unknown): unknown {
  return compilePayload(value, undefined);
}

/**
 * `Assign` for a node's own variable plus any aliases.
 *
 * Written as an expression per target rather than assigning one and copying it:
 * a variable is not readable in the state that writes it.
 */
function assignments(
  node: WorkflowNodeId,
  value: unknown,
  aliases: readonly WorkflowNodeId[],
): Json {
  const assign: Json = {};
  assign[variableOf(node)] = value;
  for (const alias of aliases) assign[variableOf(alias)] = value;
  return Object.keys(assign).length === 0 ? {} : { Assign: assign };
}

// ---------------------------------------------------------------------------
// Invocations
// ---------------------------------------------------------------------------

function invocationState(
  node: InvocationNode,
  next: string | undefined,
  aliases: readonly WorkflowNodeId[],
  context: LowerContext,
): Json {
  const shared: Json = {
    Type: "Task",
    ...(node.timeoutSeconds === undefined
      ? {}
      : { TimeoutSeconds: node.timeoutSeconds }),
  };

  if (node.invokes === "lambda") {
    const result = jsonata("$states.result");
    return {
      ...shared,
      // The function ARN in `Resource` is the payload-only Lambda integration:
      // the state result is the function's return value, with no
      // `{Payload, StatusCode}` envelope to normalize away, and a function error
      // fails the state rather than succeeding with a `FunctionError` field a
      // graph would have to remember to check.
      Resource: context.resolver.lambdaArn(node.target),
      // Always emitted. Omitting `Arguments` forwards the state's input, which
      // is whatever the previous step happened to produce; an absent payload
      // means `{}`, and the local lane passes exactly that.
      Arguments:
        node.payload === undefined ? {} : compilePayload(node.payload, node.id),
      ...assignments(node.id, result, aliases),
      Output: result,
      ...flow(next),
    };
  }

  if (node.invokes === "workflow") {
    const resolve = context.resolver.workflowArn;
    if (resolve === undefined) {
      throw new Error(
        `runWorkflow("${node.target}") needs a workflow resolver. The compiler was given no way to resolve a child state machine ARN.`,
      );
    }
    const result = jsonata("$states.result.Output");
    return {
      ...shared,
      Resource: STATES_START_EXECUTION_SYNC_RESOURCE,
      Arguments: {
        StateMachineArn: resolve(node.target),
        Input:
          node.payload === undefined ? {} : compilePayload(node.payload, node.id),
      },
      ...assignments(node.id, result, aliases),
      Output: result,
      ...flow(next),
    };
  }

  const launch = context.resolver.taskLaunch(node.target);
  if (node.completion === "callback") {
    // The container reports a business result, so the step's output is that
    // result rather than the ECS task metadata. It does not also wait for the
    // process to exit: reporting and exiting are different events, and the
    // first terminal one is the answer.
    return {
      ...shared,
      Resource: ECS_RUN_TASK_CALLBACK_RESOURCE,
      ...(node.heartbeatSeconds === undefined
        ? {}
        : { HeartbeatSeconds: node.heartbeatSeconds }),
      Arguments: {
        ...taskLaunchArguments(launch),
        Overrides: {
          ContainerOverrides: [
            {
              Name: launch.containerName,
              Environment: [
                { Name: "FRAMEWORK_TASK_INPUT", Value: taskInputExpression(node) },
                {
                  // The literal rather than the constant, for the reason the
                  // input variable below gives: importing a value back out of
                  // the facade this module is re-exported by is a cycle.
                  Name: "FRAMEWORK_TASK_CALLBACK",
                  Value: jsonata(`$string(${awsCallbackHandleExpression()})`),
                },
              ],
            },
          ],
        },
      },
      ...assignments(node.id, jsonata("$states.result"), aliases),
      Output: jsonata("$states.result"),
      ...flow(next),
    };
  }
  // The integration answers with ECS task metadata. Normalized to the small
  // framework summary, deliberately not the container's stdout, which is
  // diagnostic and has no business-output channel.
  //
  // `ExitCode` is guarded because ECS genuinely omits it when a container is
  // killed rather than exiting — and in JSONata a missing field is
  // `States.QueryEvaluationError`, not `undefined`. Reading it unguarded would
  // fail exactly on the paths a graph most needs to handle.
  const summary = {
    runId: jsonata("$states.result.TaskArn"),
    exitCode: jsonata(
      '$exists($states.result.Containers[0].ExitCode) ? $states.result.Containers[0].ExitCode : null',
    ),
  };

  return {
    ...shared,
    Resource: ECS_RUN_TASK_SYNC_RESOURCE,
    // Compiled from the same immutable launch specification `runTask` uses,
    // including the revision-qualified definition ARN and the networking.
    Arguments: {
      ...taskLaunchArguments(launch),
      Overrides: {
        ContainerOverrides: [
          {
            Name: launch.containerName,
            Environment: [
              {
                // The literal rather than the constant `./index` exports. This
                // module is re-exported *by* that facade, so importing a value
                // back out of it is a runtime cycle — and for one protocol
                // string it is not worth a shared module either.
                // `invocation-protocol.test.ts` asserts this against the
                // reader's own `FRAMEWORK_TASK_INPUT_ENVIRONMENT`, which is what
                // keeps the two halves honest.
                Name: "FRAMEWORK_TASK_INPUT",
                Value: taskInputExpression(node),
              },
            ],
          },
        ],
      },
    },
    ...assignments(node.id, summary, aliases),
    Output: summary,
    ...flow(next),
  };
}

/** The launch specification both task integrations share. */
function taskLaunchArguments(
  launch: ReturnType<AslResolver["taskLaunch"]>,
): Json {
  return {
    Cluster: launch.cluster,
    TaskDefinition: launch.taskDefinitionArn,
    LaunchType: "FARGATE",
    PlatformVersion: launch.platformVersion,
    NetworkConfiguration: {
      AwsvpcConfiguration: {
        Subnets: [...launch.subnets],
        SecurityGroups: [...launch.securityGroups],
        AssignPublicIp: launch.assignPublicIp ? "ENABLED" : "DISABLED",
      },
    },
  };
}

/**
 * The task's input, as one JSON string.
 *
 * `$string` rather than an intrinsic: JSONata mode has no `States.JsonToString`.
 * The two differ on scalars — `$string("a")` is `a` where the intrinsic gave
 * `"a"` — which is why a task payload is required to be a JSON document. The
 * local interpreter applies the same rule, so the lanes agree.
 */
function taskInputExpression(node: InvocationNode): string {
  if (node.payload === undefined) return jsonata('$string({})');
  const reference = referenceIn(node.payload);
  if (reference !== undefined) {
    return jsonata(`$string(${expressionOf(reference, node.id)})`);
  }
  return jsonata(`$string(${objectExpression(node.payload, node.id)})`);
}

/** A payload as one JSONata object-construction expression. */
function objectExpression(value: unknown, current: WorkflowNodeId): string {
  return operandText(value, current);
}

// ---------------------------------------------------------------------------
// Parallel and map
// ---------------------------------------------------------------------------

function parallelState(
  node: ParallelNode,
  next: string | undefined,
  aliases: readonly WorkflowNodeId[],
  context: LowerContext,
): Json {
  const branches = node.branches.map((branch) => {
    // Each branch is its own state machine, with its own states and its own
    // variable scope. Nothing it assigns survives the join, which is why the
    // validator refuses a reference from outside the branch into it.
    const scope: Scope = { states: {} };
    const entry = lower(branch, undefined, scope, context);
    return { StartAt: entry, States: scope.states };
  });

  // AWS answers with an array in branch order. Reassembled here into whatever
  // the author asked for, so the array never reaches application code.
  const joined =
    node.names === undefined
      ? jsonata("$states.result")
      : jsonata(
          `{${node.names
            .map((branchName, index) => `${JSON.stringify(branchName)}: $states.result[${index}]`)
            .join(", ")}}`,
        );

  return {
    Type: "Parallel",
    Branches: branches,
    ...assignments(node.id, joined, aliases),
    Output: joined,
    ...flow(next),
  };
}

function mapState(
  node: MapNode,
  next: string | undefined,
  aliases: readonly WorkflowNodeId[],
  context: LowerContext,
): Json {
  const scope: Scope = { states: {} };
  const bodyEntry = lower(node.body, undefined, scope, context);

  // The current item is bound once, at the top of the iteration, and read from
  // a variable thereafter. `ItemSelector` is the only place the context object
  // exposes it, and `$states.input` stops being the item as soon as one state
  // has run — so reading it directly would work in the first state of the body
  // and silently mean something else in the second.
  const bindName = `MapBind_${node.id}`;
  const states: Json = {
    [bindName]: {
      Type: "Pass",
      Assign: {
        [mapBindingVariable(node.id, "item")]: jsonata("$states.input.item"),
        [mapBindingVariable(node.id, "index")]: jsonata("$states.input.index"),
      },
      Next: bodyEntry,
    },
    ...scope.states,
  };

  const result = jsonata("$states.result");
  return {
    Type: "Map",
    Items: jsonata(expressionOf(node.items, undefined)),
    ItemSelector: {
      item: jsonata("$states.context.Map.Item.Value"),
      index: jsonata("$states.context.Map.Item.Index"),
    },
    ItemProcessor: {
      ProcessorConfig: {
        Mode: node.mode === "distributed" ? "DISTRIBUTED" : "INLINE",
      },
      StartAt: bindName,
      States: states,
    },
    // Always emitted, because the local executor bounds iterations the same
    // way. An omitted MaxConcurrency means "unlimited" in AWS and would be a
    // different graph from the one that ran on a developer's machine.
    MaxConcurrency: node.maxConcurrency,
    ...assignments(node.id, result, aliases),
    Output: result,
    ...flow(next),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** One workflow as an ASL definition object, ready for a CDK `DefinitionBody`. */
export function compileWorkflowToAsl(
  workflow: CompiledWorkflow,
  resolver: AslResolver,
): Json {
  const scope: Scope = { states: {} };
  const startAt = lower(workflow.root, undefined, scope, { workflow, resolver });

  return {
    Comment: `Generated from workflows["${workflow.id}"] in framework.config.ts. Do not edit in the console.`,
    // Set once, at the top. Branch and iteration state machines inherit it.
    QueryLanguage: "JSONata",
    StartAt: startAt,
    TimeoutSeconds: workflow.timeoutSeconds,
    States: scope.states,
  };
}

// ---------------------------------------------------------------------------
// The development bridge
// ---------------------------------------------------------------------------

/**
 * One advanced integration, as a state machine of its own.
 *
 * Local development runs orchestration on a developer's machine, and two of
 * these integrations cannot follow it there. An HTTPS call through an
 * EventBridge Connection is authenticated by AWS, from a secret the connection
 * owns — reproducing that locally would mean handing the credential to a laptop.
 * An explicit AWS operation is bound to a role whose grant is the point of
 * declaring it. In both cases the honest answer is that the *call* belongs in
 * AWS even when the orchestration does not.
 *
 * So the deployment generates one tiny Express state machine per bound
 * reference, holding exactly that one task and exactly that one role, and the
 * local runner starts it synchronously. Authentication, connection behavior and
 * IAM stay where they were; what crosses the boundary is a request and a
 * response.
 *
 * Its `Arguments` are built as a single JSONata object rather than field by
 * field, because that is what makes an absent member — no body on a GET, no
 * query on a plain path — *omit* the argument instead of sending nothing.
 *
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/call-https-apis.html
 */
export function compileIntegrationBridge(
  spec: IntegrationSpec,
  operation: string,
  resolution: IntegrationResolution,
  options: { readonly timeoutSeconds?: number } = {},
): Json {
  const input = "$states.context.Execution.Input";
  const state: Json = (() => {
    if (spec.kind === "httpConnection") {
      if (resolution.endpoint === undefined || resolution.connectionArn === undefined) {
        throw new Error(
          `httpConnection:${spec.id} needs the endpoint and connection its binding fixes.`,
        );
      }
      return {
        Type: "Task",
        Resource: INTEGRATION_RESOURCES["httpConnection:request"] as string,
        Arguments: jsonata(
          `{${[
            `"ApiEndpoint": ${literal(resolution.endpoint)} & ${input}.path`,
            `"Method": ${input}.method`,
            `"Authentication": {"ConnectionArn": ${literal(resolution.connectionArn)}}`,
            `"Headers": ${input}.headers`,
            `"QueryParameters": ${input}.query`,
            `"RequestBody": ${input}.body`,
          ].join(", ")}}`,
        ),
        Output: jsonata(
          '{"statusCode": $states.result.StatusCode, "headers": $states.result.Headers, "body": $states.result.ResponseBody}',
        ),
        End: true,
      };
    }
    if (spec.kind === "awsOperation") {
      const fixed = resolution.parameters ?? {};
      return {
        Type: "Task",
        Resource: `arn:aws:states:::aws-sdk:${spec.service}:${spec.action}`,
        // Fixed parameters last, exactly as the inline lowering merges them: a
        // runtime value cannot replace the resource the binding named.
        Arguments: jsonata(
          Object.keys(fixed).length === 0
            ? `${input}.parameters`
            : `$merge([${input}.parameters, ${literal(fixed)}])`,
        ),
        Output: jsonata("$states.result"),
        End: true,
      };
    }
    throw new Error(
      `${spec.kind}:${spec.id} needs no development bridge: the local lane calls it directly.`,
    );
  })();

  return {
    Comment: `Development bridge for ${spec.kind}:${spec.id} ${operation}. Generated; do not edit in the console.`,
    QueryLanguage: "JSONata",
    StartAt: "Perform",
    // Express executions are capped well below this; the bound is here so a
    // hung call cannot hold a local step open past its own deadline either.
    TimeoutSeconds: options.timeoutSeconds ?? 60,
    States: { Perform: state },
  };
}

/** Which references need a bridge to be reachable from local orchestration. */
export function needsDevelopmentBridge(spec: IntegrationSpec): boolean {
  return spec.kind === "httpConnection" || spec.kind === "awsOperation";
}

/** Every node a graph contains, for callers deriving permissions or docs. */
export function nodesOf(root: WorkflowNode): readonly WorkflowNode[] {
  const all: WorkflowNode[] = [];
  const visit = (node: WorkflowNode): void => {
    all.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return all;
}
