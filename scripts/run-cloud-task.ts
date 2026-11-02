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
import { findRepositoryRoot, readAuthoredInputs } from "@repo/framework/config/source";
import { contextFromArgs, resolveRepositoryTarget } from "@repo/framework/deploy/node";
import { encodeInvocationInput, parseInvocationDescriptor, type AwsTaskDescriptor } from "../packages/framework/src/runtime/descriptor";
import { cliCredentialProvider } from "./aws-connections";
import { runAwsSync } from "./aws-cli";

const TASK_LAUNCH_OUTPUT_PREFIX = "framework:task-launch:v1:";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const taskId = process.argv.slice(2).find((argument, index, all) => !argument.startsWith("--") && !all[index - 1]?.startsWith("--"));
  if (!taskId) throw new Error("Usage: npm run task:cloud -- <task-id> [--profile <PROFILE>] [--region <REGION>]");
  const inputs = readAuthoredInputs();
  // Cloud tasks exist only in production deployments: the named one, or the
  // production target cdk.json declares.
  const argumentContext = contextFromArgs(process.argv.slice(2));
  const { target } = resolveRepositoryTarget({
    root: findRepositoryRoot(),
    get: (key) => (key === "prodDeployment" ? "true" : argumentContext[key]),
    env: process.env,
    requireInputs: false,
  });
  const deployment = option("deployment") ?? target.name;
  const profile = option("profile") ?? process.env.AWS_PROFILE;
  const region = option("region") ?? target.region ?? process.env.AWS_REGION ?? inputs.CDK_DEFAULT_REGION;
  const stack = `${deployment}-EcsTasksStack`;
  if (profile) process.env.AWS_PROFILE = profile;

  if (target.region && region !== target.region) throw new Error("The selected region differs from the deployment's pinned region. No task was launched.");
  const aws = { profile, region };
  const caller = runAwsSync(["sts", "get-caller-identity"], aws) as { Account?: string };
  if (target.account && caller.Account !== target.account) throw new Error("The selected AWS profile resolves to a different account from the deployment. No task was launched.");
  const outputs = (runAwsSync(["cloudformation", "describe-stacks", "--stack-name", stack], aws) as {
    Stacks: { Outputs?: { Description?: string; OutputValue?: string }[] }[];
  }).Stacks[0]?.Outputs ?? [];
  const raw = outputs.find((output) => output.Description === `${TASK_LAUNCH_OUTPUT_PREFIX}${taskId}`)?.OutputValue;
  if (!raw) {
    const deployed = outputs.flatMap((output) => output.Description?.startsWith(TASK_LAUNCH_OUTPUT_PREFIX) ? [output.Description.slice(TASK_LAUNCH_OUTPUT_PREFIX.length)] : []);
    throw new Error(`${stack} has no task "${taskId}". Deployed tasks: ${deployed.length > 0 ? deployed.join(", ") : "none"}. Is it cloud-enabled, and is this the right profile?`);
  }
  const descriptor = parseInvocationDescriptor(raw, { kind: "task", target: taskId }) as AwsTaskDescriptor;
  const descriptorAccount = /^arn:[^:]+:ecs:[^:]+:(\d{12}):/.exec(descriptor.launch.cluster)?.[1];
  if ((descriptorAccount && descriptorAccount !== caller.Account) || (region && descriptor.launch.region !== region)) throw new Error("The deployed task descriptor differs from the verified AWS destination. No task was launched.");

  const { DescribeTasksCommand, ECSClient, waitUntilTasksStopped } = await import("@aws-sdk/client-ecs");
  const client = new ECSClient({ region: descriptor.launch.region, ...(profile ? { credentials: cliCredentialProvider(profile, { env: process.env }) } : {}) });

  const { runAwsTask } = await import("../packages/framework/src/runtime/aws");
  const { runId } = await runAwsTask(descriptor, encodeInvocationInput(undefined, `task:${taskId}`), { client });
  console.log(`Started task:${taskId} (${runId}). Waiting for it to finish...`);

  await waitUntilTasksStopped({ client, maxWaitTime: 1800 }, { cluster: descriptor.launch.cluster, tasks: [runId] });
  const task = (await client.send(new DescribeTasksCommand({ cluster: descriptor.launch.cluster, tasks: [runId] }))).tasks?.[0];
  const container = task?.containers?.find((entry) => entry.name === descriptor.launch.containerName);
  const exitCode = container?.exitCode;
  console.log(
    exitCode === 0
      ? `task:${taskId} finished with exit code 0.`
      : `task:${taskId} stopped: ${task?.stoppedReason ?? "unknown reason"}${exitCode === undefined ? "" : `, exit code ${exitCode}`}. Its log is in CloudWatch under the ${taskId} stream prefix.`,
  );
  client.destroy();
  process.exitCode = exitCode ?? 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
