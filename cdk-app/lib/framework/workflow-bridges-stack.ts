import { deferResourceAttachment } from "./framework-resources";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import {
  compileIntegrationBridge,
  getLocalTargets,
  integrationKey,
  integrationOutputId,
  needsDevelopmentBridge,
  resolveWorkflow,
  type FrameworkConfig,
  type IntegrationUse,
} from "@repo/framework/config";
import {
  INTEGRATION_OUTPUT_DESCRIPTION_PREFIX,
  requireIntegration,
} from "./framework-integrations";

/**
 * The AWS half of two integrations that cannot follow orchestration home.
 *
 * Development runs the graph on a developer's machine and leaves the managed
 * services in AWS. DynamoDB, SQS, SNS and EventBridge follow that arrangement
 * happily: they are ordinary SDK calls, and the developer's own credentials
 * make them. Two do not.
 *
 * An HTTPS call through an EventBridge Connection is authenticated by AWS from
 * a secret the connection owns; reproducing it locally would mean putting that
 * credential on a laptop. An explicitly bound AWS operation is defined by the
 * role its binding grants, and running it under a developer's own permissions
 * would be testing a different thing from what production does.
 *
 * So each one gets a bridge: an Express state machine holding exactly that task
 * and exactly that role, which the local runner starts synchronously. The call
 * still happens in AWS, under the role the binding wrote, with the connection's
 * own credentials — what crosses to the laptop is a request and a response.
 *
 * Built only by a development deployment. A production deployment compiles the
 * same operations inline into the workflow that uses them, so there is nothing
 * here to build.
 */

export interface WorkflowBridgesStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
}

/** Every advanced integration a locally executed workflow reaches for. */
export function developmentBridgeReferences(
  config: FrameworkConfig,
): readonly IntegrationUse[] {
  const uses = new Map<string, IntegrationUse>();
  for (const target of getLocalTargets(config, ["workflow"])) {
    for (const use of resolveWorkflow(config, target.id).integrations) {
      if (!needsDevelopmentBridge(use.reference)) continue;
      const key = integrationKey(use.reference);
      const existing = uses.get(key);
      uses.set(
        key,
        existing === undefined
          ? use
          : {
              reference: use.reference,
              operations: [
                ...new Set([...existing.operations, ...use.operations]),
              ],
              awaitsCallback: existing.awaitsCallback || use.awaitsCallback,
            },
      );
    }
  }
  return [...uses.values()].sort((left, right) =>
    integrationKey(left.reference).localeCompare(integrationKey(right.reference)),
  );
}

function constructIdFor(key: string): string {
  return `Bridge${key
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => (part[0] as string).toUpperCase() + part.slice(1))
    .join("")}`;
}

export class WorkflowBridgesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkflowBridgesStackProps) {
    super(scope, id, props);

    for (const use of developmentBridgeReferences(props.config)) {
      const spec = use.reference;
      const key = integrationKey(spec);
      const constructId = constructIdFor(key);

      // A role of its own, holding exactly what this one operation needs. The
      // binding wrote the grant; nothing here widens it.
      const role = new iam.Role(this, `${constructId}Role`, {
        assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
        description: `Development bridge for ${key}.`,
      });
      let definition: string | undefined;
      deferResourceAttachment(this, () => {
        const binding = requireIntegration(this, spec);
      binding.grant(role, use.operations);

      definition = JSON.stringify(compileIntegrationBridge(
        spec,
        use.operations[0] as string,
        binding.resolution,
      ));

      });
      const logGroup = new logs.LogGroup(this, `${constructId}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const machine = new sfn.StateMachine(this, constructId, {
        // Express, because a bridge is one short synchronous call and the
        // local runner waits for its result. Nothing here suspends.
        stateMachineType: sfn.StateMachineType.EXPRESS,
        definitionBody: sfn.DefinitionBody.fromString(cdk.Lazy.string({ produce: () => {
          if (!definition) throw new Error("Finalize framework resources before synthesizing bridges.");
          return definition;
        } })),
        role,
        logs: { destination: logGroup, level: sfn.LogLevel.ERROR },
      });

      // What the binding document publishes for this reference: the bridge, not
      // the endpoint. Local execution reaches the operation through here.
      new cdk.CfnOutput(this, integrationOutputId(spec), {
        value: machine.stateMachineArn,
        description: `${INTEGRATION_OUTPUT_DESCRIPTION_PREFIX}${key}`,
      });
    }
  }
}
