import assert from "./support/assert";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
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
let navigation: typeof import("../src/views/NavigationStrip");
let api: typeof import("../src/api");

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
  navigation = await import("../src/views/NavigationStrip");
  api = await import("../src/api");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, busy: null };
});
after(async () => { await builder?.dispose(); dom.window.close(); });
afterEach(() => { ui.cleanup(); mock.restoreAll(); });

async function mount(Component: ComponentType, initial = response) {
  let updateResponse: (next: SnapshotResponse) => void;
  const client = new query.QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  function Root() {
    const [current, setCurrent] = useState(initial);
    updateResponse = setCurrent;
    return h(studio.StudioProvider, { response: current, selected: undefined, select: () => {}, children: h(Component) });
  }
  const root = router.createRootRoute({ component: Root });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren(["/", "/database", "/deploy", "/graphql", "/cognito", "/domains", "/websockets"].map(route => router.createRoute({ getParentRoute: () => root, path: route, component: () => null }))) });
  const render = () => h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app }));
  ui.render(render());
  await ui.waitFor(() => assert.ok(document.querySelector("button")));
  return async (next: SnapshotResponse) => {
    await ui.act(async () => updateResponse(next));
  };
}

test("primary navigation retains one source toggle and no validation control across all destinations", async () => {
  await mount(() => h(shell.Shell, { children: h("p", null, "Workspace content") }));
  const navigation = ui.screen.getByRole("navigation", { name: "Views" });
  const destinations = ["Map", "Database", "Deploy", "GraphQL", "Cognito", "Domains", "WebSockets"];
  assert.deepEqual(ui.within(navigation).getAllByRole("link").map(link => link.textContent), destinations);
  const environment = ui.screen.getByRole("group", { name: "Source environment" });
  for (const name of destinations) {
    const link = ui.within(navigation).getByRole("link", { name });
    ui.fireEvent.click(link);
    await ui.waitFor(() => assert.equal(link.getAttribute("aria-current"), "page"));
    assert.equal(navigation.querySelectorAll('[aria-current="page"]').length, 1);
    assert.equal(ui.screen.queryByRole("button", { name: /Configuration health/ }), null, "the navbar carries no source validation control");
    assert.equal(ui.screen.getByRole("group", { name: "Source environment" }), environment);
    const modes = ui.within(environment);
    ui.fireEvent.click(modes.getByRole("button", { name: "Production" }));
    assert.equal(modes.getByRole("button", { name: "Production" }).getAttribute("aria-pressed"), "true");
    ui.fireEvent.click(modes.getByRole("button", { name: "Development" }));
    assert.equal(modes.getByRole("button", { name: "Development" }).getAttribute("aria-pressed"), "true");
    assert.equal(ui.screen.getAllByRole("group", { name: "Source environment" }).length, 1);
    assert.equal(ui.screen.queryByRole("group", { name: "Source edit history" }), null);
  }
});

function navigationFixture(kind: "links" | "buttons") {
  let width = 220;
  let ancestorScrollRequests = 0;
  const labels = ["First", "Second", "Third", "Last"];
  const observers: { target?: Element; disconnected: boolean; resize: () => void }[] = [];
  const resizeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    readonly state: (typeof observers)[number];
    constructor(resize: () => void) { this.state = { disconnected: false, resize }; observers.push(this.state); }
    observe(target: Element) { this.state.target = target; }
    disconnect() { this.state.disconnected = true; }
  } });
  const content = (active: string) => h("div", { "data-testid": "navigation-scroll-parent" }, h(navigation.NavigationStrip, {
    label: "Fixture navigation", activeKey: active,
    children: labels.map((label, index) => h(kind === "links" ? "a" : "button", {
      key: label,
      ...(kind === "links" ? { href: `#${label}`, "aria-current": active === label ? "page" as const : undefined } : { type: "button" as const, "aria-pressed": active === label }),
      ref: (item: HTMLElement | null) => {
        if (!item) return;
        const strip = item.parentElement!;
        strip.getBoundingClientRect = () => new dom.window.DOMRect(100, 80, width, 32);
        item.getBoundingClientRect = () => new dom.window.DOMRect(104 + index * 112 - strip.scrollLeft, 80, 96, 32);
        item.scrollIntoView = () => { ancestorScrollRequests++; strip.parentElement!.scrollTop += 100; };
      },
    }, label)),
  }));
  return {
    content, observers,
    resize(nextWidth: number) { width = nextWidth; observers.at(-1)!.resize(); },
    ancestorScrollRequests: () => ancestorScrollRequests,
    restore() { if (resizeDescriptor) Object.defineProperty(globalThis, "ResizeObserver", resizeDescriptor); else Reflect.deleteProperty(globalThis, "ResizeObserver"); },
  };
}

function assertNavigationItemVisible(strip: HTMLElement, item: HTMLElement) {
  const viewport = strip.getBoundingClientRect(), bounds = item.getBoundingClientRect();
  assert.ok(bounds.left >= viewport.left + 4, `${item.textContent} must reveal its left edge and focus outline`);
  assert.ok(bounds.right <= viewport.right - 4, `${item.textContent} must reveal its right edge and focus outline`);
}

for (const kind of ["links", "buttons"] as const) test(`navigation reveals the active ${kind === "links" ? "route" : "section"} on mount, selection change and resize`, () => {
  const fixture = navigationFixture(kind);
  try {
    const mounted = ui.render(fixture.content("Third"));
    const strip = mounted.getByRole("navigation", { name: "Fixture navigation" });
    const role = kind === "links" ? "link" : "button";
    assertNavigationItemVisible(strip, mounted.getByRole(role, { name: "Third" }));
    assert.ok(strip.scrollLeft > 0, "the initial active destination must be revealed");
    mounted.rerender(fixture.content("First"));
    assertNavigationItemVisible(strip, mounted.getByRole(role, { name: "First" }));
    mounted.rerender(fixture.content("Last"));
    assertNavigationItemVisible(strip, mounted.getByRole(role, { name: "Last" }));
    ui.act(() => fixture.resize(140));
    assertNavigationItemVisible(strip, mounted.getByRole(role, { name: "Last" }));
    assert.equal(fixture.observers.at(-1)?.target, strip);
    assert.ok(fixture.observers.slice(0, -1).every(observer => observer.disconnected), "selection changes must dispose old observers");
    assert.equal(fixture.ancestorScrollRequests(), 0, "revealing a destination must scroll only the horizontal strip");
    mounted.unmount();
    assert.ok(fixture.observers.every(observer => observer.disconnected), "unmount must dispose the remaining resize observer");
  } finally { fixture.restore(); }
});

test("keyboard focus reveals both edges of navigation items without scrolling vertical ancestors", () => {
  const fixture = navigationFixture("buttons");
  try {
    const mounted = ui.render(fixture.content("First"));
    const strip = mounted.getByRole("navigation", { name: "Fixture navigation" });
    const parent = mounted.getByTestId("navigation-scroll-parent");
    parent.scrollTop = 72;
    strip.scrollTop = 16;
    for (const name of ["Last", "Second", "First"]) {
      const item = mounted.getByRole("button", { name });
      ui.act(() => item.focus());
      assert.equal(document.activeElement, item);
      assertNavigationItemVisible(strip, item);
      assert.equal(parent.scrollTop, 72, "focusing navigation must preserve the workspace's vertical position");
      assert.equal(strip.scrollTop, 16, "focus reveal must not change vertical scrolling");
    }
    assert.equal(fixture.ancestorScrollRequests(), 0, "scrollIntoView would move vertical ancestors");
    mounted.unmount();
  } finally { fixture.restore(); }
});

test("source environment offers the two source modes and protects unsaved edits before switching", async () => {
  let context: ReturnType<typeof studio.useStudio>;
  function Workspace() {
    context = studio.useStudio();
    return h(shell.Shell, { children: null });
  }
  await mount(Workspace);
  const environment = ui.within(ui.screen.getByRole("group", { name: "Source environment" }));
  assert.deepEqual(environment.getAllByRole("button").map(button => button.textContent), ["Development", "Production"], "named deployments such as staging must not masquerade as additional source modes");
  const development = environment.getByRole("button", { name: "Development" });
  const production = environment.getByRole("button", { name: "Production" });
  assert.equal(development.getAttribute("aria-pressed"), "true");
  ui.fireEvent.click(production);
  assert.equal(production.getAttribute("aria-pressed"), "true");
  assert.equal(context!.mode, "prod");
  ui.act(() => context!.draft.beginCreation("stack"));
  const draft = context!.draft.creation();
  assert.ok(draft);
  ui.fireEvent.click(development);
  const dialog = await ui.screen.findByRole("dialog", { name: "Unsaved changes" });
  assert.equal(context!.mode, "prod");
  ui.fireEvent.click(ui.within(dialog).getByRole("button", { name: "Keep Editing" }));
  assert.equal(context!.draft.creation(), draft);
  assert.equal(production.getAttribute("aria-pressed"), "true");
  ui.fireEvent.click(development);
  ui.fireEvent.click(ui.within(await ui.screen.findByRole("dialog", { name: "Unsaved changes" })).getByRole("button", { name: "Discard and Continue" }));
  await ui.waitFor(() => assert.equal(development.getAttribute("aria-pressed"), "true"));
  assert.equal(context!.mode, "dev");
  assert.equal(context!.draft.dirty, false);
});

test("a stale source opens configuration details, including source problems and the saved-source audit", async () => {
  const commands: unknown[][] = [];
  mock.method(api.api, "command", async (...args: unknown[]) => { commands.push(args); return { command: "framework:check", exitCode: 0, output: "All checks passed", durationMs: 20 }; });
  const initial = { ...response, snapshot: { ...response.snapshot,
    source: { ...response.snapshot.source, problems: ["A declaration file could not be indexed."] },
    models: { dev: { ...response.snapshot.models.dev, stale: true as const, diagnostics: [] }, prod:{ ...response.snapshot.models.prod, diagnostics: [] } },
  } };
  await mount(() => h(shell.Shell, { children: null }), initial);
  const why = ui.screen.getByRole("button", { name: "Show why" });
  why.focus();
  ui.fireEvent.click(why);
  const details = ui.screen.getByRole("complementary", { name: "Configuration health" });
  assert.match(details.textContent!, /A declaration file could not be indexed/);
  assert.match(details.textContent!, /does not establish AWS credentials, deployment status or application health/, "configuration validation must keep its evidence boundary clear");
  const close = ui.within(details).getByRole("button", { name: "Close Configuration health" });
  assert.equal(document.activeElement, close);
  ui.fireEvent.keyDown(close, { key: "Escape" });
  assert.equal(ui.screen.queryByRole("complementary", { name: "Configuration health" }), null);
  assert.equal(document.activeElement, why);
  ui.fireEvent.click(why);
  assert.equal(commands.length, 0);
  ui.fireEvent.click(ui.screen.getByText("Additional checks", { selector: "summary" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check generated files and wiring" }));
  await ui.screen.findByRole("heading", { name: "framework:check passed" });
  assert.deepEqual(commands, [["framework:check", false]]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to configuration health" }));
  assert.ok(ui.screen.getByRole("heading", { name: "Configuration health" }));
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
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Input parameter or secret" }));
  const wizard = await ui.screen.findByRole("dialog", { name: "Create input parameter or secret" });
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
  assert.ok(controls.getByRole("group", { name: "Tags" }).closest("[data-creation-field][data-wide=true]"));
  ui.fireEvent.change(id, { target: { value: "polishedInput" } });
  assert.equal(id.getAttribute("aria-invalid"), "false");
  assert.equal(id.getAttribute("aria-describedby")!.split(" ").length, 1);
  await update({ ...response, snapshot: { ...response.snapshot, revision: `${response.snapshot.revision}-external` } });
  await ui.waitFor(() => assert.ok(controls.getByRole("alert")));
  for (const element of wizard.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("[data-slot=\"creation-form-fields\"] input, [data-slot=\"creation-form-fields\"] select, [data-slot=\"creation-form-fields\"] button")) assert.equal(element.disabled, true);
  assert.equal((controls.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement).disabled, true);
  assert.equal((controls.getByRole("button", { name: "Cancel creation" }) as HTMLButtonElement).disabled, false);
});

test("the architecture board keeps valid resource-only applications visible and offers creation", async () => {
  const snapshot = response.snapshot;
  const models = { dev: { ...snapshot.models.dev, targets: [], routes: [], edges: [] }, prod: { ...snapshot.models.prod, targets: [], routes: [], edges: [] } };
  await mount(() => h(shell.Shell, { children: h(board.Board) }), { ...response, snapshot: { ...snapshot, models } });
  assert.ok(ui.screen.getByRole("group", { name: "Application architecture" }));
  assert.ok(document.querySelector("[data-ui~=\"board\"] [data-entity-id^='resource:']"));
  assert.ok(ui.screen.getByRole("button", { name: "Add to application" }));
  assert.equal(ui.screen.queryByText(/graph did not load/), null);
});

test("an unavailable Board graph keeps its source switch available to reach a working environment", async () => {
  const snapshot = response.snapshot;
  await mount(() => h(shell.Shell, { children: h(board.Board) }), { ...response, snapshot: { ...snapshot, models: { ...snapshot.models,
    dev: { ...snapshot.models.dev, status: "error", targets: [], routes: [], resources: [], edges: [], localServices: [] },
  } } });
  assert.ok(ui.screen.getByText(/development graph did not load/));
  const environment = ui.within(ui.screen.getByRole("group", { name: "Source environment" }));
  const production = environment.getByRole("button", { name: "Production" });
  assert.equal((production as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(production);
  await ui.screen.findByRole("group", { name: "Application architecture" });
  assert.equal(ui.screen.queryByText(/graph did not load/), null);
  assert.equal(ui.screen.getByRole("button", { name: "Production" }).getAttribute("aria-pressed"), "true");
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
