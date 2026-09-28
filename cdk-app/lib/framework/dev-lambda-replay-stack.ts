import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import { REPLAY_MAX_RECEIVE_COUNT } from "@repo/framework/runtime/event-replay";

/**
 * How long a captured invocation is kept. A capture carries the event's full
 * payload — for a Cognito trigger, a user's email and name — and a replay is
 * useful for days, not forever.
 */
const CAPTURE_RETENTION = cdk.Duration.days(7);

export class DevLambdaReplayStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.deadLetterQueue = new sqs.Queue(this, "DevLambdaReplayDeadLetterQueue", {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.queue = new sqs.Queue(this, "DevLambdaReplayQueue", {
      visibilityTimeout: cdk.Duration.minutes(5),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: REPLAY_MAX_RECEIVE_COUNT,
      },
    });

    this.bucket = new s3.Bucket(this, "DevLambdaReplayBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: CAPTURE_RETENTION }],
    });

    this.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.queue),
    );

    new cdk.CfnOutput(this, "ReplayBucketName", {
      value: this.bucket.bucketName,
      exportName: `${this.stackName}:ReplayBucketName`,
    });

    new cdk.CfnOutput(this, "ReplayQueueUrl", {
      value: this.queue.queueUrl,
      exportName: `${this.stackName}:ReplayQueueUrl`,
    });

    new cdk.CfnOutput(this, "ReplayQueueArn", {
      value: this.queue.queueArn,
      exportName: `${this.stackName}:ReplayQueueArn`,
    });

    new cdk.CfnOutput(this, "ReplayDeadLetterQueueUrl", {
      value: this.deadLetterQueue.queueUrl,
      exportName: `${this.stackName}:ReplayDeadLetterQueueUrl`,
    });
  }
}
