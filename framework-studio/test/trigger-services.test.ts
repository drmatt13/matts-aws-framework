import { sourceFixtureCheckpoint } from "./support/source-fixture";
import assert from "./support/assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { generateCreationArtifacts } from "../server/edits/creation-generation";
import type { TriggerBinding } from "../shared/triggers";
import { triggerTiming, triggerUnavailable } from "../shared/trigger-availability";

const repository = path.resolve(__dirname, "../..");
let root: string, builder: SnapshotBuilder, edits: EditService;
let firstFile: string, secondFile: string, stackFile: string;
const reference = (name: string) => ({ $cdk: "@repo/framework/cdk-resource", path: ["storage", name], optional: false });
const bind = (event: string, adapter: string, field: string, id: string, options: Record<string, unknown>): TriggerBinding => ({ event, id, key: `storage.${field}/${id}`, adapter, resource: `resource:storage.${field}`, accepts: ({ sqs: "sqs-batch", dynamodb: "dynamodb-stream", sns: "sns", s3: "s3" } as Record<string, string>)[adapter]!, options });
const s3 = (delivery: string, eventTypes = ["s3:ObjectCreated:*"]) => ({ delivery, eventTypes, acknowledgeRecursionRisk: true });

before(async () => {
  const cache = path.join(repository, ".cache/framework-studio"); mkdirSync(cache, { recursive: true }); root = mkdtempSync(path.join(cache, "trigger-services-"));
  for (const directory of ["framework-config/resources", "cdk-app/lib/framework", "cdk-app/bin"]) mkdirSync(path.join(root, directory), { recursive: true });
  cpSync(path.join(repository, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "framework.config.ts"), 'import { defineFrameworkConfig } from "@repo/framework/config"; import { defaults } from "./framework-config/defaults"; import { resources } from "./framework-config/resources"; import { first } from "./framework-config/first"; import { second } from "./framework-config/second"; export default defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], services: [], events: [first, second] });');
  writeFileSync(path.join(root, "framework-config/resources/inputs.ts"), 'import { resource } from "@repo/framework/config"; export const setting = resource.fromEnv("FIXTURE_SETTING");');
  writeFileSync(path.join(root, "framework-config/resources.ts"), 'import { defineResources, resource } from "@repo/framework/config"; import type { Storage } from "../cdk-app/lib/stacks"; import { setting } from "./resources/inputs"; export const resources = defineResources({ setting, storage: resource.stack<Storage>() });');
  stackFile = path.join(root, "cdk-app/lib/stacks.ts");
  writeFileSync(stackFile, `import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as notifications from "aws-cdk-lib/aws-s3-notifications";
import * as sources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import { eventFunction } from "./framework/framework-events";
import { linkResources } from "./framework/framework-resources";
import { resources } from "../../framework-config/resources";
throw new Error("Stack source must never execute");
const key = { name: "pk", type: dynamodb.AttributeType.STRING };
export class Storage extends cdk.Stack {
  public readonly queue: sqs.Queue;
  public readonly modestQueue: sqs.Queue;
  public readonly shortQueue: sqs.Queue;
  public readonly fifoQueue: sqs.Queue;
  public readonly namedFifo: sqs.Queue;
  public readonly consumedQueue: sqs.Queue;
  public readonly importedQueue: sqs.IQueue;
  public readonly dlq: sqs.Queue;
  public readonly table: dynamodb.TableV2;
  public readonly plainTable: dynamodb.TableV2;
  public readonly replicated: dynamodb.TableV2;
  public readonly topic: sns.Topic;
  public readonly fifoTopic: sns.Topic;
  public readonly bucket: s3.Bucket;
  public readonly plainBucket: s3.Bucket;
  public readonly l2Bucket: s3.Bucket;
  public readonly notifiedBucket: s3.Bucket;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.queue = new sqs.Queue(this, "Queue", { visibilityTimeout: cdk.Duration.minutes(2) });
    this.modestQueue = new sqs.Queue(this, "Modest", { visibilityTimeout: cdk.Duration.seconds(30) });
    this.shortQueue = new sqs.Queue(this, "Short", { visibilityTimeout: cdk.Duration.seconds(5) });
    this.fifoQueue = new sqs.Queue(this, "Fifo", { fifo: true, visibilityTimeout: cdk.Duration.minutes(5) });
    this.namedFifo = new sqs.Queue(this, "NamedFifo", { queueName: "orders.fifo", visibilityTimeout: cdk.Duration.minutes(5) });
    this.consumedQueue = new sqs.Queue(this, "Consumed", { visibilityTimeout: cdk.Duration.minutes(5) });
    this.importedQueue = sqs.Queue.fromQueueArn(this, "Imported", "arn:aws:sqs:us-east-1:111122223333:imported");
    this.dlq = new sqs.Queue(this, "Dlq");
    this.table = new dynamodb.TableV2(this, "Table", { partitionKey: key, dynamoStream: dynamodb.StreamViewType.NEW_IMAGE });
    this.plainTable = new dynamodb.TableV2(this, "PlainTable", { partitionKey: key });
    this.replicated = new dynamodb.TableV2(this, "Replicated", { partitionKey: key, replicas: [{ region: "us-west-2" }] });
    this.topic = new sns.Topic(this, "Topic");
    this.fifoTopic = new sns.Topic(this, "FifoTopic", { fifo: true });
    this.bucket = new s3.Bucket(this, "Bucket");
    const cfnBucket = this.bucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.notificationConfiguration = { eventBridgeConfiguration: { eventBridgeEnabled: true } };
    this.plainBucket = new s3.Bucket(this, "PlainBucket");
    this.l2Bucket = new s3.Bucket(this, "L2Bucket", { eventBridgeEnabled: true });
    this.notifiedBucket = new s3.Bucket(this, "Notified");
    eventFunction(this, "second").addEventSource(new sources.SqsEventSource(this.consumedQueue));
    this.notifiedBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new notifications.LambdaDestination(eventFunction(this, "second")));
    linkResources(this, resources.storage);
  }
}
`);
  writeFileSync(path.join(root, "cdk-app/lib/framework/framework-resources.ts"), "export function linkResources(scope: unknown, reference: unknown) {}");
  writeFileSync(path.join(root, "cdk-app/lib/framework/framework-events.ts"), "export function eventFunction(scope: unknown, id: string): any { return undefined; }");
  writeFileSync(path.join(root, "cdk-app/bin/main.ts"), 'import { App } from "aws-cdk-lib"; import { Storage } from "../lib/stacks"; const app = new App(); new Storage(app, "Storage");');
  writeFileSync(path.join(root, "cdk-app/cdk.json"), '{"app":"tsx bin/main.ts"}');
  firstFile = path.join(root, "framework-config/first.ts");
  writeFileSync(firstFile, 'import { resources } from "./resources";\nexport const first = { first: { directory: "/lambda_functions/first", cloud: { bindings: [resources.storage.plainBucket.grantReadWrite()] } } } as const;\n');
  secondFile = path.join(root, "framework-config/second.ts");
  writeFileSync(secondFile, 'export const second = { second: { directory: "/lambda_functions/second" } } as const;\n');
  // Every reviewed edit runs the real generator. Include authentic inputs and
  // the implementations declared by this intentionally small application.
  for (const relative of ["package.json", "package-lock.json", "packages/framework/src", "packages/api-contract/src/generated"]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    cpSync(path.join(repository, relative), path.join(root, relative), { recursive: true });
  }
  writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
  for (const id of ["first", "second"]) {
    const directory = path.join(root, "cdk-app/lambda_functions", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "index.ts"), "export const lambdaHandler = async (event: unknown) => event;\n");
  }
  const generated = await generateCreationArtifacts(root, new Map());
  for (const [file, text] of generated.overrides) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
  for (const file of generated.deletions.keys()) rmSync(file);
  builder = new SnapshotBuilder(root); edits = new EditService(root, builder); await builder.refresh();
  for (const target of builder.current!.snapshot.models.dev.targets) assert.ok(target.implementation?.ready, target.implementation?.problems.join("\n") ?? `${target.ref} implementation was not checked`);
});
let restoreSource: () => Promise<void>;
beforeEach(() => { restoreSource = sourceFixtureCheckpoint(root, builder); });
afterEach(async () => { await restoreSource(); });

after(async () => { await builder?.dispose(); assert.ok(root.startsWith(path.join(repository, ".cache/framework-studio") + path.sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test("each service field is discovered semantically with its concrete availability reason", () => {
  const snapshot = builder.current!.snapshot;
  assert.equal(snapshot.models.dev.status, "ok", JSON.stringify(snapshot.models.dev.diagnostics));
  const reason = (field: string, adapter: string, options: Record<string, unknown> = {}) => triggerUnavailable(snapshot, `resource:storage.${field}`, adapter, options);
  for (const [field, adapter] of [["queue", "sqs"], ["fifoQueue", "sqs"], ["namedFifo", "sqs"], ["table", "dynamodb"], ["replicated", "dynamodb"], ["topic", "sns"], ["bucket", "s3"], ["plainBucket", "s3"]] as const) assert.equal(reason(field, adapter), undefined, field);
  const kinds = (field: string) => snapshot.source.triggerCapabilities!.find((item) => item.resource === `resource:storage.${field}`)!.adapters.map((item) => item.kind);
  assert.deepEqual(kinds("queue"), ["sqs"]);
  assert.deepEqual(kinds("table"), ["dynamodb"]);
  assert.deepEqual(kinds("topic"), ["sns"]);
  assert.deepEqual(kinds("bucket"), ["s3"]);
  assert.match(reason("importedQueue", "sqs")!, /Imported or immutable/);
  assert.match(reason("consumedQueue", "sqs")!, /native Lambda consumer/);
  assert.match(reason("plainTable", "dynamodb")!, /No stream enabled/);
  assert.match(reason("fifoTopic", "sns")!, /FIFO topics cannot deliver to Lambda/);
  assert.match(reason("l2Bucket", "s3")!, /notification custom resource/);
  assert.match(reason("plainBucket", "s3", { delivery: "eventbridge" })!, /EventBridge delivery is not enabled/);
  assert.equal(reason("plainBucket", "s3", { delivery: "notification" }), undefined);
  assert.equal(reason("bucket", "s3", { delivery: "eventbridge" }), undefined);
  assert.match(reason("bucket", "s3", { delivery: "notification" })!, /already uses EventBridge delivery/);
  assert.match(reason("notifiedBucket", "s3", { delivery: "notification" })!, /native notifications/);
  assert.match(reason("fifoQueue", "sqs", { batchWindowSeconds: 1 })!, /do not support a batching window/);
  assert.match(reason("namedFifo", "sqs", { batchSize: 11, batchWindowSeconds: 1 })!, /at most ten/);
  assert.equal(reason("fifoQueue", "sqs", { batchSize: 10, batchWindowSeconds: 0 }), undefined);
  assert.match(reason("dlq", "dynamodb")!, /no compatible trigger adapter/);
  for (const model of Object.values(snapshot.models)) {
    for (const from of ["resource:storage.consumedQueue", "resource:storage.notifiedBucket"]) assert.ok(model.edges.some((edge) => edge.relation === "trigger" && edge.provenance === "source" && edge.from === from && edge.to === "lambda:second"), `${model.mode} ${from}`);
  }
});

test("SQS visibility must cover the event timeout in both graphs; the six-times guidance is only a recommendation", () => {
  const snapshot = builder.current!.snapshot;
  const timing = (field: string, options: Record<string, unknown> = {}) => triggerTiming(snapshot, { event: "first", resource: `resource:storage.${field}`, adapter: "sqs", options });
  assert.match(timing("shortQueue").problem!, /\(5s\) must be at least the function timeout \(10s\)/);
  assert.deepEqual(timing("queue"), {});
  assert.equal(timing("modestQueue").problem, undefined);
  assert.match(timing("modestQueue").recommendation!, /at least 60s \(6× the function timeout plus the batching window\); this is 30s/);
  assert.match(timing("queue", { batchWindowSeconds: 61 }).recommendation!, /at least 121s/);
  assert.deepEqual(triggerTiming(snapshot, { event: "first", resource: "resource:storage.table", adapter: "dynamodb", options: {} }), {});
});

test("a multi-service, multi-file draft previews both graphs, writes literal descriptors with exact source bytes", async () => {
  const originalFirst = readFileSync(firstFile, "utf8"), originalSecond = readFileSync(secondFile, "utf8");
  const first = [
    bind("first", "sqs", "modestQueue", "orders", { batchSize: 5, reportBatchItemFailures: true }),
    bind("first", "dynamodb", "table", "changes", { startingPosition: "TRIM_HORIZON", onFailureQueue: reference("dlq"), filters: [{ eventName: ["INSERT"] }] }),
    bind("first", "s3", "plainBucket", "uploads", { ...s3("notification", ["s3:ObjectCreated:Put"]), prefix: "inbox/" }),
  ];
  const second = [bind("second", "sns", "topic", "fanout", { filterPolicy: { kind: ["order"] } }), bind("second", "s3", "bucket", "rules", s3("eventbridge"))];
  const plan = await edits.planBatch([{ kind: "triggers", event: "first", bindings: first }, { kind: "triggers", event: "second", bindings: second }], builder.current!.snapshot.revision);
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.changes.length, 2);
  assert.equal(readFileSync(firstFile, "utf8"), originalFirst, "preview is offline");
  assert.ok(plan.impact.some((line) => /AWS recommends at least 60s/.test(line)), plan.impact.join("\n"));
  assert.ok(plan.impact.some((line) => /lambda:first can write to this bucket \(grantReadWrite/.test(line)), plan.impact.join("\n"));
  assert.ok(plan.impact.some((line) => line.includes("Handler contract acknowledged: dynamodb-stream")));
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  const written = readFileSync(firstFile, "utf8");
  assert.match(written, /import \{ trigger as studioTrigger \} from "@repo\/framework\/config";/);
  assert.match(written, /studioTrigger\.adapter\("dynamodb", resources\.storage\.table, \{ id: "changes", accepts: "dynamodb-stream", startingPosition: "TRIM_HORIZON", onFailureQueue: resources\.storage\.dlq, filters: \[\{ eventName: \["INSERT"\] \}\] \}\)/);
  assert.doesNotMatch(written, /arn:|\$cdk/);
  for (const model of Object.values(builder.current!.snapshot.models)) {
    assert.equal(model.status, "ok");
    assert.deepEqual(model.triggers!.map((binding) => `${binding.event}:${binding.key}`).sort(), [...first, ...second].map((binding) => `${binding.event}:${binding.key}`).sort());
    for (const binding of [...first, ...second]) assert.ok(model.edges.some((edge) => edge.relation === "trigger" && edge.provenance === "declared" && edge.from === binding.resource && edge.to === `lambda:${binding.event}` && edge.attachment === binding.key), `${model.mode} ${binding.key}`);
  }
  const reassign = await edits.planBatch([{ kind: "triggers", event: "first", bindings: first.slice(1) }, { kind: "triggers", event: "second", bindings: [...second, { ...first[0]!, event: "second" }] }], builder.current!.snapshot.revision);
  assert.equal(reassign.ok, true, JSON.stringify(reassign.preflight));
  assert.equal((await edits.applyBatch(reassign.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.prod.triggers!.find((binding) => binding.key === "storage.modestQueue/orders")?.event, "second");
  await restoreSource();
  assert.equal(readFileSync(firstFile, "utf8"), originalFirst); assert.equal(readFileSync(secondFile, "utf8"), originalSecond);
  assert.equal(builder.current!.snapshot.models.dev.triggers!.length, 0);
  await restoreSource();
  assert.equal(readFileSync(firstFile, "utf8"), originalFirst);
});

test("unsafe or invalid service bindings are refused before any write, with the adapter's reason", async () => {
  const before = [readFileSync(firstFile, "utf8"), readFileSync(secondFile, "utf8")];
  const refuse = async (binding: TriggerBinding, pattern: RegExp) => assert.rejects(edits.planBatch([{ kind: "triggers", event: binding.event, bindings: [binding] }], builder.current!.snapshot.revision), pattern, binding.key);
  await refuse(bind("first", "sqs", "shortQueue", "short", {}), /must be at least the function timeout/);
  await refuse(bind("first", "sqs", "consumedQueue", "consumed", {}), /native Lambda consumer/);
  await refuse(bind("first", "sqs", "fifoQueue", "fifo", { batchWindowSeconds: 1 }), /batching window/);
  await refuse(bind("first", "sqs", "queue", "large", { batchSize: 50 }), /batch window of at least one second/);
  await refuse(bind("first", "sqs", "importedQueue", "imported", {}), /Imported or immutable/);
  await refuse(bind("first", "dynamodb", "plainTable", "plain", { startingPosition: "LATEST" }), /No stream enabled/);
  await refuse(bind("first", "dynamodb", "table", "missing-position", {}), /startingPosition is required/);
  await refuse(bind("first", "dynamodb", "table", "bad-dlq", { startingPosition: "LATEST", onFailureQueue: reference("importedQueue") }), /choose a compatible owned public resource/);
  await refuse(bind("first", "sns", "fifoTopic", "fifo-topic", {}), /FIFO topics/);
  await refuse(bind("first", "sns", "topic", "scoped", { filterScope: "MessageBody" }), /filter scope requires a filter policy/);
  await refuse(bind("first", "s3", "bucket", "put", s3("eventbridge", ["s3:ObjectCreated:Put"])), /EventBridge delivery supports/);
  await refuse(bind("first", "s3", "l2Bucket", "l2", s3("eventbridge")), /notification custom resource/);
  await refuse(bind("first", "s3", "notifiedBucket", "native", s3("notification")), /native notifications/);
  await refuse({ ...bind("first", "s3", "plainBucket", "unreviewed", s3("notification")), options: { delivery: "notification", eventTypes: ["s3:ObjectCreated:*"] } }, /acknowledgeRecursionRisk is required/);
  await refuse({ ...bind("first", "sqs", "queue", "contract", {}), accepts: "sns" }, /acknowledge handler contract sqs-batch/);
  await refuse(bind("first", "sqs", "nothing", "nothing", {}), /Unknown public type/);
  const overlap = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [bind("first", "s3", "plainBucket", "a", s3("notification")), bind("first", "s3", "plainBucket", "b", { ...s3("notification", ["s3:ObjectCreated:Put"]), prefix: "x/" })] }], builder.current!.snapshot.revision);
  assert.equal(overlap.ok, false, "overlapping notifications fail in both graphs");
  assert.ok(["dev", "prod"].every((mode) => overlap.preflight[mode as "dev" | "prod"].diagnostics.some((item) => /overlapping S3 notifications/.test(item.message))), JSON.stringify(overlap.preflight));
  await assert.rejects(edits.applyBatch(overlap.planId), /rejected/);
  assert.deepEqual([readFileSync(firstFile, "utf8"), readFileSync(secondFile, "utf8")], before);
});

test("a capability source change after review expires the trigger plan", async () => {
  const plan = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [bind("first", "sqs", "queue", "orders", {})] }], builder.current!.snapshot.revision);
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  const original = readFileSync(stackFile, "utf8");
  writeFileSync(stackFile, original.replace("cdk.Duration.minutes(2)", "cdk.Duration.seconds(5)"));
  try { await assert.rejects(edits.applyBatch(plan.planId), /cdk-app\/lib\/stacks\.ts changed after review/); }
  finally { writeFileSync(stackFile, original); await builder.refresh(); }
  assert.doesNotMatch(readFileSync(firstFile, "utf8"), /trigger/);
});

test("an event's failure destination writes onFailure with the catalog reference, reads back, and is removed exactly", async () => {
  const original = readFileSync(firstFile, "utf8");
  const plan = await edits.planBatch([{ kind: "onFailure", event: "first", value: { destination: "resource:storage.dlq", retryAttempts: 1 } }], builder.current!.snapshot.revision);
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.ok(plan.impact.some((line) => line.includes("go to resource:storage.dlq after 1 retries")));
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  assert.match(readFileSync(firstFile, "utf8"), /onFailure: \{ destination: resources\.storage\.dlq, retryAttempts: 1 \}/, "reuses the file's catalog import");
  for (const model of Object.values(builder.current!.snapshot.models)) {
    assert.deepEqual(model.failureDestinations, [{ event: "first", destination: "resource:storage.dlq", retryAttempts: 1 }]);
    assert.ok(model.edges.some((edge) => edge.relation === "grant" && edge.label === "onFailure" && edge.from === "lambda:first" && edge.to === "resource:storage.dlq"));
  }
  const refuse = (value: Record<string, unknown>, pattern: RegExp) => assert.rejects(edits.planBatch([{ kind: "onFailure", event: "first", value: value as never }], builder.current!.snapshot.revision), pattern);
  await refuse({ destination: "resource:storage.fifoQueue" }, /not FIFO/);
  await refuse({ destination: "resource:storage.table" }, /SQS queue or SNS topic/);
  await refuse({ destination: "resource:storage.dlq", maxEventAgeSeconds: 30 }, /from 60 to 21600/);
  const removal = await edits.planBatch([{ kind: "onFailure", event: "first", value: null }], builder.current!.snapshot.revision);
  assert.equal(removal.ok, true, JSON.stringify(removal.preflight));
  assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
  assert.equal(readFileSync(firstFile, "utf8"), original, "no property or dead import remains");
  await restoreSource();
  assert.equal(readFileSync(firstFile, "utf8"), original);
});
