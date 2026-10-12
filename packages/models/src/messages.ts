import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * Flatten block-style message content back to plain text before replaying it
 * to the model.
 *
 * The Responses API (`useResponsesApi: true` in bedrockMantle.ts) *returns* assistant
 * content as an array of blocks — `[{ type: "text", text: "..." }]` — but only
 * accepts a plain string when that same history is sent back on the next turn,
 * so turn 2 of any thread fails validation without this. Tool call metadata is
 * carried over untouched so the tools loop still works.
 *
 * Setting `useResponsesApi: false` in bedrockMantle.ts makes this helper unnecessary
 * (and streams in far finer token chunks) — delete it if you go that route.
 */
export function toModelMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;

    const content = extractText(message.content);

    switch (message.type) {
      case "ai": {
        const ai = message as AIMessage;
        return new AIMessage({
          content,
          ...(ai.tool_calls ? { tool_calls: ai.tool_calls } : {}),
          ...(ai.id ? { id: ai.id } : {}),
        });
      }
      case "tool": {
        const toolMessage = message as ToolMessage;
        return new ToolMessage({
          content,
          tool_call_id: toolMessage.tool_call_id,
          ...(toolMessage.id ? { id: toolMessage.id } : {}),
        });
      }
      default:
        return new HumanMessage({
          content,
          ...(message.id ? { id: message.id } : {}),
        });
    }
  });
}

/** Normalize a message's `content` (string, or provider content blocks) down to plain text. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
}
