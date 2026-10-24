import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h } from "react";
import { webSocketDefaults } from "../server/websockets";

/**
 * The WebSockets page is ws-tester ported into Studio: the same launch handoff, the same
 * Compose defaults and the same connection lifecycle.
 */

// The page reads its launch link when its module loads, as ws-tester does, so the
// address is set before anything imports it.
const LAUNCH = `http://localhost/websockets?${new URLSearchParams({ localWsUrl: "ws://localhost:9081", apiGatewayWsUrl: "https://not-a-socket.example" })}#token=header.payload.signature`;

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let launch: typeof import("../src/websockets/launch");

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}

before(() => {
  const require = createRequire(import.meta.url);
  (require as unknown as { extensions: Record<string, unknown> }).extensions[".css"] = () => {};
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><head><meta name=\"studio-token\" content=\"test\"></head><body></body></html>", { url: LAUNCH, pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  ui = require("@testing-library/react");
  query = require("@tanstack/react-query");
});
after(() => dom.window.close());
afterEach(() => { ui.cleanup(); mock.restoreAll(); FakeSocket.instances = []; });

function render(element: ReturnType<typeof h>) {
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  ui.render(h(query.QueryClientProvider, { client }, element));
}

test("a launch link's token leaves the address bar and fills both panels, with Compose's URL where the link names none", async () => {
  const api = await import("../src/api");
  mock.method(api.api, "webSocketDefaults", async () => ({ local: "ws://localhost:8081?token=", apiGateway: "wss://abc.execute-api.us-east-1.amazonaws.com/prod" }));
  const page = await import("../src/views/websockets/WebSockets");
  launch = await import("../src/websockets/launch");
  assert.equal(window.location.hash, "", "the token is cleared as soon as the page loads");
  assert.match(window.location.search, /localWsUrl=/, "the non-secret URLs stay for a reload");
  render(h(page.WebSockets));
  const local = await ui.screen.findByRole("textbox", { name: "Local connection URL" }) as HTMLInputElement;
  const aws = ui.screen.getByRole("textbox", { name: "AWS connection URL" }) as HTMLInputElement;
  assert.equal(local.value, "ws://localhost:9081/?token=header.payload.signature", "the link's local URL, with the token");
  assert.equal(aws.value, "wss://abc.execute-api.us-east-1.amazonaws.com/prod?token=header.payload.signature", "a non-WebSocket link value falls back to Compose's");
});

test("a page whose defaults cannot be read still offers both panels", async () => {
  const api = await import("../src/api");
  mock.method(api.api, "webSocketDefaults", async () => { throw new Error("Studio is restarting"); });
  const page = await import("../src/views/websockets/WebSockets");
  render(h(page.WebSockets));
  assert.match((await ui.screen.findByRole("alert")).textContent!, /Studio is restarting/);
  assert.ok(ui.screen.getByRole("textbox", { name: "AWS connection URL" }));
});

// ws-tester/src/lib/tokenHandoff.test.ts, unchanged in substance.
test("takes the launch token from the fragment and clears it from the address bar", () => {
  window.history.replaceState(null, "", "/?mode=local#token=header.payload.signature");
  assert.equal(launch.consumeLaunchToken(), "header.payload.signature");
  assert.equal(window.location.pathname + window.location.search + window.location.hash, "/?mode=local");
});

test("prefills each panel from its launch parameter, keeping them after the token is cleared", () => {
  const search = new URLSearchParams({
    [launch.LAUNCH_URL_PARAMS.local]: "ws://localhost:9081",
    [launch.LAUNCH_URL_PARAMS.apiGateway]: "wss://abc.execute-api.us-east-1.amazonaws.com/prod",
  });
  window.history.replaceState(null, "", `/?${search}#token=header.payload.signature`);
  launch.consumeLaunchToken();
  assert.equal(launch.launchConnectionUrl(launch.LAUNCH_URL_PARAMS.local, "ws://localhost:8081?token="), "ws://localhost:9081");
  assert.equal(launch.launchConnectionUrl(launch.LAUNCH_URL_PARAMS.apiGateway, ""), "wss://abc.execute-api.us-east-1.amazonaws.com/prod");
});

test("falls back to the Compose setting when the launch link names no usable URL", () => {
  window.history.replaceState(null, "", `/?${launch.LAUNCH_URL_PARAMS.apiGateway}=https%3A%2F%2Fexample.com`);
  assert.equal(launch.launchConnectionUrl(launch.LAUNCH_URL_PARAMS.local, "ws://localhost:8081?token="), "ws://localhost:8081?token=");
  assert.equal(launch.launchConnectionUrl(launch.LAUNCH_URL_PARAMS.apiGateway, "wss://fallback.example/prod"), "wss://fallback.example/prod");
  assert.equal(launch.launchConnectionUrl(launch.LAUNCH_URL_PARAMS.apiGateway, undefined), "");
  window.history.replaceState(null, "", `/?${launch.LAUNCH_URL_PARAMS.local}=not%20a%20url`);
  assert.equal(launch.launchConnectionUrl(launch.LAUNCH_URL_PARAMS.local, ""), "");
});

test("fills the WebSocket token query without discarding other parameters", () => {
  assert.equal(launch.connectionUrlWithToken("ws://localhost:8081/?mode=local&token=", "header.payload.signature"), "ws://localhost:8081/?mode=local&token=header.payload.signature");
});

test("the defaults are Compose's ws-tester URLs and nothing else from root .env", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-websockets-"));
  try {
    assert.deepEqual(webSocketDefaults(root), { local: "", apiGateway: "" }, "no export yet: both panels start empty");
    writeFileSync(path.join(root, ".env"), ["LOCAL_WS_DEV_SERVER_HOST_PORT=9081", "VITE_API_GATEWAY_WS_URL=wss://abc.execute-api.us-east-1.amazonaws.com/prod", "POSTGRES_PASSWORD=never-returned", ""].join("\n"));
    const defaults = webSocketDefaults(root);
    assert.deepEqual(defaults, { local: "ws://localhost:9081?token=", apiGateway: "wss://abc.execute-api.us-east-1.amazonaws.com/prod" });
    assert.doesNotMatch(JSON.stringify(defaults), /never-returned/);
    writeFileSync(path.join(root, ".env"), "LOCAL_WS_DEV_SERVER_HOST_PORT=not-a-port\nVITE_API_GATEWAY_WS_URL=\n");
    assert.deepEqual(webSocketDefaults(root), { local: "", apiGateway: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a panel connects, prefills the example payload, sends it, logs replies and records how the connection ended", async () => {
  const { WebSocketTester } = await import("../src/views/websockets/WebSocketTester");
  render(h(WebSocketTester, { title: "Local", description: "local-ws-dev-server", initialConnectionURL: "ws://localhost:8081/?token=abc" }));
  const connect = ui.screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  await ui.waitFor(() => assert.equal(connect.disabled, false));
  const payload = ui.screen.getByRole("textbox", { name: "Send payload" }) as HTMLTextAreaElement;
  assert.equal(payload.disabled, true);
  assert.equal(payload.placeholder, "You must establish a websocket connection first...");

  ui.fireEvent.click(connect);
  assert.equal(FakeSocket.instances.length, 1);
  const socket = FakeSocket.instances[0]!;
  assert.equal(socket.url, "ws://localhost:8081/?token=abc");
  assert.equal(connect.disabled, true, "one attempt at a time");
  await ui.act(async () => socket.onopen!());
  assert.ok(ui.screen.getByText("Connected to WebSocket"));
  assert.equal(ui.screen.queryByRole("textbox", { name: "Local connection URL" }), null, "the connected URL is shown, not edited");
  assert.equal(payload.value, `{\n  "action": "customAction",\n  "message": "Hello from the client!"\n}`);
  const send = ui.screen.getByRole("button", { name: "Send payload to Local" }) as HTMLButtonElement;
  assert.equal(send.disabled, false);
  ui.fireEvent.click(send);
  assert.deepEqual(socket.sent, [payload.value]);

  ui.fireEvent.change(payload, { target: { value: "{ not json" } });
  assert.equal(send.disabled, true, "only a JSON payload can be sent");

  await ui.act(async () => socket.onmessage!({ data: JSON.stringify({ greeting: "hello back" }) }));
  // As in ws-tester, a reply arrives folded (`collapsed={0}`) and opens on click.
  const log = ui.screen.getByRole("log", { name: "Messages" });
  await ui.waitFor(() => assert.ok(log.querySelector(".ws-tester-message .node-ellipsis")));
  assert.equal(ui.within(log).queryByText(/hello back/), null);
  ui.fireEvent.click(log.querySelector(".ws-tester-message .node-ellipsis")!);
  await ui.within(log).findByText(/hello back/);

  await ui.act(async () => socket.onclose!());
  assert.ok(ui.screen.getByText("Disconnected from WebSocket"));
  assert.equal((ui.screen.getByRole("textbox", { name: "Send payload" }) as HTMLTextAreaElement).value, "");
  const url = ui.screen.getByRole("textbox", { name: "Local connection URL" });

  // Enter reconnects; a socket that closes before opening is a failed attempt.
  ui.fireEvent.keyDown(url, { key: "Enter" });
  assert.equal(FakeSocket.instances.length, 2);
  await ui.act(async () => FakeSocket.instances[1]!.onclose!());
  assert.ok(ui.screen.getByText("Failed to connect to WebSocket"));

  // Disconnecting closes the socket once and ignores its late events.
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Connect" }));
  const third = FakeSocket.instances[2]!;
  await ui.act(async () => third.onopen!());
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Disconnect" }));
  assert.equal(third.closed, true);
  assert.equal(third.onclose, null);
  await ui.act(async () => third.onmessage!({ data: JSON.stringify({ late: "ignored" }) }));
  assert.equal(ui.screen.queryByText(/ignored/), null);
  assert.equal(ui.screen.getAllByText("Disconnected from WebSocket").length, 2);
});

test("a panel without a usable URL cannot connect", async () => {
  const { WebSocketTester } = await import("../src/views/websockets/WebSocketTester");
  render(h(WebSocketTester, { title: "AWS", description: "API Gateway", initialConnectionURL: "" }));
  const connect = ui.screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  assert.equal(connect.disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "AWS connection URL" }), { target: { value: "not a url" } });
  assert.equal(connect.disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "AWS connection URL" }), { target: { value: "wss://abc.execute-api.us-east-1.amazonaws.com/prod" } });
  await ui.waitFor(() => assert.equal(connect.disabled, false));
});
