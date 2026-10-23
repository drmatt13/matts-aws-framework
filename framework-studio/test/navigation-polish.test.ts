import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, useState, type ComponentType } from "react";
import type { SnapshotResponse } from "../shared/api";
import { SnapshotBuilder } from "../server/snapshot";

let builder: SnapshotBuilder;
let response: SnapshotResponse;
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let add: typeof import("../src/views/AddMenu");
let board: typeof import("../src/views/Board");
let database: typeof import("../src/views/DatabaseDiagram");
let shell: typeof import("../src/views/Shell");

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  studio = await import("../src/studio"); add = await import("../src/views/AddMenu"); board = await import("../src/views/Board"); database = await import("../src/views/DatabaseDiagram");
  shell = await import("../src/views/Shell");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, history: {}, busy: null };
});
after(async () => { await builder?.dispose(); dom.window.close(); });
afterEach(() => ui.cleanup());

async function mount(Component: ComponentType, initial = response) {
  let updateResponse: (next: SnapshotResponse) => void;
  const client = new query.QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  function Root() {
    const [current, setCurrent] = useState(initial);
    updateResponse = setCurrent;
    return h(studio.StudioProvider, { response: current, selected: undefined, select: () => {}, children: h(Component) });
  }
  const root = router.createRootRoute({ component: Root });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  const render = () => h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app }));
  ui.render(render());
  await ui.waitFor(() => assert.ok(document.querySelector("button")));
  return async (next: SnapshotResponse) => {
    await ui.act(async () => updateResponse(next));
  };
}

test("shell health exposes both verdicts and follows validated snapshot changes", async () => {
  const initial = { ...response, snapshot: { ...response.snapshot, models: { ...response.snapshot.models,
    dev: { ...response.snapshot.models.dev, diagnostics: [] },
    prod: { ...response.snapshot.models.prod, diagnostics: [{ severity: "error" as const, stage: "validate" as const, message: "Invalid production configuration" }, { severity: "warning" as const, stage: "validate" as const, message: "Check production inputs" }] },
  } } };
  const update = await mount(() => h(shell.Shell, { children: null }), initial);
  assert.ok(ui.screen.getByRole("group", { name: "Environment" }));
  const health = ui.screen.getByRole("button", { name: "Configuration health" });
  const description = () => document.getElementById(health.getAttribute("aria-describedby")!)!.textContent;
  assert.match(description()!, /Development: valid\. Production: 1 error, 1 warning/);
  await update({ ...initial, snapshot: { ...initial.snapshot, revision: `${initial.snapshot.revision}-valid`, models: { ...initial.snapshot.models, prod: { ...initial.snapshot.models.prod, diagnostics: [] } } } });
  await ui.waitFor(() => assert.equal(description(), "Development: valid. Production: valid"));
});

test("watch failures expose polling and recover without replacing the editor", async () => {
  const initial = { ...response, sourceWatch: { status: "polling" as const, checkedAt: new Date().toISOString(), pollIntervalMs: 5000, problems: [{ path: "framework-config", code: "EMFILE" }] } };
  const update = await mount(() => h(shell.Shell, { children: h("input", { "aria-label": "Preserved draft", defaultValue: "draft" }) }), initial);
  const editor = ui.screen.getByRole("textbox", { name: "Preserved draft" });
  assert.ok(ui.screen.getByText(/Checking for changes every 5s/));
  assert.ok(ui.screen.getByRole("button", { name: "Reload source" }));
  assert.ok(ui.screen.getByText(/framework-config: EMFILE/));
  await update({ ...initial, sourceWatch: { ...initial.sourceWatch, status: "watching", problems: [] } });
  assert.equal(ui.screen.queryByRole("button", { name: "Reload source" }), null);
  assert.equal(ui.screen.getByRole("textbox", { name: "Preserved draft" }), editor);
});

test("creation chooser supports directional navigation and Escape returns focus to its trigger", async () => {
  await mount(add.AddMenu);
  const trigger = ui.screen.getByRole("button", { name: "Add to application" });
  ui.fireEvent.click(trigger);
  const menu = ui.screen.getByRole("dialog", { name: "Add to application" });
  const options = ui.within(menu);
  const first = options.getByRole("button", { name: "Function" });
  first.focus();
  ui.fireEvent.keyDown(first, { key: "ArrowRight" });
  assert.equal(document.activeElement, options.getByRole("button", { name: "Stack" }));
  ui.fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  assert.equal(document.activeElement, options.getByRole("button", { name: "Workflow" }));
  ui.fireEvent.keyDown(document.activeElement!, { key: "End" });
  assert.equal(document.activeElement, options.getByRole("button", { name: "Authentication provider" }));
  ui.fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
});

test("toolbar creation has a visible action label and preserves chooser dismissal focus", async () => {
  await mount(() => h(add.AddMenu, { presentation: "toolbar" }));
  const trigger = ui.screen.getByRole("button", { name: "Add to application" });
  assert.equal(trigger.textContent, "Add to application");
  ui.fireEvent.click(trigger);
  const chooser = ui.screen.getByRole("dialog", { name: "Add to application" });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-controls"), chooser.id);
  const close = ui.within(chooser).getByRole("button", { name: "Close add menu" });
  assert.equal(document.activeElement, close);
  ui.fireEvent.click(close);
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger);
});

test("unavailable creation explains the reason beside disabled resource choices", async () => {
  const snapshot = response.snapshot;
  await mount(add.AddMenu, { ...response, snapshot: { ...snapshot, models: { ...snapshot.models, dev: { ...snapshot.models.dev, stale: true } } } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  const menu = ui.within(ui.screen.getByRole("dialog", { name: "Add to application" }));
  assert.match(menu.getByRole("status").textContent!, /Configuration health/);
  assert.equal((menu.getByRole("button", { name: "Function" }) as HTMLButtonElement).disabled, true);
});

test("creation helpers and validation stay associated with controls and source conflicts freeze the complete form", async () => {
  const update = await mount(add.AddMenu);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Input parameter" }));
  const wizard = await ui.screen.findByRole("dialog", { name: "Create input parameter" });
  const controls = ui.within(wizard);
  const id = controls.getByRole("textbox", { name: "Stable identifier" });
  assert.equal(id.getAttribute("aria-invalid"), "false", "a fresh form offers guidance before showing a validation error");
  assert.equal(id.getAttribute("aria-describedby")!.split(" ").length, 1);
  assert.equal((controls.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement).disabled, true, "untouched required fields still block review");
  ui.fireEvent.blur(id);
  assert.equal(id.getAttribute("aria-invalid"), "true", "leaving an empty required field reveals its error");
  const describedBy = id.getAttribute("aria-describedby")!.split(" ");
  assert.equal(describedBy.length, 2, "validation retains the naming help alongside its error");
  for (const reference of describedBy) assert.ok(document.getElementById(reference));
  assert.equal(controls.getByRole("textbox", { name: "Description" }).hasAttribute("aria-describedby"), false, "no dangling description references for fields without help");
  assert.ok(controls.getByRole("group", { name: "Tags" }).closest(".creation-field-wide"));
  ui.fireEvent.change(id, { target: { value: "polishedInput" } });
  assert.equal(id.getAttribute("aria-invalid"), "false");
  assert.equal(id.getAttribute("aria-describedby")!.split(" ").length, 1);
  await update({ ...response, snapshot: { ...response.snapshot, revision: `${response.snapshot.revision}-external` } });
  await ui.waitFor(() => assert.ok(controls.getByRole("alert")));
  for (const element of wizard.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(".creation-form-fields input, .creation-form-fields select, .creation-form-fields button")) assert.equal(element.disabled, true);
  assert.equal((controls.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement).disabled, true);
  assert.equal((controls.getByRole("button", { name: "Cancel creation" }) as HTMLButtonElement).disabled, false);
});

test("the architecture board keeps valid resource-only applications visible and offers creation", async () => {
  const snapshot = response.snapshot;
  const models = { dev: { ...snapshot.models.dev, targets: [], routes: [], edges: [] }, prod: { ...snapshot.models.prod, targets: [], routes: [], edges: [] } };
  await mount(board.Board, { ...response, snapshot: { ...snapshot, models } });
  assert.ok(ui.screen.getByRole("group", { name: "Application architecture" }));
  assert.ok(document.querySelector(".board [data-entity-id^='resource:']"));
  assert.ok(ui.screen.getByRole("button", { name: "Add to application" }));
  assert.equal(ui.screen.queryByText(/graph did not load/), null);
});

test("schema search offers a keyboard reset, retains input focus after clearing and bounds zoom controls", async () => {
  await mount(() => h(database.DatabaseDiagram, { schema: response.snapshot.schema, onSelect: () => {}, onLocate: () => {} }));
  const search = ui.screen.getByRole("searchbox", { name: "Find a table or column" }) as HTMLInputElement;
  ui.fireEvent.change(search, { target: { value: "no-such-table-or-column" } });
  assert.match(ui.screen.getByRole("status").textContent!, /^0 matching tables/);
  const clear = ui.screen.getByRole("button", { name: "Clear schema search" });
  clear.focus();
  ui.fireEvent.click(clear);
  assert.equal(search.value, "");
  assert.equal(document.activeElement, search);
  ui.fireEvent.change(search, { target: { value: "query" } });
  ui.fireEvent.keyDown(search, { key: "Escape" });
  assert.equal(search.value, "");
  const zoomIn = ui.screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
  for (let i = 0; i < 12; i++) ui.fireEvent.click(zoomIn);
  assert.equal(zoomIn.disabled, true);
  const zoomOut = ui.screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
  for (let i = 0; i < 20; i++) ui.fireEvent.click(zoomOut);
  assert.equal(zoomOut.disabled, true);
});
