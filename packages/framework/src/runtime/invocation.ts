import { runAwsTask, startAwsWorkflow } from "./aws";
import { readInvocationVariable } from "./context";
import {
  descriptorEnvironmentName,
  encodeInvocationInput,
  parseInvocationDescriptor,
  type TaskDescriptor,
  type WorkflowDescriptor,
} from "./descriptor";
import { runLocalTask, startLocalWorkflow } from "./local";
// Type-only: the generated unions of declared ids, so a misspelled id fails to
// compile instead of failing at runtime as a missing descriptor.
import type { TaskTargetId, WorkflowTargetId } from "../generated/target-ids";

export * from "./context";
export * from "./descriptor";
export { buildTaskOverrides } from "./aws";

/**
 * The shared invocation utility.
 *
 * The same separation `databaseConnection()` uses: deployment and local startup
 * supply the configuration, this resolves it, and the handler contains no
 * environment-specific branch. Import `runTask` from `@repo/framework/runtime/invocation`
 * is the whole integration — the same source runs under Docker Compose in
 * development and in AWS in production, and which transport it takes is
 * decided by the descriptor it was given, not by anything it reads about its
 * surroundings.
 *
 * `PROD_DEPLOYMENT` is a CDK composition input, not a flag read here.
 * `USE_LOCAL_DEV_STACK` is emphatically not a transport selector either: local
 * Compose sets it false to prevent replay recapture, while deployed replay
 * Lambdas receive true, so reading it would get the answer backwards in both
 * directions.
 */

export interface RunTaskResult {
  /**
   * Opaque. In AWS this is the ECS task ARN; locally it identifies a local run
   * and deliberately does not pretend to be one.
   */
  readonly runId: string;
}

export interface StartWorkflowResult {
  /** Opaque: the Step Functions execution ARN in AWS, a local execution id otherwise. */
  readonly executionId: string;
}

export interface InvocationOptions {
  /**
   * The calling target, such as `"lambda:test-run-task"`.
   *
   * Rarely needed. A local descriptor names the caller it was issued to, so
   * `runTask(id, input)` already tells the runner who is calling; this exists
   * for descriptors generated before that field, which carry none. Ignored by
   * the AWS transport, where the caller's own role is the check.
   *
   * It may confirm the binding it was written for and may not reassign it: a
   * value disagreeing with the descriptor's own caller fails, because an option
   * that could name another target would be a way to borrow that target's
   * grants from the one place the edge is checked.
   */
  readonly caller?: string;
}

function readDescriptor<Descriptor extends TaskDescriptor | WorkflowDescriptor>(
  kind: "task" | "workflow",
  id: string,
): Descriptor {
  // Read at invocation time, from the scoped map when there is one, so a cached
  // handler module never retains another caller's binding.
  const raw = readInvocationVariable(descriptorEnvironmentName(kind, id));
  return parseInvocationDescriptor(raw, { kind, target: id }) as Descriptor;
}

/**
 * Launches a declared ECS task and returns once the launch is acknowledged.
 *
 * The return says the submission was accepted. It does not promise the
 * container started, exited successfully, or produced output — there is no
 * wait, no status-polling convenience, no automatic retry and no cancellation
 * tree here on purpose. Work that needs ordered completion and failure
 * propagation belongs in a workflow, whose ECS step awaits the task.
 */
export async function runTask(
  id: TaskTargetId,
  input?: unknown,
  options: InvocationOptions = {},
): Promise<RunTaskResult> {
  const descriptor = readDescriptor<TaskDescriptor>("task", id);
  if (descriptor.transport === "local") {
    return runLocalTask(descriptor, input, options.caller);
  }
  return runAwsTask(descriptor, encodeInvocationInput(input, `runTask("${id}")`));
}

/**
 * Starts a declared workflow execution and returns once it is accepted.
 *
 * Resolves after acceptance: it never keeps a request open for the lifetime of
 * the graph. Operators read completion through native Step Functions APIs in
 * AWS, or the local runner's own controls.
 */
export async function startWorkflow(
  id: WorkflowTargetId,
  input?: unknown,
  options: InvocationOptions = {},
): Promise<StartWorkflowResult> {
  const descriptor = readDescriptor<WorkflowDescriptor>("workflow", id);
  if (descriptor.transport === "local") {
    return startLocalWorkflow(descriptor, input, options.caller);
  }
  return startAwsWorkflow(
    descriptor,
    encodeInvocationInput(input, `startWorkflow("${id}")`),
  );
}
