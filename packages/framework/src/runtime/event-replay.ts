import type {
  Context,
  DynamoDBStreamEvent,
  EventBridgeEvent,
  PostConfirmationTriggerEvent,
  S3Event,
  SNSEvent,
  SQSEvent,
} from "aws-lambda";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
// Import only the generated replay projection, which is a bare object literal.
// Replay consumers do not need the configuration machinery. Framework types
// stay type-only for the same reason.
import { EVENT_REPLAY_MANIFEST } from "../generated/event-replay";
import type { EventLambdaId } from "../generated/target-ids";
import type { EventReplayManifest, LambdaTarget } from "@repo/framework/config";
// Type-only, so this entry point still loads nothing of the callbacks one. The
// replay bucket carries two kinds of message now, and a reader has to be able
// to tell them apart.
import type { CallbackReplayEnvelope } from "./callbacks";

/**
 * The generated manifest is `as const`, so its keys are a literal union and an
 * arbitrary `replayId` cannot index it. Widened once here rather than at the
 * lookup: an id that is absent means the handler's `localReplay` was removed
 * from framework.config.ts, which disables capture rather than failing to
 * compile.
 */
const REPLAY_TARGETS: EventReplayManifest = EVENT_REPLAY_MANIFEST;

/**
 * Deliveries a replay message gets before SQS moves it to the dead-letter
 * queue. One number for both halves: the replay stack configures the queue
 * with it, and the local dispatcher says "final attempt" when it is reached.
 */
export const REPLAY_MAX_RECEIVE_COUNT = 5;

type CaptureEligibleEvent =
  | PostConfirmationTriggerEvent
  | DynamoDBStreamEvent
  | SQSEvent
  | SNSEvent
  | S3Event
  | EventBridgeEvent<string, unknown>;

/**
 * Constructed on first use and reused afterwards. Replay capture is off in
 * every deployed lane except a dev deployment, so production handlers never
 * construct these clients.
 */
let s3Client: S3Client | undefined;
let sqsClient: SQSClient | undefined;

function s3(): S3Client {
  s3Client ??= new S3Client({});
  return s3Client;
}

function sqs(): SQSClient {
  sqsClient ??= new SQSClient({});
  return sqsClient;
}

/**
 * What the development replay bucket can hold.
 *
 * Two things, for the same reason: both are a message that has to cross from
 * AWS to a developer's machine, and the bucket is the path that exists between
 * them. A captured event replays a handler; a callback completion resumes a
 * suspended step.
 */
export type ReplayMessage = ReplayEnvelope | CallbackReplayEnvelope;

/** Whether a replayed message is a callback completion rather than an event. */
export function isCallbackReplayMessage(
  message: ReplayMessage,
): message is CallbackReplayEnvelope {
  return (message as CallbackReplayEnvelope).kind === "callback";
}

export type ReplayEnvelope = {
  version?: 1;
  id: string;
  capturedAt: string;
  eventType: string;
  sourceHint: string;
  replayId?: string;
  target?: LambdaTarget;
  /** Legacy fields retained while previously captured messages drain. */
  handlerName?: string;
  lambdaName?: string;
  awsRequestId?: string;
  originalEvent: CaptureEligibleEvent;
};

// Reused rather than re-allocated so the production path (capture disabled)
// costs a string comparison and nothing else.
const NOT_CAPTURED: Promise<boolean> = Promise.resolve(false);

function detectEventType(event: CaptureEligibleEvent): string {
  if ("triggerSource" in event) {
    return "PostConfirmationTriggerEvent";
  }

  if (
    "Records" in event &&
    Array.isArray(event.Records) &&
    event.Records.length > 0
  ) {
    // SNS spells the field `EventSource` where the others use `eventSource`,
    // which is why an SNS record used to fall through every branch and capture
    // as an unknown event. A workflow waiting on an SNS worker needs that
    // record to replay like any other.
    const firstRecord = event.Records[0] as
      | { eventSource?: string; EventSource?: string }
      | undefined;
    const source = firstRecord?.eventSource ?? firstRecord?.EventSource ?? "records";

    if (source === "aws:dynamodb") return "DynamoDBStreamEvent";
    if (source === "aws:sqs") return "SQSEvent";
    if (source === "aws:s3") return "S3Event";
    if (source === "aws:sns") return "SNSEvent";
  }

  if ("source" in event && "detail-type" in event) {
    return "EventBridgeEvent";
  }

  return "UnknownEvent";
}

function detectSourceHint(event: CaptureEligibleEvent): string {
  if ("triggerSource" in event) {
    return `cognito:${event.triggerSource}`;
  }

  if (
    "Records" in event &&
    Array.isArray(event.Records) &&
    event.Records.length > 0
  ) {
    const record = event.Records[0] as
      | { eventSource?: string; EventSource?: string }
      | undefined;
    return record?.eventSource ?? record?.EventSource ?? "records";
  }

  if ("source" in event && typeof event.source === "string") {
    return event.source;
  }

  return "unknown";
}

/**
 * Wraps an event handler declared with `localReplay: true`.
 *
 *   export const lambdaHandler = withLocalReplay(async (event, context) => {
 *     ...
 *   });
 *
 * In a development deployment the invocation is captured to the replay bucket
 * and the wrapper answers AWS on the handler's behalf; the local API dev
 * server then replays the captured event through this same handler on your
 * machine. Everywhere else — production, and the local replay itself — the
 * handler simply runs.
 *
 * What a captured invocation answers: a Cognito trigger gets its event back,
 * which is what Cognito requires; every other source gets `undefined`, which
 * SQS, SNS, S3, DynamoDB streams and EventBridge treat as success.
 *
 * No id argument: the framework tells the deployed function which declaration
 * it is. `framework:check` refuses a `localReplay` handler that is not
 * wrapped, and a wrapped handler whose declaration has no `localReplay`.
 */
export function withLocalReplay<
  Event extends CaptureEligibleEvent,
  Result,
>(
  handler: (event: Event, context: Context) => Promise<Result>,
): (event: Event, context: Context) => Promise<Result> {
  return async (event, context) => {
    if (await captureEventDrivenInvocation(event, context)) {
      return ("triggerSource" in event ? event : undefined) as Result;
    }
    return handler(event, context);
  };
}

/**
 * Captures an event-driven invocation for local replay and reports whether it
 * did. Prefer {@link withLocalReplay}, which calls this and returns for you.
 *
 * The replay id defaults to the one the framework assigns the deployed
 * function. Pass it explicitly only when calling this from a handler the
 * framework did not build; it is typed to the event ids this repository
 * declares, so a misspelling fails to compile.
 *
 * Deliberately not `async`: with capture disabled this is a string comparison
 * and an already-resolved promise, so deployed Lambdas pay nothing for the
 * dev-deployment path they never take. An absent target means the replay entry was
 * removed from framework.config.ts and capture is disabled for this
 * handler.
 */
export function captureEventDrivenInvocation(
  event: CaptureEligibleEvent,
  context: Context,
  replayId: EventLambdaId | undefined = process.env.FRAMEWORK_REPLAY_ID as
    | EventLambdaId
    | undefined,
): Promise<boolean> {
  if (!replayId || process.env.USE_LOCAL_DEV_STACK !== "true") {
    return NOT_CAPTURED;
  }
  const target = REPLAY_TARGETS[replayId];
  if (!target) {
    return NOT_CAPTURED;
  }

  const bucketName = process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  // Unused while replays arrive via S3 -> SQS notifications, but the local
  // dispatcher reads the same queue, so a missing URL is still a broken setup.
  const queueUrl = process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;

  if (!bucketName || !queueUrl) {
    const message = `Missing required replay configuration. Set DEV_LAMBDA_REPLAY_BUCKET_NAME and DEV_LAMBDA_REPLAY_QUEUE_URL before invoking ${replayId} with USE_LOCAL_DEV_STACK=true.`;
    console.error(message);
    throw new Error(message);
  }

  return captureToReplayBucket(event, context, replayId, target, bucketName);
}

async function captureToReplayBucket(
  event: CaptureEligibleEvent,
  context: Context,
  replayId: string,
  target: LambdaTarget,
  bucketName: string,
): Promise<boolean> {
  const capturedAt = new Date().toISOString();
  const eventType = detectEventType(event);
  const sourceHint = detectSourceHint(event);

  const key = [
    "replay",
    eventType,
    capturedAt.slice(0, 10),
    `${context.awsRequestId}.json`,
  ].join("/");

  const envelope: ReplayEnvelope = {
    version: 1,
    id: context.awsRequestId,
    capturedAt,
    eventType,
    sourceHint,
    replayId,
    target,
    lambdaName: context.functionName,
    awsRequestId: context.awsRequestId,
    originalEvent: event,
  };

  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(envelope, null, 2),
      ContentType: "application/json",
    }),
  );

  return true;
}

export type ReplayResult = {
  envelope: ReplayMessage;
  receiptHandle: string;
  receiveCount: number;
};

/**
 * Receives the next replay, if any.
 *
 * A message that can never become a replay is deleted here rather than
 * returned: S3's `s3:TestEvent` (sent once when the notification is created),
 * a body that is not an S3 notification, and a notification whose object has
 * since expired. Left alone, each would cycle to the dead-letter queue and
 * bury the captures that actually failed.
 */
export async function pollReplayQueue(
  queueUrl: string,
  bucketName: string,
): Promise<ReplayResult[]> {
  const response = await sqs().send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      // The local dispatcher deliberately invokes one replay at a time. Only
      // receive one so queued messages do not lose visibility while another
      // handler is still running.
      MaxNumberOfMessages: 1,
      // Long polling checks all SQS servers and returns as soon as a replay is
      // available. Short polling can report a false empty response for this
      // deliberately low-volume queue and delay a replay across several polls.
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );

  if (!response.Messages || response.Messages.length === 0) {
    return [];
  }

  const results: ReplayResult[] = [];

  for (const message of response.Messages) {
    if (!message.ReceiptHandle) continue;
    const discard = async (reason: string): Promise<void> => {
      console.warn(`[replay] Discarding a queue message that is not a replay: ${reason}.`);
      await deleteReplayMessage(queueUrl, message.ReceiptHandle!);
    };

    let key: string | undefined;
    try {
      const notification = JSON.parse(message.Body ?? "") as Partial<S3Event>;
      const record = notification.Records?.[0];
      if (record?.s3?.object?.key) {
        key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      }
    } catch {
      // Handled below as "not an S3 notification".
    }
    if (!key) {
      await discard("the body is not an S3 object notification");
      continue;
    }

    let bodyText: string | undefined;
    try {
      const object = await s3().send(
        new GetObjectCommand({ Bucket: bucketName, Key: key }),
      );
      bodyText = await object.Body?.transformToString("utf-8");
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") {
        await discard(`the captured object ${key} no longer exists`);
        continue;
      }
      throw error;
    }
    if (!bodyText) {
      await discard(`the captured object ${key} is empty`);
      continue;
    }

    let envelope: ReplayMessage;
    try {
      envelope = JSON.parse(bodyText) as ReplayMessage;
    } catch {
      await discard(`the captured object ${key} is not JSON`);
      continue;
    }

    results.push({
      envelope,
      receiptHandle: message.ReceiptHandle,
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "1"),
    });
  }

  return results;
}

export async function extendReplayMessageVisibility(
  queueUrl: string,
  receiptHandle: string,
  visibilityTimeoutSeconds: number,
): Promise<void> {
  await sqs().send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: visibilityTimeoutSeconds,
    }),
  );
}

export async function deleteReplayMessage(
  queueUrl: string,
  receiptHandle: string,
): Promise<void> {
  await sqs().send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  );
}
