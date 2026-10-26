import assert from "./support/assert";
import { mock, test } from "node:test";

test("an old server's HTML fallback cannot masquerade as empty successful API data", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ content: "test-session" }) } });
  const { call, ApiError } = await import("../src/api");
  const request = mock.method(globalThis, "fetch", async () => new Response("<!doctype html><title>Studio</title>", { status: 200, headers: { "content-type": "text/html" } }));
  try {
    await assert.rejects(call("/frontend-release/settings"), error => error instanceof ApiError && error.status === 502 && /Restart npm run studio/.test(error.message));
    request.mock.mockImplementation(async () => new Response(JSON.stringify({ error: "Restart the running server" }), { status: 404 }));
    await assert.rejects(call("/frontend-release/settings"), error => error instanceof ApiError && error.status === 404 && error.message === "Restart the running server");
  } finally { request.mock.restore(); }
});
