/**
 * The wire both lanes speak, shared by the agent adapter, the tool wrappers,
 * the local Gateway emulator and every caller.
 *
 * Nothing here imports Node: the browser client follows the same rules, so
 * they are stated once.
 */

/**
 * The argument a user tool's identity travels in.
 *
 * The agent adapter writes the caller's verified ID token here on every call to
 * an `auth: true` tool, overwriting anything the model put there, and the
 * tool's wrapper verifies it and removes it before the handler runs. It is
 * never in the schema the model is shown, and a contract may not declare it.
 */
export const IDENTITY_ARGUMENT = "__framework_identity";

/** AgentCore Runtime's session header, which routes a request to its microVM. */
export const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

/**
 * Who a backend caller is, for the local runner's edge check — the local
 * stand-in for the IAM grant `invokesAgent` writes in AWS.
 */
export const CALLER_HEADER = "x-framework-caller";

/** The MCP revision the framework speaks to a Gateway, in both lanes. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** A conversation id is the application's; it never reaches AgentCore as written. */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Who owns a session of an agent without users: its callers, collectively. */
export const SERVICE_SESSION_OWNER = "service";

/** What an invocation carries, in both lanes and from every caller. */
export interface AgentInvocationBody<Input = unknown> {
  readonly conversationId: string;
  readonly input: Input;
}

/** A JSON-answering agent's reply. A streaming agent answers with SSE instead. */
export interface AgentInvocationReply<Result = unknown> {
  readonly result: Result;
}
