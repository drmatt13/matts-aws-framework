import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { applyApiGatewayRouting, registerAgentRoute } from "../lib/routeProxyHelpers";
import { startTestCognito } from "../../packages/framework/test/support/cognito";

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

async function listen(server: ReturnType<typeof createServer> | ReturnType<express.Express["listen"]>) {
  if (!server.listening) await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("the browser's agent route verifies the user, then streams the agent through the runner", async () => {
  const cognito = await startTestCognito();
  const seen: { url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const runner = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"status"}\n\n');
      response.end('data: {"type":"done"}\n\n');
    });
  }).listen(0, "127.0.0.1");
  const runnerUrl = await listen(runner);

  const app = express();
  applyApiGatewayRouting(app);
  registerAgentRoute(app, "echo-agent", "/chat/echo", runnerUrl);
  registerAgentRoute(app, "echo-agent", "/api/chat/alias", runnerUrl);
  registerAgentRoute(app, "echo-agent", "/chat/v1.0+(test)", runnerUrl);
  const httpApp = express();
  applyApiGatewayRouting(httpApp);
  httpApp.post("/chat/echo", (_req, res) => res.json({ lane: "http" }));
  app.use("/api", httpApp);
  const apiServer = app.listen(0, "127.0.0.1");
  const api = await listen(apiServer);

  try {
    const body = JSON.stringify({ conversationId: "c", input: { message: "hi" } });
    const anonymous = await fetch(`${api}/chat/echo`, { method: "POST", body });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { message: "Unauthorized" });
    assert.equal(seen.length, 0, "an unauthenticated request never reaches the agent");
    const literal = await fetch(`${api}/chat/v1.0+(test)`, { method: "POST", body });
    assert.equal(literal.status, 401, "supported punctuation is matched literally");
    const lookalike = await fetch(`${api}/chat/v1X0+(test)`, { method: "POST", body });
    assert.equal(lookalike.status, 404);

    const token = await cognito.idToken("user-a");
    const reply = await fetch(`${api}/chat/echo`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [SESSION_HEADER]: "s".repeat(64) },
      body,
    });
    assert.equal(reply.headers.get("content-type"), "text/event-stream");
    assert.equal(await reply.text(), 'data: {"type":"status"}\n\ndata: {"type":"done"}\n\n');
    assert.equal(seen[0].url, "/agents/echo-agent/invocations");
    assert.equal(seen[0].headers.authorization, `Bearer ${token}`);
    assert.equal(seen[0].headers[SESSION_HEADER], "s".repeat(64));
    assert.equal(seen[0].body, body);
    const http = await fetch(`${api}/api/chat/echo`, { method: "POST" });
    assert.deepEqual(await http.json(), { lane: "http" });
    assert.equal(seen.length, 1, "the distinct HTTP browser path never invokes the agent");
    const alias = await fetch(`${api}/api/chat/alias`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body,
    });
    assert.equal(alias.status, 200, "an explicitly chosen /api agent path is mounted before the HTTP app");
    await alias.text();
    assert.equal(seen.length, 2);
    const wrongMethod = await fetch(`${api}/chat/echo`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(seen.length, 2, "unsupported methods do not invoke an agent");
    for (const wrongPath of ["/chat/echo/", "/Chat/echo", "/chat/echo/extra"]) {
      const missing = await fetch(`${api}${wrongPath}`, { method: "POST", body });
      assert.equal(missing.status, 404);
    }
  } finally {
    cognito.restore();
    runner.close();
    apiServer.close();
  }
});
