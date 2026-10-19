import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as notifications from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { createHash } from "node:crypto";
import type { IConstruct } from "constructs";
import { registerCdkTriggerAdapter, triggerAttachmentId, triggerOptionResource, type TriggerAttachmentContext } from "./framework-triggers";

function sameEnvironment(context: TriggerAttachmentContext, resource: cdk.IResource) {
  if (cdk.Token.isUnresolved(resource.env.account) || cdk.Token.isUnresolved(resource.env.region) || resource.env.account !== context.fn.env.account || resource.env.region !== context.fn.env.region) throw new Error(`${context.binding.origin}: source and function require the same explicit account and region.`);
}
function identity(context: TriggerAttachmentContext) {
  if (cdk.Stack.of(context.fn).node.tryFindChild(triggerAttachmentId(context.binding))) throw new Error(`${context.binding.origin}: attachment identity is occupied; manual wiring review required.`);
}
function failureQueue(context: TriggerAttachmentContext, name: string): sqs.Queue | undefined {
  const queue = triggerOptionResource(context, name);
  if (!queue) return undefined;
  if (!(queue instanceof sqs.Queue) || queue.fifo) throw new Error(`${context.binding.origin}: ${name} requires an owned standard queue.`);
  sameEnvironment(context, queue);
  if (queue.encryptionMasterKey && !(queue.encryptionMasterKey instanceof kms.Key)) throw new Error(`${context.binding.origin}: imported failure-queue encryption key policy requires manual review.`);
  return queue;
}
function batchOptions(context: TriggerAttachmentContext): lambda.EventSourceMappingOptions {
  const options = context.binding.options;
  return {
    batchSize: options.batchSize as number | undefined,
    maxBatchingWindow: options.batchWindowSeconds === undefined ? undefined : cdk.Duration.seconds(options.batchWindowSeconds as number),
    enabled: options.enabled as boolean | undefined,
    reportBatchItemFailures: options.reportBatchItemFailures as boolean | undefined,
    filters: (options.filters as Record<string, unknown>[] | undefined)?.map((filter) => lambda.FilterCriteria.filter(filter)),
  };
}
function mappingOwnership(context: TriggerAttachmentContext, arn: string) {
  const stack = cdk.Stack.of(context.fn);
  for (const node of context.resource.node.root.node.findAll()) if (node instanceof lambda.CfnEventSourceMapping && JSON.stringify(stack.resolve(node.eventSourceArn)) === JSON.stringify(stack.resolve(arn))) {
    // An unclassified mapping cannot prove whether its function/filters are compatible.
    throw new Error(`${context.binding.origin}: existing native source mapping requires manual wiring review.`);
  }
}
// TableV2 always exposes a StreamArn attribute token, so only the owned L1 proves a stream.
function streamArn(context: TriggerAttachmentContext): string {
  const table = context.resource as dynamodb.ITable;
  const child = table.node.defaultChild;
  if (child instanceof dynamodb.CfnGlobalTable || child instanceof dynamodb.CfnTable) {
    const specification = cdk.Stack.of(table).resolve(child.streamSpecification) as Record<string, unknown> | undefined;
    if (specification !== undefined && (typeof specification !== "object" || Object.keys(specification).some((key) => key === "Ref" || key.startsWith("Fn::")) || typeof specification.streamViewType !== "string")) throw new Error(`${context.binding.origin}: the table's stream configuration is unresolved; manual review required.`);
    if (!specification) throw new Error(`${context.binding.origin}: table has no stream; enable it separately in its owning stack.`);
  } else if (child !== undefined) throw new Error(`${context.binding.origin}: unknown table ownership; manual review required.`);
  if (!table.tableStreamArn || typeof table.grantStreamRead !== "function") throw new Error(`${context.binding.origin}: table has no stream; enable it separately in its owning stack.`);
  return table.tableStreamArn;
}
function notificationConfiguration(bucket: s3.Bucket): Record<string, unknown> | undefined {
  const child = bucket.node.defaultChild;
  if (!(child instanceof s3.CfnBucket)) throw new Error("Unknown bucket ownership; manual wiring review required.");
  return cdk.Stack.of(bucket).resolve(child.notificationConfiguration) as Record<string, unknown> | undefined;
}

const notificationOwners = new WeakMap<IConstruct, Map<string, string>>();

/** Register service capabilities once; application stacks only expose their public resources. */
export function registerServiceTriggerAdapters(): void {
  registerCdkTriggerAdapter({
    kind: "sqs",
    validate(context) {
      identity(context);
      const queue = context.resource;
      if (!(queue instanceof sqs.Queue)) throw new Error(`${context.binding.origin}: queue visibility and policy ownership require an owned Queue.`);
      sameEnvironment(context, queue);
      mappingOwnership(context, queue.queueArn);
      const options = context.binding.options;
      if (queue.fifo && (Number(options.batchSize ?? 10) > 10 || Number(options.batchWindowSeconds ?? 0) > 0)) throw new Error(`${context.binding.origin}: FIFO queues support batches up to ten and no batching window.`);
      const child = queue.node.defaultChild as sqs.CfnQueue;
      const visibility = cdk.Stack.of(queue).resolve(child.visibilityTimeout ?? 30);
      const timeout = context.fn.timeout?.toSeconds() ?? 3;
      if (typeof visibility !== "number") throw new Error(`${context.binding.origin}: queue visibility is unresolved; manual review required.`);
      if (visibility < timeout) throw new Error(`${context.binding.origin}: queue visibility must be at least the function timeout (${timeout}s).`);
      const recommended = 6 * timeout + Number(options.batchWindowSeconds ?? 0);
      if (visibility < recommended) cdk.Annotations.of(context.fn).addWarning(`SQS trigger ${context.binding.id}: AWS recommends visibility of at least ${recommended}s (six times the function timeout plus batch window); queue is ${visibility}s.`);
    },
    attach(context) {
      const queue = context.resource as sqs.Queue;
      const grant = queue.grantConsumeMessages(context.fn);
      const mapping = new lambda.EventSourceMapping(cdk.Stack.of(context.fn), triggerAttachmentId(context.binding), { ...batchOptions(context), target: context.fn, eventSourceArn: queue.queueArn, maxConcurrency: context.binding.options.maxConcurrency as number | undefined });
      grant.applyBefore(mapping);
    },
  });
  registerCdkTriggerAdapter({
    kind: "dynamodb",
    validate(context) {
      identity(context);
      const table = context.resource as dynamodb.ITable;
      const arn = streamArn(context);
      sameEnvironment(context, table);
      mappingOwnership(context, arn);
      failureQueue(context, "onFailureQueue");
    },
    attach(context) {
      const table = context.resource as dynamodb.ITable;
      const options = context.binding.options;
      const dlq = failureQueue(context, "onFailureQueue");
      const grant = table.grantStreamRead(context.fn);
      const mapping = new lambda.EventSourceMapping(cdk.Stack.of(context.fn), triggerAttachmentId(context.binding), {
        ...batchOptions(context), target: context.fn, eventSourceArn: streamArn(context),
        startingPosition: options.startingPosition === "LATEST" ? lambda.StartingPosition.LATEST : lambda.StartingPosition.TRIM_HORIZON,
        parallelizationFactor: options.parallelizationFactor as number | undefined,
        retryAttempts: options.retryAttempts as number | undefined,
        maxRecordAge: options.maxRecordAgeSeconds === undefined ? undefined : cdk.Duration.seconds(options.maxRecordAgeSeconds as number),
        bisectBatchOnError: options.bisectBatchOnError as boolean | undefined,
        onFailure: dlq ? new sources.SqsDlq(dlq) : undefined,
      });
      grant.applyBefore(mapping);
    },
  });
  registerCdkTriggerAdapter({
    kind: "sns",
    validate(context) {
      identity(context);
      const topic = context.resource as sns.ITopic;
      if (!topic.topicArn || typeof topic.addSubscription !== "function") throw new Error(`${context.binding.origin}: an SNS topic is required.`);
      if (topic.fifo) throw new Error(`${context.binding.origin}: SNS FIFO topics cannot deliver to Lambda; subscribe an SQS FIFO queue instead.`);
      sameEnvironment(context, topic);
      failureQueue(context, "deadLetterQueue");
      for (const node of topic.node.root.node.findAll()) if (node instanceof sns.CfnSubscription && JSON.stringify(cdk.Stack.of(topic).resolve(node.topicArn)) === JSON.stringify(cdk.Stack.of(topic).resolve(topic.topicArn)) && JSON.stringify(cdk.Stack.of(context.fn).resolve(node.endpoint)) === JSON.stringify(cdk.Stack.of(context.fn).resolve(context.fn.functionArn))) throw new Error(`${context.binding.origin}: this native SNS subscription is occupied; manual review required.`);
    },
    attach(context) {
      const topic = context.resource as sns.ITopic;
      const options = context.binding.options;
      const filter = options.filterPolicy as Record<string, unknown> | undefined;
      const body = (policy: Record<string, unknown>): Record<string, sns.FilterOrPolicy> => Object.fromEntries(Object.entries(policy).map(([name, value]) => [name, Array.isArray(value) ? sns.FilterOrPolicy.filter(new sns.SubscriptionFilter(value)) : sns.FilterOrPolicy.policy(body(value as Record<string, unknown>))]));
      const dlq = failureQueue(context, "deadLetterQueue");
      const subscription = new sns.Subscription(cdk.Stack.of(context.fn), triggerAttachmentId(context.binding), {
        topic, protocol: sns.SubscriptionProtocol.LAMBDA, endpoint: context.fn.functionArn, deadLetterQueue: dlq,
        ...(filter ? options.filterScope === "MessageBody" ? { filterPolicyWithMessageBody: body(filter) } : { filterPolicy: Object.fromEntries(Object.entries(filter).map(([name, value]) => [name, new sns.SubscriptionFilter(value as unknown[])])) } : {}),
      });
      context.fn.addPermission(`${triggerAttachmentId(context.binding)}-Invoke`, { principal: new iam.ServicePrincipal("sns.amazonaws.com"), sourceArn: topic.topicArn });
      if (dlq?.encryptionMasterKey) dlq.encryptionMasterKey.grantEncryptDecrypt(new iam.ServicePrincipal("sns.amazonaws.com").withConditions({ ArnEquals: { "aws:SourceArn": topic.topicArn } }));
      // Subscription creation must wait for the scoped Lambda resource permission.
      const permission = context.fn.node.tryFindChild(`${triggerAttachmentId(context.binding)}-Invoke`);
      if (permission) subscription.node.addDependency(permission);
    },
  });
  registerCdkTriggerAdapter({
    kind: "s3",
    validate(context) {
      identity(context);
      const bucket = context.resource;
      if (!(bucket instanceof s3.Bucket)) throw new Error(`${context.binding.origin}: bucket mutation requires an owned Bucket.`);
      sameEnvironment(context, bucket);
      const configuration = notificationConfiguration(bucket);
      const native = bucket.node.findAll().some((node) => node instanceof cdk.CfnResource && node.cfnResourceType === "Custom::S3BucketNotifications");
      const eventBridge = configuration?.eventBridgeConfiguration;
      if (context.binding.options.delivery === "eventbridge") {
        if (!eventBridge) throw new Error(`${context.binding.origin}: enable EventBridge explicitly on the owning bucket first; an unclassified notification custom resource requires manual review.`);
      } else {
        if (configuration && Object.keys(configuration).length || native) throw new Error(`${context.binding.origin}: existing native bucket notification configuration requires manual review; preserve its delivery architecture.`);
        // Each unmanaged notification resource read-modify-writes the whole bucket configuration;
        // two owning stacks could deploy concurrently and drop each other's entries.
        const owners = notificationOwners.get(bucket.node.root) ?? new Map<string, string>();
        notificationOwners.set(bucket.node.root, owners);
        const key = context.binding.resource!.path.join("."), stack = cdk.Stack.of(context.fn).node.path;
        if ((owners.get(key) ?? stack) !== stack) throw new Error(`${context.binding.origin}: S3 notifications for one bucket must target event functions in one owning stack.`);
        owners.set(key, stack);
      }
    },
    attach(context) {
      const bucket = context.resource as s3.Bucket;
      const options = context.binding.options;
      const stack = cdk.Stack.of(context.fn);
      const prefix = String(options.prefix ?? ""), suffix = String(options.suffix ?? "");
      if (options.delivery === "eventbridge") {
        const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
        new events.Rule(stack, triggerAttachmentId(context.binding), {
          eventPattern: { source: ["aws.s3"], detailType: (options.eventTypes as string[]).map((type) => type === "s3:ObjectCreated:*" ? "Object Created" : "Object Deleted"), detail: { bucket: { name: [bucket.bucketName] }, ...(prefix || suffix ? { object: { key: [{ wildcard: `${escape(prefix)}*${escape(suffix)}` }] } } : {}) } },
          targets: [new targets.LambdaFunction(context.fn)],
        });
      } else {
        // An imported reference keeps the notification custom resource in the function's
        // existing owner and uses CDK's unmanaged merge, preserving other subscribers.
        const sourceId = `FrameworkNotifications-${createHash("sha256").update(context.binding.resource!.path.join(".")).digest("hex").slice(0, 16)}`;
        const reference = stack.node.tryFindChild(sourceId) as s3.IBucket | undefined ?? s3.Bucket.fromBucketAttributes(stack, sourceId, { bucketArn: bucket.bucketArn, bucketName: bucket.bucketName });
        for (const event of options.eventTypes as string[]) reference.addEventNotification(event as s3.EventType, new notifications.LambdaDestination(context.fn), ...(prefix || suffix ? [{ ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) }] : []));
      }
    },
  });
}
