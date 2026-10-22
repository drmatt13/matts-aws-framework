import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { createElement as h } from "react";
import type { EditorView } from "@codemirror/view";
import type { SnapshotResponse } from "../shared/api";
import type { ModeModel, Snapshot } from "../shared/model";
import type { DatabaseSourceReview, DatabaseValidation, DatabaseWorkbench } from "../shared/database-workbench";
import { parseDeclaredSchema } from "../server/database";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

const require = createRequire(import.meta.url);
const source = `// use prisma-8
// Keep comments and physical mappings.
model Person {
  id Uuid @id
}
model Entry {
  id Uuid @id
  title String @map("entry_title") // do not lose this
  ownerId Uuid
  owner Person @relation(fields: [ownerId], references: [id])
  @@map("entries")
}
`;
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let database: typeof import("../src/views/Database");
let history: typeof import("../src/views/DatabaseHistory");
let dom: { window: Window & typeof globalThis };
let persisted: DatabaseWorkbench;
let sourceReviews: DatabaseSourceReview[];
let saves: string[];
let saveGate: Promise<void> | undefined;
let refreshUnavailable: boolean;
let fullscreenElement: Element | null = null;
const clients: import("@tanstack/react-query").QueryClient[] = [];

function validate(text: string): DatabaseValidation {
  const parsed = parse(text, "contract.prisma");
  const file = parsed.sources.sourceFileFor(parsed.document.syntax);
  return { sourceHash: text, valid: !parsed.diagnostics.length,
    diagnostics: parsed.diagnostics.map(item => ({ from: file.offsetAt(item.range.start), to: file.offsetAt(item.range.end), severity: "error" as const, code: item.code, message: item.message })),
    schema: parsed.diagnostics.length ? undefined : parseDeclaredSchema(text), storageHash: text, executionHash: text, validatedAt: "2026-10-22T12:00:00Z" };
}
function workbench(text = source, revision = "source-revision"): DatabaseWorkbench {
  return { source: text, revision, configRevision: "config", file: "packages/database/prisma/contract.prisma", validation: validate(text), capabilities: { dialect: "Prisma 8", semanticValidation: true, formatting: true, languageServer: false, notes: ["Completion is curated syntax assistance; semantic validation uses pinned Prisma."] }, targets: [
    { id: "local:postgres", label: "Development PostgreSQL", available: true, identity: "local-identity", detail: "Read only; does not start Compose." },
    { id: "production", label: "Production RDS", available: false, identity: "production-identity", detail: "Private IAM and TLS access required." },
  ] };
}
function snapshot(): Snapshot {
  const mode = (mode: "dev" | "prod"): ModeModel => ({ mode, status: "ok", targets: [], routes: [], resources: [], edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 });
  return { revision: "graph-revision", repositoryRoot: "/fixture", generatedAt: "2026-10-22T12:00:00Z", descriptions: { values: {} }, schema: parseDeclaredSchema(source), databaseProblems: [], webSocketApi: false, models: { dev: mode("dev"), prod: mode("prod") }, files: {}, source: { cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, entities: {}, editability: {}, links: {}, catalog: {}, problems: [] } };
}

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "Window", "HTMLElement", "HTMLDialogElement", "Element", "Node", "Text", "MutationObserver", "DOMRect", "Range", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  dom.window.HTMLElement.prototype.requestFullscreen = async function () {
    fullscreenElement = this;
    document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
  document.exitFullscreen = async () => {
    fullscreenElement = null;
    document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  studio = await import("../src/studio"); database = await import("../src/views/Database"); history = await import("../src/views/DatabaseHistory");
});
beforeEach(() => {
  fullscreenElement = null;
  persisted = workbench(); sourceReviews = []; saves = []; saveGate = undefined; refreshUnavailable = false;
  mock.method(database.databaseApi, "load", async () => persisted);
  mock.method(database.databaseApi, "validate", async (text: string) => validate(text));
  mock.method(database.databaseApi, "review", async (text: string, expectedRevision: string) => {
    const validation = validate(text);
    if (!validation.valid) throw new Error("Finish the invalid Prisma draft before saving. Nothing was written.");
    const reviewed: DatabaseSourceReview = { reviewId: `review-${sourceReviews.length}`, file: persisted.file, before: persisted.source, after: text, expectedRevision, sourceHash: text, configRevision: "config", validation, effects: ["Writes authored contract only. No migration, database or deployment changes."], expiresAt: "2026-10-22T13:00:00Z" };
    sourceReviews.push(reviewed); return reviewed;
  });
  mock.method(database.databaseApi, "save", async (id: string) => {
    saves.push(id); await saveGate;
    const reviewed = sourceReviews.find(item => item.reviewId === id)!;
    persisted = workbench(reviewed.after, "saved-revision");
    return { saved: true, source: persisted.source, revision: persisted.revision, file: persisted.file, refresh: refreshUnavailable ? "unavailable" as const : "complete" as const, message: refreshUnavailable ? "Source saved; graph refresh unavailable. Refresh separately." : "Source saved." };
  });
  mock.method(history.historyApi, "load", async () => ({ revision: "history", sourceHash: persisted.revision, migrations: [], snapshots: [], heads: [], refs: [], issues: [], observedAt: "2026-10-22T12:00:00Z" }));
});
afterEach(() => { ui.cleanup(); for (const client of clients.splice(0)) client.clear(); mock.restoreAll(); });
after(() => dom.window.close());

async function mount() {
  const response: SnapshotResponse = { snapshot: snapshot(), evaluating: false, history: {}, commands: {}, busy: null };
  function Root() { return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h("div", null, h(router.Link, { to: "/other" }, "Open other view"), h(router.Outlet)) }); }
  const root = router.createRootRoute({ component: Root });
  const application = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/database"] }), routeTree: root.addChildren([
    router.createRoute({ getParentRoute: () => root, path: "/database", component: database.Database }),
    router.createRoute({ getParentRoute: () => root, path: "/other", component: () => h("p", null, "Other view reached") }),
  ]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: application })));
  await ui.screen.findByRole("textbox", { name: "Prisma schema source" });
  return application;
}
function editor(): EditorView { return require("@codemirror/view").EditorView.findFromDOM(ui.screen.getByRole("textbox", { name: "Prisma schema source" }))!; }
function replaceText(old: string, next: string) {
  const view = editor(), from = view.state.doc.toString().indexOf(old); assert.ok(from >= 0);
  ui.act(() => view.dispatch({ changes: { from, to: from + old.length, insert: next }, annotations: require("@codemirror/commands").isolateHistory.of("full") }));
}
async function validateDraft() { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Validate draft" })); await ui.waitFor(() => assert.ok(!ui.screen.queryByText("Validating…"))); }

test("diagram fields navigate to source and cursor navigation highlights their logical and physical identities", async () => {
  await mount();
  const view = editor();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Locate Entry.title" }));
  const selection = view.state.selection.main;
  assert.match(view.state.sliceDoc(selection.from, selection.to), /title String @map\("entry_title"\)/);
  assert.match(document.querySelector(".workbench-entity-details")!.textContent!, /Entry\.title/);
  assert.match(document.querySelector(".workbench-entity-details")!.textContent!, /entry_title/);
  const person = source.indexOf("id Uuid");
  ui.act(() => view.dispatch({ selection: { anchor: person } }));
  assert.equal(ui.screen.getByRole("button", { name: "Select table Person" }).getAttribute("aria-pressed"), "true");
});

test("temporarily invalid drafts retain the labeled last-valid diagram and preserve editor undo", async () => {
  await mount();
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const view = editor();
  replaceText("title String", "title String?"); await validateDraft();
  replaceText("title String?", "title ???"); await validateDraft();
  assert.ok(ui.screen.getByText("Invalid draft"));
  assert.ok(ui.screen.getByText(/Last valid diagram/));
  assert.equal(ui.screen.getByRole("textbox", { name: "Prisma schema source" }), content);
  const oldSelection = view.state.selection.main;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Locate Entry.title" }));
  assert.deepEqual(view.state.selection.main, oldSelection, "source navigation pauses while last-valid diagram is retained");
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.match(view.state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("source review requires explicit Save schema and keeps text, comments and mapping through review", async () => {
  await mount();
  replaceText("title String", "displayName String"); await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.equal(sourceReviews.length, 1); assert.equal(saves.length, 0);
  assert.match(ui.screen.getByLabelText("Proposed source").textContent!, /displayName String @map\("entry_title"\)/);
  assert.match(ui.screen.getByLabelText("Proposed source").textContent!, /do not lose this/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to editing" }));
  assert.equal(saves.length, 0); assert.match(editor().state.doc.toString(), /displayName/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save schema" }));
  await ui.waitFor(() => assert.ok(!ui.screen.queryByRole("dialog"), "source review closes after save"));
  assert.deepEqual(saves, ["review-1"]);
  assert.ok(ui.screen.getByText("Saved source", { selector: ".workbench-badge" }));
});

test("discard asks deliberately, preserves undo and never writes source", async () => {
  await mount(); replaceText("title String", "title String?");
  const view = editor(), content = view.contentDOM;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  await ui.screen.findByRole("dialog", { name: "Discard schema draft?" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep editing" }));
  assert.match(view.state.doc.toString(), /title String\?/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Discard draft" }));
  assert.equal(view.state.doc.toString(), source);
  assert.equal(editor().contentDOM, content);
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.match(view.state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("route navigation and browser exit protect an unsaved schema and allow explicit discard", async () => {
  const application = await mount(); replaceText("title String", "title String?");
  const exit = new dom.window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(exit); assert.equal(exit.defaultPrevented, true);
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Open other view" }));
  await ui.screen.findByRole("dialog", { name: "Leave your schema draft?" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep editing" }));
  await ui.waitFor(() => assert.equal(application.state.location.pathname, "/database"));
  assert.match(editor().state.doc.toString(), /title String\?/);
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Open other view" }));
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Discard and continue" }));
  await ui.screen.findByText("Other view reached");
  assert.equal(saves.length, 0);
});

test("external save conflict preserves editor identity and offers an explicit latest-source review", async () => {
  await mount(); replaceText("title String", "title String?");
  const content = editor().contentDOM;
  persisted = workbench(source.replace("title String", "title VarChar(200)"), "external-revision");
  ui.fireEvent(window, new dom.window.Event("focus"));
  await ui.screen.findByText("Saved source changed outside this session.");
  assert.equal(editor().contentDOM, content); assert.match(editor().state.doc.toString(), /title String\?/);
  assert.equal((ui.screen.getByRole("button", { name: "Review source changes" }) as HTMLButtonElement).disabled, true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review draft against latest source" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.equal(sourceReviews[0]?.expectedRevision, "external-revision");
  assert.match(ui.screen.getByLabelText("Saved source").textContent!, /VarChar\(200\)/);
  assert.equal(saves.length, 0);
});

test("keyboard resizing and schema focus modes keep the same editor session", async () => {
  await mount(); const view = editor();
  assert.ok(!ui.screen.queryByText("Next: understand database evolution"));
  const separator = ui.screen.getByRole("separator", { name: "Resize source and diagram" });
  ui.fireEvent.keyDown(separator, { key: "End" }); assert.equal(separator.getAttribute("aria-valuenow"), "75");
  ui.fireEvent.keyDown(separator, { key: "Home" }); assert.equal(separator.getAttribute("aria-valuenow"), "25");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Focus source" }));
  assert.equal(document.querySelector(".workbench-split")?.getAttribute("data-mode"), "source");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Focus diagram" }));
  assert.equal(document.querySelector(".workbench-split")?.getAttribute("data-mode"), "diagram");
  const controls = ui.screen.getByRole("group", { name: "Editing layout" });
  assert.equal(controls.closest(".workbench-source-pane, .workbench-diagram-pane"), null, "layout controls must stay outside either hideable pane");
  assert.equal(ui.within(controls).getAllByRole("button").length, 3);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Split source and diagram" }));
  assert.equal(editor(), view);
});

test("fullscreen panes preserve draft, selection and undo and restore layout and keyboard focus on browser exit", async () => {
  await mount();
  replaceText("title String", "title String?");
  const view = editor();
  ui.act(() => view.dispatch({ selection: { anchor: 25 } }));
  const selection = view.state.selection.main;
  for (const pane of ["Prisma source", "schema diagram"]) {
    const trigger = ui.screen.getByRole("button", { name: `Fullscreen ${pane}` });
    trigger.focus();
    ui.fireEvent.click(trigger);
    await ui.waitFor(() => assert.ok(document.fullscreenElement === document.querySelector(".database-workbench"), "workbench enters fullscreen"));
    assert.equal(document.querySelector(".workbench-split")?.getAttribute("data-mode"), pane === "Prisma source" ? "source" : "diagram");
    assert.equal(editor(), view);
    assert.deepEqual(view.state.selection.main, selection);
    assert.match(view.state.doc.toString(), /title String\?/);
    // The same event is emitted when the browser handles Escape.
    await ui.act(() => document.exitFullscreen());
    await ui.waitFor(() => assert.ok(document.activeElement === trigger, "keyboard focus returns to the fullscreen trigger"));
    assert.equal(document.querySelector(".workbench-split")?.getAttribute("data-mode"), "split");
  }
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.equal(view.state.doc.toString(), source);
  assert.equal(saves.length, 0);
});

test("fullscreen keeps layout switching and source review available; exit returns to the original focus mode", async () => {
  await mount(); replaceText("title String", "title String?"); await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Focus source" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fullscreen Prisma source" }));
  await ui.waitFor(() => assert.ok(document.fullscreenElement));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Split source and diagram" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Focus diagram" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  const review = await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.ok(document.fullscreenElement!.contains(review), "review must be visible within the fullscreen element");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to editing" }));
  ui.fireEvent.click(ui.within(ui.screen.getByRole("region", { name: "Schema diagram pane" })).getByRole("button", { name: "Exit fullscreen" }));
  await ui.waitFor(() => assert.equal(document.fullscreenElement, null));
  assert.equal(document.querySelector(".workbench-split")?.getAttribute("data-mode"), "source");
  assert.equal(saves.length, 0);
});

test("a rejected fullscreen request restores the workspace and preserves unsaved text", async () => {
  await mount(); replaceText("title String", "title String?");
  mock.method(dom.window.HTMLElement.prototype, "requestFullscreen", async () => { throw new Error("Denied by browser"); });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fullscreen schema diagram" }));
  await ui.screen.findByText(/The browser could not change fullscreen mode/);
  assert.equal(document.fullscreenElement, null);
  assert.equal(document.querySelector(".workbench-split")?.getAttribute("data-mode"), "split");
  assert.match(editor().state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("save freezes the reviewed draft and remains a source success when graph refresh fails", async () => {
  await mount(); replaceText("title String", "title String?"); await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fullscreen Prisma source" }));
  await ui.waitFor(() => assert.ok(document.fullscreenElement));
  let finish!: () => void;
  saveGate = new Promise<void>(resolve => { finish = resolve; }); refreshUnavailable = true;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save schema" }));
  await ui.waitFor(() => assert.equal(editor().state.readOnly, true));
  assert.equal((ui.screen.getByRole("button", { name: "Back to editing" }) as HTMLButtonElement).disabled, true);
  assert.equal(persisted.source, source, "no source success is claimed before the response");
  await ui.act(async () => { finish(); await saveGate; });
  await ui.waitFor(() => assert.ok(!ui.screen.queryByRole("dialog"), "review closes after successful source write"));
  assert.match(persisted.source, /title String\?/);
  assert.ok(ui.screen.getByText("Saved source", { selector: ".workbench-badge" }));
  const feedback = await ui.screen.findByText("Source saved; graph refresh unavailable. Refresh separately.");
  assert.ok(document.fullscreenElement!.contains(feedback), "partial-effect feedback remains visible in fullscreen");
  assert.equal(saves.length, 1);
});

test("inspection requires an explicit target and a late response cannot cross target selection", async () => {
  let resolveObservation!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveObservation = resolve; });
  const bodies: { targetId: string }[] = [];
  mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return pending; });
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Database status" }));
  await ui.screen.findByRole("combobox", { name: "Database target" });
  assert.equal(bodies.length, 0);
  assert.equal((ui.screen.getByRole("button", { name: "Inspect database" }) as HTMLButtonElement).disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database target" }), { target: { value: "local:postgres" } });
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("button", { name: "Inspect database" }) as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Inspect database" }));
  await ui.waitFor(() => assert.equal(bodies.length, 1));
  assert.equal(bodies[0]?.targetId, "local:postgres");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database target" }), { target: { value: "production" } });
  await ui.act(async () => {
    resolveObservation(Response.json({ id: "local-observation", targetId: "local:postgres", targetIdentity: "local-identity", observedAt: "2026-10-22T12:00:00Z", savedRevision: "source-revision", historyRevision: "history", baseline: { label: "Saved source" }, status: "observed", marker: { status: "matches" }, physical: { status: "matches", issues: [], warnings: [] }, migrationState: { status: "current", message: "Fixture is current" }, ledger: [], message: "Local-only observation marker", limits: [] }));
    await pending;
  });
  assert.ok(!ui.screen.queryByText("Local-only observation marker"));
  assert.ok(ui.screen.getByText("Database state is unknown until an explicit inspection succeeds."));
  assert.equal(bodies.length, 1, "target changes never implicitly inspect or write");
});
