/**
 * The invocation descriptor: what a caller is told about a target it binds.
 *
 * One versioned JSON document per declared binding, written into a reserved
 * environment name by whichever side resolved it — CDK for a deployed caller,
 * local startup for a container or dev-server invocation. The handler never
 * authors an ARN, a Docker URL or a launch setting, and never chooses a
 * transport: the descriptor it receives already says which one it is.
 *
 * `transport` is explicit rather than inferred. Deriving it from
 * `PROD_DEPLOYMENT`, from AWS credential availability or from a hostname would
 * all be wrong in the case that matters most: an event Lambda a dev deployment
 * put in AWS is genuinely running in AWS and needs AWS destinations, because it
 * cannot reach the laptop's Compose network, while a Compose container keeps
 * its local destination even with production outputs in its environment.
 *
 * There is no cross-transport fallback anywhere below. A missing binding, a
 * malformed document, an unsupported version, a target mismatch or an
 * unreachable selected endpoint each fail explicitly, because "quietly used the
 * other one" is the failure mode this whole design exists to prevent.
 */

/** Bumped when the document's shape changes in a way a reader must notice. */
export const INVOCATION_DESCRIPTOR_VERSION = 1;

/** The resolved ECS launch specification, identical for direct and workflow launches. */
export interface AwsTaskLaunchSpecification {
  readonly region: string;
  /** Cluster ARN, not name: the RunTask grant is conditioned on this exact value. */
  readonly cluster: string;
  /** Revision-qualified: a family-only ARN would silently drift from the grant. */
  readonly taskDefinitionArn: string;
  readonly containerName: string;
  readonly launchType: "FARGATE";
  readonly platformVersion: string;
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
  readonly assignPublicIp: boolean;
}

export interface AwsTaskDescriptor {
  readonly version: number;
  readonly kind: "task";
  readonly transport: "aws";
  /** The bound target id, so a mismatched injection is caught rather than launched. */
  readonly target: string;
  readonly launch: AwsTaskLaunchSpecification;
}

export interface LocalTaskDescriptor {
  readonly version: number;
  readonly kind: "task";
  readonly transport: "local";
  readonly target: string;
  /** The private runner on the project's Compose network. Never a public route. */
  readonly runnerUrl: string;
  /**
   * The target this descriptor was written for, such as `"lambda:test-run-task"`.
   *
   * The local projection derives a caller's descriptors from that caller's own
   * declared bindings, so it already knows who the document belongs to; writing
   * it down is what lets the documented two-argument `runTask(id, input)` work
   * in the local lane, where the runner has to be told who is calling.
   *
   * Optional because a descriptor written before this field existed still
   * parses. Such a document needs an explicit `caller` option, exactly as
   * before.
   */
  readonly caller?: string;
}

export interface AwsWorkflowDescriptor {
  readonly version: number;
  readonly kind: "workflow";
  readonly transport: "aws";
  readonly target: string;
  readonly region: string;
  readonly stateMachineArn: string;
}

export interface LocalWorkflowDescriptor {
  readonly version: number;
  readonly kind: "workflow";
  readonly transport: "local";
  readonly target: string;
  readonly runnerUrl: string;
  /** The bound caller, for the same reason as {@link LocalTaskDescriptor.caller}. */
  readonly caller?: string;
}

export type TaskDescriptor = AwsTaskDescriptor | LocalTaskDescriptor;
export type WorkflowDescriptor = AwsWorkflowDescriptor | LocalWorkflowDescriptor;
export type InvocationDescriptor = TaskDescriptor | WorkflowDescriptor;

/**
 * An agent, as its caller is told about it. `auth` travels with the transport
 * because it decides how the caller authenticates: an agent with users accepts
 * only a user's token, so its caller forwards one instead of signing with IAM.
 */
export interface AwsAgentDescriptor {
  readonly version: number;
  readonly kind: "agent";
  readonly transport: "aws";
  readonly target: string;
  readonly auth: boolean;
  readonly region: string;
  readonly arn: string;
}

export interface LocalAgentDescriptor {
  readonly version: number;
  readonly kind: "agent";
  readonly transport: "local";
  readonly target: string;
  readonly auth: boolean;
  readonly runnerUrl: string;
  /** The bound caller, for the same reason as {@link LocalTaskDescriptor.caller}. */
  readonly caller?: string;
}

export type AgentDescriptor = AwsAgentDescriptor | LocalAgentDescriptor;

/** The environment name a target id's descriptor arrives under. */
export function descriptorEnvironmentName(
  kind: "task" | "workflow" | "agent",
  id: string,
): string {
  const prefix =
    kind === "task" ? "FRAMEWORK_TASK_" : kind === "workflow" ? "FRAMEWORK_WORKFLOW_" : "FRAMEWORK_AGENT_";
  return `${prefix}${id.replace(/-/g, "_").toUpperCase()}`;
}

/** The reserved override a launched task reads its JSON input from. */
export const FRAMEWORK_TASK_INPUT_ENVIRONMENT = "FRAMEWORK_TASK_INPUT";

/** ECS caps the complete serialized overrides object, not just the input. */
export const ECS_OVERRIDES_CHARACTER_LIMIT = 8192;

export class InvocationDescriptorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvocationDescriptorError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireStringArray(
  value: unknown,
  field: string,
  where: string,
): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new InvocationDescriptorError(
      `${where} has a "${field}" that is not a list of non-empty strings.`,
    );
  }
  return value as readonly string[];
}

/**
 * Parses one descriptor and proves it describes the binding that was asked for.
 *
 * The target check is not redundant with the environment name: a caller reading
 * `FRAMEWORK_TASK_NIGHTLY_ROLLUP` and finding a descriptor for another task has
 * been mis-injected, and launching it would be worse than failing.
 */
export function parseInvocationDescriptor(
  raw: string | undefined,
  expected: { readonly kind: "task" | "workflow"; readonly target: string },
): InvocationDescriptor {
  const name = descriptorEnvironmentName(expected.kind, expected.target);
  const where = `Invocation descriptor ${name}`;

  if (raw === undefined) {
    throw new InvocationDescriptorError(
      `${where} is not set. Declare ${expected.kind === "task" ? `runsTask("${expected.target}")` : `startsWorkflow("${expected.target}")`} in this target's cloud.bindings; the descriptor is injected from that declaration.`,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new InvocationDescriptorError(
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new InvocationDescriptorError(`${where} is not a JSON object.`);
  }
  const record = document as Record<string, unknown>;

  if (record.version !== INVOCATION_DESCRIPTOR_VERSION) {
    throw new InvocationDescriptorError(
      `${where} declares version ${String(record.version)}; this runtime reads version ${INVOCATION_DESCRIPTOR_VERSION}. Redeploy the caller, or update @repo/framework.`,
    );
  }
  if (record.kind !== expected.kind) {
    throw new InvocationDescriptorError(
      `${where} describes a ${String(record.kind)}, not a ${expected.kind}.`,
    );
  }
  if (record.target !== expected.target) {
    throw new InvocationDescriptorError(
      `${where} describes target "${String(record.target)}", not "${expected.target}".`,
    );
  }
  if (record.transport !== "aws" && record.transport !== "local") {
    throw new InvocationDescriptorError(
      `${where} declares transport "${String(record.transport)}". Expected "aws" or "local".`,
    );
  }

  if (record.transport === "local") {
    if (!isNonEmptyString(record.runnerUrl)) {
      throw new InvocationDescriptorError(`${where} has no "runnerUrl".`);
    }
    // Absent is allowed and means "the submission has to name its caller";
    // present but not a string is a malformed document, and guessing at it
    // would put an unchecked identity in front of the runner's edge check.
    if (record.caller !== undefined && !isNonEmptyString(record.caller)) {
      throw new InvocationDescriptorError(
        `${where} has a "caller" that is not a non-empty string.`,
      );
    }
    return {
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind: expected.kind,
      transport: "local",
      target: expected.target,
      runnerUrl: record.runnerUrl.replace(/\/+$/, ""),
      ...(record.caller === undefined ? {} : { caller: record.caller as string }),
    } as InvocationDescriptor;
  }

  if (expected.kind === "workflow") {
    for (const field of ["region", "stateMachineArn"] as const) {
      if (!isNonEmptyString(record[field])) {
        throw new InvocationDescriptorError(`${where} has no "${field}".`);
      }
    }
    return {
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind: "workflow",
      transport: "aws",
      target: expected.target,
      region: record.region as string,
      stateMachineArn: record.stateMachineArn as string,
    };
  }

  const launch = record.launch;
  if (launch === null || typeof launch !== "object" || Array.isArray(launch)) {
    throw new InvocationDescriptorError(`${where} has no "launch" object.`);
  }
  const spec = launch as Record<string, unknown>;
  for (const field of [
    "region",
    "cluster",
    "taskDefinitionArn",
    "containerName",
    "platformVersion",
  ] as const) {
    if (!isNonEmptyString(spec[field])) {
      throw new InvocationDescriptorError(`${where} launch has no "${field}".`);
    }
  }
  if (spec.launchType !== "FARGATE") {
    throw new InvocationDescriptorError(
      `${where} launch declares launchType "${String(spec.launchType)}". v1 tasks are Fargate.`,
    );
  }
  if (typeof spec.assignPublicIp !== "boolean") {
    throw new InvocationDescriptorError(
      `${where} launch has no boolean "assignPublicIp".`,
    );
  }
  const subnets = requireStringArray(spec.subnets, "subnets", `${where} launch`);
  if (subnets.length === 0) {
    throw new InvocationDescriptorError(`${where} launch selects no subnets.`);
  }

  return {
    version: INVOCATION_DESCRIPTOR_VERSION,
    kind: "task",
    transport: "aws",
    target: expected.target,
    launch: {
      region: spec.region as string,
      cluster: spec.cluster as string,
      taskDefinitionArn: spec.taskDefinitionArn as string,
      containerName: spec.containerName as string,
      launchType: "FARGATE",
      platformVersion: spec.platformVersion as string,
      subnets,
      securityGroups: requireStringArray(
        spec.securityGroups,
        "securityGroups",
        `${where} launch`,
      ),
      assignPublicIp: spec.assignPublicIp,
    },
  };
}

/** Parses an `invokesAgent` descriptor and proves it describes the agent asked for. */
export function parseAgentDescriptor(raw: string | undefined, target: string): AgentDescriptor {
  const where = `Invocation descriptor ${descriptorEnvironmentName("agent", target)}`;
  if (raw === undefined) {
    throw new InvocationDescriptorError(
      `${where} is not set. Declare invokesAgent("${target}") in this target's cloud.bindings; the descriptor is injected from that declaration.`,
    );
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new InvocationDescriptorError(
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new InvocationDescriptorError(`${where} is not a JSON object.`);
  }
  if (record.version !== INVOCATION_DESCRIPTOR_VERSION) {
    throw new InvocationDescriptorError(
      `${where} declares version ${String(record.version)}; this runtime reads version ${INVOCATION_DESCRIPTOR_VERSION}. Redeploy the caller, or update @repo/framework.`,
    );
  }
  if (record.kind !== "agent" || record.target !== target) {
    throw new InvocationDescriptorError(
      `${where} describes ${String(record.kind)} "${String(record.target)}", not agent "${target}".`,
    );
  }
  if (typeof record.auth !== "boolean") {
    throw new InvocationDescriptorError(`${where} has no boolean "auth".`);
  }
  if (record.transport === "local") {
    if (!isNonEmptyString(record.runnerUrl)) throw new InvocationDescriptorError(`${where} has no "runnerUrl".`);
    if (record.caller !== undefined && !isNonEmptyString(record.caller)) {
      throw new InvocationDescriptorError(`${where} has a "caller" that is not a non-empty string.`);
    }
    return {
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind: "agent",
      transport: "local",
      target,
      auth: record.auth,
      runnerUrl: record.runnerUrl.replace(/\/+$/, ""),
      ...(record.caller === undefined ? {} : { caller: record.caller as string }),
    };
  }
  if (record.transport === "aws") {
    for (const field of ["region", "arn"] as const) {
      if (!isNonEmptyString(record[field])) throw new InvocationDescriptorError(`${where} has no "${field}".`);
    }
    return {
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind: "agent",
      transport: "aws",
      target,
      auth: record.auth,
      region: record.region as string,
      arn: record.arn as string,
    };
  }
  throw new InvocationDescriptorError(
    `${where} declares transport "${String(record.transport)}". Expected "aws" or "local".`,
  );
}

/** The document as the one string both projections write. */
export function serializeInvocationDescriptor(
  descriptor: InvocationDescriptor,
): string {
  return JSON.stringify(descriptor);
}

/**
 * The v1 input protocol: JSON, validated without silent coercion.
 *
 * `undefined` means "no input", which is not the same as `null` and not the
 * same as `{}`. Anything JSON cannot represent faithfully — a function, a
 * `BigInt`, a circular reference — fails here rather than arriving at the task
 * as something else.
 */
export function encodeInvocationInput(input: unknown, where: string): string {
  if (input === undefined) return "";
  let encoded: string;
  try {
    encoded = JSON.stringify(input) as string;
  } catch (error) {
    throw new InvocationDescriptorError(
      `${where} input is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new InvocationDescriptorError(
      `${where} input serialized to nothing. Pass a JSON value, or omit it.`,
    );
  }
  return encoded;
}
