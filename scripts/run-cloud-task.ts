/**
 * Launches a declared task in AWS and waits for it to finish.
 *
 *   npm run task:cloud -- <task-id> --profile <PROFILE>
 *   npm run db:migrate:cloud -- --profile <PROFILE>
 *
 * The launch is the one a workload's runsTask(...) makes: the same descriptor,
 * published as an output of the deployment's tasks stack, through the same
 * framework call. That is what lets a person run work that has to happen inside
 * the network — applying migrations to a database nothing outside the VPC can
 * reach — without a bastion, a tunnel or a NAT gateway.
 *
 * Exits with the container's exit code.
 */
import { execFileSync } from "node:child_process";
import { readAuthoredInputs } from "@repo/framework/config/source";
import { encodeInvocationInput, parseInvocationDescriptor, type AwsTaskDescriptor } from "../packages/framework/src/runtime/descriptor";

const TASK_LAUNCH_OUTPUT_PREFIX = "framework:task-launch:v1:";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const taskId = process.argv.slice(2).find((argument, index, all) => !argument.startsWith("--") && !all[index - 1]?.startsWith("--"));
  if (!taskId) throw new Error("Usage: npm run task:cloud -- <task-id> [--profile <PROFILE>] [--region <REGION>]");
  const inputs = readAuthoredInputs();
  const profile = option("profile") ?? process.env.AWS_PROFILE;
  const region = option("region") ?? process.env.AWS_REGION ?? inputs.CDK_DEFAULT_REGION;
  const stack = `${inputs.CDK_APP_NAME ?? "my-aws-app"}-EcsTasksStack`;
  if (profile) process.env.AWS_PROFILE = profile;

  const cli = ["cloudformation", "describe-stacks", "--stack-name", stack, "--output", "json", ...(profile ? ["--profile", profile] : []), ...(region ? ["--region", region] : [])];
  const outputs = (JSON.parse(execFileSync("aws", cli, { encoding: "utf8" })) as {
    Stacks: { Outputs?: { Description?: string; OutputValue?: string }[] }[];
  }).Stacks[0]?.Outputs ?? [];
  const raw = outputs.find((output) => output.Description === `${TASK_LAUNCH_OUTPUT_PREFIX}${taskId}`)?.OutputValue;
  if (!raw) {
    const deployed = outputs.flatMap((output) => output.Description?.startsWith(TASK_LAUNCH_OUTPUT_PREFIX) ? [output.Description.slice(TASK_LAUNCH_OUTPUT_PREFIX.length)] : []);
    throw new Error(`${stack} has no task "${taskId}". Deployed tasks: ${deployed.length > 0 ? deployed.join(", ") : "none"}. Is it cloud-enabled, and is this the right profile?`);
  }
  const descriptor = parseInvocationDescriptor(raw, { kind: "task", target: taskId }) as AwsTaskDescriptor;

  const { runAwsTask } = await import("../packages/framework/src/runtime/aws");
  const { runId } = await runAwsTask(descriptor, encodeInvocationInput(undefined, `task:${taskId}`));
  console.log(`Started task:${taskId} (${runId}). Waiting for it to finish...`);

  const { DescribeTasksCommand, ECSClient, waitUntilTasksStopped } = await import("@aws-sdk/client-ecs");
  const client = new ECSClient({ region: descriptor.launch.region });
  await waitUntilTasksStopped({ client, maxWaitTime: 1800 }, { cluster: descriptor.launch.cluster, tasks: [runId] });
  const task = (await client.send(new DescribeTasksCommand({ cluster: descriptor.launch.cluster, tasks: [runId] }))).tasks?.[0];
  const container = task?.containers?.find((entry) => entry.name === descriptor.launch.containerName);
  const exitCode = container?.exitCode;
  console.log(
    exitCode === 0
      ? `task:${taskId} finished with exit code 0.`
      : `task:${taskId} stopped: ${task?.stoppedReason ?? "unknown reason"}${exitCode === undefined ? "" : `, exit code ${exitCode}`}. Its log is in CloudWatch under the ${taskId} stream prefix.`,
  );
  process.exit(exitCode ?? 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
