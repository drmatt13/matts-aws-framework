import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  AGENTCORE_CONSTRUCT_ID,
  getCloudTargets,
  type CloudMode,
  type FrameworkConfig,
  type GatewayToolManifest,
  type NormalizedTarget,
} from "@repo/framework/config";
import { FrameworkAgentCore, hasAgentCoreCloudResources } from "./framework-agentcore";
import { FrameworkWorkflows } from "./framework-workflows";
import type { CognitoResources } from "./http-api-gateway-stack";

/**
 * The stack orchestration lives in: workflows, and AgentCore's agents, Gateways
 * and tools.
 *
 * They share a stack because they call each other. A workflow step invokes an
 * agent, which makes the state machine reference the Runtime; a tool or agent
 * starts a workflow, which makes the Lambda or Runtime reference the state
 * machine. In two stacks those are opposite dependencies CloudFormation cannot
 * order, whatever the targets themselves do. In one stack only the resources
 * are ordered, and their graph is the invocation graph, which config
 * validation already proves acyclic — so both directions deploy, and a genuine
 * cycle is still refused before synthesis, with the edges that form it.
 *
 * Sharing a stack is all they share. Each is built by its own module, from its
 * own configuration section, with its own grants: `framework-workflows.ts` puts
 * state machines directly in this stack's scope, keeping the logical ids they
 * had when this stack held only workflows, and `framework-agentcore.ts` is one
 * construct, `AgentCore`, under it. The stack keeps the id `WorkflowsStack`,
 * which is its deployed name.
 */

/**
 * CloudFormation's per-stack resource quota. Refused at synthesis rather than
 * at deploy time, where it would surface as a failed change set.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html
 */
export const STACK_RESOURCE_LIMIT = 500;

/** Whether this graph builds an orchestration stack at all. A dev graph never does. */
export function hasOrchestrationCloudResources(config: FrameworkConfig, mode: CloudMode): boolean {
  return getCloudTargets(config, ["workflow"], mode).length > 0 || hasAgentCoreCloudResources(config, mode);
}

export interface OrchestrationStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
  readonly mode: CloudMode;
  /** The user pool an agent declared `auth: true` accepts tokens from. */
  readonly cognito: CognitoResources;
  /** The workflow selection the composition factory validated, when there is one. */
  readonly workflows?: readonly NormalizedTarget[];
  /** The committed tool contract projection. Overridable for fixtures. */
  readonly tools?: GatewayToolManifest;
}

export class OrchestrationStack extends cdk.Stack {
  public readonly workflows: FrameworkWorkflows;
  /** Absent when the deployment builds no agent or tool. */
  public readonly agentcore?: FrameworkAgentCore;

  public constructor(scope: Construct, id: string, props: OrchestrationStackProps) {
    super(scope, id, props);
    const { config, mode } = props;
    this.workflows = new FrameworkWorkflows(this, { config, mode, ...(props.workflows ? { targets: props.workflows } : {}) });
    if (hasAgentCoreCloudResources(config, mode)) {
      this.agentcore = new FrameworkAgentCore(this, AGENTCORE_CONSTRUCT_ID, {
        config,
        mode,
        cognito: props.cognito,
        ...(props.tools ? { tools: props.tools } : {}),
      });
    }

    this.node.addValidation({
      validate: () => {
        const resources = this.node
          .findAll()
          .filter((construct) => construct instanceof cdk.CfnResource && cdk.Stack.of(construct) === this).length;
        return resources > STACK_RESOURCE_LIMIT
          ? [
              `${this.stackName} holds ${resources} resources, over CloudFormation's ${STACK_RESOURCE_LIMIT} per stack. Each agent adds 8 (4 without tools), each tool and each workflow 4, and the first agent 23 more for the shared MMDSv2 provider (docs/AGENTCORE.md, "Deployment"). Disable targets this deployment does not need with deploy: "local-only", or split the application.`,
            ]
          : [];
      },
    });
  }
}
