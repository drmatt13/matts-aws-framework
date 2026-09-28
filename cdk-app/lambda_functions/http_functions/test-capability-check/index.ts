import { randomUUID } from "node:crypto";
import { authenticated } from "@repo/framework/runtime/auth";
import { jsonResponse } from "@repo/framework/runtime/http";
import { startWorkflow } from "@repo/framework/runtime/invocation";

/** Starts the development-only capability fixture through its declared binding. */
export const lambdaHandler = authenticated(async () => {
  const { executionId } = await startWorkflow("capability-check", {
    runId: randomUUID(),
    values: [1, 2, 3],
  });
  return jsonResponse(202, { executionId });
});
