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
  /** Syntax facts Studio reads from a field's constructor props; `suffix` tests a string literal's ending. */
  readonly facts?: readonly { readonly name: string; readonly properties: readonly string[]; readonly kind: "presence" | "boolean" | "duration" | "suffix"; readonly suffix?: string; readonly fallback?: boolean | number; readonly assignmentPath?: string }[];
  /** A fact a binding needs; with `option`, only when that option equals `equals` or exceeds `above`. */
  readonly requiredFacts?: readonly { readonly name: string; readonly value: boolean; readonly reason: string; readonly option?: string; readonly equals?: string; readonly above?: number }[];
  /** Any recognized native trigger on the resource occupies it (optionally for one option value). */
  readonly nativeExclusive?: { readonly reason: string; readonly option?: string; readonly equals?: string };
  /** A duration fact that must cover the destination's timeout; the larger multiple is only AWS advice. */
  readonly timeoutFact?: { readonly name: string; readonly label: string; readonly recommendedMultiple: number; readonly plusOption?: string };
}

export interface EventTrigger {
  readonly $trigger: "@repo/framework/trigger";
  readonly adapter: string;
  readonly id: string;
  readonly resource: CdkResourceSpec;
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
  if (!value || value.$trigger !== "@repo/framework/trigger" || !isCdkResource(value.resource) || !value.resource.path.length) throw new Error("A trigger requires a public CDK resource from the catalog.");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id)) throw new Error("A trigger id must be a stable kebab-case name.");
  const adapter = adapters.get(value.adapter);
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
  contract: "eventbridge", delivery: "Asynchronous EventBridge envelope or configured target input, with retries", replay: true,
  fields: [
    { name: "eventPattern", label: "Event pattern", kind: "json", required: true }, { name: "enabled", label: "Enabled", kind: "boolean" },
    { name: "input", label: "Target input", kind: "json" }, { name: "retryAttempts", label: "Retry attempts", kind: "number", min: 0, max: 185 },
    { name: "maxEventAgeSeconds", label: "Maximum event age (seconds)", kind: "number", min: 60, max: 86400 },
    { name: "deadLetterQueue", label: "Dead-letter queue", kind: "resource", resourceType: { module: "aws-sqs", name: "IQueue", owned: true } },
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
  { name: "batchSize", label: "Batch size", kind: "number", min: 1, max: 10000 },
  { name: "batchWindowSeconds", label: "Batch window (seconds)", kind: "number", min: 0, max: 300 },
  { name: "filters", label: "Filter patterns (JSON array)", kind: "json", array: true },
  { name: "reportBatchItemFailures", label: "Partial batch responses", kind: "boolean" },
  { name: "enabled", label: "Enabled", kind: "boolean" },
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
  fields: [...batchFields, { name: "maxConcurrency", label: "Maximum concurrency", kind: "number", min: 2, max: 1000 }],
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
  contract: "dynamodb-stream", delivery: "At-least-once DynamoDB Records batch; handle ordering, duplicates and configured partial failures", replay: false, requiresOwned: true, onePerEvent: true,
  // CDK derives a NEW_AND_OLD_IMAGES stream for replicated tables.
  facts: [{ name: "stream", properties: ["stream", "dynamoStream", "replicas", "replicationRegions"], kind: "presence", fallback: false }],
  requiredFacts: [{ name: "stream", value: true, reason: "No stream enabled; change the table in its owning stack first." }],
  nativeExclusive: { reason: "Stream already has a native Lambda mapping; manual wiring review required." },
  fields: [...batchFields,
    { name: "startingPosition", label: "Starting position", kind: "enum", required: true, values: ["LATEST", "TRIM_HORIZON"] },
    { name: "parallelizationFactor", label: "Parallelization factor", kind: "number", min: 1, max: 10 },
    { name: "retryAttempts", label: "Retry attempts", kind: "number", min: 0, max: 10000 },
    { name: "maxRecordAgeSeconds", label: "Maximum record age (seconds)", kind: "number", min: 60, max: 604800 },
    { name: "bisectBatchOnError", label: "Bisect failed batch", kind: "boolean" },
    { name: "onFailureQueue", label: "Failure queue", kind: "resource", resourceType: { module: "aws-sqs", name: "IQueue", owned: true } },
  ],
}, validateBatch);
const sns = defineTriggerAdapter<ITopic, {
  readonly filterPolicy?: Readonly<Record<string, JsonArgument>>;
  readonly filterScope?: "MessageAttributes" | "MessageBody";
  readonly deadLetterQueue?: CdkResource<IQueue>;
}>({
  kind: "sns", label: "SNS", types: [{ module: "aws-sns", name: "Topic", mutable: true }, { module: "aws-sns", name: "ITopic" }],
  contract: "sns", delivery: "Asynchronous SNS Records envelope with retries; handle duplicate messages", replay: true, onePerEvent: true,
  facts: [{ name: "fifo", properties: ["fifo"], kind: "boolean", fallback: false }],
  requiredFacts: [{ name: "fifo", value: false, reason: "SNS FIFO topics cannot deliver to Lambda; subscribe an SQS FIFO queue instead." }],
  fields: [
    { name: "filterPolicy", label: "Subscription filter", kind: "json" },
    { name: "filterScope", label: "Filter scope", kind: "enum", values: ["MessageAttributes", "MessageBody"] },
    { name: "deadLetterQueue", label: "Dead-letter queue", kind: "resource", resourceType: { module: "aws-sqs", name: "IQueue", owned: true } },
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
  contract: "s3", delivery: "S3 Records notification or EventBridge S3 envelope; avoid writes that retrigger this filter", replay: true, requiresOwned: true,
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
    { name: "eventTypes", label: "S3 event types (JSON array)", kind: "json", array: true, required: true },
    { name: "prefix", label: "Key prefix", kind: "string" }, { name: "suffix", label: "Key suffix", kind: "string" },
    { name: "acknowledgeRecursionRisk", label: "Reviewed recursive-write risk", kind: "boolean", required: true },
  ],
}, (options) => {
  if (options.acknowledgeRecursionRisk !== true) throw new Error("Review and acknowledge S3 recursive-write risk.");
  if (!Array.isArray(options.eventTypes) || !options.eventTypes.length || new Set(options.eventTypes).size !== options.eventTypes.length || options.eventTypes.some((item) => !S3_TRIGGER_EVENTS.includes(item as typeof S3_TRIGGER_EVENTS[number]))) throw new Error("Choose unique supported S3 event types.");
  if (options.delivery === "eventbridge" && options.eventTypes.some((item) => !["s3:ObjectCreated:*", "s3:ObjectRemoved:*"].includes(String(item)))) throw new Error("S3 EventBridge delivery supports ObjectCreated:* and ObjectRemoved:*; specific API notifications require notification delivery.");
  for (const name of ["prefix", "suffix"] as const) if (typeof options[name] === "string" && (options[name].includes("*") || new TextEncoder().encode(options[name]).length > 1024)) throw new Error(`S3 ${name} must be a literal filter of at most 1024 UTF-8 bytes, without wildcards.`);
});

export const trigger = {
  cognito, eventbridge, sqs, dynamodb, sns, s3,
  adapter(kind: string, resource: CdkResourceSpec, options: TriggerOptions & Readonly<Record<string, unknown>>): EventTrigger {
    const { id, accepts, ...settings } = options;
    const descriptor: EventTrigger = { $trigger: "@repo/framework/trigger", adapter: kind, id, accepts, resource, options: settings as Record<string, JsonArgument> };
    validateTrigger(descriptor);
    return Object.freeze(descriptor);
  },
};

export function normalizeTriggers(events: Readonly<Record<string, { readonly triggers?: readonly EventTrigger[]; readonly localReplay?: true }>>, resources: ResourceDeclarationGroup): readonly NormalizedTrigger[] {
  const result: NormalizedTrigger[] = [];
  const slots = new Map<string, string>();
  const attachments = new Set<string>();
  const eventSources = new Set<string>();
  const declared = listCdkResourceDeclarations(resources);
  const groups = listCdkResourceGroupDeclarations(resources);
  const available = (resource: CdkResourceSpec): boolean => resource.absent !== true && [...declared, ...groups].some((reference) => reference.absent !== true && (isCdkResource(reference) ? reference.path.join(".") === resource.path.join(".") : isGroupMember(reference, resource.path)));
  for (const [event, declaration] of Object.entries(events)) {
    if (declaration.triggers !== undefined && !Array.isArray(declaration.triggers)) throw new Error(`events["${event}"].triggers must be an array.`);
    const ids = new Set<string>();
    for (const [index, descriptor] of (declaration.triggers ?? []).entries()) {
      const metadata = validateTrigger(descriptor);
      const origin = `events["${event}"].triggers[${index}]`;
      if (ids.has(descriptor.id)) throw new Error(`${origin}: duplicate attachment id ${descriptor.id}.`);
      ids.add(descriptor.id);
      if (!available(descriptor.resource)) throw new Error(`${origin}: resources.${descriptor.resource.path.join(".")} is missing in this graph.`);
      for (const field of metadata.fields.filter((field) => field.kind === "resource")) {
        const reference = descriptor.options[field.name] as CdkResourceSpec | undefined;
        if (reference && !available(reference)) throw new Error(`${origin}: ${field.name} is missing in this graph.`);
      }
      if (declaration.localReplay && !metadata.replay && !metadata.replayOperations?.includes(String(descriptor.options[metadata.exclusive ?? ""]))) throw new Error(`${origin}: local replay cannot supply this synchronous response.`);
      const key = `${descriptor.resource.path.join(".")}/${descriptor.id}`;
      if (attachments.has(key)) throw new Error(`${origin}: duplicate attachment id ${key}.`);
      attachments.add(key);
      const source = `${descriptor.adapter}/${descriptor.resource.path.join(".")}/${event}`;
      if (metadata.onePerEvent && eventSources.has(source)) throw new Error(`${origin}: duplicate source binding for event ${event}.`);
      eventSources.add(source);
      const slot = `${descriptor.resource.path.join(".")}/${metadata.exclusive ? descriptor.options[metadata.exclusive] : key}`;
      if (slots.has(slot)) throw new Error(`${origin}: duplicate trigger slot ${slot}, already owned by ${slots.get(slot)}.`);
      slots.set(slot, origin);
      result.push({ ...descriptor, event, key, origin });
    }
  }
  // S3 refuses overlapping notification filters on a bucket; overlapping rules for one event
  // would deliver each object twice to the same function.
  const buckets = result.filter((binding) => binding.adapter === "s3");
  for (const [index, left] of buckets.entries()) for (const right of buckets.slice(index + 1)) {
    if (left.resource.path.join(".") !== right.resource.path.join(".") || left.options.delivery !== right.options.delivery) continue;
    if (left.options.delivery === "eventbridge" && left.event !== right.event) continue;
    const overlap = (left.options.eventTypes as string[]).some((a) => (right.options.eventTypes as string[]).some((b) => a === b || a.endsWith("*") && b.startsWith(a.slice(0, -1)) || b.endsWith("*") && a.startsWith(b.slice(0, -1))));
    const a = String(left.options.prefix ?? ""), b = String(right.options.prefix ?? ""), x = String(left.options.suffix ?? ""), y = String(right.options.suffix ?? "");
    if (overlap && (a.startsWith(b) || b.startsWith(a)) && (x.endsWith(y) || y.endsWith(x))) throw new Error(left.options.delivery === "notification" ? `${right.origin}: overlapping S3 notifications require disjoint event or key filters.` : `${right.origin}: overlapping S3 rules would invoke ${right.event} twice; use disjoint event or key filters.`);
  }
  return result;
}
