import * as cdk from "aws-cdk-lib";
import type * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import path from "node:path";
import { findRepositoryRoot } from "@repo/framework/config/source";

const HANDLER = path.join(
  findRepositoryRoot(__dirname),
  "packages",
  "framework",
  "src",
  "runtime",
  "agentcore-metadata-handler.ts",
);

/**
 * Turns on MMDSv2 for every Runtime the framework builds.
 *
 * Since June 30, 2026 AgentCore refuses to invoke a Runtime whose
 * `metadataConfiguration.requireMMDSV2` is not true, and the CloudFormation
 * Runtime schema — so CDK too — cannot set it yet. A custom resource per
 * Runtime reads it after CloudFormation writes it and updates only that
 * setting, carrying every other field across, then waits for READY.
 *
 * One provider serves every Runtime: its handlers are stateless and act only on
 * the RuntimeId their resource names, so a provider per agent bought nothing
 * but about two dozen resources each. Least privilege is kept per Runtime
 * rather than per function: {@link enable} grants the handlers that Runtime and
 * its execution role, by ARN, and nothing broader — the handlers can touch the
 * Runtimes this construct enabled and no others.
 *
 * Temporary by design. Delete this construct, and its handler, once
 * AWS::BedrockAgentCore::Runtime accepts MetadataConfiguration; set it on the
 * Runtime instead. Until then the update creates a Runtime version after the
 * one CloudFormation made, which is why callers use the DEFAULT endpoint.
 */
export class RuntimeMetadataV2 extends Construct {
  private readonly onEvent: nodejs.NodejsFunction;
  private readonly isComplete: nodejs.NodejsFunction;
  private readonly provider: cr.Provider;
  /** Apart from the shared handlers, so an agent named "provider" cannot collide. */
  private readonly patches: Construct;

  public constructor(scope: Construct, id: string) {
    super(scope, id);
    const bundling = { externalModules: [], target: "node24" };
    this.onEvent = new nodejs.NodejsFunction(this, "Handler", {
      entry: HANDLER,
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(2),
      bundling,
    });
    this.isComplete = new nodejs.NodejsFunction(this, "Completion", {
      entry: HANDLER,
      handler: "isComplete",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      bundling,
    });
    this.provider = new cr.Provider(this, "Provider", {
      onEventHandler: this.onEvent,
      isCompleteHandler: this.isComplete,
      queryInterval: cdk.Duration.seconds(10),
      totalTimeout: cdk.Duration.minutes(10),
    });
    this.patches = new Construct(this, "Runtimes");
  }

  /** Requires MMDSv2 on one Runtime, granting the handlers that Runtime alone. */
  public enable(id: string, runtime: agentcore.Runtime): void {
    this.onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:UpdateAgentRuntime"],
        resources: [runtime.agentRuntimeArn],
      }),
    );
    // UpdateAgentRuntime restates the Runtime's role, which is a pass.
    this.onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [runtime.role.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" } },
      }),
    );
    this.isComplete.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["bedrock-agentcore:GetAgentRuntime"], resources: [runtime.agentRuntimeArn] }),
    );
    // The version is a property so every CloudFormation update to the Runtime
    // reapplies the setting to the version it produced.
    const patch = new cdk.CustomResource(this.patches, id, {
      serviceToken: this.provider.serviceToken,
      properties: { RuntimeId: runtime.agentRuntimeId, Version: runtime.agentRuntimeVersion },
    });
    patch.node.addDependency(runtime);
  }
}
