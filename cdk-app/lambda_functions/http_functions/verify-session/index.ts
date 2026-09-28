import { authenticated } from "@repo/framework/runtime/auth";
import { jsonResponse } from "@repo/framework/runtime/http";

/** Answers 200 for a valid session; `authenticated` answers everything else. */
export const lambdaHandler = authenticated(async () =>
  jsonResponse(200, { success: true }),
);
