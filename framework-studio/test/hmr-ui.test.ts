import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { act } from "react";
import ts from "typescript";
import type { SnapshotResponse } from "../shared/api";
import { SnapshotBuilder } from "../server/snapshot";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { installMapShims } from "./support/map-shims";

test("entry replacement retains one React root, query cache and pending inspector draft", async () => {
  const require = createRequire(import.meta.url);
  (require as unknown as { extensions: Record<string, unknown> }).extensions[".css"] = () => {};
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<!doctype html><html><head><meta name="studio-token" content="test"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body><div id="root"></div></body></html>`, { url: "http://localhost/?select=service%3Aexample-service", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "HTMLInputElement"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  // The selection opens in the home page's map panel.
  installMapShims(dom.window);
  const refresh = await import(pathToFileURL(path.join(path.dirname(require.resolve("@vitejs/plugin-react")), "refresh-runtime.js")).href) as {
    injectIntoGlobalHook(target: typeof globalThis): void;
    registerExportsForReactRefresh(id: string, exports: Record<string, unknown>): void;
    validateRefreshBoundaryAndEnqueueUpdate(id: string, before: Record<string, unknown>, after: Record<string, unknown>): string | undefined;
  };
  refresh.injectIntoGlobalHook(globalThis);
  const sources: { listeners: Map<string, (event: { data: string }) => void> }[] = [];
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class {
    readonly listeners = new Map<string, (event: { data: string }) => void>();
    constructor() { sources.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
    removeEventListener(name: string) { this.listeners.delete(name); }
    close() { sources.splice(sources.indexOf(this), 1); }
  } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const builder = new SnapshotBuilder(path.resolve(".."));
  const clients = new Set<import("@tanstack/react-query").QueryClient>();
  let root: import("react-dom/client").Root | undefined;
  let prune: (() => void) | undefined;
  try {
    const response: SnapshotResponse = { snapshot: (await builder.refresh()).snapshot, history: {}, commands: {}, busy: null, evaluating: false };
    const writes: string[] = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: { method?: string }) => {
      const pathname = new URL(input, "http://localhost").pathname;
      if (init?.method && init.method !== "GET") writes.push(pathname);
      return new Response(JSON.stringify(pathname === "/api/snapshot" ? response : { error: `Unexpected request: ${pathname}` }), { status: pathname === "/api/snapshot" ? 200 : 404 });
    } });
    const query = require("@tanstack/react-query") as typeof import("@tanstack/react-query");
    const mount = query.QueryClient.prototype.mount;
    mock.method(query.QueryClient.prototype, "mount", function (this: import("@tanstack/react-query").QueryClient) { clients.add(this); mount.call(this); });
    const reactDOM = require("react-dom/client") as typeof import("react-dom/client");
    const createRoot = reactDOM.createRoot;
    let roots = 0;
    mock.method(reactDOM, "createRoot", (container: Element | Document | DocumentFragment) => { roots++; root = createRoot(container); return root; });
    const ui = await import("@testing-library/react");
    const filename = path.resolve("src/main.tsx");
    // Evaluate the actual entry twice with Vite's persisted data and installed
    // React Refresh runtime. Node only needs its import.meta.hot substituted.
    const compiled = ts.transpileModule(readFileSync(filename, "utf8").replaceAll("import.meta.hot", "__studioHot"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const hot = { data: {} as Record<string, unknown>, dispose(callback: (data: Record<string, unknown>) => void) { dispose = callback; }, prune(callback: () => void) { prune = callback; } };
    let dispose: ((data: Record<string, unknown>) => void) | undefined;
    let previous: Record<string, unknown> | undefined;
    const evaluate = () => {
      const module = { exports: {} as Record<string, unknown> };
      new Function("require", "module", "exports", "__studioHot", compiled)(createRequire(filename), module, module.exports, hot);
      refresh.registerExportsForReactRefresh(filename, module.exports);
      if (previous) assert.equal(refresh.validateRefreshBoundaryAndEnqueueUpdate(filename, previous, module.exports), undefined, "entry exports must remain a valid React Refresh boundary");
      previous = module.exports;
    };
    await ui.act(async () => evaluate());
    await ui.waitFor(() => assert.ok(document.querySelector(".declaration-tags summary")), { timeout: 10000 });
    ui.fireEvent.click(document.querySelector(".declaration-tags summary")!);
    const key = await ui.screen.findByRole("textbox", { name: "Tag 1 key" });
    const value = `${(key as HTMLInputElement).value}-pending`;
    ui.fireEvent.change(key, { target: { value } });
    await ui.screen.findByLabelText("Pending inspector changes");
    const inspector = document.querySelector(".inspector");
    for (let replacement = 0; replacement < 2; replacement++) {
      assert.ok(dispose);
      dispose(hot.data);
      await ui.act(async () => { evaluate(); await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.equal(roots, 1, "entry replacement must reuse the container's React root");
      assert.equal(clients.size, 1, "entry replacement must retain the mounted query cache");
      assert.equal(document.querySelectorAll(".shell").length, 1);
      assert.equal(document.querySelectorAll(".landscape-top").length, 1);
      assert.equal(document.querySelector(".inspector"), inspector, "Fast Refresh must preserve the mounted draft provider");
      assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 key" }) as HTMLInputElement).value, value);
      assert.ok(ui.screen.getByLabelText("Pending inspector changes"));
      assert.equal(sources.length, 1, "entry replacement must leave one active source stream");
    }
    assert.deepEqual(writes, [], "hot replacement never applies or discards source changes");
    await ui.act(async () => prune?.());
    assert.equal(document.getElementById("root")!.childElementCount, 0, "removing the entry must unmount its root");
    assert.equal(sources.length, 0, "removing the entry must release source observers");
    root = undefined;
  } finally {
    await act(async () => root?.unmount());
    for (const client of clients) client.clear();
    mock.restoreAll();
    await builder.dispose();
    dom.window.close();
  }
});
