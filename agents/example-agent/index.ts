import { agent } from "@repo/framework/runtime/agentcore";
import { contract } from "./contract";
import { getThread, NoPendingInterruptError, streamAssistant } from "./graph";

/**
 * The LangGraph example, served by AgentCore Runtime.
 *
 * The framework owns the boundary: the user is verified, the session is this
 * user's own, and the request and every event are checked against the
 * contract. This file only translates between that contract and the graph.
 * The caller's conversation id is the graph's thread id.
 */
export const handler = agent("example-agent", contract).stream(async function* (
  input,
  { conversationId, tools, signal },
) {
  if (input.type === "history") {
    yield { type: "history", ...(await getThread(conversationId)) };
    return;
  }

  const resume = input.type === "resume";
  const turn = { threadId: conversationId, context: { tools }, signal };
  try {
    for await (const text of streamAssistant(resume ? input.response : input.message, turn, resume)) {
      yield { type: "delta", text };
    }
  } catch (error) {
    // A client mistake, not a failure: say so in the stream rather than
    // ending it with the adapter's generic error.
    if (error instanceof NoPendingInterruptError) {
      yield { type: "refused", reason: "NO_PENDING_INTERRUPT", message: error.message };
      return;
    }
    throw error;
  }

  // The turn either paused on interrupt() or reached END with a reply.
  const thread = await getThread(conversationId);
  if (thread.interrupt) {
    yield { type: "interrupt", ...thread.interrupt };
    return;
  }
  const reply = thread.messages.filter((message) => message.role === "ai").at(-1);
  yield { type: "message", text: reply?.content ?? "" };
});
