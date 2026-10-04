import { authenticatedTool } from "@repo/framework/runtime/tools";
import { contract } from "./contract";

/** Gateway invokes this with the model's arguments; the wrapper checks them and the user. */
export const lambdaHandler = authenticatedTool(contract, async (input, session) => ({
  message: input.message,
  length: input.message.length,
  sub: session.payload.sub,
}));
