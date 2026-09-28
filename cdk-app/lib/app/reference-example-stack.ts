import { linkResources } from "../framework/framework-resources";
import { resources } from "../../../framework-config/resources";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface ReferenceExampleStackProps extends cdk.StackProps {
  retainStatefulResources?: boolean;
}

/**
 * Scratch stack of plain L2 constructs: bucket, table, queue, and topic, wired
 * to each other. Nothing here is registered with the framework config, so it
 * only deploys once the stack is added to an app.
 *
 * The wiring is deliberately end-to-end so the example shows a real flow:
 *   upload to bucket -> SNS topic -> SQS queue -> DLQ after 3 failed reads
 *
 * Nothing consumes the queue yet; that is the piece left to add.
 */
export class ReferenceExampleStack extends cdk.Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly recordsTable: dynamodb.TableV2;
  public readonly notificationsTopic: sns.Topic;
  public readonly processingQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(
    scope: Construct,
    id: string,
    props?: ReferenceExampleStackProps,
  ) {
    super(scope, id, props);

    // Example resources are throwaway by default so `cdk destroy` leaves nothing behind.
    const retainStatefulResources = props?.retainStatefulResources ?? false;
    const statefulRemovalPolicy = retainStatefulResources
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // ---------------------------------------------------------------------
    // S3 bucket
    // ---------------------------------------------------------------------
    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          id: "ExpireOldVersions",
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      // No `autoDeleteObjects`: it would add a custom-resource Lambda, so a
      // bucket holding objects has to be emptied by hand before `cdk destroy`.
      removalPolicy: statefulRemovalPolicy,
    });

    // Turning on EventBridge through the L2 (`eventBridgeEnabled`, or any
    // `addEventNotification` call) makes CDK synthesize a custom-resource
    // Lambda to configure the bucket. Setting the CFN property directly is the
    // one escape hatch here, and it keeps the stack free of Lambda functions.
    const cfnDocumentsBucket = this.documentsBucket.node
      .defaultChild as s3.CfnBucket;
    cfnDocumentsBucket.notificationConfiguration = {
      eventBridgeConfiguration: { eventBridgeEnabled: true },
    };

    // ---------------------------------------------------------------------
    // DynamoDB table
    // ---------------------------------------------------------------------
    this.recordsTable = new dynamodb.TableV2(this, "RecordsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // Lets a row delete itself once `expiresAt` (unix seconds) passes.
      timeToLiveAttribute: "expiresAt",
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: retainStatefulResources,
      },
      globalSecondaryIndexes: [
        {
          indexName: "byStatus",
          partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: statefulRemovalPolicy,
    });

    // ---------------------------------------------------------------------
    // SQS queues (dead-letter queue first, the main queue redrives into it)
    // ---------------------------------------------------------------------
    this.deadLetterQueue = new sqs.Queue(this, "ProcessingDeadLetterQueue", {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.processingQueue = new sqs.Queue(this, "ProcessingQueue", {
      // Visibility timeout must be >= the consumer's timeout, or SQS redelivers
      // a message that is still being processed.
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // ---------------------------------------------------------------------
    // SNS topic, fanning out to the queue
    // ---------------------------------------------------------------------
    this.notificationsTopic = new sns.Topic(this, "NotificationsTopic", {
      displayName: "Reference example notifications",
    });

    this.notificationsTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(this.processingQueue, {
        // Raw delivery hands the consumer the published payload instead of
        // wrapping it in the SNS envelope.
        rawMessageDelivery: true,
      }),
    );

    // Uploads announce themselves on the topic, which lands them in the queue.
    new events.Rule(this, "UploadCreatedRule", {
      description: "Forwards new uploads/ objects to the topic",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [this.documentsBucket.bucketName] },
          object: { key: [{ prefix: "uploads/" }] },
        },
      },
      targets: [new eventsTargets.SnsTopic(this.notificationsTopic)],
    });

    // ---------------------------------------------------------------------
    // EventBridge schedule
    // ---------------------------------------------------------------------
    new events.Rule(this, "HourlySweepRule", {
      description: "Publishes an hourly sweep message onto the topic",
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [
        new eventsTargets.SnsTopic(this.notificationsTopic, {
          message: events.RuleTargetInput.fromObject({
            kind: "hourly-sweep",
            firedAt: events.EventField.time,
          }),
        }),
      ],
    });

    // ---------------------------------------------------------------------
    // Operational bits: a parameter to read at runtime, and a DLQ alarm
    // ---------------------------------------------------------------------
    new ssm.StringParameter(this, "ProcessingQueueUrlParameter", {
      parameterName: `/${this.stackName}/processing-queue-url`,
      stringValue: this.processingQueue.queueUrl,
      description: "Queue URL for consumers that CDK does not wire up directly",
    });

    new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      alarmDescription: "Messages have given up after 3 processing attempts",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, "DocumentsBucketName", {
      value: this.documentsBucket.bucketName,
      exportName: `${this.stackName}:DocumentsBucketName`,
    });

    new cdk.CfnOutput(this, "RecordsTableName", {
      value: this.recordsTable.tableName,
      exportName: `${this.stackName}:RecordsTableName`,
    });

    new cdk.CfnOutput(this, "NotificationsTopicArn", {
      value: this.notificationsTopic.topicArn,
      exportName: `${this.stackName}:NotificationsTopicArn`,
    });

    new cdk.CfnOutput(this, "ProcessingQueueUrl", {
      value: this.processingQueue.queueUrl,
      exportName: `${this.stackName}:ProcessingQueueUrl`,
    });

    new cdk.CfnOutput(this, "DeadLetterQueueUrl", {
      value: this.deadLetterQueue.queueUrl,
      exportName: `${this.stackName}:DeadLetterQueueUrl`,
    });

    // Every construct above, offered to the framework under the name its field
    // already has. Last in the constructor, because it reads what is assigned.
    linkResources(this, resources.referenceExamples);
  }
}
