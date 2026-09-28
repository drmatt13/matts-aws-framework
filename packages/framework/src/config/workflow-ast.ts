/**
 * The workflow intermediate representation.
 *
 * This is the contract. A workflow callback builds one of these graphs, and the
 * two backends — the ASL compiler and the local interpreter — are projections of
 * it. Neither reads authored data, and the interpreter never sees ASL: that is
 * what stops the two lanes from disagreeing about what a graph means.
 *
 * Everything here is pure data with no imports, so the vocabulary can be
 * re-exported without a cycle and bundled into a browser surface without
 * dragging a runtime behind it.
 *
 * ## Why an AST rather than a state map
 *
 * The previous representation was Amazon States Language with TypeScript types
 * on it: the author named states and wired `next` between them. A structured
 * graph makes a whole class of error impossible to express rather than merely
 * checked — a transition to a state that does not exist, an unreachable state, a
 * state with neither `next` nor `end`. None of those can be constructed here.
 *
 * The cost is that back edges are gone: structured control flow has no `goto`.
 * `map` covers repetition over a collection and `retry` covers "until it
 * succeeds"; a bounded `repeatUntil` is the shape to add if polling on a
 * *result* is ever needed, and it would lower to the same wait/choice cycle.
 */

import type { DeploySetting } from "./deploy";
import type { IntegrationSpec } from "./workflow-integrations";

/**
 * A node's identity, assigned in construction order.
 *
 * Stable and deterministic, which is what lets state names be derived rather
 * than authored, and what lets observability name a node without depending on
 * anything a developer typed.
 */
export type WorkflowNodeId = string;

/** One step of a property path: a member name or a constant array index. */
export type WorkflowPathStep = string | number;

// ---------------------------------------------------------------------------
// Symbolic values
//
// A workflow value is a *reference*, not a value. `validated.output.accountId`
// reads as ordinary property access and records a path; nothing is read at
// construction time, because there is nothing to read yet.
// ---------------------------------------------------------------------------

/** Where a symbolic value comes from. */
export type WorkflowValueSource =
  /** The result of a node, once it has run. */
  | { readonly kind: "node"; readonly node: WorkflowNodeId }
  /** The workflow's own input. */
  | { readonly kind: "input" }
  /**
   * A map's current item or index.
   *
   * Separate from a node reference on purpose. AWS exposes the current item
   * through `ItemSelector` on the Map state, and it is explicitly *not* readable
   * from states inside the `ItemProcessor` — so this resolves through a
   * different mechanism than a workflow variable and must stay distinguishable.
   */
  | {
      readonly kind: "mapBinding";
      readonly map: WorkflowNodeId;
      readonly field: "item" | "index";
    }
  /** The error an `attempt` handler receives. */
  | { readonly kind: "error"; readonly attempt: WorkflowNodeId }
  /**
   * The current element of a data-only `project` or `filter`.
   *
   * Separate from a map item because it is not a step: nothing is scheduled,
   * nothing is concurrent, and the binding exists only inside the expression
   * that introduced it. Keeping it distinguishable is what lets the validator
   * say so when one leaks out.
   */
  | { readonly kind: "elementBinding"; readonly binding: WorkflowBindingId };

/** The identity of one expression-scoped element binding. */
export type WorkflowBindingId = string;

/** A resolved reference: where it starts, and how far into it to read. */
export interface WorkflowReference {
  readonly kind: "reference";
  readonly source: WorkflowValueSource;
  readonly path: readonly WorkflowPathStep[];
}

/**
 * The operations `expr` offers over symbolic values.
 *
 * A closed set, on purpose. The alternative — accepting raw JSONata — would
 * put an expression language the framework does not evaluate into the one
 * place both lanes have to agree, and the local interpreter would then need a
 * JSONata engine whose behavior it could only hope matched AWS's.
 */
export const WORKFLOW_OPERATORS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "concat",
  "coalesce",
  "ifElse",
  "length",
  "at",
  "project",
  "filter",
  "merge",
] as const;

export type WorkflowOperator = (typeof WORKFLOW_OPERATORS)[number];

/** The element-wise body of a `project` or the predicate of a `filter`. */
export interface WorkflowLambda {
  readonly binding: WorkflowBindingId;
  /** `project`: the value each element becomes. */
  readonly body?: unknown;
  /** `filter`: whether the element is kept. */
  readonly predicate?: WorkflowCondition;
}

/**
 * A computed value.
 *
 * Carries a `path` for the same reason a reference does: `expr.merge(a, b).id`
 * reads as ordinary property access, and the access belongs to the term rather
 * than to a separate wrapper.
 */
export interface WorkflowOperation {
  readonly kind: "operation";
  readonly operator: WorkflowOperator;
  readonly operands: readonly unknown[];
  readonly path: readonly WorkflowPathStep[];
  /** `ifElse` only. */
  readonly condition?: WorkflowCondition;
  /** `project` and `filter` only. */
  readonly lambda?: WorkflowLambda;
}

/** Anything a symbolic value can carry: a read, or a computation over reads. */
export type WorkflowTerm = WorkflowReference | WorkflowOperation;

/** The brand that distinguishes a symbolic value from an ordinary object. */
export const WORKFLOW_REFERENCE = Symbol.for("framework.workflow.reference");

/**
 * A phantom marker carrying the value's type.
 *
 * Type-only — `declare const` means it never exists at runtime. It is here
 * because `WorkflowValueMembers<T>` is a conditional type, and TypeScript cannot
 * infer `T` from a conditional position. Without a plainly inferrable
 * occurrence, `OutputOf<Flow<T>>` silently resolves to `unknown` and every typed
 * property access on a step's output degrades to `any`-like nothingness.
 */
export declare const WORKFLOW_OUTPUT: unique symbol;

/** A symbolic value carrying the type it will hold at runtime. */
export type WorkflowValue<T> = {
  readonly [WORKFLOW_REFERENCE]: WorkflowReference;
  readonly [WORKFLOW_OUTPUT]: T;
} & WorkflowValueMembers<T>;

/**
 * Typed property access over a symbolic value.
 *
 * `-?` strips optionality so `user.output.name` stays reachable on an optional
 * member; whether it is *present* at runtime is a question for `exists()`, not
 * for whether the path can be written.
 */
type WorkflowValueMembers<T> = [T] extends [readonly (infer Element)[]]
  ? { readonly [index: number]: WorkflowValue<Element> }
  : [T] extends [object]
    ? { readonly [K in keyof T]-?: WorkflowValue<T[K]> }
    : unknown;

/** A payload position: a literal, a symbolic value, or a structure of both. */
export type WorkflowExpression<T> =
  | WorkflowValue<T>
  | ([T] extends [readonly (infer Element)[]]
      ? readonly WorkflowExpression<Element>[]
      : [T] extends [object]
        ? { readonly [K in keyof T]: WorkflowExpression<T[K]> }
        : T);

/** The error an `attempt` handler receives, as AWS shapes it. */
export interface WorkflowErrorValue {
  readonly error: string;
  readonly cause: string;
}

// ---------------------------------------------------------------------------
// Conditions
//
// An expression tree rather than a JavaScript predicate: a closure cannot be
// compiled into a Choice rule, and operator overloading cannot work because a
// symbolic value is not a number. The tree is small on purpose.
// ---------------------------------------------------------------------------

/** One side of a comparison: a symbolic value or a literal. */
export type WorkflowOperand = WorkflowTerm | { readonly literal: unknown };

export type WorkflowComparator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "startsWith"
  | "endsWith";

export type WorkflowCondition =
  | {
      readonly kind: "compare";
      readonly comparator: WorkflowComparator;
      readonly left: WorkflowOperand;
      readonly right: WorkflowOperand;
    }
  | { readonly kind: "and"; readonly operands: readonly WorkflowCondition[] }
  | { readonly kind: "or"; readonly operands: readonly WorkflowCondition[] }
  | { readonly kind: "not"; readonly operand: WorkflowCondition }
  | { readonly kind: "exists"; readonly value: WorkflowTerm }
  | { readonly kind: "isNull"; readonly value: WorkflowTerm };

// ---------------------------------------------------------------------------
// Error selection
// ---------------------------------------------------------------------------

/**
 * Which failures a `retry` or `attempt` clause responds to.
 *
 * Framework vocabulary rather than AWS error names: `"any"` is the ordinary
 * case and means retryable task failures, not literally every error. The
 * compiler maps these to `ErrorEquals`.
 */
export type WorkflowErrorSelector = "any" | "timeout" | readonly string[];

export interface WorkflowRetryPolicy {
  /** Number of *retries*. `retries: 3` runs the work up to four times. */
  readonly retries: number;
  readonly intervalSeconds?: number | undefined;
  readonly backoffRate?: number | undefined;
  readonly maxDelaySeconds?: number | undefined;
  readonly jitter?: "none" | "full" | undefined;
  readonly on?: WorkflowErrorSelector | undefined;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface WorkflowNodeBase {
  readonly id: WorkflowNodeId;
  /** Optional, for observability only. It never participates in wiring. */
  readonly label?: string | undefined;
}

/** A step target: an `events` Lambda, a container task, or a child workflow. */
export type WorkflowInvocationKind = "lambda" | "task" | "workflow";

/**
 * One unit of framework work, awaited.
 *
 * `runTask` means "start this task and wait for its completion semantics", not
 * "the RunTask API accepted the call" — which is why a following node does not
 * begin merely because ECS acknowledged the launch.
 */
export interface InvocationNode extends WorkflowNodeBase {
  readonly kind: "invocation";
  readonly invokes: WorkflowInvocationKind;
  readonly target: string;
  readonly payload?: unknown;
  readonly timeoutSeconds?: number | undefined;
  /**
   * Which event ends the step.
   *
   * `exit` is the ordinary reading of `runTask`: the container ran, and the
   * result is the framework's task summary. `callback` means the container
   * reports a *business result* and the step ends when it does — which is a
   * different event from the process exiting, and the two are kept apart
   * rather than one being inferred from the other.
   */
  readonly completion?: "exit" | "callback";
  /** Callback mode only, and never an extension of the absolute deadline. */
  readonly heartbeatSeconds?: number | undefined;
}

/**
 * One managed-service call, awaited.
 *
 * Kept separate from {@link InvocationNode} because the two answer different
 * questions. An invocation names a workload this repository declares and builds;
 * an integration names a resource application CDK creates and binds. The graph
 * derives permissions from both, but from different bindings and with different
 * grants.
 *
 * `completion` is the distinction the plan insists on: waiting for the API call
 * to be accepted and waiting for a worker to report a result are different
 * events, and a step says which one it means rather than leaving it to be
 * inferred from the reference.
 */
export interface IntegrationNode extends WorkflowNodeBase {
  readonly kind: "integration";
  readonly reference: IntegrationSpec;
  readonly operation: string;
  readonly arguments?: unknown;
  readonly timeoutSeconds?: number | undefined;
  readonly completion: "response" | "callback";
  /** Callback steps only, and never an extension of the absolute deadline. */
  readonly heartbeatSeconds?: number | undefined;
}

export interface SequenceNode extends WorkflowNodeBase {
  readonly kind: "sequence";
  readonly steps: readonly WorkflowNode[];
}

/**
 * Concurrent branches, joined.
 *
 * `names` is present for the object form and absent for the positional one;
 * the compiler reassembles AWS's branch-result array into whichever the author
 * asked for, so the array never reaches application code.
 */
export interface ParallelNode extends WorkflowNodeBase {
  readonly kind: "parallel";
  readonly branches: readonly WorkflowNode[];
  readonly names?: readonly string[] | undefined;
}

export interface WorkflowChoiceRule {
  readonly when: WorkflowCondition;
  readonly then: WorkflowNode;
}

/**
 * Ordered rules with a required default.
 *
 * The default is required rather than optional because an unmatched Choice is a
 * runtime failure in AWS, and "the workflow stopped and the reason is
 * `States.NoChoiceMatched`" is a worse diagnostic than a compile-time demand for
 * an `otherwise`.
 */
export interface ChoiceNode extends WorkflowNodeBase {
  readonly kind: "choice";
  readonly rules: readonly WorkflowChoiceRule[];
  readonly otherwise: WorkflowNode;
  /**
   * Whether the author omitted a false branch on a two-way `when`.
   *
   * The node still carries a pass-through `otherwise`, but the output type is
   * `T | undefined` and the validator preserves that meaning.
   */
  readonly optional?: true | undefined;
}

export interface MapNode extends WorkflowNodeBase {
  readonly kind: "map";
  readonly items: WorkflowTerm;
  readonly body: WorkflowNode;
  /** Always present: the builder folds in AWS's inline default. */
  readonly maxConcurrency: number;
  readonly mode: "inline" | "distributed";
}

export interface WaitNode extends WorkflowNodeBase {
  readonly kind: "wait";
  readonly seconds?: WorkflowExpression<number> | undefined;
  readonly until?: WorkflowExpression<string> | undefined;
}

export interface RetryNode extends WorkflowNodeBase {
  readonly kind: "retry";
  readonly body: WorkflowNode;
  readonly policy: WorkflowRetryPolicy;
}

export interface AttemptNode extends WorkflowNodeBase {
  readonly kind: "attempt";
  readonly body: WorkflowNode;
  readonly handler: WorkflowNode;
  readonly on?: WorkflowErrorSelector | undefined;
}

/**
 * A no-op that continues.
 *
 * Not part of the authored language — the builder creates one for the implicit
 * else of a `when` with no false branch. It exists because "skip the work and
 * carry on" and "finish successfully" are different things, and a `succeed`
 * would end the execution rather than rejoin the flow.
 */
export interface PassNode extends WorkflowNodeBase {
  readonly kind: "pass";
  readonly result?: unknown;
}

export interface SucceedNode extends WorkflowNodeBase {
  readonly kind: "succeed";
  /**
   * The explicit workflow result.
   *
   * Named `result` rather than `output` because every node is also a `Flow`,
   * and `Flow.output` is the symbolic reference to a node's result. Two
   * different things called `output` on one object means the accessor silently
   * replaces the data — which it did, until a test caught it.
   */
  readonly result?: unknown;
}

export interface FailNode extends WorkflowNodeBase {
  readonly kind: "fail";
  readonly error: string;
  readonly cause?: string | undefined;
}

/**
 * A verbatim ASL state.
 *
 * Deliberately ugly, deliberately not imported by ordinary workflows. A raw
 * state can introduce resources, IAM and semantics the typed graph cannot
 * derive, so the local interpreter refuses to guess at it rather than running
 * something that only resembles what AWS would do.
 */
export interface RawStateNode extends WorkflowNodeBase {
  readonly kind: "rawState";
  readonly state: Readonly<Record<string, unknown>>;
}

export type WorkflowNode =
  | InvocationNode
  | IntegrationNode
  | SequenceNode
  | ParallelNode
  | ChoiceNode
  | MapNode
  | WaitNode
  | RetryNode
  | AttemptNode
  | PassNode
  | SucceedNode
  | FailNode
  | RawStateNode;

/**
 * Node kinds a `retry` policy can wrap.
 *
 * AWS attaches `Retry` to one state, and there is no way back to the start of a
 * chain, so a sequence is not retryable however natural it looks to write. The
 * set is stated here because two places need the same answer: the validator,
 * which refuses the graph, and the compiler, which would otherwise be the first
 * to notice.
 */
export const RETRYABLE_NODE_KINDS = [
  "invocation",
  "integration",
  "map",
  "parallel",
] as const;

export type RetryableNodeKind = (typeof RETRYABLE_NODE_KINDS)[number];

export function isRetryableNodeKind(kind: string): kind is RetryableNodeKind {
  return (RETRYABLE_NODE_KINDS as readonly string[]).includes(kind);
}

export const WORKFLOW_NODE_KINDS = [
  "invocation",
  "integration",
  "sequence",
  "parallel",
  "choice",
  "map",
  "wait",
  "retry",
  "attempt",
  "pass",
  "succeed",
  "fail",
  "rawState",
] as const;

// ---------------------------------------------------------------------------
// The authored entry
// ---------------------------------------------------------------------------

/**
 * Execution type.
 *
 * Standard is the default and the only one that supports the `.sync`
 * integrations `runTask` and `runWorkflow` depend on. Express is offered because
 * it materially changes cost and duration limits, not as an AWS implementation
 * detail — and the validator refuses a graph whose steps it cannot honour rather
 * than letting AWS fail at run time.
 */
export type WorkflowExecutionType = "standard" | "express";

export interface WorkflowOptions {
  /** Whole-execution deadline. Required: a graph needs a bound. */
  readonly timeoutSeconds: number;
  readonly deploy?: DeploySetting;
  readonly type?: WorkflowExecutionType;
  readonly cloud?: {
    readonly constructId?: string;
    readonly outputs?: {
      readonly arn?: { readonly id: string; readonly exportName?: string };
    };
  };
}

/**
 * A workflow as declared: the graph, plus how and where it runs.
 *
 * This is what `workflow(...)` returns and what a `workflows` section holds. The
 * graph is built eagerly and synchronously when the entry is declared, so a
 * malformed graph is a module-load error rather than a deployment surprise.
 */
export interface WorkflowDefinition {
  readonly root: WorkflowNode;
  readonly timeoutSeconds: number;
  readonly deploy?: DeploySetting;
  readonly type?: WorkflowExecutionType;
  readonly cloud?: WorkflowOptions["cloud"];
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/** Every node directly contained by this one, in execution-declaration order. */
export function childrenOf(node: WorkflowNode): readonly WorkflowNode[] {
  switch (node.kind) {
    case "sequence":
      return node.steps;
    case "parallel":
      return node.branches;
    case "choice":
      return [...node.rules.map((rule) => rule.then), node.otherwise];
    case "map":
      return [node.body];
    case "retry":
      return [node.body];
    case "attempt":
      return [node.body, node.handler];
    default:
      return [];
  }
}

/** Depth-first walk, parents before children. */
export function walkWorkflow(
  node: WorkflowNode,
  visit: (node: WorkflowNode) => void,
): void {
  visit(node);
  for (const child of childrenOf(node)) walkWorkflow(child, visit);
}

/**
 * The node whose result is this node's result.
 *
 * A sequence answers with its last step and a retry with its body, because that
 * is what "the output of this flow" means to an author. A node with no single
 * answer — a parallel join, a choice union — is its own result.
 */
export function resultNodeOf(node: WorkflowNode): WorkflowNode {
  if (node.kind === "sequence") {
    const last = node.steps[node.steps.length - 1];
    return last === undefined ? node : resultNodeOf(last);
  }
  if (node.kind === "retry") return resultNodeOf(node.body);
  return node;
}
