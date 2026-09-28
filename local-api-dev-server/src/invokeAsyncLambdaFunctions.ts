import { getEventReplayManifest, type LambdaTarget } from "@repo/framework/config";
import {
  deleteReplayMessage,
  extendReplayMessageVisibility,
  isCallbackReplayMessage,
  pollReplayQueue,
  REPLAY_MAX_RECEIVE_COUNT,
  type ReplayEnvelope,
  type ReplayMessage,
  type ReplayResult,
} from "@repo/framework/runtime/event-replay";
import type { CallbackReplayEnvelope } from "@repo/framework/runtime/callbacks";
import framework from "../../framework.config";

// localReplay uses the Lambda ids themselves; this is the derived lookup view.
const eventReplay = getEventReplayManifest(framework);

type ReplayExecutor = {
  invoke(
    target: LambdaTarget,
    event: unknown,
    context?: { readonly awsRequestId?: string },
  ): Promise<unknown>;
};

function legacyFunctionFragment(target: LambdaTarget): string {
  return target
    .slice("lambda:".length)
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export function resolveReplayTarget(
  envelope: ReplayEnvelope,
): LambdaTarget | undefined {
  if (envelope.replayId && envelope.replayId in eventReplay) {
    return eventReplay[envelope.replayId as keyof typeof eventReplay];
  }

  if (
    envelope.target &&
    Object.values(eventReplay).some((target) => target === envelope.target)
  ) {
    return envelope.target;
  }

  const legacyName = envelope.handlerName ?? envelope.lambdaName;
  if (!legacyName) return undefined;
  return Object.values(eventReplay).find((target) =>
    legacyName.includes(legacyFunctionFragment(target)),
  );
}

/**
 * What a message that failed on its last delivery is told. SQS moves it to the
 * replay dead-letter queue next, where `npm run replay:redrive` returns it
 * once the handler is fixed.
 */
function finalAttemptNotice(receiveCount: number): string {
  return receiveCount >= REPLAY_MAX_RECEIVE_COUNT
    ? " This was the final attempt: the message moves to the replay dead-letter queue. Fix the cause, then run npm run replay:redrive."
    : "";
}

type ErrorLike = { name?: string; message?: string };

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === "object"
    ? (error as ErrorLike)
    : { message: String(error) };
}

function isExpiredAwsLoginSession(error: unknown): boolean {
  const { name, message } = asErrorLike(error);
  const normalizedName = (name ?? "").toLowerCase();
  const normalizedMessage = (message ?? "").toLowerCase();
  return (
    normalizedName.includes("credentialsprovidererror") &&
    (normalizedMessage.includes("session has expired") ||
      normalizedMessage.includes("reauthenticate"))
  );
}

function logReplayPollingError(error: unknown): void {
  if (isExpiredAwsLoginSession(error)) {
    console.error(
      `❌ [replay] AWS session expired. Run 'aws login --profile ${process.env.AWS_PROFILE ?? "<profile>"}' and restart local-api-dev-server.`,
    );
  } else {
    const { name, message } = asErrorLike(error);
    console.error(
      `[replay] Polling error (${name || "Error"}): ${message || String(error)}`,
    );
  }
  if (process.env.DEV_REPLAY_VERBOSE_ERRORS === "true") {
    console.error("[replay][debug] Original polling error:", error);
  }
}

/**
 * Forwards one callback completion to the private runner.
 *
 * A worker running in AWS cannot reach a developer's Compose network, so it
 * writes its completion to the replay bucket and this carries it the rest of
 * the way. The runner answers `gone` or `conflict` for a callback it is not
 * holding — a retried attempt, a duplicate delivery, or a runner that has since
 * restarted. All three are terminal: the message is deleted rather than
 * redelivered forever, because nothing will ever be waiting for it again.
 *
 * Returns whether the message should be deleted.
 */
async function forwardCallbackCompletion(
  envelope: CallbackReplayEnvelope,
  runnerUrl: string | undefined,
): Promise<boolean> {
  if (!runnerUrl) {
    console.error(
      "[replay] A callback completion arrived but LOCAL_INVOCATION_RUNNER_URL is not set; it will be retried.",
    );
    return false;
  }
  const url = `${runnerUrl.replace(/\/+$/, "")}/callbacks/${encodeURIComponent(
    envelope.handle.token,
  )}/${envelope.outcome}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(envelope.result === undefined ? {} : { result: envelope.result }),
        ...(envelope.error === undefined ? {} : { error: envelope.error }),
      }),
    });
    if (response.ok) {
      console.log(`[replay] Forwarded a ${envelope.outcome} callback to the runner.`);
      return true;
    }
    if (response.status === 404 || response.status === 409 || response.status === 410) {
      console.warn(
        `[replay] The runner is not holding this callback (HTTP ${response.status}); dropping the message.`,
      );
      return true;
    }
    console.error(`[replay] The runner refused a callback (HTTP ${response.status}).`);
    return false;
  } catch (error) {
    console.error("[replay] Could not reach the local runner for a callback:", error);
    return false;
  }
}

export default async function invokeAsyncLambdaFunctions(
  executor: ReplayExecutor,
  onFatalError?: () => void,
  dependencies: {
    poll: (queueUrl: string, bucketName: string) => Promise<ReplayResult[]>;
    delete: (queueUrl: string, receiptHandle: string) => Promise<void>;
    extendVisibility: (
      queueUrl: string,
      receiptHandle: string,
      visibilityTimeoutSeconds: number,
    ) => Promise<void>;
  } = {
    poll: pollReplayQueue,
    delete: deleteReplayMessage,
    extendVisibility: extendReplayMessageVisibility,
  },
): Promise<void> {
  const queueUrl = process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;
  const bucketName = process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  if (!queueUrl || !bucketName) return;

  try {
    const results = await dependencies.poll(queueUrl, bucketName);

    for (const { envelope, receiptHandle, receiveCount } of results) {
      if (isCallbackReplayMessage(envelope)) {
        if (
          await forwardCallbackCompletion(
            envelope,
            process.env.LOCAL_INVOCATION_RUNNER_URL,
          )
        ) {
          await dependencies
            .delete(queueUrl, receiptHandle)
            .catch((error: unknown) =>
              console.error("[replay] Deleting a forwarded callback failed:", error),
            );
        }
        continue;
      }

      const target = resolveReplayTarget(envelope);
      if (!target) {
        console.warn(
          `[replay] No manifest target for replayId="${envelope.replayId}" handlerName="${envelope.handlerName}" lambdaName="${envelope.lambdaName}"; message will be retried (attempt ${receiveCount} of ${REPLAY_MAX_RECEIVE_COUNT}).${finalAttemptNotice(receiveCount)}`,
        );
        continue;
      }

      console.log(
        `[replay] Invoking ${target} for ${envelope.eventType} (attempt ${receiveCount} of ${REPLAY_MAX_RECEIVE_COUNT}).`,
      );
      const visibilityHeartbeat = setInterval(() => {
        void dependencies.extendVisibility(queueUrl, receiptHandle, 300).catch(
          (error) => console.error("[replay] Failed to extend visibility:", error),
        );
      }, 60_000);

      const invocationStartedAt = Date.now();
      let invocationDurationMs: number | undefined;
      try {
        // The captured request id, so a replay's log lines can be matched to
        // the invocation in CloudWatch that produced them.
        await executor.invoke(target, envelope.originalEvent, {
          awsRequestId: envelope.awsRequestId ?? envelope.id,
        });
        invocationDurationMs = Date.now() - invocationStartedAt;
      } catch (error) {
        console.error(
          `[replay] Invocation failed for ${target}; message will be retried.${finalAttemptNotice(receiveCount)}`,
          error,
        );
      } finally {
        clearInterval(visibilityHeartbeat);
      }

      if (invocationDurationMs === undefined) continue;

      try {
        await dependencies.delete(queueUrl, receiptHandle);
        console.log(
          `[replay] Invocation succeeded for ${target} in ${invocationDurationMs}ms; replay message deleted.`,
        );
      } catch (error) {
        console.error(
          `[replay] Invocation succeeded for ${target}, but deleting the replay message failed; it may be retried:`,
          error,
        );
      }
    }
  } catch (error) {
    logReplayPollingError(error);
    if (isExpiredAwsLoginSession(error)) onFatalError?.();
  }
}
