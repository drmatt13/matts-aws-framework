import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import { once } from "node:events";
import test from "node:test";
import type { Request, Response } from "express";
import proxyToContainer from "../lib/proxyToContainer";

type UpstreamCall = { method: string; url: string; body: string };

/**
 * A stand-in container. The deployed side asserts the equivalent behaviour
 * through the synthesized `overwrite:path` parameter mappings in
 * cdk-app/test/framework-routing.test.ts; this covers the local half, which
 * cannot be reached through the dev server because /example-service is auth: true.
 */
async function withUpstream(
  run: (baseUrl: string, calls: UpstreamCall[]) => Promise<void>,
): Promise<void> {
  const calls: UpstreamCall[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      calls.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ seen: request.url }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected a TCP address for the upstream stub.");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function mockRequest(
  originalUrl: string,
  options: { method?: string; rawBody?: Buffer; baseUrl?: string } = {},
): Request {
  const [pathname] = originalUrl.split("?");
  const request = {
    method: options.method ?? "GET",
    originalUrl,
    baseUrl: options.baseUrl,
    path: pathname,
    headers: { "content-type": "application/json" },
    rawBody: options.rawBody,
    on: () => request,
    pipe: () => request,
    readableEnded: true,
  };
  return request as unknown as Request;
}

/**
 * proxyToContainer pipes the upstream response into `res` and resolves on the
 * real "finish" event, so the double must be an actual Writable, not a stub.
 */
function mockResponse(): {
  response: Response;
  finished: Promise<{ status: number; body: string }>;
} {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  const response = writable as unknown as Response & { statusCode: number };
  response.statusCode = 0;
  response.status = ((code: number) => {
    response.statusCode = code;
    return response;
  }) as Response["status"];
  response.setHeader = (() => response) as unknown as Response["setHeader"];
  response.headersSent = false;
  // writableFinished is a real getter on Writable, which is what
  // proxyToContainer's res.on("close") guard reads.

  const finished = once(writable, "finish").then(() => ({
    status: response.statusCode,
    body: Buffer.concat(chunks).toString("utf8"),
  }));

  return { response: response as unknown as Response, finished };
}

test("strips the public mount prefix before reaching the service", async () => {
  await withUpstream(async (baseUrl, calls) => {
    // /langgraph/chat must arrive as /chat
    const nested = mockResponse();
    await proxyToContainer(
      mockRequest("/langgraph/chat"),
      nested.response,
      baseUrl,
      "/langgraph",
    );
    await nested.finished;

    // The bare mount must arrive as /
    const root = mockResponse();
    await proxyToContainer(
      mockRequest("/langgraph"),
      root.response,
      baseUrl,
      "/langgraph",
    );
    await root.finished;

    assert.deepEqual(
      calls.map((call) => call.url),
      ["/chat", "/"],
    );
  });
});

test("strips both /api and the service mount, including a root service mount", async () => {
  await withUpstream(async (baseUrl, calls) => {
    for (const [url, base, mount] of [
      ["/api/langgraph/chat?limit=5", "/api/langgraph", "/langgraph"],
      ["/api/langgraph", "/api/langgraph", "/langgraph"],
      ["/api/chat?limit=5", "/api", "/"],
    ]) {
      const response = mockResponse();
      await proxyToContainer(mockRequest(url, { baseUrl: base }), response.response, baseUrl, mount);
      await response.finished;
    }
    assert.deepEqual(calls.map((call) => call.url), ["/chat?limit=5", "/", "/chat?limit=5"]);
  });
});

test("preserves query strings, method, and body across the proxy", async () => {
  await withUpstream(async (baseUrl, calls) => {
    const { response, finished } = mockResponse();
    await proxyToContainer(
      mockRequest("/langgraph/chat/history/t-1?limit=5&order=desc", {
        method: "POST",
        rawBody: Buffer.from('{"message":"hi"}'),
      }),
      response,
      baseUrl,
      "/langgraph",
    );
    await finished;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/chat/history/t-1?limit=5&order=desc");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, '{"message":"hi"}');
  });
});
