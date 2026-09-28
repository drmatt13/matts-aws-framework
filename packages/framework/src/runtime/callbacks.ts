import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  SendTaskFailureCommand,
  SendTaskHeartbeatCommand,
  SendTaskSuccessCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";

/**
 * How work that finishes somewhere else reports back.
 *
 * A workflow that puts a message on a queue has learned that SQS accepted it,
 * and nothing more. When the graph needs the *answer* — an approval decision, a
 * parsed document — something has to carry it back, and that something is a
 * callback: the step suspends, the worker does the work, and the worker says
 * how it went.
 *
 * ## One vocabulary
 *
 * ```ts
 * import { completeCallback, failCallback, heartbeatCallback, taskCallback }
 *   from "@repo/framework/runtime/callbacks";
 *
 * // A messaging worker receives { payload, callback }.
 * await completeCallback(request.callback, { approved: true });
 *
 * // A container reports its own result.
 * await completeCallback(taskCallback(), result);
 * ```
 *
 * ## Where a completion goes
 *
 * The handle says *which* callback, never *where to send it*. A URL travelling
 * in a message would be a URL a worker had to trust, and a message is not a
 * trustworthy place to learn where your control plane is. Instead the handle
 * carries a delivery *kind*, and this module resolves the destination from the
 * process's own framework-issued environment:
 *
 * - `aws` — the worker runs in AWS and the token is a Step Functions task
 *   token, so it calls `SendTaskSuccess` directly.
 * - `local` — orchestration is a developer's private runner. A process on the
 *   Compose network posts to it. A worker running *in AWS* cannot reach it at
 *   all, so it writes the completion to the development replay bucket, and the
 *   local dispatcher that already drains that bucket forwards it.
 *
 * ## What a callback does not promise
 *
 * Completion is not exactly-once business execution. A queue can deliver a
 * message twice, and both deliveries may try to complete; the first terminal
 * completion wins and the rest are refused. Keeping the *work* idempotent is
 * the application's job, and this says so rather than implying otherwise.
 *
 * Tokens are credentials for resuming an execution. They are not logged here,
 * and should not be logged anywhere else.
 */

export const CALLBACK_HANDLE_VERSION = 1;

/** The environment name a container task's own callback handle arrives under. */
export const TASK_CALLBACK_ENVIRONMENT = "FRAMEWORK_TASK_CALLBACK";

/** How a completion reaches the execution waiting for it. */
export type CallbackDelivery = "aws" | "local";

/**
 * Which callback this is.
 *
 * Versioned because it crosses a queue: a message written by one deployment can
 * be read after the next, and a handle whose shape changed should be refused
 * rather than half-understood.
 */
export interface CallbackHandle {
  readonly version: number;
  readonly delivery: CallbackDelivery;
  /** Opaque. In AWS it is the task token; locally it is the broker's. */
  readonly token: string;
  /** Observability only. Routing never reads these. */
  readonly execution?: string;
  readonly attempt?: number;
}

export class CallbackError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CallbackError";
  }
}

/** Whether a value is a callback handle this runtime understands. */
export function isCallbackHandle(value: unknown): value is CallbackHandle {
  if (typeof value !== "object" || value === null) return false;
  const handle = value as CallbackHandle;
  return (
    handle.version === CALLBACK_HANDLE_VERSION &&
    (handle.delivery === "aws" || handle.delivery === "local") &&
    typeof handle.token === "string" &&
    handle.token.length > 0
  );
}

function requireHandle(handle: unknown, origin: string): CallbackHandle {
  if (!isCallbackHandle(handle)) {
    throw new CallbackError(
      `${origin} needs the callback handle the framework sent with the work. A message carries it as \`callback\`, and a container reads it with taskCallback().`,
    );
  }
  return handle;
}

/**
 * The handle a container task in callback mode was launched with.
 *
 * Reading it is how a container opts into reporting a *business result*.
 * Ordinary `runTask` waits for the process to exit and produces a task summary;
 * stdout is logging and has never been a result channel.
 */
export function taskCallback(
  environment: NodeJS.ProcessEnv = process.env,
): CallbackHandle {
  const raw = environment[TASK_CALLBACK_ENVIRONMENT];
  if (!raw) {
    throw new CallbackError(
      `${TASK_CALLBACK_ENVIRONMENT} is not set, so this task was not started in callback mode. Declare the step as runTask(id, { completion: "callback", timeoutSeconds }).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CallbackError(`${TASK_CALLBACK_ENVIRONMENT} is not valid JSON.`);
  }
  return requireHandle(parsed, "taskCallback()");
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

let sfnClient: SFNClient | undefined;
let s3Client: S3Client | undefined;

function sfn(): SFNClient {
  sfnClient ??= new SFNClient({});
  return sfnClient;
}

function s3(): S3Client {
  s3Client ??= new S3Client({});
  return s3Client;
}

/** A completion travelling through the development replay bucket. */
export interface CallbackReplayEnvelope {
  readonly version: 1;
  readonly kind: "callback";
  readonly outcome: "succeeded" | "failed" | "heartbeat";
  readonly capturedAt: string;
  readonly handle: CallbackHandle;
  readonly result?: unknown;
  readonly error?: { readonly error: string; readonly cause?: string };
}

/** Where the replay bucket puts callback completions, for the dispatcher. */
export const CALLBACK_REPLAY_PREFIX = "callbacks";

type Outcome = CallbackReplayEnvelope["outcome"];

function localRunnerUrl(environment: NodeJS.ProcessEnv): string | undefined {
  const url = environment.LOCAL_INVOCATION_RUNNER_URL;
  return url === undefined || url.length === 0
    ? undefined
    : url.replace(/\/+$/, "");
}

async function deliverLocally(
  handle: CallbackHandle,
  outcome: Outcome,
  body: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const runner = localRunnerUrl(environment);
  if (runner !== undefined) {
    const response = await fetch(
      `${runner}/callbacks/${encodeURIComponent(handle.token)}/${outcome}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new CallbackError(
        `The local runner refused this completion (HTTP ${response.status}). ${detail}`.trim(),
      );
    }
    return;
  }

  // No runner on this network: this worker is in AWS and the execution waiting
  // for it is on a developer's machine. The development replay bucket is the
  // path that already exists between the two, so the completion takes it.
  const bucket = environment.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  if (!bucket) {
    throw new CallbackError(
      "This callback belongs to a local execution, and neither LOCAL_INVOCATION_RUNNER_URL nor DEV_LAMBDA_REPLAY_BUCKET_NAME is set. A worker completes a local callback either from the Compose network or through the development replay bucket.",
    );
  }
  const envelope: CallbackReplayEnvelope = {
    version: 1,
    kind: "callback",
    outcome,
    capturedAt: new Date().toISOString(),
    handle,
    ...(body as { result?: unknown; error?: { error: string; cause?: string } }),
  };
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      // The token is part of the key so two completions of one callback collide
      // on the same object rather than queueing two resumes. The broker refuses
      // the second anyway; this just makes the duplicate cheaper.
      Key: `${CALLBACK_REPLAY_PREFIX}/${outcome}/${encodeURIComponent(handle.token)}.json`,
      Body: JSON.stringify(envelope),
      ContentType: "application/json",
    }),
  );
}

/**
 * Reports that the work succeeded, with its result.
 *
 * The result is the step's output. It travels as JSON, so anything JSON cannot
 * represent fails here rather than arriving as something else.
 */
export async function completeCallback(
  handle: unknown,
  result: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const callback = requireHandle(handle, "completeCallback()");
  const output = JSON.stringify(result ?? null);
  if (output === undefined) {
    throw new CallbackError(
      "completeCallback() was given a result JSON cannot represent.",
    );
  }
  if (callback.delivery === "aws") {
    await sfn().send(
      new SendTaskSuccessCommand({ taskToken: callback.token, output }),
    );
    return;
  }
  await deliverLocally(callback, "succeeded", { result: result ?? null }, environment);
}

export interface CallbackFailure {
  /** The error name a retry or catch clause matches, such as "Rejected". */
  readonly error: string;
  readonly cause?: string;
}

/** Reports that the work failed, under a name the graph can catch. */
export async function failCallback(
  handle: unknown,
  failure: CallbackFailure,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const callback = requireHandle(handle, "failCallback()");
  if (typeof failure?.error !== "string" || failure.error.length === 0) {
    throw new CallbackError(
      'failCallback() needs an error name, such as { error: "Rejected" }.',
    );
  }
  if (callback.delivery === "aws") {
    await sfn().send(
      new SendTaskFailureCommand({
        taskToken: callback.token,
        error: failure.error,
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      }),
    );
    return;
  }
  await deliverLocally(
    callback,
    "failed",
    {
      error: {
        error: failure.error,
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      },
    },
    environment,
  );
}

/**
 * Reports that the work is still going.
 *
 * A heartbeat resets the *heartbeat* timer only. It never extends the step's
 * absolute deadline, which is the whole point of having one: a worker that
 * keeps saying "still here" for an hour does not get an hour when the step was
 * given ten minutes.
 */
export async function heartbeatCallback(
  handle: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const callback = requireHandle(handle, "heartbeatCallback()");
  if (callback.delivery === "aws") {
    await sfn().send(new SendTaskHeartbeatCommand({ taskToken: callback.token }));
    return;
  }
  await deliverLocally(callback, "heartbeat", {}, environment);
}

/**
 * The `{ payload, callback }` shape a messaging worker receives.
 *
 * Declared here so a worker can type its own message body without inventing a
 * matching interface, and without the framework claiming to know what the
 * payload is.
 */
export interface CallbackRequest<Payload> {
  readonly payload: Payload;
  readonly callback: CallbackHandle;
}

/** Reads a message body as a callback request, or says what is wrong with it. */
export function parseCallbackRequest<Payload>(
  body: unknown,
): CallbackRequest<Payload> {
  if (typeof body !== "object" || body === null) {
    throw new CallbackError("A callback request is a JSON object.");
  }
  const request = body as { payload?: unknown; callback?: unknown };
  return {
    payload: request.payload as Payload,
    callback: requireHandle(request.callback, "parseCallbackRequest()"),
  };
}
