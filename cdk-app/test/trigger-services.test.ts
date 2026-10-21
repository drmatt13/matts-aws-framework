import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Duration, Stack, CfnResource } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as notifications from "aws-cdk-lib/aws-s3-notifications";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as kms from "aws-cdk-lib/aws-kms";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineResources, resource, trigger, type CdkResource, type EventFailureDestination, type EventTrigger, type FrameworkConfig } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { initializeFrameworkResources, linkResource, finalizeFrameworkResources } from "../lib/framework/framework-resources";
import { appEventRegistry } from "../lib/framework/framework-events";

const env = { account: "111122223333", region: "us-east-1" };
const catalog = defineResources({
  queue: resource.cdk<sqs.IQueue>(), fifo: resource.cdk<sqs.IQueue>(), short: resource.cdk<sqs.IQueue>(), modest: resource.cdk<sqs.IQueue>(), imported: resource.cdk<sqs.IQueue>(),
  table: resource.cdk<dynamodb.ITable>(), plainTable: resource.cdk<dynamodb.ITable>(),
  topic: resource.cdk<sns.ITopic>(), fifoTopic: resource.cdk<sns.ITopic>(),
  bucket: resource.cdk<s3.Bucket>(), plainBucket: resource.cdk<s3.Bucket>(), l2Bucket: resource.cdk<s3.Bucket>(),
  dlq: resource.cdk<sqs.IQueue>(),
});
type Native = "sqs" | "dynamodb" | "sns" | "s3" | "s3-cfn";
function setup(triggers: readonly EventTrigger[] = [], options: { mode?: "dev" | "prod"; native?: Native; second?: readonly EventTrigger[]; onFailure?: EventFailureDestination } = {}) {
  const config = defineFrameworkConfig({ networks: [fixtureVpc], resources: catalog, defaults, http: [], services: [], webSocket: [], events: [{
    event: { directory: "/test/fixtures/workload-handler", triggers, ...(options.onFailure ? { onFailure: options.onFailure } : {}) },
    second: { directory: "/test/fixtures/caller", triggers: options.second ?? [] },
  }] }) as unknown as FrameworkConfig;
  const app = new App();
  initializeFrameworkResources(app, { config, mode: options.mode ?? "dev", deployment: "test", readers: { env: {} } });
  const owner = new Stack(app, "Owner", { env });
  const compute = new Stack(app, "AsynchronousLambdaFunctionsStack", { env });
  const make = (id: string) => new lambda.Function(compute, id, { code: lambda.Code.fromInline("exports.handler = async e => e"), handler: "index.handler", runtime: lambda.Runtime.NODEJS_24_X, timeout: Duration.seconds(30) });
  const fn = make("Event"), second = make("Second");
  appEventRegistry(app).lambda("event", fn);
  appEventRegistry(app).lambda("second", second);
  const key = new kms.Key(owner, "QueueKey");
  const queue = linkResource(owner, catalog.queue, new sqs.Queue(owner, "Queue", { visibilityTimeout: Duration.seconds(200), encryptionMasterKey: key }));
  const fifo = linkResource(owner, catalog.fifo, new sqs.Queue(owner, "Fifo", { fifo: true, visibilityTimeout: Duration.seconds(180) }));
  linkResource(owner, catalog.short, new sqs.Queue(owner, "Short", { visibilityTimeout: Duration.seconds(20) }));
  linkResource(owner, catalog.modest, new sqs.Queue(owner, "Modest", { visibilityTimeout: Duration.seconds(60) }));
  linkResource(owner, catalog.imported, sqs.Queue.fromQueueArn(owner, "ImportedQueue", "arn:aws:sqs:us-east-1:111122223333:imported"));
  const table = linkResource(owner, catalog.table, new dynamodb.TableV2(owner, "Table", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES }));
  linkResource(owner, catalog.plainTable, new dynamodb.TableV2(owner, "PlainTable", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING } }));
  const topic = linkResource(owner, catalog.topic, new sns.Topic(owner, "Topic"));
  topic.addSubscription(new subscriptions.SqsSubscription(queue));
  linkResource(owner, catalog.fifoTopic, new sns.Topic(owner, "FifoTopic", { fifo: true }));
  const bucket = linkResource(owner, catalog.bucket, new s3.Bucket(owner, "Bucket"));
  (bucket.node.defaultChild as s3.CfnBucket).notificationConfiguration = { eventBridgeConfiguration: { eventBridgeEnabled: true } };
  const plainBucket = linkResource(owner, catalog.plainBucket, new s3.Bucket(owner, "PlainBucket"));
  linkResource(owner, catalog.l2Bucket, new s3.Bucket(owner, "L2Bucket", { eventBridgeEnabled: true }));
  linkResource(owner, catalog.dlq, new sqs.Queue(owner, "DeadLetters", { encryptionMasterKey: new kms.Key(owner, "DlqKey") }));
  if (options.native === "sqs") fn.addEventSource(new sources.SqsEventSource(queue));
  if (options.native === "dynamodb") second.addEventSource(new sources.DynamoEventSource(table, { startingPosition: lambda.StartingPosition.LATEST }));
  if (options.native === "sns") topic.addSubscription(new subscriptions.LambdaSubscription(fn));
  if (options.native === "s3") plainBucket.addEventNotification(s3.EventType.OBJECT_REMOVED, new notifications.LambdaDestination(second));
  if (options.native === "s3-cfn") (plainBucket.node.defaultChild as s3.CfnBucket).notificationConfiguration = { topicConfigurations: [{ event: "s3:ObjectCreated:*", topic: topic.topicArn }] };
  return { app, owner, compute, fn, second, queue, fifo, table, topic, bucket, plainBucket };
}
const templates = (app: App) => JSON.stringify(app.synth().stacks.map((stack) => stack.template));
// The owner may only publish cross-stack exports for the consumer; its resources stay byte-identical.
const ownerUnchanged = (declared: ReturnType<typeof setup>) => {
  const baseline = setup();
  finalizeFrameworkResources(baseline.app);
  const actual = Template.fromStack(declared.owner).toJSON(), expected = Template.fromStack(baseline.owner).toJSON();
  assert.deepEqual(actual.Resources, expected.Resources, "the resource owner keeps its exact resources");
  assert.deepEqual(Object.keys(actual.Outputs).filter((key) => !(key in expected.Outputs) && !key.startsWith("ExportsOutput")), []);
};
const sqsTrigger = (options: Record<string, unknown> = {}, resource: CdkResource<sqs.IQueue> = catalog.queue, id = "orders") => trigger.sqs(resource, { id, accepts: "sqs-batch", ...options });
const dynamoTrigger = (options: Record<string, unknown> = {}, resource: CdkResource<dynamodb.ITable> = catalog.table) => trigger.dynamodb(resource, { id: "changes", accepts: "dynamodb-stream", startingPosition: "TRIM_HORIZON", ...options });
const snsTrigger = (options: Record<string, unknown> = {}, resource: CdkResource<sns.ITopic> = catalog.topic) => trigger.sns(resource, { id: "fanout", accepts: "sns", ...options });
const s3Trigger = (options: Record<string, unknown> = {}, resource: CdkResource<s3.Bucket> = catalog.bucket, id = "uploads") => trigger.s3(resource, { id, accepts: "s3", delivery: "eventbridge", eventTypes: ["s3:ObjectCreated:*"], acknowledgeRecursionRisk: true, ...options } as never);

test("SQS maps the queue in the function's existing owner with batch options, least-privilege consume grants and no reverse dependency", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([sqsTrigger({ batchSize: 50, batchWindowSeconds: 2, maxConcurrency: 5, reportBatchItemFailures: true, filters: [{ body: { kind: ["order"] } }] })], { mode });
    finalizeFrameworkResources(current.app);
    const compute = Template.fromStack(current.compute);
    compute.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
    compute.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 50, MaximumBatchingWindowInSeconds: 2, ScalingConfig: { MaximumConcurrency: 5 }, FunctionResponseTypes: ["ReportBatchItemFailures"],
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ body: { kind: ["order"] } }) }] },
    });
    const [logicalId, mapping] = Object.entries(compute.findResources("AWS::Lambda::EventSourceMapping"))[0]!;
    assert.match(logicalId, /^FrameworkTrigger[a-f0-9]+orders/);
    const policies = JSON.stringify(compute.findResources("AWS::IAM::Policy"));
    for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "kms:Decrypt"]) assert.ok(policies.includes(action), action);
    assert.doesNotMatch(policies, /"sqs:\*"|"lambda:\*"|"Resource":"\*"/);
    assert.ok((mapping.DependsOn as string[]).some((id) => id.includes("ServiceRoleDefaultPolicy")), "the grant is applied before the mapping");
    assert.deepEqual(current.owner.dependencies.map((stack) => stack.node.id), []);
    assert.deepEqual(current.compute.dependencies.map((stack) => stack.node.id), ["Owner"]);
    ownerUnchanged(current);
    templates(current.app);
    Annotations.fromStack(current.compute).hasNoWarning("*", Match.stringLikeRegexp("SQS trigger"));
  }
});

test("SQS enforces visibility of at least the function timeout but only recommends six times it", () => {
  const short = setup([sqsTrigger({}, catalog.short)]);
  assert.throws(() => finalizeFrameworkResources(short.app), /visibility must be at least the function timeout \(30s\)/);
  assert.equal(short.app.node.findAll().filter((node) => node instanceof lambda.CfnEventSourceMapping).length, 0);
  const exact = setup([sqsTrigger({}, catalog.fifo)]);
  finalizeFrameworkResources(exact.app);
  Annotations.fromStack(exact.compute).hasNoWarning("*", Match.stringLikeRegexp("SQS trigger"));
  const recommended = setup([sqsTrigger({}, catalog.modest)]);
  finalizeFrameworkResources(recommended.app);
  Annotations.fromStack(recommended.compute).hasWarning("*", Match.stringLikeRegexp("AWS recommends visibility of at least 180s.*queue is 60s"));
  assert.equal(recommended.compute.node.findAll().filter((node) => node instanceof lambda.CfnEventSourceMapping).length, 1, "a recommendation never blocks the mapping");
  const windowed = setup([sqsTrigger({ batchSize: 20, batchWindowSeconds: 5 }, catalog.modest)]);
  finalizeFrameworkResources(windowed.app);
  Annotations.fromStack(windowed.compute).hasWarning("*", Match.stringLikeRegexp("at least 185s"));
});

test("SQS rejects FIFO batching beyond its limits, imported queues and existing native consumers before any attachment", () => {
  for (const options of [{ batchSize: 11, batchWindowSeconds: 1 }, { batchWindowSeconds: 1 }]) {
    const fifo = setup([sqsTrigger(options, catalog.fifo)]);
    assert.throws(() => finalizeFrameworkResources(fifo.app), /FIFO queues support batches up to ten and no batching window/);
  }
  assert.throws(() => sqsTrigger({ batchSize: 11 }), /batch window of at least one second/);
  assert.throws(() => sqsTrigger({ maxConcurrency: 1 }), /invalid maxConcurrency/);
  assert.throws(() => sqsTrigger({ filters: [{}] }), /non-empty pattern/);
  const imported = setup([sqsTrigger({}, catalog.imported)]);
  assert.throws(() => finalizeFrameworkResources(imported.app), /owned Queue/);
  const native = setup([sqsTrigger()], { native: "sqs" });
  assert.throws(() => finalizeFrameworkResources(native.app), /existing native source mapping/);
  assert.equal(native.app.node.findAll().filter((node) => node instanceof lambda.CfnEventSourceMapping).length, 1, "only the native mapping remains");
  const duplicate = () => setup([sqsTrigger(), sqsTrigger({}, catalog.queue, "orders-again")]);
  assert.throws(duplicate, /duplicate source binding/);
});

test("changing an SQS destination within the event owner preserves the mapping logical identity", () => {
  const first = setup([sqsTrigger()]), second = setup([], { second: [sqsTrigger()] });
  finalizeFrameworkResources(first.app); finalizeFrameworkResources(second.app);
  const a = Template.fromStack(first.compute).findResources("AWS::Lambda::EventSourceMapping"), b = Template.fromStack(second.compute).findResources("AWS::Lambda::EventSourceMapping");
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.notDeepEqual(Object.values(a)[0]!.Properties.FunctionName, Object.values(b)[0]!.Properties.FunctionName);
});

test("DynamoDB maps an enabled stream with stream-read grants and a failure destination, and never enables a stream", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([dynamoTrigger({ batchSize: 100, parallelizationFactor: 2, retryAttempts: 3, maxRecordAgeSeconds: 3600, bisectBatchOnError: true, reportBatchItemFailures: true, onFailureQueue: catalog.dlq })], { mode });
    finalizeFrameworkResources(current.app);
    const compute = Template.fromStack(current.compute);
    compute.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "TRIM_HORIZON", BatchSize: 100, ParallelizationFactor: 2, MaximumRetryAttempts: 3, MaximumRecordAgeInSeconds: 3600, BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"], DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    const policies = JSON.stringify(compute.findResources("AWS::IAM::Policy"));
    for (const action of ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams", "sqs:SendMessage", "kms:GenerateDataKey"]) assert.ok(policies.includes(action), action);
    assert.doesNotMatch(policies, /"dynamodb:\*"/);
    ownerUnchanged(current);
    templates(current.app);
  }
  const absent = setup([dynamoTrigger({}, catalog.plainTable)]);
  assert.throws(() => finalizeFrameworkResources(absent.app), /no stream; enable it separately/);
  const plain = absent.owner.node.findChild("PlainTable").node.defaultChild as dynamodb.CfnGlobalTable;
  assert.equal(absent.owner.resolve(plain.streamSpecification), undefined, "the table remains without a stream");
  assert.equal(absent.app.node.findAll().filter((node) => node instanceof lambda.CfnEventSourceMapping).length, 0);
  assert.throws(() => dynamoTrigger({ startingPosition: "AT_TIMESTAMP" }), /invalid startingPosition/);
  assert.throws(() => trigger.dynamodb(catalog.table, { id: "changes", accepts: "dynamodb-stream" } as never), /startingPosition is required/);
  assert.throws(() => dynamoTrigger({ parallelizationFactor: 11 }), /invalid parallelizationFactor/);
  assert.throws(() => dynamoTrigger({ maxConcurrency: 2 }), /unsupported option maxConcurrency/);
});

test("DynamoDB rejects a stream that already has a native mapping, from any function", () => {
  const native = setup([dynamoTrigger()], { native: "dynamodb" });
  assert.throws(() => finalizeFrameworkResources(native.app), /existing native source mapping/);
});

test("SNS subscribes the function with a topic-scoped invoke permission, filters and DLQ while preserving existing subscribers", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([snsTrigger({ filterPolicy: { kind: ["order"] }, deadLetterQueue: catalog.dlq })], { mode });
    finalizeFrameworkResources(current.app);
    const compute = Template.fromStack(current.compute);
    compute.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda", FilterPolicy: { kind: ["order"] }, RedrivePolicy: Match.anyValue() });
    compute.hasResourceProperties("AWS::Lambda::Permission", { Action: "lambda:InvokeFunction", Principal: "sns.amazonaws.com", SourceArn: Match.anyValue() });
    const [, subscription] = Object.entries(compute.findResources("AWS::SNS::Subscription"))[0]!;
    assert.ok((subscription.DependsOn as string[] | undefined)?.some((id) => id.includes("Invoke")), "the subscription waits for its invoke permission");
    const owner = Template.fromStack(current.owner);
    owner.resourceCountIs("AWS::SNS::Subscription", 1);
    owner.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "sqs" });
    const all = templates(current.app);
    assert.match(all, /sns.amazonaws.com/);
    assert.match(all, /kms:GenerateDataKey/);
    assert.deepEqual(current.owner.dependencies.map((stack) => stack.node.id), []);
  }
  const body = setup([snsTrigger({ filterScope: "MessageBody", filterPolicy: { detail: { kind: ["order"] } } })]);
  finalizeFrameworkResources(body.app);
  Template.fromStack(body.compute).hasResourceProperties("AWS::SNS::Subscription", { FilterPolicyScope: "MessageBody", FilterPolicy: { detail: { kind: ["order"] } } });
  assert.throws(() => snsTrigger({ filterScope: "MessageBody" }), /filter scope requires a filter policy/);
  assert.throws(() => snsTrigger({ filterPolicy: { detail: { kind: ["order"] } } }), /nested policies require MessageBody/);
  assert.throws(() => snsTrigger({ filterPolicy: { kind: [] } }), /non-empty condition arrays/);
});

test("SNS rejects FIFO topics, a native subscription to the same function and duplicate bindings", () => {
  const fifo = setup([snsTrigger({}, catalog.fifoTopic)]);
  assert.throws(() => finalizeFrameworkResources(fifo.app), /FIFO topics cannot deliver to Lambda/);
  const native = setup([snsTrigger()], { native: "sns" });
  assert.throws(() => finalizeFrameworkResources(native.app), /native SNS subscription is occupied/);
  assert.throws(() => setup([snsTrigger(), { ...snsTrigger(), id: "again" }]), /duplicate source binding/);
  const other = setup([], { native: "sns", second: [snsTrigger()] });
  finalizeFrameworkResources(other.app);
  templates(other.app);
});

test("S3 EventBridge delivery adds a rule in the function owner and leaves the bucket untouched", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([s3Trigger({ prefix: "uploads/", suffix: ".pdf", eventTypes: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"] })], { mode });
    finalizeFrameworkResources(current.app);
    const compute = Template.fromStack(current.compute);
    compute.hasResourceProperties("AWS::Events::Rule", { EventPattern: { source: ["aws.s3"], "detail-type": ["Object Created", "Object Deleted"], detail: { bucket: { name: [Match.anyValue()] }, object: { key: [{ wildcard: "uploads/*.pdf" }] } } } });
    compute.hasResourceProperties("AWS::Lambda::Permission", { Principal: "events.amazonaws.com" });
    assert.doesNotMatch(JSON.stringify(compute.toJSON()), /Custom::S3BucketNotifications|BucketNotificationsHandler/);
    ownerUnchanged(current);
    templates(current.app);
  }
  assert.throws(() => s3Trigger({ eventTypes: ["s3:ObjectCreated:Put"] }), /EventBridge delivery supports ObjectCreated/);
  assert.throws(() => s3Trigger({ acknowledgeRecursionRisk: false }), /recursive-write risk/);
  assert.throws(() => s3Trigger({ prefix: "uploads/*" }), /without wildcards/);
  assert.throws(() => s3Trigger({ eventTypes: [] }), /unique supported S3 event types/);
  assert.throws(() => s3Trigger({ delivery: "webhook" }), /invalid delivery/);
  const disabled = setup([s3Trigger({}, catalog.plainBucket)]);
  assert.throws(() => finalizeFrameworkResources(disabled.app), /enable EventBridge explicitly on the owning bucket/);
});

test("S3 notification delivery merges an unmanaged notification from the function owner and grants S3 a scoped invoke", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([s3Trigger({ delivery: "notification", eventTypes: ["s3:ObjectCreated:Put"], prefix: "inbox/" }, catalog.plainBucket)], { mode, second: [s3Trigger({ delivery: "notification", eventTypes: ["s3:ObjectRemoved:*"] }, catalog.plainBucket, "removals")] });
    finalizeFrameworkResources(current.app);
    const compute = Template.fromStack(current.compute);
    compute.resourceCountIs("Custom::S3BucketNotifications", 1);
    compute.hasResourceProperties("Custom::S3BucketNotifications", { Managed: false, NotificationConfiguration: { LambdaFunctionConfigurations: [
      { Events: ["s3:ObjectCreated:Put"], Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "inbox/" }] } }, LambdaFunctionArn: Match.anyValue() },
      { Events: ["s3:ObjectRemoved:*"], LambdaFunctionArn: Match.anyValue() },
    ] } });
    compute.hasResourceProperties("AWS::Lambda::Permission", { Principal: "s3.amazonaws.com", SourceAccount: Match.anyValue(), SourceArn: Match.anyValue() });
    ownerUnchanged(current);
    templates(current.app);
  }
  assert.throws(() => setup([s3Trigger({ delivery: "notification", eventTypes: ["s3:ObjectCreated:*"], prefix: "a/" }, catalog.plainBucket), s3Trigger({ delivery: "notification", eventTypes: ["s3:ObjectCreated:Put"], prefix: "a/b" }, catalog.plainBucket, "nested")]), /overlapping S3 notifications/);
  setup([s3Trigger({ delivery: "notification", eventTypes: ["s3:ObjectCreated:*"], prefix: "a/" }, catalog.plainBucket), s3Trigger({ delivery: "notification", eventTypes: ["s3:ObjectCreated:*"], prefix: "b/" }, catalog.plainBucket, "disjoint")]);
});

test("S3 notification delivery rejects any existing native configuration rather than guessing its ownership", () => {
  const notification = { delivery: "notification", eventTypes: ["s3:ObjectCreated:*"] };
  const eventBridge = setup([s3Trigger(notification)]);
  assert.throws(() => finalizeFrameworkResources(eventBridge.app), /existing native bucket notification configuration/);
  for (const native of ["s3", "s3-cfn"] as const) {
    const current = setup([s3Trigger(notification, catalog.plainBucket)], { native });
    assert.throws(() => finalizeFrameworkResources(current.app), /existing native bucket notification configuration/);
  }
  for (const options of [notification, {}]) {
    const l2 = setup([s3Trigger(options, catalog.l2Bucket)]);
    assert.throws(() => finalizeFrameworkResources(l2.app), /notification|EventBridge/);
    assert.equal(l2.compute.node.findAll().filter((node) => node instanceof CfnResource && ["AWS::Events::Rule", "Custom::S3BucketNotifications"].includes(node.cfnResourceType)).length, 0);
  }
});

test("DynamoDB reads stream presence from the table's own configuration, and imported tables need an explicit stream ARN", () => {
  const { attachFrameworkTriggers } = require("../lib/framework/framework-triggers") as typeof import("../lib/framework/framework-triggers");
  const current = setup();
  const imports = defineResources({ withStream: resource.cdk<dynamodb.ITable>(), withoutStream: resource.cdk<dynamodb.ITable>(), unresolved: resource.cdk<dynamodb.ITable>() });
  linkResource(current.owner, imports.withStream, dynamodb.TableV2.fromTableAttributes(current.owner, "WithStream", { tableArn: "arn:aws:dynamodb:us-east-1:111122223333:table/with", tableStreamArn: "arn:aws:dynamodb:us-east-1:111122223333:table/with/stream/2026-10-18T00:00:00.000" }));
  linkResource(current.owner, imports.withoutStream, dynamodb.TableV2.fromTableAttributes(current.owner, "WithoutStream", { tableArn: "arn:aws:dynamodb:us-east-1:111122223333:table/without" }));
  const unresolved = new dynamodb.TableV2(current.owner, "Unresolved", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING } });
  (unresolved.node.defaultChild as dynamodb.CfnGlobalTable).streamSpecification = { "Fn::If": ["Condition", { streamViewType: "KEYS_ONLY" }, { Ref: "AWS::NoValue" }] } as never;
  linkResource(current.owner, imports.unresolved, unresolved);
  const config = (name: keyof typeof imports) => defineFrameworkConfig({ networks: [fixtureVpc], resources: imports, defaults, http: [], services: [], webSocket: [], events: [{ event: { directory: "/test/fixtures/workload-handler", triggers: [dynamoTrigger({}, imports[name])] } }] }) as unknown as FrameworkConfig;
  assert.throws(() => attachFrameworkTriggers(current.app, config("withoutStream")), /no stream/);
  assert.throws(() => attachFrameworkTriggers(current.app, config("unresolved")), /stream configuration is unresolved/);
  attachFrameworkTriggers(current.app, config("withStream"));
  const mapping = current.compute.node.findAll().find((node): node is lambda.CfnEventSourceMapping => node instanceof lambda.CfnEventSourceMapping);
  assert.match(String(mapping?.eventSourceArn), /table\/with\/stream/);
});

test("S3 notifications for one bucket cannot be split across function owners", () => {
  const { attachFrameworkTriggers } = require("../lib/framework/framework-triggers") as typeof import("../lib/framework/framework-triggers");
  const current = setup();
  const vpc = new Stack(current.app, "VpcEventFunctionsStack", { env });
  appEventRegistry(current.app).lambda("elsewhere", new lambda.Function(vpc, "Elsewhere", { code: lambda.Code.fromInline("exports.handler = async e => e"), handler: "index.handler", runtime: lambda.Runtime.NODEJS_24_X }));
  const notification = (id: string, eventTypes: string[]) => s3Trigger({ delivery: "notification", eventTypes }, catalog.plainBucket, id);
  const config = defineFrameworkConfig({ networks: [fixtureVpc], resources: catalog, defaults, http: [], services: [], webSocket: [], events: [{
    event: { directory: "/test/fixtures/workload-handler", triggers: [notification("created", ["s3:ObjectCreated:*"])] },
    elsewhere: { directory: "/test/fixtures/caller", triggers: [notification("removed", ["s3:ObjectRemoved:*"])] },
  }] }) as unknown as FrameworkConfig;
  assert.throws(() => attachFrameworkTriggers(current.app, config), /one owning stack/);
  assert.equal(current.app.node.findAll().filter((node) => node instanceof CfnResource && node.cfnResourceType === "Custom::S3BucketNotifications").length, 1, "only the fixture's own L2 notification resource exists");
});

test("a schedule creates an EventBridge Scheduler schedule beside the function in both modes, leaving resource owners untouched", () => {
  for (const mode of ["dev", "prod"] as const) {
    const current = setup([trigger.schedule({ id: "nightly", accepts: "schedule", expression: "cron(0 2 * * ? *)", timezone: "Europe/London", input: { job: "report" } })], { mode });
    finalizeFrameworkResources(current.app);
    const template = Template.fromStack(current.compute);
    template.resourceCountIs("AWS::Scheduler::Schedule", 1);
    template.hasResourceProperties("AWS::Scheduler::Schedule", { ScheduleExpression: "cron(0 2 * * ? *)", ScheduleExpressionTimezone: "Europe/London", Target: Match.objectLike({ Input: Match.stringLikeRegexp("report") }) });
    ownerUnchanged(current);
  }
});

test("onFailure sends failed asynchronous runs to a standard queue or topic, and refuses FIFO or a native async configuration", () => {
  const current = setup([snsTrigger()], { onFailure: { destination: catalog.dlq, retryAttempts: 1, maxEventAgeSeconds: 3600 } });
  finalizeFrameworkResources(current.app);
  Template.fromStack(current.compute).hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 1, MaximumEventAgeInSeconds: 3600, DestinationConfig: { OnFailure: { Destination: Match.anyValue() } } });
  const topic = setup([], { onFailure: { destination: catalog.topic } });
  finalizeFrameworkResources(topic.app);
  Template.fromStack(topic.compute).resourceCountIs("AWS::Lambda::EventInvokeConfig", 1);
  assert.throws(() => finalizeFrameworkResources(setup([], { onFailure: { destination: catalog.fifo } }).app), /standard SQS queue or SNS topic/);
  const native = setup([], { onFailure: { destination: catalog.topic } });
  native.fn.configureAsyncInvoke({ retryAttempts: 0 });
  assert.throws(() => finalizeFrameworkResources(native.app), /already configures asynchronous invocation natively/);
});
