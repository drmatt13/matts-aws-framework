import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>();
let idToken: string | null = null;

vi.mock("./auth", () => ({
  frameworkHttpApiFetch: (input: unknown, init?: RequestInit) => fetchMock(input, init),
  getCognitoIdToken: () => idToken,
  refreshSession: async () => "expired",
  SessionExpiredError: class SessionExpiredError extends Error {},
}));

const { agentSessionId, readAgentEvents, streamAgent, AgentStreamError } = await import("./agents");

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function token(sub: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ sub, token_use: "id" })}.signature`;
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  idToken = null;
});

describe("agents", () => {
  it("derives the session the agent's adapter derives, so a conversation reaches its own session", async () => {
    const expected = createHash("sha256").update(JSON.stringify(["user-a", "conversation-1"])).digest("hex");
    expect(await agentSessionId("user-a", "conversation-1")).toBe(expected);
  });

  it("reads server-sent events across chunk boundaries, ignoring keepalives", async () => {
    const events = await collect(
      readAgentEvents(body('data: {"type":"st', 'atus"}\n\n: keepalive\n\n', 'data: {"type":"echo"}\n\n')),
    );
    expect(events).toEqual([{ type: "status" }, { type: "echo" }]);
  });

  it("turns an error event into an error the caller can catch", async () => {
    await expect(collect(readAgentEvents(body('event: error\ndata: {"error":"AGENT_EXECUTION_FAILED"}\n\n')))).rejects.toThrow(
      AgentStreamError,
    );
  });

  it("posts the conversation to the agent's route with the session header, and streams what it answers", async () => {
    vi.stubGlobal("window", { location: { origin: "https://app.example.com" } });
    idToken = token("user-a");
    fetchMock.mockResolvedValue(
      new Response(body('data: {"type":"status","text":"hi"}\n\n'), { headers: { "content-type": "text/event-stream" } }),
    );
  const events = await collect(streamAgent("echo-agent", { message: "hello" }, { conversationId: "c-1" }));
    expect(events).toEqual([{ type: "status", text: "hi" }]);

    const [route, init] = fetchMock.mock.calls[0];
    expect(route).toBeInstanceOf(URL);
    expect((route as URL).href).toBe("https://app.example.com/chat/echo");
    expect(JSON.parse(init!.body as string)).toEqual({ conversationId: "c-1", input: { message: "hello" } });
    expect((init!.headers as Record<string, string>)["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"]).toBe(
      await agentSessionId("user-a", "c-1"),
    );
  });
});
