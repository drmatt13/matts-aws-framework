import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { mock, test } from "node:test";
import { act } from "react";
import type { SnapshotResponse } from "../shared/api";
import { SnapshotBuilder } from "../server/snapshot";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

test("background snapshot errors and retry preserve the mounted editor and its pending draft", async () => {
  const require = createRequire(import.meta.url);
  (require as unknown as { extensions: Record<string, unknown> }).extensions[".css"] = () => {};
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<!doctype html><html><head><meta name="studio-token" content="test"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body><div id="root"></div></body></html>`, { url: "http://localhost/?select=service%3Aexample-service", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "HTMLInputElement"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  const sources: { listeners: Map<string, (event: { data: string }) => void> }[] = [];
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class {
    readonly listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
    close() { sources.splice(sources.indexOf(this), 1); }
  } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const builder = new SnapshotBuilder(path.resolve(".."));
  let unmount: (() => void) | undefined;
  let queryClient: import("@tanstack/react-query").QueryClient | undefined;
  try {
    const response: SnapshotResponse = { snapshot: (await builder.refresh()).snapshot, history: {}, commands: {}, busy: null, evaluating: false };
    let failed = false;
    let snapshotReads = 0;
    const writes: string[] = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: { method?: string }) => {
      const pathname = new URL(input, "http://localhost").pathname;
      if (init?.method && init.method !== "GET") writes.push(pathname);
      if (pathname === "/api/snapshot") {
        snapshotReads++;
        return new Response(JSON.stringify(failed ? { error: "Connection interrupted" } : response), { status: failed ? 500 : 200 });
      }
      return new Response(JSON.stringify({ error: `Unexpected request: ${pathname}` }), { status: 404 });
    } });
    const ui = await import("@testing-library/react");
    const query = require("@tanstack/react-query") as typeof import("@tanstack/react-query");
    const mount = query.QueryClient.prototype.mount;
    mock.method(query.QueryClient.prototype, "mount", function (this: import("@tanstack/react-query").QueryClient) { queryClient = this; mount.call(this); });
    const reactDOM = require("react-dom/client") as typeof import("react-dom/client");
    const createRoot = reactDOM.createRoot;
    mock.method(reactDOM, "createRoot", (container: Element | Document | DocumentFragment) => {
      const root = createRoot(container);
      unmount = () => root.unmount();
      return root;
    });
    await ui.act(async () => { await import("../src/main"); });
    const key = await ui.screen.findByRole("textbox", { name: "Tag 1 key" }, { timeout: 10000 });
    const original = (key as HTMLInputElement).value;
    ui.fireEvent.change(key, { target: { value: `${original}-pending` } });
    await ui.screen.findByLabelText("Pending inspector changes");
    const editor = document.querySelector(".inspector");
    const initialReads = snapshotReads;
    failed = true;
    ui.act(() => sources.at(-1)?.listeners.get("snapshot")?.({ data: JSON.stringify({ external: [] }) }));
    await ui.screen.findByText(/Studio couldn’t refresh the configuration/, {}, { timeout: 5000 });
    assert.ok(snapshotReads > initialReads);
    assert.ok(document.querySelector(".inspector") === editor, "the editor remains mounted");
    assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 key" }) as HTMLInputElement).value, `${original}-pending`);
    assert.ok(ui.screen.getByLabelText("Pending inspector changes"));
    failed = false;
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Try again" }));
    await ui.waitFor(() => assert.ok(!document.querySelector(".shell-notice")));
    assert.ok(document.querySelector(".inspector") === editor, "retry preserves the existing editor");
    assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 key" }) as HTMLInputElement).value, `${original}-pending`);
    assert.ok(ui.screen.getByLabelText("Pending inspector changes"));
    assert.deepEqual(writes, [], "connection recovery never applies a draft");
    assert.ok(unmount && queryClient, "the entry point's root and query cache are captured for cleanup");
  } finally {
    await act(async () => unmount?.());
    queryClient?.clear();
    mock.restoreAll();
    await builder.dispose();
    dom.window.close();
  }
});
