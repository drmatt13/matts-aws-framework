import assert from "node:assert/strict";
import { test } from "node:test";
import type { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { runAwsTask } from "../src/runtime/aws";
import type { AwsTaskDescriptor } from "../src/runtime/descriptor";

const descriptor: AwsTaskDescriptor = {
  version: 1, kind: "task", transport: "aws", target: "worker",
  launch: {
    region: "us-east-1", cluster: "arn:aws:ecs:us-east-1:123456789012:cluster/app",
    taskDefinitionFamily: "worker", containerName: "worker", launchType: "FARGATE",
    platformVersion: "1.4.0", subnets: ["subnet-1"], securityGroups: ["sg-1"], assignPublicIp: false,
  },
};

test("host task launch uses the supplied connection client and retains descriptor and failure checks", async () => {
  const commands: RunTaskCommand[] = [];
  let rejected = false;
  const client = { send: async (command: RunTaskCommand) => {
    commands.push(command);
    return rejected ? { failures: [{ reason: "ACCESS_DENIED" }] } : { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:123456789012:task/run" }] };
  } } as unknown as Pick<ECSClient, "send">;
  const result = await runAwsTask(descriptor, "fixture-input", { client });
  assert.equal(result.runId, "arn:aws:ecs:us-east-1:123456789012:task/run");
  assert.equal(commands[0]!.input.cluster, descriptor.launch.cluster);
  assert.equal(commands[0]!.input.overrides?.containerOverrides?.[0]?.environment?.[0]?.value, "fixture-input");
  rejected = true;
  await assert.rejects(runAwsTask(descriptor, "", { client }), /ACCESS_DENIED/);
});
