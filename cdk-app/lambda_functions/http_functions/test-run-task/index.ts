import { randomUUID } from "node:crypto";
import {
  jsonResponse,
  parseJsonBody,
} from "@repo/framework/runtime/http";
import { authenticated } from "@repo/framework/runtime/auth";
import { runTask } from "@repo/framework/runtime/invocation";
/**
 * The request this route accepts and the acknowledgement it returns. Declared
 * here rather than in a `contract.ts`: a one-string body does not earn a
 * projection into `@repo/api-contract`, and no other workspace consumes it.
 *
 * The response is an acknowledgement, not a result. A 202 says the launch was
 * submitted; it says nothing about whether the container started, exited zero,
 * or produced anything -- which is exactly the boundary `runTask` draws.
 */
interface TestRunTaskRequest {
  readonly message: string;
}

interface TestRunTaskResponse {
  /**
   * Opaque. The ECS task ARN in AWS; a local run id under Compose. Never parse
   * it -- the local value deliberately does not pretend to be an ARN.
   */
  readonly runId: string;
  /** Stamped by this handler and logged by the container, so the two can be matched up. */
  readonly taskId: string;
}

/**
 * `POST /test/run-task` — the direct half of the invocation smoke test.
 *
 * It waits for ECS to accept the launch and nothing more. `runTask` resolves on
 * acknowledgement, so this returns 202 while the container is still running:
 * the task's own exit status is read from its logs, never by holding this
 * request open. Work that needs ordered completion belongs in a workflow, whose
 * ECS step awaits the task.
 */
export const lambdaHandler = authenticated(async (event, session) => {
  let message: string;
  try {
    const body = parseJsonBody<Partial<TestRunTaskRequest>>(event.body ?? null);
    if (typeof body.message !== "string" || body.message.length === 0) {
      throw new Error('Body must declare a non-empty "message".');
    }
    message = body.message;
  } catch (error) {
    return jsonResponse(400, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Stamped here rather than in the container so the acknowledgement and the
  // container's log lines carry the same id.
  const taskId = randomUUID();

  try {
    // Awaited on purpose. `runTask` resolves on *acceptance*, not completion, so
    // this returns while the container is still running - the 202 is already the
    // early answer. Dropping the await would return success before the runner
    // had accepted anything, escape this try/catch, and in AWS risk the
    // execution environment being frozen with the submission still in flight.
    const { runId } = await runTask("invocation-test-task", {
      message,
      taskId,
      invokedBy: session.payload.sub,
    });
    return jsonResponse(202, { runId, taskId } satisfies TestRunTaskResponse);
  } catch (error) {
    console.error("runTask(invocation-test-task) failed:", error);
    return jsonResponse(502, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
