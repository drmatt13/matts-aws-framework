import { randomUUID } from "node:crypto";
import {
  ECS_OVERRIDES_CHARACTER_LIMIT,
  FRAMEWORK_TASK_INPUT_ENVIRONMENT,
  InvocationDescriptorError,
  type AwsTaskDescriptor,
  type AwsWorkflowDescriptor,
} from "./descriptor";

/**
 * The AWS half of the transport.
 *
 * Clients are created lazily and cached per region: a handler that only ever
 * uses the local transport should not pay to construct an ECS client, and a
 * handler that launches repeatedly should not construct one per invocation.
 */
const ecsClients = new Map<string, import("@aws-sdk/client-ecs").ECSClient>();
const sfnClients = new Map<string, import("@aws-sdk/client-sfn").SFNClient>();

async function ecsClient(region: string) {
  const cached = ecsClients.get(region);
  if (cached) return cached;
  const { ECSClient } = await import("@aws-sdk/client-ecs");
  const client = new ECSClient({ region });
  ecsClients.set(region, client);
  return client;
}

async function sfnClient(region: string) {
  const cached = sfnClients.get(region);
  if (cached) return cached;
  const { SFNClient } = await import("@aws-sdk/client-sfn");
  const client = new SFNClient({ region });
  sfnClients.set(region, client);
  return client;
}

/**
 * The complete overrides object, checked against ECS's own budget.
 *
 * The limit is on the whole serialized overrides, so it is measured on the
 * whole object rather than on the input alone — measuring only the payload
 * would pass locally and fail in AWS with a message about a field the caller
 * never wrote. Large data travels through application-owned storage; there is
 * no automatic payload store, deliberately.
 */
export function buildTaskOverrides(
  containerName: string,
  encodedInput: string,
): { readonly containerOverrides: readonly unknown[] } {
  const overrides = {
    containerOverrides: [
      {
        name: containerName,
        ...(encodedInput === ""
          ? {}
          : {
              environment: [
                { name: FRAMEWORK_TASK_INPUT_ENVIRONMENT, value: encodedInput },
              ],
            }),
      },
    ],
  };
  const serialized = JSON.stringify(overrides);
  if (serialized.length > ECS_OVERRIDES_CHARACTER_LIMIT) {
    throw new InvocationDescriptorError(
      `Task input produces ${serialized.length} characters of ECS overrides, over the ${ECS_OVERRIDES_CHARACTER_LIMIT}-character limit. Pass a storage reference the task reads instead of the data itself.`,
    );
  }
  return overrides;
}

/**
 * Submits one ECS task and returns its ARN.
 *
 * The client token is generated once per submission and reused for the SDK's
 * transport retries, so a retried request is the same submission rather than a
 * second task. A later application call is a new submission: this is transport
 * idempotency, not business deduplication.
 *
 * A 200 is not success. `RunTask` reports per-target problems in `failures`
 * while still answering 200, so both that array and the returned task ARN are
 * checked before the launch is called accepted.
 */
export async function runAwsTask(
  descriptor: AwsTaskDescriptor,
  encodedInput: string,
): Promise<{ readonly runId: string }> {
  const { launch } = descriptor;
  const { RunTaskCommand } = await import("@aws-sdk/client-ecs");
  const client = await ecsClient(launch.region);

  const response = await client.send(
    new RunTaskCommand({
      cluster: launch.cluster,
      taskDefinition: launch.taskDefinitionArn,
      launchType: launch.launchType,
      platformVersion: launch.platformVersion,
      count: 1,
      clientToken: randomUUID(),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [...launch.subnets],
          securityGroups: [...launch.securityGroups],
          assignPublicIp: launch.assignPublicIp ? "ENABLED" : "DISABLED",
        },
      },
      overrides: buildTaskOverrides(launch.containerName, encodedInput) as never,
    }),
  );

  const failures = response.failures ?? [];
  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `${failure.arn ?? "?"}: ${failure.reason ?? "unknown"}${failure.detail ? ` (${failure.detail})` : ""}`)
      .join("; ");
    throw new Error(
      `ECS accepted the request but failed to run task:${descriptor.target}: ${detail}`,
    );
  }
  const runId = response.tasks?.[0]?.taskArn;
  if (!runId) {
    throw new Error(
      `ECS returned no task ARN for task:${descriptor.target}, and no failure explaining why.`,
    );
  }
  return { runId };
}

/**
 * Starts one Standard execution and returns its ARN.
 *
 * The execution name is framework-generated per submission and reused for
 * transport retries, which is what makes a retry the same execution. A fresh
 * application call starts a new one; there is no redrive and no business
 * deduplication implied.
 */
export async function startAwsWorkflow(
  descriptor: AwsWorkflowDescriptor,
  encodedInput: string,
): Promise<{ readonly executionId: string }> {
  const { StartExecutionCommand } = await import("@aws-sdk/client-sfn");
  const client = await sfnClient(descriptor.region);

  const response = await client.send(
    new StartExecutionCommand({
      stateMachineArn: descriptor.stateMachineArn,
      name: `${descriptor.target}-${randomUUID()}`.slice(0, 80),
      input: encodedInput === "" ? "{}" : encodedInput,
    }),
  );
  if (!response.executionArn) {
    throw new Error(
      `Step Functions returned no execution ARN for workflow:${descriptor.target}.`,
    );
  }
  return { executionId: response.executionArn };
}
