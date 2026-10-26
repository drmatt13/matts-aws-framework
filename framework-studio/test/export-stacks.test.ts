import assert from "./support/assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_ENV_STACK_OUTPUTS } from "../../scripts/root-env-outputs";
import { readExportStacks } from "../server/source/export-stacks";

test("only mapped CfnOutputs are projected, aliases work, and literals/templates never enter symbolic values", () => {
  const root = mkdtempSync(path.resolve(__dirname, "../../.cache/export-stacks-"));
  const files = {
    "cdk-app/cdk.json": JSON.stringify({ app: "npx tsx bin/main.ts" }),
    "cdk-app/bin/main.ts": 'import { DevLambdaReplayStack } from "../lib/replay"; new DevLambdaReplayStack();',
    "cdk-app/lib/replay.ts": `import { CfnOutput as Output } from "aws-cdk-lib";
      export class DevLambdaReplayStack {
        constructor() {
          new Output(this, "ReplayBucketName", { value: this.bucket.bucketName });
          new Output(this, "ReplayQueueUrl", { value: "literal-value-must-stay-private" });
          new Output(this, "ReplayQueueArn", { value: \`private-template-\${this.queue.queueArn}\` });
          new Output(this, "ReplayDeadLetterQueueUrl", { value: "unmapped-must-stay-private" });
        }
      }`,
    "cdk-app/lib/unmapped.ts": 'import * as cdk from "aws-cdk-lib"; export class EcsTasksStack { constructor() { new cdk.CfnOutput(this, "ReplayBucketName", { value: "excluded" }); } }',
  };
  try {
    for (const [name, value] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), value); }
    const stacks = readExportStacks(root);
    assert.equal(stacks.length, 1);
    assert.equal(stacks[0]?.usage?.status, "referenced");
    assert.deepEqual(stacks[0]?.outputs.map((output) => [output.name, output.envName, output.symbol]), [
      ["ReplayBucketName", ROOT_ENV_STACK_OUTPUTS.DevLambdaReplayStack.ReplayBucketName, "bucket.bucketName"],
      ["ReplayQueueUrl", ROOT_ENV_STACK_OUTPUTS.DevLambdaReplayStack.ReplayQueueUrl, "ReplayQueueUrl"],
      ["ReplayQueueArn", ROOT_ENV_STACK_OUTPUTS.DevLambdaReplayStack.ReplayQueueArn, "ReplayQueueArn"],
    ]);
    assert.ok(!JSON.stringify(stacks).includes("must-stay-private"));
    assert.ok(!JSON.stringify(stacks).includes("private-template"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
