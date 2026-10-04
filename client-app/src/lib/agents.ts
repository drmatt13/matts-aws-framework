import { AGENT_ROUTE, type AgentEndpoints } from "@repo/api-contract";
import { FrameworkHttpApiFetch, getCognitoIdToken, refreshSession, SessionExpiredError } from "./auth";

/**
 * Talking to an agent with users from the browser.
 *
 *   for await (const event of streamAgent("echo-agent", { message }, { conversationId })) {
 *     render(event);
 *   }
 *
 * The declared same-origin path with the signed-in user's token, through the same
 * fetch as every authenticated route — refresh and retry included. Locally the
 * dev server streams the agent from its session process; deployed, CloudFront
 * streams it from AgentCore Runtime. The request and its events are typed by
 * the agent's own contract.
 *
 * `conversationId` is yours: a random id per conversation (crypto.randomUUID())
 * is enough. The session it lands in is derived from it and the user, so one
 * user can never resume another's.
 */

type AgentId = keyof AgentEndpoints;
type RequestOf<Id extends AgentId> = AgentEndpoints[Id]["request"]["_input"];
type EventOf<Id extends AgentId> = AgentEndpoints[Id] extends { readonly event: { readonly _output: infer Event } }
  ? Event
  : AgentEndpoints[Id] extends { readonly response: { readonly _output: infer Response } }
    ? Response
    : never;

export interface StreamAgentOptions {
  readonly conversationId: string;
  readonly signal?: AbortSignal;
}

/** The agent failed, refused the request, or ended its stream with an error. */
export class AgentStreamError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AgentStreamError";
  }
}

/** The Runtime session a conversation routes to: sha256 of [sub, conversationId], as the agent derives it. */
export async function agentSessionId(sub: string, conversationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([sub, conversationId])));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed-in user's subject, read from the token the fetch below will send. */
async function currentSubject(): Promise<string> {
  let token = getCognitoIdToken();
  if (!token) {
    await refreshSession();
    token = getCognitoIdToken();
  }
  if (!token) throw new SessionExpiredError();
  const payload = token.split(".")[1] ?? "";
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
  if (typeof claims.sub !== "string") throw new SessionExpiredError();
  return claims.sub;
}

/**
 * Server-sent events as values. Comments (`: keepalive`) are skipped; an
 * `error` event ends the stream by throwing.
 */
export async function* readAgentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf("\n\n");
        const lines = block.split("\n");
        const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (!data) continue;
        if (lines.includes("event: error")) {
          const { error } = JSON.parse(data) as { error?: string };
          throw new AgentStreamError(error ?? "AGENT_EXECUTION_FAILED");
        }
        yield JSON.parse(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Invokes an agent with users and yields what it streams. An agent that
 * answers with JSON instead yields its one result.
 */
export async function* streamAgent<Id extends AgentId>(
  id: Id,
  input: RequestOf<Id>,
  options: StreamAgentOptions,
): AsyncGenerator<EventOf<Id>> {
  const sessionId = await agentSessionId(await currentSubject(), options.conversationId);
  // A URL bypasses the HTTP API helper's /api prefix while retaining its
  // origin check, bearer authentication, refresh and one retry after 401.
  const response = await FrameworkHttpApiFetch(new URL(AGENT_ROUTE[id], window.location.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
    },
    body: JSON.stringify({ conversationId: options.conversationId, input }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new AgentStreamError(`${String(id)} answered HTTP ${response.status}.`, response.status);
  }
  if (response.headers.get("content-type")?.includes("application/json")) {
    const { result } = (await response.json()) as { result: EventOf<Id> };
    yield result;
    return;
  }
  for await (const event of readAgentEvents(response.body)) yield event as EventOf<Id>;
}
