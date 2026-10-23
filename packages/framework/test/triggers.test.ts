import assert from "node:assert/strict";
import { test } from "node:test";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { defineResources, normalizeFailureDestinations, normalizeTriggers, resource, trigger, triggerAdapters, validateTrigger, type EventTrigger } from "../src/config";

const catalog = defineResources({ sources: resource.stack<{ pool: IUserPool; bus: IEventBus; queue: IQueue; dlq: IQueue; topic: ITopic; table: ITable; bucket: Bucket }>() });
const signup = () => trigger.cognito(catalog.sources.pool, { id: "signup", operation: "preSignUp", accepts: "cognito" });

test("typed triggers are serializable symbolic descriptors and normalize stable event attachment identities", () => {
  const descriptor = signup();
  const json = JSON.parse(JSON.stringify(descriptor));
  assert.equal(json.resource.path.join("."), "sources.pool");
  assert.equal(json.options.operation, "preSignUp");
  assert.equal(normalizeTriggers({ event: { triggers: [descriptor] } }, catalog)[0]?.key, "sources.pool/signup");
  assert.ok(!JSON.stringify(descriptor).includes("functionArn"));
});

test("duplicate hooks and attachment ids, missing resources, unsupported hooks and missing acknowledgement are refused", () => {
  assert.throws(() => normalizeTriggers({ first: { triggers: [signup()] }, second: { triggers: [{ ...signup(), id: "other-id" }] } }, catalog), /duplicate trigger slot/);
  assert.throws(() => normalizeTriggers({ event: { triggers: [signup(), signup()] } }, catalog), /duplicate attachment id/);
  assert.throws(() => normalizeTriggers({ event: { triggers: [signup()] } }, {}), /missing in this graph/);
  const absent = { ...signup(), resource: { ...signup().resource!, absent: true as const } };
  assert.throws(() => normalizeTriggers({ event: { triggers: [absent] } }, catalog), /missing in this graph/);
  assert.throws(() => validateTrigger({ ...signup(), options: { operation: "customEmailSender" } }), /invalid operation/);
  assert.throws(() => validateTrigger({ ...signup(), accepts: "unknown" }), /acknowledge handler contract/);
  assert.throws(() => normalizeTriggers({ event: { triggers: [signup()], localReplay: true } }, catalog), /synchronous response/);
});

test("EventBridge validates event patterns, bounds and JSON-only options", () => {
  const descriptor = trigger.eventbridge(catalog.sources.bus, { id: "orders", accepts: "eventbridge", eventPattern: { source: ["orders"] }, retryAttempts: 2 });
  assert.equal(validateTrigger(descriptor).kind, "eventbridge");
  for (const options of [{ eventPattern: {} }, { eventPattern: { source: ["orders"] }, retryAttempts: 186 }, { eventPattern: { source: ["orders"] }, copiedArn: "bad" }, { eventPattern: { source: [() => {}] } }, { eventPattern: { "detail-type": ["wrong field name"] } }, { eventPattern: { source: 42 } }]) assert.throws(() => validateTrigger({ ...descriptor, options: options as never }));
});

const services = {
  sqs: () => trigger.sqs(catalog.sources.queue, { id: "orders", accepts: "sqs-batch", batchSize: 20, batchWindowSeconds: 2, filters: [{ body: { kind: ["order"] } }], reportBatchItemFailures: true, maxConcurrency: 4 }),
  sns: () => trigger.sns(catalog.sources.topic, { id: "fanout", accepts: "sns", filterPolicy: { kind: ["order"] }, deadLetterQueue: catalog.sources.dlq }),
  dynamodb: () => trigger.dynamodb(catalog.sources.table, { id: "changes", accepts: "dynamodb-stream", startingPosition: "LATEST", onFailureQueue: catalog.sources.dlq, retryAttempts: 2 }),
  s3: () => trigger.s3(catalog.sources.bucket, { id: "uploads", accepts: "s3", delivery: "notification", eventTypes: ["s3:ObjectCreated:Put"], prefix: "inbox/", acknowledgeRecursionRisk: true }),
};

test("service descriptors are JSON-only symbolic data that round-trip through validation and normalization", () => {
  for (const [kind, make] of Object.entries(services)) {
    const descriptor = make();
    const json = JSON.parse(JSON.stringify(descriptor)) as EventTrigger;
    assert.equal(JSON.stringify(json), JSON.stringify(descriptor), kind);
    assert.equal(validateTrigger(json).kind, kind);
    assert.ok(Object.isFrozen(descriptor));
    assert.doesNotMatch(JSON.stringify(descriptor), /arn:|function|Token/i);
    const [binding] = normalizeTriggers({ event: { triggers: [json] } }, catalog);
    assert.equal(binding?.key, `${descriptor.resource!.path.join(".")}/${descriptor.id}`);
    assert.equal(binding?.origin, 'events["event"].triggers[0]');
  }
  assert.deepEqual(triggerAdapters().map((adapter) => adapter.kind), ["cognito", "eventbridge", "sqs", "dynamodb", "sns", "s3", "schedule"]);
  assert.throws(() => trigger.adapter("sqs", catalog.sources.queue, { id: "orders", accepts: "sns" }), /acknowledge handler contract sqs-batch/);
});

test("every registered resource adapter ships a serializable guide: requirements, a typed field example and documentation", () => {
  for (const adapter of triggerAdapters().filter((item) => !item.resourceless)) {
    const { guide } = adapter;
    assert.ok(guide.requirements.length >= 2, adapter.kind);
    assert.match(guide.field, /^[a-z][A-Za-z]*$/, adapter.kind);
    assert.ok(adapter.types.some((type) => guide.type.endsWith(`.${type.name}`)), `${adapter.kind}: ${guide.type} is one of its CDK types`);
    assert.ok(guide.construct.startsWith("new "), adapter.kind);
    assert.ok(guide.imports.every((line) => /^import \* as \w+ from "aws-cdk-lib(\/[\w-]+)?";$/.test(line)), adapter.kind);
    assert.match(guide.docs, /^https:\/\/docs\.aws\.amazon\.com\//);
    assert.deepEqual(JSON.parse(JSON.stringify(guide)), guide);
  }
});

test("service bindings refuse duplicate sources per event, unavailable option resources and unsafe local replay", () => {
  assert.throws(() => normalizeTriggers({ event: { triggers: [services.sqs(), { ...services.sqs(), id: "orders-again" }] } }, catalog), /duplicate source binding/);
  assert.equal(normalizeTriggers({ first: { triggers: [services.sqs()] }, second: { triggers: [{ ...services.sqs(), id: "orders-second" }] } }, catalog).length, 2, "competing consumers stay explicit and separately identified");
  assert.throws(() => normalizeTriggers({ first: { triggers: [services.sqs()] }, second: { triggers: [services.sqs()] } }, catalog), /duplicate attachment id sources.queue\/orders/);
  const missing = { ...services.sns(), options: { ...services.sns().options, deadLetterQueue: { ...JSON.parse(JSON.stringify(catalog.sources.dlq)), absent: true } } } as EventTrigger;
  assert.throws(() => normalizeTriggers({ event: { triggers: [missing] } }, catalog), /deadLetterQueue is missing in this graph/);
  for (const kind of ["sqs", "dynamodb"] as const) assert.throws(() => normalizeTriggers({ event: { triggers: [services[kind]()], localReplay: true } }, catalog), /local replay cannot supply/);
  for (const kind of ["sns", "s3"] as const) assert.equal(normalizeTriggers({ event: { triggers: [services[kind]()], localReplay: true } }, catalog).length, 1);
});

test("service options enforce documented AWS bounds and reject unsupported combinations", () => {
  const invalid: [keyof typeof services, Record<string, unknown>, RegExp][] = [
    ["sqs", { batchSize: 0 }, /invalid batchSize/], ["sqs", { batchSize: 10001, batchWindowSeconds: 1 }, /invalid batchSize/],
    ["sqs", { batchSize: 11, batchWindowSeconds: 0 }, /batch window of at least one second/], ["sqs", { batchWindowSeconds: 301 }, /invalid batchWindowSeconds/],
    ["sqs", { maxConcurrency: 1001 }, /invalid maxConcurrency/], ["sqs", { filters: [{}, {}, {}, {}, {}, {}] }, /at most five/], ["sqs", { startingPosition: "LATEST" }, /unsupported option/],
    ["dynamodb", { startingPosition: "AT_TIMESTAMP" }, /invalid startingPosition/], ["dynamodb", { retryAttempts: -1 }, /invalid retryAttempts/],
    ["dynamodb", { maxRecordAgeSeconds: 59 }, /invalid maxRecordAgeSeconds/], ["dynamodb", { onFailureQueue: "arn:aws:sqs:us-east-1:1:q" }, /invalid onFailureQueue/],
    ["sns", { filterScope: "MessageBody", filterPolicy: undefined }, /requires a filter policy/], ["sns", { filterPolicy: { kind: "order" } }, /non-empty condition arrays/],
    ["s3", { eventTypes: ["s3:ObjectCreated:Put", "s3:ObjectCreated:Put"] }, /unique supported/], ["s3", { eventTypes: ["s3:Object:Everything"] }, /unique supported/],
    ["s3", { delivery: "eventbridge" }, /EventBridge delivery supports/], ["s3", { suffix: "x".repeat(1025) }, /1024 UTF-8 bytes/], ["s3", { acknowledgeRecursionRisk: undefined }, /acknowledgeRecursionRisk is required/],
  ];
  for (const [kind, patch, pattern] of invalid) {
    const descriptor = services[kind]();
    const options = Object.fromEntries(Object.entries({ ...descriptor.options, ...patch }).filter(([, value]) => value !== undefined));
    assert.throws(() => validateTrigger({ ...descriptor, options } as EventTrigger), pattern, `${kind} ${JSON.stringify(patch)}`);
  }
});

test("S3 notifications on one bucket must have disjoint event or key filters; EventBridge rules may overlap", () => {
  const notification = (id: string, eventTypes: string[], prefix?: string, suffix?: string) => trigger.s3(catalog.sources.bucket, { id, accepts: "s3", delivery: "notification", eventTypes: eventTypes as never, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}), acknowledgeRecursionRisk: true });
  assert.throws(() => normalizeTriggers({ a: { triggers: [notification("a", ["s3:ObjectCreated:*"])] }, b: { triggers: [notification("b", ["s3:ObjectCreated:Copy"], "x/")] } }, catalog), /overlapping S3 notifications/);
  assert.throws(() => normalizeTriggers({ a: { triggers: [notification("a", ["s3:ObjectCreated:*"], undefined, ".pdf")] }, b: { triggers: [notification("b", ["s3:ObjectCreated:Put"], undefined, "report.pdf")] } }, catalog), /overlapping/);
  for (const [left, right] of [[["s3:ObjectCreated:*"], ["s3:ObjectRemoved:*"]], [["s3:ObjectCreated:*", "x/"], ["s3:ObjectCreated:*", "y/"]]] as const) {
    assert.equal(normalizeTriggers({ a: { triggers: [notification("a", [left[0]], left[1])] }, b: { triggers: [notification("b", [right[0]], right[1])] } }, catalog).length, 2);
  }
  const rule = (id: string) => trigger.s3(catalog.sources.bucket, { id, accepts: "s3", delivery: "eventbridge", eventTypes: ["s3:ObjectCreated:*"], acknowledgeRecursionRisk: true });
  assert.equal(normalizeTriggers({ a: { triggers: [rule("a")] }, b: { triggers: [rule("b")] } }, catalog).length, 2);
  assert.throws(() => normalizeTriggers({ a: { triggers: [rule("a"), rule("b")] } }, catalog), /overlapping S3 rules would invoke a twice/);
  assert.equal(normalizeTriggers({ a: { triggers: [rule("a"), notification("b", ["s3:ObjectCreated:*"])] } }, catalog).length, 2, "delivery paths are independent");
});

test("a failure destination is a catalog queue or topic with bounded retries and age, present in the graph", () => {
  const [normalized] = normalizeFailureDestinations({ event: { onFailure: { destination: catalog.sources.dlq, retryAttempts: 1, maxEventAgeSeconds: 3600 } }, other: {} }, catalog);
  assert.deepEqual(normalized, { event: "event", destination: { $cdk: "@repo/framework/cdk-resource", path: ["sources", "dlq"], optional: false }, retryAttempts: 1, maxEventAgeSeconds: 3600, origin: 'events["event"].onFailure' });
  assert.equal(normalizeFailureDestinations({ event: { onFailure: { destination: catalog.sources.topic } } }, catalog).length, 1);
  for (const [value, pattern] of [
    [{ destination: catalog.sources.dlq, retryAttempts: 3 }, /retryAttempts is 0, 1 or 2/],
    [{ destination: catalog.sources.dlq, maxEventAgeSeconds: 59 }, /from 60 to 21600/],
    [{ destination: "arn:aws:sqs:us-east-1:1:q" }, /resource catalog/],
    [{ destination: catalog.sources.dlq, onSuccess: catalog.sources.topic }, /unsupported option onSuccess/],
  ] as const) assert.throws(() => normalizeFailureDestinations({ event: { onFailure: value as never } }, catalog), pattern);
  assert.throws(() => normalizeFailureDestinations({ event: { onFailure: { destination: catalog.sources.dlq } } }, {}), /missing in this graph/);
  assert.deepEqual(triggerAdapters().filter((item) => item.asyncInvoke).map((item) => item.kind), ["eventbridge", "sns", "s3", "schedule"]);
});

test("a schedule needs no resource, validates rate and cron expressions, and normalizes by adapter", () => {
  const every = (expression: string, extra: Record<string, unknown> = {}) => trigger.schedule({ id: "nightly", accepts: "schedule", expression, ...extra });
  const descriptor = every("rate(5 minutes)");
  assert.equal(descriptor.resource, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
  for (const valid of ["rate(1 minute)", "rate(2 hours)", "rate(7 days)", "cron(0 9 * * ? *)", "cron(15 3 ? * MON-FRI *)"]) assert.equal(validateTrigger(every(valid)).kind, "schedule", valid);
  for (const [expression, pattern] of [["rate(1 minutes)", /rate\(1 minute\)/], ["rate(5 minute)", /rate\(5 minutes\)/], ["rate(0 hours)", /at least 1/], ["cron(0 9 * * MON *)", /must be \?/], ["every day", /rate\(N/], ["cron(0 9 * * ?)", /rate\(N/]] as const) assert.throws(() => every(expression), pattern, expression);
  assert.throws(() => every("rate(1 hour)", { timezone: "not a zone" }), /IANA name/);
  assert.equal(validateTrigger(every("rate(1 hour)", { timezone: "Europe/London", enabled: false, input: { job: "report" } })).kind, "schedule");
  assert.throws(() => validateTrigger({ ...descriptor, resource: catalog.sources.queue }), /takes no resource/);
  const [binding] = normalizeTriggers({ event: { triggers: [descriptor], localReplay: true } }, catalog);
  assert.equal(binding?.key, "schedule/nightly", "asynchronous schedules work with local replay");
  assert.throws(() => normalizeTriggers({ a: { triggers: [descriptor] }, b: { triggers: [descriptor] } }, catalog), /duplicate attachment id schedule\/nightly/);
  const schedule = triggerAdapters().find((item) => item.kind === "schedule")!;
  assert.ok(schedule.resourceless && schedule.guide.requirements.length >= 2 && /^https:\/\/docs\.aws\.amazon\.com\//.test(schedule.guide.docs));
});
