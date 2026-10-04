import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { z } from "zod";
import { IDENTITY_ARGUMENT, SESSION_HEADER } from "../src/protocol/agentcore";
import {
  agent,
  agentSessionId,
  createAgentServer,
  invokeAgent,
  type AgentServerOptions,
} from "../src/runtime/agentcore";
import { withInvocationEnvironment } from "../src/runtime/context";
import { ADAPTER_ENVIRONMENT, serveAgent } from "../src/runtime/agentcore-serve";
import { startTestCognito, type TestCognito } from "./support/cognito";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function invoke(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${url}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const service = (conversationId: string) => ({ [SESSION_HEADER]: agentSessionId("service", conversationId) });

let cognito: TestCognito;
test.before(async () => {
  cognito = await startTestCognito();
});
test.after(() => cognito.restore());

const summarizer = agent("summarizer", {
  request: z.object({ text: z.string() }),
  response: z.object({ summary: z.string() }),
}).respond(async (input) => ({ summary: input.text.slice(0, 3) }));

async function serve(definition: Parameters<typeof createAgentServer>[0], options: AgentServerOptions) {
  const server = createAgentServer(definition, options);
  const url = await listen(server);
  return { url, close: () => server.close() };
}

test("an agent answers /ping and a JSON invocation through the Runtime HTTP contract", async () => {
  const { url, close } = await serve(summarizer, { auth: false, tools: [] });
  try {
    assert.deepEqual(await (await fetch(`${url}/ping`)).json(), { status: "Healthy" });

    const reply = await invoke(url, { conversationId: "c-1", input: { text: "hello" } }, service("c-1"));
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { result: { summary: "hel" } });

    const invalid = await invoke(url, { conversationId: "c-1", input: { text: 3 } }, service("c-1"));
    assert.equal(invalid.status, 400);
    assert.match(JSON.stringify(await invalid.json()), /text/);

    const misrouted = await invoke(url, { conversationId: "c-1", input: { text: "x" } }, service("c-2"));
    assert.equal(misrouted.status, 403);
  } finally {
    close();
  }
});

test("an agent with users needs the user's token, and a conversation belongs to that user", async () => {
  let seen: string | undefined;
  const support = agent("support-agent", {
    request: z.object({ question: z.string() }),
    response: z.object({ answer: z.string() }),
  }).respond(async (input, context) => {
    seen = context.user?.payload.sub;
    return { answer: `${context.conversationId}:${input.question}` };
  });
  const { url, close } = await serve(support, { auth: true, tools: [] });
  try {
    const body = { conversationId: "c-1", input: { question: "hi" } };
    const owned = { [SESSION_HEADER]: agentSessionId("user-a", "c-1") };

    assert.equal((await invoke(url, body, owned)).status, 401);

    const tokenA = await cognito.idToken("user-a");
    const reply = await invoke(url, body, { ...owned, authorization: `Bearer ${tokenA}` });
    assert.deepEqual(await reply.json(), { result: { answer: "c-1:hi" } });
    assert.equal(seen, "user-a");

    // User B, holding a valid token of their own, aims at user A's session.
    const tokenB = await cognito.idToken("user-b");
    assert.equal((await invoke(url, body, { ...owned, authorization: `Bearer ${tokenB}` })).status, 403);

    // Behind AgentCore's authorizer, the adapter still refuses what is not a live ID token.
    for (const refused of [
      await cognito.expiredIdToken("user-a"),
      await cognito.otherClientIdToken("user-a"),
      await cognito.idToken("user-a", { token_use: "access" }),
      await cognito.forgedIdToken("user-a"),
    ]) {
      assert.equal((await invoke(url, body, { ...owned, authorization: `Bearer ${refused}` })).status, 401);
    }
  } finally {
    close();
  }
});

test("a streaming agent sends each validated event as server-sent events", async () => {
  const narrator = agent("narrator", {
    request: z.object({ count: z.number().int() }),
    event: z.object({ n: z.number().int() }),
  }).stream(async function* (input) {
    for (let n = 1; n <= input.count; n++) yield { n };
    // Not an integer: the adapter must refuse it at the boundary.
    yield { n: 0.5 };
  });
  const { url, close } = await serve(narrator, { auth: false, tools: [], keepaliveMs: 5 });
  try {
    const reply = await invoke(url, { conversationId: "c", input: { count: 2 } }, service("c"));
    assert.match(reply.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await reply.text();
    const data = [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]));
    assert.deepEqual(data.slice(0, 2), [{ n: 1 }, { n: 2 }]);
    assert.match(text, /event: error\ndata: {"error":"AGENT_EVENT_INVALID"}/);
  } finally {
    close();
  }
});

test("tools.call maps ids to wire names and carries the user's token only to user tools", async () => {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const gateway = createServer(async (request, response) => {
    const message = (await readJson(request)) as { id: string; params: { name: string; arguments: Record<string, unknown> } };
    calls.push(message.params);
    const result =
      message.params.name === "broken___broken"
        ? { isError: true, content: [{ type: "text", text: "Invalid arguments. caseNumber: Required" }] }
        : { isError: false, structuredContent: { ok: true }, content: [{ type: "text", text: '{"ok":true}' }] };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const gatewayUrl = await listen(gateway);

  const schema = { type: "object", properties: { caseNumber: { type: "string" } }, required: ["caseNumber"] } as const;
  let specs: unknown;
  const support = agent("support-agent", {
    request: z.object({}),
    response: z.object({ done: z.boolean() }),
  }).respond(async (_input, { tools }) => {
    specs = tools.specs;
    await tools.call("lookup-case", { caseNumber: "1", [IDENTITY_ARGUMENT]: "forged by the model" });
    await tools.call("echo", { caseNumber: "2" });
    await assert.rejects(tools.call("broken", {}), /caseNumber: Required/);
    await assert.rejects(tools.call("undeclared", {}), /not one of this agent's tools/);
    return { done: true };
  });
  const tool = (id: string, auth: boolean) => ({
    id,
    auth,
    wireName: `${id}___${id}`,
    description: `The ${id} tool.`,
    inputSchema: schema,
  });
  const { url, close } = await serve(support, {
    auth: true,
    tools: [tool("lookup-case", true), tool("echo", false), tool("broken", false)],
    gateway: { transport: "local", url: gatewayUrl },
  });
  try {
    const token = await cognito.idToken("user-a");
    const reply = await invoke(
      url,
      { conversationId: "c", input: {} },
      { [SESSION_HEADER]: agentSessionId("user-a", "c"), authorization: `Bearer ${token}` },
    );
    assert.deepEqual(await reply.json(), { result: { done: true } });

    assert.deepEqual(specs, [
      { name: "lookup-case", description: "The lookup-case tool.", inputSchema: schema },
      { name: "echo", description: "The echo tool.", inputSchema: schema },
      { name: "broken", description: "The broken tool.", inputSchema: schema },
    ]);
    assert.deepEqual(calls[0], { name: "lookup-case___lookup-case", arguments: { caseNumber: "1", [IDENTITY_ARGUMENT]: token } });
    assert.deepEqual(calls[1], { name: "echo___echo", arguments: { caseNumber: "2" } });
  } finally {
    close();
    gateway.close();
  }
});

test("serveAgent starts the adapter its environment describes, and refuses another agent's module", async () => {
  const environment = {
    agent: "echo-agent",
    auth: false,
    gateway: { transport: "local", url: "http://127.0.0.1:9" },
  };
  process.env[ADAPTER_ENVIRONMENT] = JSON.stringify(environment);
  try {
    await assert.rejects(serveAgent(summarizer, 0), /serves agent "echo-agent", but its module exports agent\("summarizer"/);
    await assert.rejects(serveAgent({ handler() {} }, 0), /must export `handler = agent\(\.\.\.\)\.stream\(\.\.\.\)` or `\.respond\(\.\.\.\)`/);

    // The generated projection supplies the tools when the environment does not.
    const echo = agent("echo-agent", {
      request: z.object({}),
      response: z.object({ names: z.array(z.string()) }),
    }).respond(async (_input, { tools }) => ({ names: tools.specs.map((spec) => spec.name) }));
    const server = await serveAgent(echo, 0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const reply = await invoke(url, { conversationId: "c", input: {} }, service("c"));
      assert.deepEqual(await reply.json(), { result: { names: ["echo"] } });
    } finally {
      server.close();
    }
  } finally {
    delete process.env[ADAPTER_ENVIRONMENT];
  }
});

/** invokeAgent for an agent the generated projection does not declare. */
const invokeUndeclared = invokeAgent as unknown as (
  id: string,
  input: unknown,
  options: Parameters<typeof invokeAgent>[2],
) => Promise<unknown>;

test("in AWS, an agent with users is called on the Runtime data plane with the caller's token, not with IAM", async () => {
  const arn = "arn:aws:bedrock-agentcore:eu-west-2:111122223333:runtime/support_agent-AbCd";
  const descriptor = JSON.stringify({ version: 1, kind: "agent", transport: "aws", target: "support-agent", auth: true, region: "eu-west-2", arn });
  const token = await cognito.idToken("user-a");
  const session = { idToken: token, payload: { sub: "user-a", token_use: "id" } };
  const seen: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify({ result: { answer: "ok" } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await withInvocationEnvironment({ FRAMEWORK_AGENT_SUPPORT_AGENT: descriptor }, () =>
      invokeUndeclared("support-agent", { question: "hi" }, { conversationId: "c-1", session }),
    );
    assert.deepEqual(result, { answer: "ok" });
    assert.equal(
      seen[0].url,
      `https://bedrock-agentcore.eu-west-2.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`,
    );
    const headers = seen[0].init?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${token}`);
    assert.equal(headers[SESSION_HEADER], agentSessionId("user-a", "c-1"));
  } finally {
    globalThis.fetch = original;
  }
});

test("invokeAgent takes its transport from the descriptor and passes the caller's session to an agent with users", async () => {
  const received: { headers: IncomingMessage["headers"]; url?: string; body: unknown }[] = [];
  const runner = createServer(async (request, response) => {
    received.push({ headers: request.headers, url: request.url, body: await readJson(request) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { answer: "ok" } }));
  });
  const runnerUrl = await listen(runner);
  const descriptor = JSON.stringify({
    version: 1,
    kind: "agent",
    transport: "local",
    target: "support-agent",
    auth: true,
    runnerUrl,
    caller: "lambda:ask",
  });
  const token = await cognito.idToken("user-a");
  const session = { idToken: token, payload: { sub: "user-a", token_use: "id" } };
  try {
    const result = await withInvocationEnvironment({ FRAMEWORK_AGENT_SUPPORT_AGENT: descriptor }, () =>
      invokeUndeclared("support-agent", { question: "hi" }, { conversationId: "c-9", session }),
    );
    assert.deepEqual(result, { answer: "ok" });
    assert.equal(received[0].url, "/agents/support-agent/invocations");
    assert.equal(received[0].headers.authorization, `Bearer ${token}`);
    assert.equal(received[0].headers[SESSION_HEADER], agentSessionId("user-a", "c-9"));
    assert.equal(received[0].headers["x-framework-caller"], "lambda:ask");
    assert.deepEqual(received[0].body, { conversationId: "c-9", input: { question: "hi" } });

    await assert.rejects(
      withInvocationEnvironment({ FRAMEWORK_AGENT_SUPPORT_AGENT: descriptor }, () =>
        invokeUndeclared("support-agent", {}, { conversationId: "c-9" }),
      ),
      /support-agent has auth: true, so invokeAgent needs the caller's session/,
    );
    await assert.rejects(
      withInvocationEnvironment({}, () => invokeUndeclared("support-agent", {}, { conversationId: "c" })),
      /Declare invokesAgent\("support-agent"\)/,
    );
  } finally {
    runner.close();
  }
});
