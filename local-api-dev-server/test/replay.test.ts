import assert from "node:assert/strict";
import test from "node:test";
import invokeAsyncLambdaFunctions, {
  resolveReplayTarget,
} from "../src/invokeAsyncLambdaFunctions";
import type {
  ReplayEnvelope,
  ReplayResult,
} from "@repo/framework/runtime/event-replay";

function envelope(overrides: Partial<ReplayEnvelope> = {}): ReplayEnvelope {
  return {
    id: "replay-1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    eventType: "PostConfirmationTriggerEvent",
    sourceHint: "cognito:PostConfirmation_ConfirmSignUp",
    originalEvent: {} as never,
    ...overrides,
  };
}

test("resolves versioned and legacy replay envelopes", () => {
  assert.equal(
    resolveReplayTarget(
      envelope({
        version: 1,
        replayId: "cognito-post-confirmation-trigger",
        target: "lambda:cognito-post-confirmation-trigger",
      }),
    ),
    "lambda:cognito-post-confirmation-trigger",
  );
  assert.equal(
    resolveReplayTarget(
      envelope({ handlerName: "CognitoPostConfirmationTrigger" }),
    ),
    "lambda:cognito-post-confirmation-trigger",
  );
});

test("logs and deletes only successful replay invocations", async (t) => {
  const priorQueue = process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;
  const priorBucket = process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = "queue";
  process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = "bucket";
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  t.mock.method(console, "error", () => {});
  const deleted: string[] = [];
  const messages: ReplayResult[] = [
    {
      envelope: envelope({ replayId: "cognito-post-confirmation-trigger" }),
      receiptHandle: "success",
      receiveCount: 1,
    },
    {
      envelope: envelope({ replayId: "cognito-post-confirmation-trigger" }),
      receiptHandle: "failure",
      receiveCount: 2,
    },
  ];
  let invocation = 0;

  try {
    await invokeAsyncLambdaFunctions(
      {
        invoke: async () => {
          invocation += 1;
          if (invocation === 2) throw new Error("expected failure");
          return {};
        },
      },
      undefined,
      {
        poll: async () => messages,
        delete: async (_queueUrl, receiptHandle) => {
          deleted.push(receiptHandle);
        },
        extendVisibility: async () => {},
      },
    );
    assert.deepEqual(deleted, ["success"]);
    assert.ok(
      logs.some((message) =>
        message.includes(
          "Invocation succeeded for lambda:cognito-post-confirmation-trigger",
        ),
      ),
    );
  } finally {
    if (priorQueue === undefined) delete process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;
    else process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = priorQueue;
    if (priorBucket === undefined) delete process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
    else process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = priorBucket;
  }
});
