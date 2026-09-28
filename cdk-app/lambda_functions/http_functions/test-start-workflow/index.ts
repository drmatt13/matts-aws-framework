import { randomUUID } from "node:crypto";
import {
  jsonResponse,
  parseJsonBody,
} from "@repo/framework/runtime/http";
import { authenticated } from "@repo/framework/runtime/auth";
import { startWorkflow } from "@repo/framework/runtime/invocation";
/**
 * The request this route accepts and the acknowledgement it returns. Declared
 * here for the same reason the direct starter declares its own: the body is one
 * string, and nothing outside this handler reads these shapes.
 *
 * 202 means the execution was accepted. The graph's terminal status is read
 * afterwards through native Step Functions APIs or the local runner's controls,
 * never by holding this request open.
 */
interface TestStartWorkflowRequest {
  readonly message: string;
}

interface TestStartWorkflowResponse {
  /** Opaque: the Step Functions execution ARN in AWS, a local execution id otherwise. */
  readonly executionId: string;
  /** Stamped by this handler and carried through the graph to the container's log lines. */
  readonly taskId: string;
}

/**
 * `POST /test/start-workflow` — the orchestrated half of the invocation smoke
 * test.
 *
 * It starts a real Standard state machine in AWS and the same authored graph in
 * the local interpreter. It deliberately does *not* call the activity Lambda or
 * the task itself: proving the workflow ran means the workflow has to be what
 * ran. Its only binding is `startsWorkflow`, so it holds no permission to
 * invoke either step directly — the graph derives those for the machine's own
 * role.
 */
export const lambdaHandler = authenticated(async (event, session) => {
  let message: string;
  try {
    const body = parseJsonBody<Partial<TestStartWorkflowRequest>>(
      event.body ?? null,
    );
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

  // Stamped here rather than in the graph so the acknowledgement and the
  // container's log lines carry the same id.
  const taskId = randomUUID();

  try {
    const result = await startWorkflow("invocation-test-workflow", {
      message,
      taskId,
      invokedBy: session.payload.sub,
    });
    const body: TestStartWorkflowResponse = {
      executionId: result.executionId,
      taskId,
    };
    console.log("Started invocation-test-workflow", body);
    return jsonResponse(202, body);
  } catch (error) {
    console.error("startWorkflow(invocation-test-workflow) failed:", error);
    return jsonResponse(502, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
