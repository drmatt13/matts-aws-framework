import assert from "./support/assert";
import { mock, test } from "node:test";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

test("an old server's HTML fallback cannot masquerade as empty successful API data", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ content: "test-session" }) } });
  const { call, ApiError } = await import("../src/http");
  const request = mock.method(globalThis, "fetch", async () => new Response("<!doctype html><title>Studio</title>", { status: 200, headers: { "content-type": "text/html" } }));
  try {
    await assert.rejects(call("/frontend-release/settings"), error => error instanceof ApiError && error.status === 502 && /Restart npm run studio/.test(error.message));
    request.mock.mockImplementation(async () => new Response(JSON.stringify({ error: "Restart the running server" }), { status: 404 }));
    await assert.rejects(call("/frontend-release/settings"), error => error instanceof ApiError && error.status === 404 && error.message === "Restart the running server");
  } finally { request.mock.restore(); }
});

test("HTTP transport preserves mutation headers, body, no-store and cancellation", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    querySelector: (selector: string) => ({ content: selector.includes("studio-protocol") ? STUDIO_PROTOCOL_VERSION : "test-session" }),
  } });
  const { call } = await import("../src/http");
  const controller = new AbortController();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const request = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ accepted: true }));
  });
  try {
    assert.deepEqual(await call("/fixture/plan", { value: "fixture" }, controller.signal), { accepted: true });
    assert.deepEqual(requests, [{ url: "/api/fixture/plan", init: {
      method: "POST", cache: "no-store", signal: controller.signal,
      headers: { "x-studio-token": "test-session", "x-studio-protocol": STUDIO_PROTOCOL_VERSION, "content-type": "application/json" },
      body: JSON.stringify({ value: "fixture" }),
    } }]);
  } finally { request.mock.restore(); }
});

test("a stale page protocol refuses a mutation before making a request", async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ content: "stale-protocol" }) } });
  const { call, ApiError } = await import("../src/http");
  const request = mock.method(globalThis, "fetch", async () => new Response("{}"));
  try {
    await assert.rejects(call("/fixture/apply", {}), error => error instanceof ApiError && error.status === 409);
    assert.equal(request.mock.callCount(), 0);
  } finally { request.mock.restore(); }
});
