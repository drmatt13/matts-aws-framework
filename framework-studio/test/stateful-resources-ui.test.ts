import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h } from "react";
import type { SnapshotResponse } from "../shared/api";
import type { ModeModel, Snapshot } from "../shared/model";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react"), query: typeof import("@tanstack/react-query"), router: typeof import("@tanstack/react-router"), studio: typeof import("../src/studio"), view: typeof import("../src/views/DataRetention");
const clients: import("@tanstack/react-query").QueryClient[] = [];
let posted: { url: string; body: any }[];
const model = (mode: "dev" | "prod"): ModeModel => ({ mode, status: "ok", targets: [], routes: [], resources: [], edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 });
const snapshot = { revision: "r1", repositoryRoot: "/fixture", generatedAt: "2026-10-23T12:00:00Z", descriptions: { values: {} }, databaseProblems: [], models: { dev: model("dev"), prod: model("prod") }, files: {}, source: { cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, entities: {}, editability: {}, links: {}, catalog: {}, problems: [] } } as unknown as Snapshot;
const response: SnapshotResponse = { snapshot, evaluating: false, commands: {}, history: {}, busy: null };
before(async () => {
  require.extensions[".css"] = () => {};
  dom = new (require("jsdom").JSDOM)(`<!doctype html><html><head><meta name="studio-token" content="t"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); query = require("@tanstack/react-query"); router = require("@tanstack/react-router"); studio = await import("../src/studio"); view = await import("../src/views/DataRetention");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
});
afterEach(() => { ui.cleanup(); clients.splice(0).forEach(client => client.clear()); mock.restoreAll(); }); after(() => dom.window.close());

function answers() {
  posted = [];
  mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body) posted.push({ url, body });
    let value: unknown;
    if (url.startsWith("/api/stateful-resources/source")) { const mode = url.includes("prod") ? "prod" : "dev"; value = { file: "framework-config/stateful-resources.ts", hash: `${mode}-hash`, mode, resources: { database: {}, cognito: { retention: "retain" } }, legacy: { file: `cdk-app/.env.${mode}`, retain: false, configured: true }, problems: [] }; }
    else if (url.startsWith("/api/deploy/overview")) value = { targets: [{ name: "job2-dev", mode: "dev", region: "us-east-1" }], profiles: [{ name: "dev", region: "us-east-1" }] };
    else if (url === "/api/stateful-resources/retention/plan") value = { planId: "plan", expiresAt: "later", effects: ["Source only; deployment is separate."], changes: [{ file: "framework-config/stateful-resources.ts", diff: { unified: `+ ${body.kind}: ${body.retention}` } }] };
    else if (url === "/api/stateful-resources/apply") value = { status: "applied", message: "Saved source only; deployment is separate." };
    else if (url === "/api/stateful-resources/reference/plan") return new Response(JSON.stringify({ error: "Original app client is missing. Choose a surviving public app client." }), { status: 422 });
    else value = response;
    return new Response(JSON.stringify(value), { status: 200 });
  });
}
async function mount(kind?: "database" | "cognito") {
  function Root() { return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h(router.Outlet) }); }
  const root = router.createRootRoute({ component: Root }), app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/lifecycle"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/lifecycle", component: () => h(view.DataRetention, { kind }) })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.waitFor(() => assert.ok(!(ui.screen.getByRole("combobox", { name: `${kind === "cognito" ? "Cognito User Pool" : "Database"} retention policy` }) as HTMLSelectElement).disabled));
}
test("independent retention is reviewed before source apply and deployed protection stays unverified", async () => {
  answers(); await mount();
  assert.equal((ui.screen.getByRole("combobox", { name: "Cognito User Pool retention policy" }) as HTMLSelectElement).value, "retain");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database retention policy" }), { target: { value: "retain" } });
  await ui.screen.findByRole("dialog", { name: "Review lifecycle source" });
  assert.equal(posted.length, 1); assert.equal(posted[0]!.body.kind, "database");
  assert.equal(posted[0]!.body.mode, "dev"); assert.equal(posted[0]!.body.hash, "dev-hash");
  assert.match(document.body.textContent!, /Unverified for this destination/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Cancel" }));
  assert.equal(posted.length, 1, "cancel cannot write source");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database retention policy" }), { target: { value: "remove" } });
  await ui.screen.findByRole("dialog", { name: "Review lifecycle source" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save lifecycle source" }));
  await ui.screen.findByText("Saved source only; deployment is separate.");
  assert.equal(posted.filter(post => post.url.endsWith("/apply")).length, 1);
});
test("retained Cognito review sends exact destination and existing client; failed prerequisites remain actionable without apply", async () => {
  answers(); await mount("cognito");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Lifecycle destination" }), { target: { value: "job2-dev" } });
  ui.fireEvent.click(ui.screen.getByText("Reference a retained resource"));
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Original resource deployment" }), { target: { value: "old-dev" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Retained resource ID" }), { target: { value: "us-east-1_Original" } });
  const review = ui.screen.getByRole("button", { name: "Inspect and review reference source" }) as HTMLButtonElement;
  assert.equal(review.disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Retained Cognito app client ID" }), { target: { value: "oldclient123" } });
  assert.equal(review.disabled, false); ui.fireEvent.click(review);
  await ui.screen.findByRole("alert");
  assert.match(document.body.textContent!, /Choose a surviving public app client/);
  assert.equal(posted.length, 1); assert.deepEqual(posted[0]!.body.selection, { profile: "dev", deployment: "job2-dev", region: "us-east-1", mode: "dev" });
  assert.equal(posted[0]!.body.clientId, "oldclient123"); assert.equal(posted.filter(post => post.url.endsWith("/apply")).length, 0);
});
