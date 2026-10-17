import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cxapi from "aws-cdk-lib/cx-api";
import { FrameworkTargetRegistry } from "../lib/framework/framework-target-registry";
import { markInfrastructure } from "../lib/framework/framework-inventory";
import { inspectInfrastructureAssembly } from "../../scripts/infrastructure-inventory";
import { readAssemblyStacks } from "../../scripts/cloud-assembly";

test("real CDK assembly associates Lambda, role, policies, logs and imported references without changing templates", () => {
  const base = path.resolve(__dirname, "../../.cache/framework-studio/cdk-inventory-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-"));
  try {
    const build = (marked: boolean) => {
      const app = new cdk.App({ outdir: path.join(root, marked ? "marked" : "plain"), context: { [cxapi.USE_CDK_MANAGED_LAMBDA_LOGGROUP]: false } });
      const stack = new cdk.Stack(app, "Example");
      const group = new logs.LogGroup(stack, "HandlerLogs");
      const fn = new lambda.Function(stack, "Handler", { code: lambda.Code.fromInline("exports.handler = async () => {};"), handler: "index.handler", runtime: lambda.Runtime.NODEJS_24_X, logGroup: group });
      const implicitLogs = new lambda.Function(stack, "ImplicitLogs", { code: lambda.Code.fromInline("exports.handler = async () => {};"), handler: "index.handler", runtime: lambda.Runtime.NODEJS_24_X });
      fn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({ actions: ["s3:ListAllMyBuckets"], resources: ["*"] }));
      const imported = s3.Bucket.fromBucketName(stack, "Imported", "existing-bucket");
      const child = new cdk.NestedStack(stack, "Child");
      new cdk.CfnResource(child, "Queue", { type: "AWS::SQS::Queue" });
      if (marked) {
        const targets = new FrameworkTargetRegistry();
        targets.lambda("handler", fn); targets.lambda("implicit-logs", implicitLogs);
        markInfrastructure(group, "lambda:handler", "supporting");
        markInfrastructure(imported, "resource:existing"); markInfrastructure(stack, "resource:example"); markInfrastructure(child, "resource:child");
      }
      return app.synth();
    };
    const plain = build(false); const marked = build(true);
    assert.deepEqual(marked.getStackArtifact("Example").template, plain.getStackArtifact("Example").template);
    const inventory = inspectInfrastructureAssembly(marked.directory);
    for (const type of ["AWS::Lambda::Function", "AWS::IAM::Role", "AWS::IAM::Policy", "AWS::Logs::LogGroup"]) {
      assert.ok(inventory.resources.some((resource) => resource.type === type && resource.owners.includes("lambda:handler")), type);
    }
    assert.ok(inventory.resources.some((resource) => resource.classification === "imported"));
    assert.deepEqual(inventory.stacks[0]!.owners, ["resource:example"]);
    assert.equal(inventory.stacks.length, 2);
    assert.ok(inventory.resources.some((resource) => resource.type === "AWS::SQS::Queue"));
    assert.ok(inventory.stacks.some((stack) => stack.owners.includes("resource:child")));
    assert.equal(readAssemblyStacks(marked.directory).length, 1, "nested templates are not separately deployable artifacts");
  } finally {
    assert.ok(!path.relative(base, root).startsWith("..")); rmSync(root, { recursive: true });
  }
});
