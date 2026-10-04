/**
 * Static validation: what the type system cannot refuse, and the compiler must.
 *
 * Two questions, both answered before anything is deployed.
 *
 * **Can this reference resolve?** A value computed inside a parallel branch does
 * not survive the join, and one branch cannot see another's work. AWS enforces
 * that at run time, on whichever branch happens to fail first, in production.
 * Here it is a synthesis error naming both ends.
 *
 * **Can this workflow type do this?** An Express workflow cannot use the `.sync`
 * integrations `runTask` and `runWorkflow` depend on. Discovering that from a
 * raw AWS error is a bad way to learn it.
 *
 * Pure and browser-safe.
 */

import {
  childrenOf,
  isRetryableNodeKind,
  RETRYABLE_NODE_KINDS,
  type WorkflowCondition,
  type WorkflowExecutionType,
  type WorkflowNode,
  type WorkflowNodeId,
  type WorkflowReference,
  type WorkflowTerm,
} from "./workflow-ast";
import type { CompiledWorkflow } from "./workflow-normalize";

/** The term a symbolic value carries, read without importing the builder. */
function referenceIn(value: unknown): WorkflowTerm | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as Record<symbol, unknown>)[
    Symbol.for("framework.workflow.reference")
  ];
  return carried === undefined ? undefined : (carried as WorkflowTerm);
}

/**
 * The reads one term performs.
 *
 * An operation is transparent: it reads whatever its operands read. The one
 * thing it hides is its own element binding, which exists only inside it — so
 * a binding that appears *outside* the operation that introduced it survives
 * this filter and is reported as the escape it is.
 */
function termReferences(term: WorkflowTerm, found: WorkflowReference[]): void {
  if (term.kind === "reference") {
    found.push(term);
    return;
  }

  const inner: WorkflowReference[] = [];
  for (const operand of term.operands) referencesIn(operand, inner);
  if (term.condition !== undefined) conditionReferences(term.condition, inner);
  if (term.lambda !== undefined) {
    referencesIn(term.lambda.body, inner);
    if (term.lambda.predicate !== undefined) {
      conditionReferences(term.lambda.predicate, inner);
    }
  }

  const binding = term.lambda?.binding;
  for (const reference of inner) {
    if (
      binding !== undefined &&
      reference.source.kind === "elementBinding" &&
      reference.source.binding === binding
    ) {
      continue;
    }
    found.push(reference);
  }
}

/** Every reference reachable inside a value, however deeply nested. */
function referencesIn(value: unknown, found: WorkflowReference[]): void {
  const term = referenceIn(value);
  if (term !== undefined) {
    termReferences(term, found);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) referencesIn(entry, found);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    referencesIn(entry, found);
  }
}

/** Every reference a condition compares. */
function conditionReferences(
  condition: WorkflowCondition,
  found: WorkflowReference[],
): void {
  switch (condition.kind) {
    case "and":
    case "or":
      for (const operand of condition.operands) conditionReferences(operand, found);
      return;
    case "not":
      conditionReferences(condition.operand, found);
      return;
    case "exists":
    case "isNull":
      termReferences(condition.value, found);
      return;
    default:
      for (const operand of [condition.left, condition.right]) {
        if (!("literal" in operand)) termReferences(operand, found);
      }
  }
}

/** Every reference one node reads, not counting its children. */
function readsOf(node: WorkflowNode): readonly WorkflowReference[] {
  const found: WorkflowReference[] = [];
  switch (node.kind) {
    case "invocation":
      referencesIn(node.payload, found);
      referencesIn(node.session, found);
      break;
    case "integration":
      referencesIn(node.arguments, found);
      break;
    case "choice":
      for (const rule of node.rules) conditionReferences(rule.when, found);
      break;
    case "map":
      termReferences(node.items, found);
      break;
    case "wait":
      referencesIn(node.seconds, found);
      referencesIn(node.until, found);
      break;
    case "pass":
    case "succeed":
      referencesIn(node.result, found);
      break;
    default:
      break;
  }
  return found;
}

/**
 * A lexical scope: what is visible at one point in the graph.
 *
 * Mirrors the compiler's variable scoping and the interpreter's, because all
 * three have to agree about the same question.
 */
interface ValidationScope {
  readonly produced: Set<WorkflowNodeId>;
  readonly bindings: Set<WorkflowNodeId>;
  readonly errors: Set<WorkflowNodeId>;
  readonly parent?: ValidationScope;
  /** What contains this scope, for a message that explains itself. */
  readonly boundary?: string;
}

function visible(
  scope: ValidationScope,
  read: (scope: ValidationScope) => boolean,
): boolean {
  for (
    let current: ValidationScope | undefined = scope;
    current !== undefined;
    current = current.parent
  ) {
    if (read(current)) return true;
  }
  return false;
}

function childScope(parent: ValidationScope, boundary: string): ValidationScope {
  return {
    produced: new Set(),
    bindings: new Set(),
    errors: new Set(),
    parent,
    boundary,
  };
}

export interface WorkflowValidationProblem {
  readonly message: string;
}

/**
 * Checks a graph, returning every problem rather than only the first.
 *
 * All of them, because fixing one reference at a time through a synthesis loop
 * is a bad way to spend an afternoon.
 */
export function validateWorkflow(
  workflow: CompiledWorkflow,
  origin: string,
): readonly WorkflowValidationProblem[] {
  const problems: WorkflowValidationProblem[] = [];
  const nameOf = (id: WorkflowNodeId): string => workflow.names.get(id) ?? id;

  /** Where each node sits, so a message can say which branch a value was made in. */
  const producedIn = new Map<WorkflowNodeId, string>();

  const check = (node: WorkflowNode, scope: ValidationScope): void => {
    // Reads happen before this node produces anything, so a node cannot
    // reference itself and a step cannot reference a later one.
    for (const reference of readsOf(node)) {
      const source = reference.source;
      if (source.kind === "input") continue;

      if (source.kind === "node") {
        if (visible(scope, (current) => current.produced.has(source.node))) continue;
        const where = producedIn.get(source.node);
        problems.push({
          message:
            where === undefined
              ? `${origin}: ${nameOf(node.id)} uses the result of ${nameOf(source.node)}, which has not run at that point. A step can only use a result produced before it.`
              : `${origin}: ${nameOf(node.id)} uses the result of ${nameOf(source.node)}, which is produced inside ${where}. Values created inside a parallel branch or a map iteration do not survive it — carry it out through that step's own result instead.`,
        });
        continue;
      }

      if (source.kind === "mapBinding") {
        if (visible(scope, (current) => current.bindings.has(source.map))) continue;
        problems.push({
          message: `${origin}: ${nameOf(node.id)} uses the item of ${nameOf(source.map)} outside that map. A map item exists only inside the iteration.`,
        });
        continue;
      }

      if (source.kind === "elementBinding") {
        // Every legitimate use is inside the operation that introduced it, and
        // `termReferences` has already removed those. What is left escaped.
        problems.push({
          message: `${origin}: ${nameOf(node.id)} uses the element of an expr.project() or expr.filter() outside it. That element exists only inside the callback it is given to.`,
        });
        continue;
      }

      if (!visible(scope, (current) => current.errors.has(source.attempt))) {
        problems.push({
          message: `${origin}: ${nameOf(node.id)} uses the error of ${nameOf(source.attempt)} outside its handler. A workflow error exists only inside the handler it is given to.`,
        });
      }
    }

    switch (node.kind) {
      case "sequence":
        for (const step of node.steps) check(step, scope);
        break;

      case "parallel": {
        node.branches.forEach((branch, index) => {
          const label = `${nameOf(node.id)} branch ${node.names?.[index] ?? index + 1}`;
          const inner = childScope(scope, label);
          markProduced(branch, label);
          check(branch, inner);
        });
        break;
      }

      case "map": {
        const label = `${nameOf(node.id)}`;
        const inner = childScope(scope, label);
        inner.bindings.add(node.id);
        markProduced(node.body, label);
        check(node.body, inner);
        break;
      }

      case "choice":
        // Branches are alternatives, not concurrent: each sees what came before,
        // and the choice's own result stands for whichever ran.
        for (const rule of node.rules) check(rule.then, scope);
        check(node.otherwise, scope);
        break;

      case "retry":
        check(node.body, scope);
        break;

      case "attempt": {
        check(node.body, scope);
        const handlerScope = childScope(scope, `${nameOf(node.id)} handler`);
        handlerScope.errors.add(node.id);
        check(node.handler, handlerScope);
        break;
      }

      default:
        break;
    }

    scope.produced.add(node.id);
  };

  /** Records where a subtree's results are produced, for the message. */
  const markProduced = (node: WorkflowNode, where: string): void => {
    if (!producedIn.has(node.id)) producedIn.set(node.id, where);
    for (const child of childrenOf(node)) markProduced(child, where);
  };

  check(workflow.root, {
    produced: new Set(),
    bindings: new Set(),
    errors: new Set(),
  });

  problems.push(...capabilityProblems(workflow, origin));
  problems.push(...agentSessionProblems(workflow, origin));
  problems.push(...retryProblems(workflow, origin));
  problems.push(...unsupportedProblems(workflow, origin));
  return problems;
}

/**
 * What a retry policy can actually wrap.
 *
 * AWS attaches `Retry` to one state and structured control flow has no way back
 * to the start of a chain, so `retry(sequence(a, b))` cannot mean what it reads
 * as. It used to pass normalization and fail later, during ASL compilation,
 * which put the diagnostic at synth time and nowhere near the declaration.
 */
function retryProblems(
  workflow: CompiledWorkflow,
  origin: string,
): readonly WorkflowValidationProblem[] {
  const problems: WorkflowValidationProblem[] = [];
  const nameOf = (id: WorkflowNodeId): string => workflow.names.get(id) ?? id;

  const visit = (node: WorkflowNode): void => {
    if (node.kind === "retry" && !isRetryableNodeKind(node.body.kind)) {
      problems.push({
        message: `${origin}: retry() at ${nameOf(node.id)} wraps ${describeNode(node.body)}, which is not one retryable step. A retry policy attaches to a single state, and there is no way back to the start of a chain — wrap the individual ${RETRYABLE_NODE_KINDS.join(", ")} step instead.`,
      });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(workflow.root);
  return problems;
}

function describeNode(node: WorkflowNode): string {
  if (node.kind === "invocation") return `${node.invokes}:${node.target}`;
  if (node.kind === "integration") {
    return `${node.reference.kind}:${node.reference.id} ${node.operation}`;
  }
  return `a ${node.kind}`;
}

/**
 * What this workflow type can actually run.
 *
 * Express state machines have no `.sync` integrations, so a graph that waits for
 * a container or a child workflow cannot be one. Better said here, in the
 * framework's own words, than discovered from an AWS error at deploy time.
 */
function capabilityProblems(
  workflow: CompiledWorkflow,
  origin: string,
): readonly WorkflowValidationProblem[] {
  if (workflow.type !== "express") return [];

  const problems: WorkflowValidationProblem[] = [];
  const visit = (node: WorkflowNode): void => {
    // An agent is a plain request-response SDK call, which express supports.
    if (node.kind === "invocation" && node.invokes !== "lambda" && node.invokes !== "agent") {
      const verb = node.invokes === "task" ? "runTask" : "runWorkflow";
      problems.push({
        message: `${origin} cannot use ${verb}("${node.target}") with express execution, because waiting for it needs an integration express workflows do not have. Use a standard workflow, or a step that returns without waiting.`,
      });
    }
    // The callback pattern is a Standard-workflow feature: an Express execution
    // has no task token to suspend on. Better said here than discovered from
    // an AWS error at deploy time.
    if (node.kind === "integration" && node.completion === "callback") {
      problems.push({
        message: `${origin} waits for a callback on ${node.reference.kind}:${node.reference.id} with express execution. Waiting for a task token is a standard-workflow pattern; use a standard workflow, or send without waiting.`,
      });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(workflow.root);
  return problems;
}

/**
 * Agent calls that would share a Runtime session concurrently without saying so.
 *
 * An execution's agent calls share its default session, which is right in
 * sequence — the session stays warm, and a retry lands where the first attempt
 * ran. Run concurrently, the calls race the session's provisioning (AgentCore
 * answers `RetryableConflictException` while a session is still being created)
 * and share one microVM's memory. So a call that can run beside another call
 * to the same agent must name its session: in a `map` body, unless the map
 * runs one item at a time, and in two branches of one `parallel`.
 */
function agentSessionProblems(
  workflow: CompiledWorkflow,
  origin: string,
): readonly WorkflowValidationProblem[] {
  const problems: WorkflowValidationProblem[] = [];
  const unnamed = (node: WorkflowNode): Extract<WorkflowNode, { kind: "invocation" }>[] => {
    const found: Extract<WorkflowNode, { kind: "invocation" }>[] = [];
    const walk = (current: WorkflowNode): void => {
      if (current.kind === "invocation" && current.invokes === "agent" && current.session === undefined) {
        found.push(current);
      }
      // A child workflow is its own execution, with its own sessions.
      for (const child of childrenOf(current)) walk(child);
    };
    walk(node);
    return found;
  };
  const reported = new Set<string>();
  const advice = 'Name a session per concurrent call, such as { session: item.caseId }, or the same literal in each to share one deliberately.';

  const visit = (node: WorkflowNode): void => {
    if (node.kind === "map" && node.maxConcurrency !== 1) {
      for (const call of unnamed(node.body)) {
        if (reported.has(call.id)) continue;
        reported.add(call.id);
        problems.push({
          message: `${origin}: invokeAgent("${call.target}") runs inside map(), whose items run concurrently, in the execution's one default session. ${advice}`,
        });
      }
    }
    if (node.kind === "parallel") {
      const branchesByAgent = new Map<string, number>();
      for (const branch of node.branches) {
        for (const agent of new Set(unnamed(branch).map((call) => call.target))) {
          branchesByAgent.set(agent, (branchesByAgent.get(agent) ?? 0) + 1);
        }
      }
      for (const [agent, branches] of branchesByAgent) {
        if (branches < 2) continue;
        problems.push({
          message: `${origin}: invokeAgent("${agent}") runs in ${branches} branches of one parallel(), concurrently, in the execution's one default session. ${advice}`,
        });
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(workflow.root);
  return problems;
}

/**
 * What the compiler models but does not yet support faithfully.
 *
 * Distributed map is the case in point. It would compile — the emitted state is
 * nearly the same — but a distributed map cannot read outer-scope variables at
 * all, and it needs permissions the graph does not currently derive. The local
 * lane has no such restriction, so accepting it would produce a workflow that
 * runs locally and fails in AWS, which is the one outcome this design exists to
 * prevent. Refused with a sentence instead.
 */
function unsupportedProblems(
  workflow: CompiledWorkflow,
  origin: string,
): readonly WorkflowValidationProblem[] {
  const problems: WorkflowValidationProblem[] = [];
  const visit = (node: WorkflowNode): void => {
    if (node.kind === "map" && node.mode === "distributed") {
      problems.push({
        message: `${origin}: map() asks for distributed mode, which the framework does not support yet. A distributed map cannot read values from outside its iteration, so a graph written for the inline default would not mean the same thing there. Use the inline default.`,
      });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(workflow.root);
  return problems;
}

/** Validates a graph, or explains every reason it cannot be built. */
export function assertWorkflowIsValid(
  workflow: CompiledWorkflow,
  origin: string,
): void {
  const problems = validateWorkflow(workflow, origin);
  if (problems.length === 0) return;
  throw new Error(problems.map((problem) => problem.message).join("\n"));
}

export type { WorkflowExecutionType };
