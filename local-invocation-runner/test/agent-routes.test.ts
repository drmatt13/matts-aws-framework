import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { defineFrameworkConfig, invokesAgent } from "@repo/framework/config";
import { defaults } from "../../framework-config/defaults";
import { registerAgentRoutes, type AgentInvoker } from "../src/agent-routes";

const cognito = { USER_POOL_ID: "pool", USER_POOL_CLIENT_ID: "client" };
const config = defineFrameworkConfig({
  defaults,
  http: [
    {
      "/ask": {
        directory: "/lambda_functions/http_functions/ask",
        methods: ["POST"],
        auth: true,
        deploy: "local-only",
        cloud: { bindings: [invokesAgent("support-agent")] },
      },
    },
  ],
  webSocket: [],
  events: [],
  services: [],
  tools: [{ echo: { deploy: "local-only" } }],
  agents: [
    {
      "support-agent": { auth: true, tools: ["echo"], deploy: "local-only", environment: cognito },
      summarizer: { deploy: "local-only" },
    },
  ],
});

async function start(invoker: AgentInvoker) {
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, {
    config,
    agents: invoker,
    tools: { invoke: async (_target, event) => ({ echoed: event }) },
    loadTools: async () => ({
      echo: { description: "Echo.", auth: false, inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the browser reaches only agents with users; a backend caller needs its declared edge", async () => {
  const forwarded: { id: string; headers: Readonly<Record<string, string>>; body: string }[] = [];
  const { url, close } = await start({
    invoke: async (id, request, consume) => {
      forwarded.push({ id, headers: request.headers, body: request.body });
      await consume(new Response("data: {\"n\":1}\n\n", { headers: { "content-type": "text/event-stream" } }));
    },
  });
  try {
    const body = { conversationId: "c", input: { message: "hi" } };
    const streamed = await post(`${url}/agents/support-agent/invocations`, body, {
      authorization: "Bearer token",
      "x-amzn-bedrock-agentcore-runtime-session-id": "s".repeat(64),
    });
    assert.equal(streamed.headers.get("content-type"), "text/event-stream");
    assert.equal(await streamed.text(), 'data: {"n":1}\n\n');
    assert.equal(forwarded[0].headers.authorization, "Bearer token");
    assert.deepEqual(JSON.parse(forwarded[0].body), body);

    assert.equal((await post(`${url}/agents/summarizer/invocations`, body)).status, 403);
    assert.equal(
      (await post(`${url}/agents/summarizer/invocations`, body, { "x-framework-caller": "lambda:ask" })).status,
      403,
      "lambda:ask declared no edge to summarizer",
    );
    assert.equal(
      (await post(`${url}/agents/support-agent/invocations`, body, { "x-framework-caller": "lambda:ask" })).status,
      200,
    );
  } finally {
    close();
  }
});

test("each agent's emulated Gateway answers MCP on the runner", async () => {
  const { url, close } = await start({ invoke: async () => {} });
  try {
    const listed = (await (await post(`${url}/agents/support-agent/gateway`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: { tools: { name: string }[] };
    };
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["echo___echo"]);

    const called = (await (
      await post(`${url}/agents/support-agent/gateway`, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo___echo", arguments: { a: 1 } },
      })
    ).json()) as { result: { structuredContent: unknown } };
    assert.deepEqual(called.result.structuredContent, { echoed: { a: 1 } });

    assert.equal((await post(`${url}/agents/support-agent/gateway`, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  } finally {
    close();
  }
});
