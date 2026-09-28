import { bindWorkflowAwsOperation } from "../framework/framework-integrations";
import { linkResources } from "../framework/framework-resources";
import { resources } from "../../../framework-config/resources";
import { readFixtureParameter } from "../../../framework-config/workflows/capabilities";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * Throwaway resources for the capability-check workflow, built only by a
 * development deployment. Each exists so a declared workflow exercises one
 * managed-service step end to end in the dev lane; nothing else reads them.
 */
export class WorkflowFixturesStack extends cdk.Stack {
  public readonly fixtureTable: dynamodb.TableV2;
  public readonly fixtureQueue: sqs.Queue;
  public readonly fixtureTopic: sns.Topic;
  public readonly fixtureBus: events.EventBus;
  private readonly fixtureParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.fixtureTable = new dynamodb.TableV2(this, "FixtureTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.fixtureQueue = new sqs.Queue(this, "FixtureQueue", {
      retentionPeriod: cdk.Duration.hours(1),
      enforceSSL: true,
    });
    this.fixtureTopic = new sns.Topic(this, "FixtureTopic");
    this.fixtureBus = new events.EventBus(this, "FixtureBus");
    this.fixtureParameter = new ssm.StringParameter(this, "FixtureParameter", {
      stringValue: "capability-check",
    });
    // The operation's resource is fixed here, so the graph cannot point it elsewhere.
    bindWorkflowAwsOperation(this, readFixtureParameter, {
      grant: (grantee) => this.fixtureParameter.grantRead(grantee),
      parameters: { Name: this.fixtureParameter.parameterName },
    });
    linkResources(this, resources.workflowFixtures);
  }
}
