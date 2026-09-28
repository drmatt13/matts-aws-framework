import type { IConstruct } from "constructs";
import type { IGrantable } from "aws-cdk-lib/aws-iam";
import type { SuggestedTaskId, SuggestedWorkflowId } from "@repo/framework/config";
import {
  FrameworkTargetRegistry,
  type FrameworkTaskTarget,
  type FrameworkWorkflowTarget,
} from "./framework-target-registry";

/**
 * Where task and workflow handles live between the stack that builds one and
 * the stacks that invoke it.
 *
 * Keyed on the CDK app's root node rather than a module singleton, exactly as
 * `appEventRegistry` is, so the several apps a test file builds never see each
 * other's targets. Nothing is added to the construct tree, so no template
 * changes.
 *
 * This is what lets a caller declared anywhere resolve a destination built
 * earlier without it being threaded through props: the composition root already
 * builds tasks and workflows before the routed workload factory, and a handle
 * found here is one that really exists in this app.
 */
const APP_INVOCATION_REGISTRIES = new WeakMap<IConstruct, FrameworkTargetRegistry>();

export function appInvocationRegistry(scope: IConstruct): FrameworkTargetRegistry {
  const root = scope.node.root;
  let registry = APP_INVOCATION_REGISTRIES.get(root);
  if (!registry) {
    registry = new FrameworkTargetRegistry();
    APP_INVOCATION_REGISTRIES.set(root, registry);
  }
  return registry;
}

export function registerAppTask(
  scope: IConstruct,
  id: string,
  target: Omit<FrameworkTaskTarget, "kind">,
): void {
  appInvocationRegistry(scope).task(id, target);
}

export function registerAppWorkflow(
  scope: IConstruct,
  id: string,
  target: Omit<FrameworkWorkflowTarget, "kind">,
): void {
  appInvocationRegistry(scope).workflow(id, target);
}

function describeBuilt(scope: IConstruct, kind: "task" | "workflow"): string {
  const built = [...appInvocationRegistry(scope).entries()]
    .filter(([reference]) => reference.startsWith(`${kind}:`))
    .map(([reference]) => reference.slice(kind.length + 1));
  return built.length > 0 ? built.join(", ") : "nothing yet";
}

/**
 * The task `id` names, with its resolved launch specification and its grant.
 *
 * The point-of-use handle for native triggers: a stack that schedules this task
 * with EventBridge asks for it where the rule is created, keeps the native
 * schedule syntax, and reuses the one launch specification rather than building
 * a second networking inventory beside it. A Lambda shim in front of a schedule
 * would be a third copy of the same launch.
 */
export function ecsTask(
  scope: IConstruct,
  id: SuggestedTaskId,
): FrameworkTaskTarget {
  const registered = appInvocationRegistry(scope).get(`task:${id}`);
  if (!registered || registered.kind !== "task") {
    throw new Error(
      `Task "${id}" is not built in this app. Declare it under framework-config/tasks/ and construct EcsTasksStack before the stack that launches it. Built here: ${describeBuilt(scope, "task")}.`,
    );
  }
  return registered;
}

/** The workflow `id` names, for a native trigger that starts an execution. */
export function frameworkWorkflow(
  scope: IConstruct,
  id: SuggestedWorkflowId,
): FrameworkWorkflowTarget {
  const registered = appInvocationRegistry(scope).get(`workflow:${id}`);
  if (!registered || registered.kind !== "workflow") {
    throw new Error(
      `Workflow "${id}" is not built in this app. Declare it under framework-config/workflows/ and construct WorkflowsStack before the stack that starts it. Built here: ${describeBuilt(scope, "workflow")}.`,
    );
  }
  return registered;
}

/** Applies a task's launch grants to a grantee, by id. */
export function grantRunTaskById(
  scope: IConstruct,
  id: SuggestedTaskId,
  grantee: IGrantable,
): void {
  ecsTask(scope, id).grantRun(grantee);
}
