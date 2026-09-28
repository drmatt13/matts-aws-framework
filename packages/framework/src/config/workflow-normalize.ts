/**
 * Normalization: the graph, made ready for a backend.
 *
 * Three jobs, none of which a backend should be doing twice:
 *
 * - **Names.** Every node gets a deterministic, readable state name. Authors do
 *   not name states, so the compiler must — and it must do it the same way every
 *   time, or an unchanged workflow produces a changed template and every diff
 *   becomes noise.
 * - **Targets.** The distinct workloads the graph references, in first-use
 *   order. This is what the execution role is derived from and what the config
 *   layer validates its invocation edges against.
 * - **Variables.** The name each node's result is stored under.
 *
 * Pure and browser-safe.
 */

import { assertWorkflowIsValid } from "./workflow-validate";
import {
  integrationKey,
  INTEGRATION_OPERATIONS,
  type IntegrationSpec,
  type IntegrationUse,
} from "./workflow-integrations";
import {
  childrenOf,
  resultNodeOf,
  walkWorkflow,
  type WorkflowDefinition,
  type WorkflowExecutionType,
  type WorkflowNode,
  type WorkflowNodeId,
} from "./workflow-ast";

/** A step target: an `events` Lambda, a container task, or a child workflow. */
export type WorkflowStepTarget =
  | `lambda:${string}`
  | `task:${string}`
  | `workflow:${string}`;

const TARGET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The graph a backend reads. Authored data is never consulted again. */
export interface CompiledWorkflow {
  readonly id: string;
  readonly root: WorkflowNode;
  readonly timeoutSeconds: number;
  readonly type: WorkflowExecutionType;
  /** Distinct step targets, in first-use order: what the execution role needs. */
  readonly targets: readonly WorkflowStepTarget[];
  /**
   * Distinct managed-service resources, in first-use order.
   *
   * Collected from the graph rather than declared beside it: a second central
   * inventory would be a list to keep in step with the code, and the code is
   * already the list. This is what CDK resolves bindings for and derives the
   * execution role's service permissions from.
   */
  readonly integrations: readonly IntegrationUse[];
  /** Node id to generated state name. */
  readonly names: ReadonlyMap<WorkflowNodeId, string>;
}

/**
 * The variable a node's result is stored under.
 *
 * Derived from the node id, which is already unique across the whole graph —
 * and that matters more than it looks. Step Functions rejects a state machine
 * in which an inner scope assigns a name an outer scope also assigns, so a
 * per-scope counter would produce a graph that fails at create time. One global
 * allocator makes that impossible by construction.
 */
export function variableOf(node: WorkflowNodeId): string {
  return `__wf_${node}`;
}

// ---------------------------------------------------------------------------
// State names
// ---------------------------------------------------------------------------

/**
 * The readable verb each integration state is named after.
 *
 * AWS's own action names, because that is what a developer reading an execution
 * history in the console is also looking at in the service's documentation.
 */
const INTEGRATION_STATE_VERBS: Readonly<Record<string, string>> = {
  "table:get": "GetItem",
  "table:put": "PutItem",
  "table:update": "UpdateItem",
  "table:delete": "DeleteItem",
  "queue:send": "SendMessage",
  "queue:request": "SendMessage",
  "topic:publish": "Publish",
  "topic:request": "Publish",
  "eventBus:put": "PutEvents",
  "eventBus:request": "PutEvents",
  "httpConnection:request": "HttpRequest",
  "awsOperation:call": "AwsCall",
};

const STATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const STATE_NAME_LIMIT = 80;

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

/**
 * A readable name for one node.
 *
 * Readable because a developer reads it in the console and in an execution
 * history, and deterministic because a random component would make every
 * redeploy look like a change. The node's ordinal is the suffix, so two steps
 * onto the same target stay distinguishable without a counter of their own.
 */
function nameOf(node: WorkflowNode): string {
  const ordinal = node.id;
  const base = ((): string => {
    switch (node.kind) {
      case "invocation": {
        const verb =
          node.invokes === "lambda"
            ? "InvokeLambda"
            : node.invokes === "task"
              ? "RunTask"
              : "RunWorkflow";
        return `${verb}_${pascal(node.target)}`;
      }
      case "integration": {
        const verb =
          INTEGRATION_STATE_VERBS[`${node.reference.kind}:${node.operation}`] ??
          pascal(node.operation);
        const waiting = node.completion === "callback" ? "Await" : "";
        return `${waiting}${verb}_${pascal(node.reference.id)}`;
      }
      case "sequence":
        return "Sequence";
      case "parallel":
        return "Parallel";
      case "choice":
        return "Choice";
      case "map":
        return "Map";
      case "wait":
        return "Wait";
      case "retry":
        return "Retry";
      case "attempt":
        return "Attempt";
      case "pass":
        return "Pass";
      case "succeed":
        return "Succeed";
      case "fail":
        return "Fail";
      default:
        return "RawState";
    }
  })();

  const labelled = node.label === undefined ? base : pascal(node.label);
  const candidate = `${labelled}_${ordinal}`;
  return candidate.length > STATE_NAME_LIMIT
    ? `${candidate.slice(0, STATE_NAME_LIMIT - ordinal.length - 1)}_${ordinal}`
    : candidate;
}

/**
 * Names for every node, guaranteed unique and valid.
 *
 * Uniqueness comes from the ordinal rather than from a de-duplicating pass, so
 * adding a node in the middle of a graph does not renumber the ones after it in
 * a way that reorders unrelated names.
 */
export function nameNodes(root: WorkflowNode): ReadonlyMap<WorkflowNodeId, string> {
  const names = new Map<WorkflowNodeId, string>();
  const taken = new Set<string>();

  walkWorkflow(root, (node) => {
    let name = nameOf(node);
    if (!STATE_NAME_PATTERN.test(name)) name = `State_${node.id}`;
    // A label can collide where a generated name cannot; the ordinal already
    // makes that near-impossible, and this makes it impossible.
    while (taken.has(name)) name = `${name}_${node.id}`;
    taken.add(name);
    names.set(node.id, name);
  });

  return names;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Distinct step targets, in first-use order. */
export function collectTargets(root: WorkflowNode): readonly WorkflowStepTarget[] {
  const targets: WorkflowStepTarget[] = [];
  const seen = new Set<string>();

  const visit = (node: WorkflowNode): void => {
    if (node.kind === "invocation") {
      const reference = `${node.invokes}:${node.target}` as WorkflowStepTarget;
      if (!seen.has(reference)) {
        seen.add(reference);
        targets.push(reference);
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };

  visit(root);
  return targets;
}

/**
 * Distinct integration resources, in first-use order, with what is done to them.
 *
 * Grouped by reference rather than listed per step, because the grant is per
 * resource: a graph that reads a table twice and writes it once needs one
 * statement naming both actions.
 */
export function collectIntegrations(root: WorkflowNode): readonly IntegrationUse[] {
  const uses = new Map<
    string,
    { reference: IntegrationSpec; operations: string[]; awaitsCallback: boolean }
  >();

  const visit = (node: WorkflowNode): void => {
    if (node.kind === "integration") {
      const key = integrationKey(node.reference);
      const existing = uses.get(key);
      if (existing === undefined) {
        uses.set(key, {
          reference: node.reference,
          operations: [node.operation],
          awaitsCallback: node.completion === "callback",
        });
      } else {
        if (!existing.operations.includes(node.operation)) {
          existing.operations.push(node.operation);
        }
        existing.awaitsCallback ||= node.completion === "callback";
      }
    }
    for (const child of childrenOf(node)) visit(child);
  };

  visit(root);
  return [...uses.values()].map((use) => ({
    reference: use.reference,
    operations: use.operations,
    awaitsCallback: use.awaitsCallback,
  }));
}

/** Refuses a reference that names an operation its kind does not have. */
function assertIntegrationsAreSupported(
  integrations: readonly IntegrationUse[],
  origin: string,
): void {
  for (const use of integrations) {
    const supported = INTEGRATION_OPERATIONS[use.reference.kind] as readonly string[];
    for (const operation of use.operations) {
      if (supported.includes(operation)) continue;
      throw new Error(
        `${origin} performs ${operation} on ${integrationKey(use.reference)}, which supports ${supported.join(", ")}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * An authored entry as the one graph both lanes execute.
 *
 * Deliberately small compared with what it replaces: a structured graph cannot
 * express a transition to a state that does not exist, an unreachable state, or
 * a state with neither a successor nor an end, so none of those need checking.
 */
export function normalizeWorkflowGraph(
  id: string,
  definition: unknown,
  origin: string,
): CompiledWorkflow {
  if (definition === null || typeof definition !== "object") {
    throw new Error(
      `${origin} is not a workflow declaration. Declare it with workflow(({ input }) => ..., { timeoutSeconds }).`,
    );
  }
  const entry = definition as WorkflowDefinition;
  const root = entry.root;
  if (
    root === null ||
    typeof root !== "object" ||
    typeof (root as WorkflowNode).kind !== "string"
  ) {
    throw new Error(
      `${origin} does not hold a workflow graph. Declare it with workflow(({ input }) => ..., { timeoutSeconds }).`,
    );
  }
  if (
    typeof entry.timeoutSeconds !== "number" ||
    !Number.isInteger(entry.timeoutSeconds) ||
    entry.timeoutSeconds < 1
  ) {
    throw new Error(`${origin}.timeoutSeconds must be a positive integer number of seconds.`);
  }

  const targets = collectTargets(root);
  for (const target of targets) {
    const separator = target.indexOf(":");
    const targetId = target.slice(separator + 1);
    if (!TARGET_ID_PATTERN.test(targetId)) {
      throw new Error(
        `${origin} names target "${target}". A step names a declared target by its kebab-case id.`,
      );
    }
  }

  const integrations = collectIntegrations(root);
  assertIntegrationsAreSupported(integrations, origin);

  const compiled: CompiledWorkflow = {
    id,
    root,
    timeoutSeconds: entry.timeoutSeconds,
    type: entry.type ?? "standard",
    targets,
    integrations,
    names: nameNodes(root),
  };

  // Validation runs here rather than in a backend, so a graph that cannot work
  // is refused once — before CDK tries to build a state machine out of it, and
  // before the local runner tries to execute it.
  assertWorkflowIsValid(compiled, origin);
  return compiled;
}

/** The node whose result is the workflow's result. */
export function resultOf(workflow: CompiledWorkflow): WorkflowNode {
  return resultNodeOf(workflow.root);
}
