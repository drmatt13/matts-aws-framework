import type { UserPool } from "aws-cdk-lib/aws-cognito";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { isCdkResource, isGroupMember, type CdkResource, type CdkResourceSpec, type JsonArgument } from "./cdk-resources";
import { listCdkResourceDeclarations, listCdkResourceGroupDeclarations, type ResourceDeclarationGroup } from "./resources";

export interface TriggerField {
  readonly name: string;
  readonly label: string;
  readonly kind: "string" | "number" | "boolean" | "json" | "enum" | "resource";
  readonly resourceType?: { readonly module: string; readonly name: string; readonly owned?: boolean };
  readonly required?: boolean;
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly array?: boolean;
  /** What Studio pre-fills; the declaration still states it explicitly. */
  readonly default?: JsonArgument;
  /** Tuning most triggers leave alone; Studio folds it under advanced options. */
  readonly advanced?: true;
}

export interface TriggerAdapterMetadata {
  readonly kind: string;
  readonly label: string;
  /** Official CDK module and exported type; Studio resolves their symbols. */
  readonly types: readonly { readonly module: string; readonly name: string; readonly mutable?: boolean }[];
  readonly fields: readonly TriggerField[];
  readonly contract: string;
  readonly delivery: string;
  readonly replay: boolean;
  readonly replayOperations?: readonly string[];
  readonly exclusive?: string;
  readonly requiresOwned?: boolean;
  readonly nativeSlots?: Readonly<Record<string, string>>;
  readonly onePerEvent?: boolean;
  /** Needs no catalog resource: the adapter creates its own source, such as a schedule. */
  readonly resourceless?: true;
  /** Lambda invokes the event asynchronously, so a failed run retries and then goes to the event's onFailure destination. */
  readonly asyncInvoke?: true;
  /** Syntax facts Studio reads from a field's constructor props; `suffix` tests a string literal's ending. */
  readonly facts?: readonly { readonly name: string; readonly properties: readonly string[]; readonly kind: "presence" | "boolean" | "duration" | "suffix"; readonly suffix?: string; readonly fallback?: boolean | number; readonly assignmentPath?: string }[];
  /** A fact a binding needs; with `option`, only when that option equals `equals` or exceeds `above`. */
  readonly requiredFacts?: readonly { readonly name: string; readonly value: boolean; readonly reason: string; readonly option?: string; readonly equals?: string; readonly above?: number }[];
  /** Any recognized native trigger on the resource occupies it (optionally for one option value). */
  readonly nativeExclusive?: { readonly reason: string; readonly option?: string; readonly equals?: string };
  /** A duration fact that must cover the destination's timeout; the larger multiple is only AWS advice. */
  readonly timeoutFact?: { readonly name: string; readonly label: string; readonly recommendedMultiple: number; readonly plusOption?: string };
  /** What a stack must expose, in plain language with a copyable example. Studio's trigger guide shows it. */
  readonly guide: TriggerGuideMetadata;
}

export interface TriggerGuideMetadata {
  readonly requirements: readonly string[];
  /** A conventional public field name and its declared type, e.g. `queue: sqs.Queue`. */
  readonly field: string;
  readonly type: string;
  readonly imports: readonly string[];
  /** The constructor initializer for that field. */
  readonly construct: string;
  /** Further constructor lines the adapter needs, such as an L1 setting. */
  readonly setup?: readonly string[];
  readonly docs: string;
}

export interface EventTrigger {
  readonly $trigger: "@repo/framework/trigger";
  readonly adapter: string;
  readonly id: string;
  /** The catalog resource that invokes the event; absent only for a resourceless adapter. */
  readonly resource?: CdkResourceSpec;
  readonly options: Readonly<Record<string, JsonArgument>>;
  readonly accepts: string;
}

export interface NormalizedTrigger extends EventTrigger {
  readonly event: string;
  readonly key: string;
  readonly origin: string;
}

export interface TriggerOptions {
  readonly id: string;
  /** A reviewed declaration of the handler's payload and response compatibility. */
  readonly accepts: string;
}

interface Adapter {
  readonly metadata: TriggerAdapterMetadata;
  readonly validate: (options: Readonly<Record<string, JsonArgument>>) => void;
}
const adapters = new Map<string, Adapter>();

/** Register one service, never individual application stacks. Contains no CDK values. */
export function defineTriggerAdapter<Native, Options extends object>(metadata: TriggerAdapterMetadata, validate: Adapter["validate"]) {
  if (adapters.has(metadata.kind)) throw new Error(`Trigger adapter ${metadata.kind} is already registered.`);
  adapters.set(metadata.kind, { metadata, validate });
  return (resource: CdkResource<Native>, options: Options & TriggerOptions): EventTrigger => {
    const { id, accepts, ...settings } = options;
    const descriptor: EventTrigger = { $trigger: "@repo/framework/trigger", adapter: metadata.kind, id, accepts, resource, options: settings as Record<string, JsonArgument> };
    validateTrigger(descriptor);
    return Object.freeze(descriptor);
  };
}

export function triggerAdapters(): readonly TriggerAdapterMetadata[] {
  return [...adapters.values()].map((adapter) => adapter.metadata);
}

export function validateTrigger(value: EventTrigger): TriggerAdapterMetadata {
  if (!value || value.$trigger !== "@repo/framework/trigger") throw new Error("A trigger requires a public CDK resource from the catalog.");
  const adapter = adapters.get(value.adapter);
  if (adapter?.metadata.resourceless) {
    if (value.resource !== undefined) throw new Error(`A ${adapter.metadata.label} trigger takes no resource.`);
  } else if (!isCdkResource(value.resource) || !value.resource.path.length) throw new Error("A trigger requires a public CDK resource from the catalog.");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id)) throw new Error("A trigger id must be a stable kebab-case name.");
  if (!adapter) throw new Error(`Unknown trigger adapter ${value.adapter}.`);
  if (value.accepts !== adapter.metadata.contract) throw new Error(`Trigger ${value.id}: acknowledge handler contract ${adapter.metadata.contract}.`);
  if (!value.options || typeof value.options !== "object" || Array.isArray(value.options)) throw new Error(`Trigger ${value.id}: options must be an object.`);
  for (const key of Object.keys(value.options)) if (!adapter.metadata.fields.some((field) => field.name === key)) throw new Error(`Trigger ${value.id}: unsupported option ${key}.`);
  for (const field of adapter.metadata.fields) {
    const item = value.options[field.name];
    if (item === undefined) { if (field.required) throw new Error(`Trigger ${value.id}: ${field.name} is required.`); continue; }
    const invalid = field.kind === "number" ? typeof item !== "number" || !Number.isInteger(item) || item < (field.min ?? -Infinity) || item > (field.max ?? Infinity)
      : field.kind === "enum" ? typeof item !== "string" || !field.values?.includes(item)
      : field.kind === "resource" ? !isCdkResource(item)
      : field.kind === "json" ? item === null || typeof item !== "object" || Array.isArray(item) !== !!field.array
      : typeof item !== field.kind;
    if (invalid) throw new Error(`Trigger ${value.id}: invalid ${field.name}.`);
  }
  const json = (item: unknown): boolean => item === null || typeof item === "boolean" || typeof item === "string" || (typeof item === "number" && Number.isFinite(item)) || (Array.isArray(item) ? item.every(json) : !!item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype && Object.values(item).every(json));
  if (!json(value.options)) throw new Error(`Trigger ${value.id}: options must contain only JSON data.`);
  adapter.validate(value.options);
  return adapter.metadata;
}

export const COGNITO_TRIGGER_OPERATIONS = {
  preSignUp: "PRE_SIGN_UP", customMessage: "CUSTOM_MESSAGE", postConfirmation: "POST_CONFIRMATION",
  preAuthentication: "PRE_AUTHENTICATION", postAuthentication: "POST_AUTHENTICATION",
  defineAuthChallenge: "DEFINE_AUTH_CHALLENGE", createAuthChallenge: "CREATE_AUTH_CHALLENGE",
  verifyAuthChallengeResponse: "VERIFY_AUTH_CHALLENGE_RESPONSE", userMigration: "USER_MIGRATION",
} as const;
export type CognitoTriggerHook = keyof typeof COGNITO_TRIGGER_OPERATIONS;
export const COGNITO_TRIGGER_HOOKS = Object.keys(COGNITO_TRIGGER_OPERATIONS) as readonly CognitoTriggerHook[];

const cognito = defineTriggerAdapter<UserPool, { readonly operation: CognitoTriggerHook }>({
  kind: "cognito", label: "Cognito", types: [{ module: "aws-cognito", name: "UserPool", mutable: true }, { module: "aws-cognito", name: "IUserPool" }],
  guide: {
    requirements: ["An owned cognito.UserPool created in the stack, not UserPool.fromUserPoolId.", "Each hook is one slot; a hook already wired in lambdaTriggers stays native.", "Hooks answer synchronously within five seconds; only postConfirmation supports local replay."],
    field: "userPool", type: "cognito.UserPool", imports: ['import * as cognito from "aws-cdk-lib/aws-cognito";'],
    construct: 'new cognito.UserPool(this, "UserPool", { selfSignUpEnabled: true })',
    docs: "https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-working-with-lambda-triggers.html",
  },
  contract: "cognito", delivery: "Synchronous Cognito event and required response", replay: false, exclusive: "operation", requiresOwned: true,
  replayOperations: ["postConfirmation"],
  nativeSlots: Object.fromEntries(Object.entries(COGNITO_TRIGGER_OPERATIONS).map(([hook, operation]) => [operation, hook])),
  fields: [{ name: "operation", label: "Hook", kind: "enum", required: true, values: COGNITO_TRIGGER_HOOKS }],
}, () => {});

const eventbridge = defineTriggerAdapter<IEventBus, {
  readonly eventPattern: Readonly<Record<string, JsonArgument>>;
  readonly enabled?: boolean;
  readonly input?: Readonly<Record<string, JsonArgument>>;
  readonly retryAttempts?: number;
  readonly maxEventAgeSeconds?: number;
  readonly deadLetterQueue?: CdkResource<IQueue>;
}>({
  kind: "eventbridge", label: "EventBridge", types: [{ module: "aws-events", name: "IEventBus" }, { module: "aws-events", name: "EventBus" }],
  guide: {
    requirements: ["An events.EventBus, or an imported bus in the function's account and region.", "Each trigger is its own rule with an event pattern.", "An optional dead-letter queue is an owned standard sqs.Queue."],
    field: "bus", type: "events.EventBus", imports: ['import * as events from "aws-cdk-lib/aws-events";'],
    construct: 'new events.EventBus(this, "Bus")',
    docs: "https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html",
  },
  contract: "eventbridge", delivery: "Asynchronous EventBridge envelope or configured target input, with retries", replay: true, asyncInvoke: true,
  fields: [
    { name: "eventPattern", label: "Event pattern", kind: "json", required: true }, { name: "enabled", label: "Enabled", kind: "boolean", advanced: true },
    { name: "input", label: "Target input", kind: "json", advanced: true }, { name: "retryAttempts", label: "Retry attempts", kind: "number", min: 0, max: 185, advanced: true },
    { name: "maxEventAgeSeconds", label: "Maximum event age (seconds)", kind: "number", min: 60, max: 86400, advanced: true },
    { name: "deadLetterQueue", label: "Dead-letter queue", kind: "resource", resourceType: { module: "aws-sqs", name: "IQueue", owned: true }, advanced: true },
  ],
}, (options) => {
  const pattern = options.eventPattern as Record<string, JsonArgument>;
  if (!Object.keys(pattern).length) throw new Error("EventBridge requires a non-empty event pattern.");
  for (const [key, value] of Object.entries(pattern)) {
    if (key === "detail") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EventBridge detail must be an object.");
    } else if (!["version", "id", "detailType", "source", "account", "time", "region", "resources"].includes(key) || !Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" && (!item || typeof item !== "object" || Array.isArray(item)))) throw new Error(`EventBridge eventPattern has invalid ${key}; use CDK EventPattern field names.`);
  }
});

const batchFields: readonly TriggerField[] = [
  { name: "batchSize", label: "Batch size", kind: "number", min: 1, max: 10000, advanced: true },
  { name: "batchWindowSeconds", label: "Batch window (seconds)", kind: "number", min: 0, max: 300, advanced: true },
  { name: "filters", label: "Filter patterns (JSON array)", kind: "json", array: true, advanced: true },
  { name: "reportBatchItemFailures", label: "Partial batch responses", kind: "boolean", advanced: true },
  { name: "enabled", label: "Enabled", kind: "boolean", advanced: true },
];
interface BatchOptions {
  readonly batchSize?: number;
  readonly batchWindowSeconds?: number;
  readonly filters?: readonly Readonly<Record<string, JsonArgument>>[];
  readonly reportBatchItemFailures?: boolean;
  readonly enabled?: boolean;
}
function validateBatch(options: Readonly<Record<string, JsonArgument>>) {
  if (options.filters !== undefined && (!Array.isArray(options.filters) || options.filters.length > 5 || options.filters.some((filter) => !filter || typeof filter !== "object" || Array.isArray(filter) || !Object.keys(filter).length))) throw new Error("Filters require at most five non-empty pattern objects.");
}
const sqs = defineTriggerAdapter<IQueue, BatchOptions & { readonly maxConcurrency?: number }>({
  kind: "sqs", label: "SQS", types: [{ module: "aws-sqs", name: "Queue", mutable: true }, { module: "aws-sqs", name: "IQueue" }],
  guide: {
    requirements: ["An owned sqs.Queue, not Queue.fromQueueArn.", "Visibility timeout at least the function timeout; AWS recommends six times it plus the batching window.", "FIFO queues take at most ten messages per batch and no batching window.", "No other Lambda already consumes the queue natively."],
    field: "queue", type: "sqs.Queue", imports: ['import * as cdk from "aws-cdk-lib";', 'import * as sqs from "aws-cdk-lib/aws-sqs";'],
    construct: 'new sqs.Queue(this, "Queue", { visibilityTimeout: cdk.Duration.seconds(60) })',
    docs: "https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html",
  },
  contract: "sqs-batch", delivery: "At-least-once SQS Records batch; handle duplicates and configured partial failures", replay: false, requiresOwned: true, onePerEvent: true,
  facts: [{ name: "visibilitySeconds", properties: ["visibilityTimeout"], kind: "duration", fallback: 30 }, { name: "fifo", properties: ["fifo"], kind: "boolean", fallback: false }, { name: "fifoName", properties: ["queueName"], kind: "suffix", suffix: ".fifo", fallback: false }],
  requiredFacts: [
    ...(["fifo", "fifoName"] as const).flatMap((name) => [
      { name, value: false, option: "batchSize", above: 10, reason: "FIFO queues deliver batches of at most ten messages." },
      { name, value: false, option: "batchWindowSeconds", above: 0, reason: "FIFO queues do not support a batching window." },
    ]),
  ],
  nativeExclusive: { reason: "Queue already has a native Lambda consumer; manual wiring review required." },
  timeoutFact: { name: "visibilitySeconds", label: "Queue visibility timeout", recommendedMultiple: 6, plusOption: "batchWindowSeconds" },
  fields: [...batchFields, { name: "maxConcurrency", label: "Maximum concurrency", kind: "number", min: 2, max: 1000, advanced: true }],
}, (options) => {
  validateBatch(options);
  if (Number(options.batchSize ?? 10) > 10 && Number(options.batchWindowSeconds ?? 0) < 1) throw new Error("SQS batches over ten require a batch window of at least one second.");
});
const dynamodb = defineTriggerAdapter<ITable, BatchOptions & {
  readonly startingPosition: "LATEST" | "TRIM_HORIZON";
  readonly parallelizationFactor?: number;
  readonly retryAttempts?: number;
  readonly maxRecordAgeSeconds?: number;
  readonly bisectBatchOnError?: boolean;
  readonly onFailureQueue?: CdkResource<IQueue>;
}>({
  kind: "dynamodb", label: "DynamoDB stream", types: [{ module: "aws-dynamodb", name: "Table", mutable: true }, { module: "aws-dynamodb", name: "TableV2", mutable: true }, { module: "aws-dynamodb", name: "ITable" }],
  guide: {
    requirements: ["An owned dynamodb.TableV2 or Table.", "A stream enabled in the table's own props (dynamoStream or stream). Studio never enables one.", "No other Lambda already reads the stream natively."],
    field: "table", type: "dynamodb.TableV2", imports: ['import * as dynamodb from "aws-cdk-lib/aws-dynamodb";'],
    construct: 'new dynamodb.TableV2(this, "Table", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES })',
    docs: "https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html",
  },
  contract: "dynamodb-stream", delivery: "At-least-once DynamoDB Records batch; handle ordering, duplicates and configured partial failures", replay: false, requiresOwned: true, onePerEvent: true,
  // CDK derives a NEW_AND_OLD_IMAGES stream for replicated tables.
  facts: [{ name: "stream", properties: ["stream", "dynamoStream", "replicas", "replicationRegions"], kind: "presence", fallback: false }],
  requiredFacts: [{ name: "stream", value: true, reason: "No stream enabled; change the table in its owning stack first." }],
  nativeExclusive: { reason: "Stream already has a native Lambda mapping; manual wiring review required." },
  fields: [...batchFields,
    { name: "startingPosition", label: "Starting position", kind: "enum", required: true, values: ["LATEST", "TRIM_HORIZON"], default: "LATEST" },
    { name: "parallelizationFactor", label: "Parallelization factor", kind: "number", min: 1, max: 10, advanced: true },
    { name: "retryAttempts", label: "Retry attempts", kind: "number", min: 0, max: 10000, advanced: true },
    { name: "maxRecordAgeSeconds", label: "Maximum record age (seconds)", kind: "number", min: 60, max: 604800, advanced: true },
    { name: "bisectBatchOnError", label: "Bisect failed batch", kind: "boolean", advanced: true },
    { name: "onFailureQueue", label: "Failure queue", kind: "resource", resourceType: { module: "aws-sqs", name: "IQueue", owned: true }, advanced: true },
  ],
}, validateBatch);
const sns = defineTriggerAdapter<ITopic, {
  readonly filterPolicy?: Readonly<Record<string, JsonArgument>>;
  readonly filterScope?: "MessageAttributes" | "MessageBody";
  readonly deadLetterQueue?: CdkResource<IQueue>;
}>({
  kind: "sns", label: "SNS", types: [{ module: "aws-sns", name: "Topic", mutable: true }, { module: "aws-sns", name: "ITopic" }],
  guide: {
    requirements: ["An sns.Topic, or an imported topic in the function's account and region.", "A standard topic: FIFO topics cannot deliver to Lambda.", "Existing subscribers are kept; one subscription per function."],
    field: "topic", type: "sns.Topic", imports: ['import * as sns from "aws-cdk-lib/aws-sns";'],
    construct: 'new sns.Topic(this, "Topic")',
    docs: "https://docs.aws.amazon.com/sns/latest/dg/sns-lambda-as-subscriber.html",
  },
  contract: "sns", delivery: "Asynchronous SNS Records envelope with retries; handle duplicate messages", replay: true, asyncInvoke: true, onePerEvent: true,
  facts: [{ name: "fifo", properties: ["fifo"], kind: "boolean", fallback: false }],
  requiredFacts: [{ name: "fifo", value: false, reason: "SNS FIFO topics cannot deliver to Lambda; subscribe an SQS FIFO queue instead." }],
  fields: [
    { name: "filterPolicy", label: "Subscription filter", kind: "json", advanced: true },
    { name: "filterScope", label: "Filter scope", kind: "enum", values: ["MessageAttributes", "MessageBody"], advanced: true },
    { name: "deadLetterQueue", label: "Dead-letter queue", kind: "resource", resourceType: { module: "aws-sqs", name: "IQueue", owned: true }, advanced: true },
  ],
}, (options) => {
  if (options.filterScope && !options.filterPolicy) throw new Error("SNS filter scope requires a filter policy.");
  const check = (value: JsonArgument, nested: boolean): boolean => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 && Object.values(value).every((entry) => Array.isArray(entry) ? entry.length > 0 && entry.every((condition) => typeof condition === "string" || typeof condition === "number" || (!!condition && typeof condition === "object" && !Array.isArray(condition))) : nested && check(entry, nested));
  if (options.filterPolicy && !check(options.filterPolicy, options.filterScope === "MessageBody")) throw new Error("SNS filters require non-empty condition arrays; nested policies require MessageBody scope.");
});
export const S3_TRIGGER_EVENTS = ["s3:ObjectCreated:*", "s3:ObjectCreated:Put", "s3:ObjectCreated:Post", "s3:ObjectCreated:Copy", "s3:ObjectCreated:CompleteMultipartUpload", "s3:ObjectRemoved:*", "s3:ObjectRemoved:Delete", "s3:ObjectRemoved:DeleteMarkerCreated", "s3:ObjectRestore:*", "s3:ObjectRestore:Post", "s3:ObjectRestore:Completed", "s3:ObjectRestore:Delete", "s3:ReducedRedundancyLostObject", "s3:Replication:*", "s3:Replication:OperationFailedReplication", "s3:Replication:OperationMissedThreshold", "s3:Replication:OperationReplicatedAfterThreshold", "s3:Replication:OperationNotTracked", "s3:LifecycleTransition", "s3:LifecycleExpiration:*", "s3:LifecycleExpiration:Delete", "s3:LifecycleExpiration:DeleteMarkerCreated", "s3:IntelligentTiering", "s3:ObjectTagging:*", "s3:ObjectTagging:Put", "s3:ObjectTagging:Delete", "s3:ObjectAcl:Put"] as const;
const s3 = defineTriggerAdapter<Bucket, {
  readonly delivery: "eventbridge" | "notification";
  readonly eventTypes: readonly (typeof S3_TRIGGER_EVENTS)[number][];
  readonly prefix?: string;
  readonly suffix?: string;
  readonly acknowledgeRecursionRisk: true;
}>({
  kind: "s3", label: "S3", types: [{ module: "aws-s3", name: "Bucket", mutable: true }, { module: "aws-s3", name: "IBucket" }],
  guide: {
    requirements: ["An owned s3.Bucket.", "EventBridge delivery: enable EventBridge on the bucket's CfnBucket notificationConfiguration. The L2 eventBridgeEnabled option creates native wiring.", "Notification delivery: the bucket has no other notification configuration.", "The function must not write objects that match its own filter."],
    field: "bucket", type: "s3.Bucket", imports: ['import * as s3 from "aws-cdk-lib/aws-s3";'],
    construct: 'new s3.Bucket(this, "Bucket")',
    setup: ["(this.bucket.node.defaultChild as s3.CfnBucket).notificationConfiguration = { eventBridgeConfiguration: { eventBridgeEnabled: true } };"],
    docs: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html",
  },
  contract: "s3", delivery: "S3 Records notification or EventBridge S3 envelope; avoid writes that retrigger this filter", replay: true, asyncInvoke: true, requiresOwned: true,
  // Only the bucket's own CFN configuration is classified. The L2 `eventBridgeEnabled` and
  // `addEventNotification` share CDK's notification custom resource, whose contents are native.
  facts: [{ name: "eventBridge", properties: [], kind: "boolean", fallback: false, assignmentPath: "notificationConfiguration.eventBridgeConfiguration.eventBridgeEnabled" }, { name: "notificationResource", properties: ["eventBridgeEnabled"], kind: "boolean", fallback: false }],
  requiredFacts: [
    { name: "notificationResource", value: false, reason: "EventBridge is enabled through CDK's notification custom resource; manual wiring review required." },
    { name: "eventBridge", value: true, option: "delivery", equals: "eventbridge", reason: "EventBridge delivery is not enabled on the bucket; enable it separately in its owning stack." },
    { name: "eventBridge", value: false, option: "delivery", equals: "notification", reason: "Bucket already uses EventBridge delivery; preserve its notification architecture." },
  ],
  nativeExclusive: { option: "delivery", equals: "notification", reason: "Bucket already has native notifications; preserve its configuration." },
  fields: [
    { name: "delivery", label: "Delivery", kind: "enum", required: true, values: ["eventbridge", "notification"] },
    { name: "eventTypes", label: "S3 event types (JSON array)", kind: "json", array: true, required: true, default: ["s3:ObjectCreated:*"] },
    { name: "prefix", label: "Key prefix", kind: "string" }, { name: "suffix", label: "Key suffix", kind: "string" },
    { name: "acknowledgeRecursionRisk", label: "Reviewed recursive-write risk", kind: "boolean", required: true },
  ],
}, (options) => {
  if (options.acknowledgeRecursionRisk !== true) throw new Error("Review and acknowledge S3 recursive-write risk.");
  if (!Array.isArray(options.eventTypes) || !options.eventTypes.length || new Set(options.eventTypes).size !== options.eventTypes.length || options.eventTypes.some((item) => !S3_TRIGGER_EVENTS.includes(item as typeof S3_TRIGGER_EVENTS[number]))) throw new Error("Choose unique supported S3 event types.");
  if (options.delivery === "eventbridge" && options.eventTypes.some((item) => !["s3:ObjectCreated:*", "s3:ObjectRemoved:*"].includes(String(item)))) throw new Error("S3 EventBridge delivery supports ObjectCreated:* and ObjectRemoved:*; specific API notifications require notification delivery.");
  for (const name of ["prefix", "suffix"] as const) if (typeof options[name] === "string" && (options[name].includes("*") || new TextEncoder().encode(options[name]).length > 1024)) throw new Error(`S3 ${name} must be a literal filter of at most 1024 UTF-8 bytes, without wildcards.`);
});

const RATE = /^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$/;
const CRON = /^cron\((\S+) (\S+) (\S+) (\S+) (\S+) (\S+)\)$/;
const SCHEDULE_TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
defineTriggerAdapter<never, ScheduleOptions>({
  kind: "schedule", label: "Schedule", types: [], resourceless: true,
  guide: {
    requirements: ["No stack resource: the framework creates an EventBridge Scheduler schedule beside the function.", "A rate, such as rate(5 minutes), or a six-field cron expression, evaluated in UTC unless a timezone is set.", "Invocations are asynchronous and retried, so a run may repeat."],
    field: "", type: "", imports: [], construct: "",
    docs: "https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html",
  },
  contract: "schedule", delivery: "Asynchronous scheduled invocation with the configured input, or an empty object; retried on failure", replay: true, asyncInvoke: true,
  fields: [
    { name: "expression", label: "Schedule expression", kind: "string", required: true, default: "rate(1 hour)" },
    { name: "timezone", label: "Timezone", kind: "string", advanced: true },
    { name: "enabled", label: "Enabled", kind: "boolean", advanced: true },
    { name: "input", label: "Input", kind: "json", advanced: true },
  ],
}, (options) => {
  const expression = String(options.expression);
  const rate = RATE.exec(expression), cron = CRON.exec(expression);
  if (rate) {
    const count = Number(rate[1]);
    if (count < 1) throw new Error("A schedule rate must be at least 1.");
    if ((count === 1) === rate[2]!.endsWith("s")) throw new Error(`Use rate(1 ${rate[2]!.replace(/s$/, "")}) or rate(${Math.max(count, 2)} ${rate[2]!.replace(/s?$/, "s")}).`);
  } else if (cron) {
    if (cron[3] !== "?" && cron[5] !== "?") throw new Error("In a schedule cron expression, day-of-month or day-of-week must be ?.");
  } else throw new Error("A schedule expression is rate(N minutes|hours|days) or cron(minutes hours day-of-month month day-of-week year).");
  if (options.timezone !== undefined && (typeof options.timezone !== "string" || !SCHEDULE_TIMEZONE.test(options.timezone))) throw new Error("A schedule timezone is an IANA name, such as Europe/London.");
});
interface ScheduleOptions {
  readonly expression: string;
  readonly timezone?: string;
  readonly enabled?: boolean;
  readonly input?: Readonly<Record<string, JsonArgument>>;
}
/** Invokes the event on a rate or cron schedule; it needs no catalog resource. */
function schedule(options: ScheduleOptions & TriggerOptions): EventTrigger {
  const { id, accepts, ...settings } = options;
  const descriptor: EventTrigger = { $trigger: "@repo/framework/trigger", adapter: "schedule", id, accepts, options: settings as Record<string, JsonArgument> };
  validateTrigger(descriptor);
  return Object.freeze(descriptor);
}

export const trigger = {
  cognito, eventbridge, sqs, dynamodb, sns, s3, schedule,
  adapter(kind: string, resource: CdkResourceSpec, options: TriggerOptions & Readonly<Record<string, unknown>>): EventTrigger {
    const { id, accepts, ...settings } = options;
    const descriptor: EventTrigger = { $trigger: "@repo/framework/trigger", adapter: kind, id, accepts, resource, options: settings as Record<string, JsonArgument> };
    validateTrigger(descriptor);
    return Object.freeze(descriptor);
  },
};

/** Whether a catalog reference is present in the graph being built. */
function availableIn(resources: ResourceDeclarationGroup): (resource: CdkResourceSpec) => boolean {
  const declared = listCdkResourceDeclarations(resources);
  const groups = listCdkResourceGroupDeclarations(resources);
  return (resource) => resource.absent !== true && [...declared, ...groups].some((reference) => reference.absent !== true && (isCdkResource(reference) ? reference.path.join(".") === resource.path.join(".") : isGroupMember(reference, resource.path)));
}

/**
 * Where an event's failed asynchronous invocations go once Lambda stops retrying
 * them: an SQS queue or SNS topic from the catalog. Applies to EventBridge, SNS,
 * S3 and schedule triggers; queue and stream sources keep their own failure path.
 */
export interface EventFailureDestination {
  readonly destination: CdkResource<IQueue> | CdkResource<ITopic>;
  /** Retries after the first failed run, 0 to 2. Lambda's default is 2. */
  readonly retryAttempts?: number;
  /** How long Lambda keeps an event for retries, 60 to 21600 seconds. Lambda's default is 21600. */
  readonly maxEventAgeSeconds?: number;
}

export interface NormalizedFailureDestination {
  readonly event: string;
  readonly destination: CdkResourceSpec;
  readonly retryAttempts?: number;
  readonly maxEventAgeSeconds?: number;
  readonly origin: string;
}

export function validateFailureDestination(value: unknown, origin = "onFailure"): asserts value is EventFailureDestination {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${origin} must be an object.`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!["destination", "retryAttempts", "maxEventAgeSeconds"].includes(key)) throw new Error(`${origin}: unsupported option ${key}.`);
  if (!isCdkResource(object.destination) || !object.destination.path.length) throw new Error(`${origin}: the destination is an SQS queue or SNS topic from the resource catalog.`);
  const whole = (item: unknown, min: number, max: number) => typeof item === "number" && Number.isInteger(item) && item >= min && item <= max;
  if (object.retryAttempts !== undefined && !whole(object.retryAttempts, 0, 2)) throw new Error(`${origin}: retryAttempts is 0, 1 or 2.`);
  if (object.maxEventAgeSeconds !== undefined && !whole(object.maxEventAgeSeconds, 60, 21600)) throw new Error(`${origin}: maxEventAgeSeconds is a whole number from 60 to 21600.`);
}

export function normalizeFailureDestinations(events: Readonly<Record<string, { readonly onFailure?: EventFailureDestination }>>, resources: ResourceDeclarationGroup): readonly NormalizedFailureDestination[] {
  const available = availableIn(resources);
  const result: NormalizedFailureDestination[] = [];
  for (const [event, declaration] of Object.entries(events)) {
    if (declaration.onFailure === undefined) continue;
    const origin = `events["${event}"].onFailure`;
    validateFailureDestination(declaration.onFailure, origin);
    const { destination, retryAttempts, maxEventAgeSeconds } = declaration.onFailure;
    if (!available(destination)) throw new Error(`${origin}: resources.${destination.path.join(".")} is missing in this graph.`);
    result.push({ event, destination: { $cdk: destination.$cdk, path: [...destination.path], optional: destination.optional }, ...(retryAttempts !== undefined ? { retryAttempts } : {}), ...(maxEventAgeSeconds !== undefined ? { maxEventAgeSeconds } : {}), origin });
  }
  return result;
}

export function normalizeTriggers(events: Readonly<Record<string, { readonly triggers?: readonly EventTrigger[]; readonly localReplay?: true }>>, resources: ResourceDeclarationGroup): readonly NormalizedTrigger[] {
  const result: NormalizedTrigger[] = [];
  const slots = new Map<string, string>();
  const attachments = new Set<string>();
  const eventSources = new Set<string>();
  const available = availableIn(resources);
  for (const [event, declaration] of Object.entries(events)) {
    if (declaration.triggers !== undefined && !Array.isArray(declaration.triggers)) throw new Error(`events["${event}"].triggers must be an array.`);
    const ids = new Set<string>();
    for (const [index, descriptor] of (declaration.triggers ?? []).entries()) {
      const metadata = validateTrigger(descriptor);
      const origin = `events["${event}"].triggers[${index}]`;
      if (ids.has(descriptor.id)) throw new Error(`${origin}: duplicate attachment id ${descriptor.id}.`);
      ids.add(descriptor.id);
      // A resourceless trigger is its own source, named by its adapter.
      const where = descriptor.resource ? descriptor.resource.path.join(".") : descriptor.adapter;
      if (descriptor.resource && !available(descriptor.resource)) throw new Error(`${origin}: resources.${where} is missing in this graph.`);
      for (const field of metadata.fields.filter((field) => field.kind === "resource")) {
        const reference = descriptor.options[field.name] as CdkResourceSpec | undefined;
        if (reference && !available(reference)) throw new Error(`${origin}: ${field.name} is missing in this graph.`);
      }
      if (declaration.localReplay && !metadata.replay && !metadata.replayOperations?.includes(String(descriptor.options[metadata.exclusive ?? ""]))) throw new Error(`${origin}: local replay cannot supply this synchronous response.`);
      const key = `${where}/${descriptor.id}`;
      if (attachments.has(key)) throw new Error(`${origin}: duplicate attachment id ${key}.`);
      attachments.add(key);
      const source = `${descriptor.adapter}/${where}/${event}`;
      if (metadata.onePerEvent && eventSources.has(source)) throw new Error(`${origin}: duplicate source binding for event ${event}.`);
      eventSources.add(source);
      const slot = `${where}/${metadata.exclusive ? descriptor.options[metadata.exclusive] : key}`;
      if (slots.has(slot)) throw new Error(`${origin}: duplicate trigger slot ${slot}, already owned by ${slots.get(slot)}.`);
      slots.set(slot, origin);
      result.push({ ...descriptor, event, key, origin });
    }
  }
  // S3 refuses overlapping notification filters on a bucket; overlapping rules for one event
  // would deliver each object twice to the same function.
  const buckets = result.filter((binding) => binding.adapter === "s3");
  for (const [index, left] of buckets.entries()) for (const right of buckets.slice(index + 1)) {
    if (left.resource!.path.join(".") !== right.resource!.path.join(".") || left.options.delivery !== right.options.delivery) continue;
    if (left.options.delivery === "eventbridge" && left.event !== right.event) continue;
    const overlap = (left.options.eventTypes as string[]).some((a) => (right.options.eventTypes as string[]).some((b) => a === b || a.endsWith("*") && b.startsWith(a.slice(0, -1)) || b.endsWith("*") && a.startsWith(b.slice(0, -1))));
    const a = String(left.options.prefix ?? ""), b = String(right.options.prefix ?? ""), x = String(left.options.suffix ?? ""), y = String(right.options.suffix ?? "");
    if (overlap && (a.startsWith(b) || b.startsWith(a)) && (x.endsWith(y) || y.endsWith(x))) throw new Error(left.options.delivery === "notification" ? `${right.origin}: overlapping S3 notifications require disjoint event or key filters.` : `${right.origin}: overlapping S3 rules would invoke ${right.event} twice; use disjoint event or key filters.`);
  }
  return result;
}
