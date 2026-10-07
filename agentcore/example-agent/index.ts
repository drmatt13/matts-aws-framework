import { agent } from "@repo/framework/runtime/agentcore";
import { contract } from "./contract";

/**
 * Deterministic proof of the plumbing — no model, no credentials, no paid
 * inference. A real agent hands `tools.specs` to its model and dispatches the
 * model's choices through `tools.call`; this one makes the call itself.
 */
export const handler = agent("echo-agent", contract).stream(async function* (input, { tools }) {
  yield { type: "status", text: "Calling the echo tool as you." };
  const echoed = await tools.call("echo", { message: input.message });
  yield { type: "echo", ...echoed };
});
