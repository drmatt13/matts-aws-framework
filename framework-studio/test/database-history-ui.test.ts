import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h, useState } from "react";
import type { DatabaseHistory as HistoryData, DatabaseSchemaComparison } from "../shared/database-history";
import type { DatabaseWorkbench } from "../shared/database-workbench";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

const require = createRequire(import.meta.url);
const first = "a".repeat(64), second = "b".repeat(64), orphan = "c".repeat(64);
const saved: DatabaseWorkbench = {
  file: "packages/database/prisma/contract.prisma", source: "// use prisma-8\n", revision: "source", configRevision: "config",
  validation: { sourceHash: "source", valid: true, diagnostics: [], validatedAt: "2026-10-22T12:00:00Z", storageHash: second },
  targets: [], capabilities: { dialect: "Prisma 8", semanticValidation: true, formatting: true, languageServer: false, notes: [] },
};
const historyData: HistoryData = {
  revision: "history", sourceHash: "source", observedAt: "2026-10-22T12:00:00Z", heads: [second], refs: [], issues: [],
  migrations: [{ id: "app/create", space: "app", name: "create", from: first, to: second, createdAt: "2026-10-22T12:00:00Z", migrationHash: "d".repeat(64), integrity: "verified", operations: [], source: "// migration source", sourcePath: "migration.ts", sourceVerification: "not-executed", pendingPlaceholders: false, issues: [] }],
  snapshots: [first, second, orphan].map(hash => ({ hash, path: `snapshots/${hash}/contract.json`, available: true, provenance: "semantic-contract", contract: {}, issues: [] })),
};
const comparison: DatabaseSchemaComparison = { from: "saved", to: "saved", sourceHash: "source", historyRevision: "history", fromStorageHash: second, toStorageHash: second, storageChanged: false, domainChanged: false, executionChanged: false, changes: [], limitations: [], observedAt: "2026-10-22T12:00:00Z" };

let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let view: typeof import("../src/views/DatabaseHistory");
let dom: { window: Window & typeof globalThis };
let update: (value: { saved: DatabaseWorkbench; snapshotRevision: string }) => void;

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "Window", "HTMLElement", "HTMLDialogElement", "Element", "Node", "Text", "MutationObserver", "DOMRect", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.scrollTo = () => {};
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); router = require("@tanstack/react-router");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  view = await import("../src/views/DatabaseHistory");
});
afterEach(() => { ui.cleanup(); mock.restoreAll(); });
after(() => dom.window.close());

async function mount() {
  function Harness() {
    const [props, setProps] = useState({ saved, snapshotRevision: "snapshot" });
    update = setProps;
    return h(view.DatabaseHistory, { ...props, active: true, draft: saved.source, dirty: false, onInstalled() {} });
  }
  const root = router.createRootRoute({ component: () => h(router.Outlet) });
  const application = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/history"] }), routeTree: root.addChildren([
    router.createRoute({ getParentRoute: () => root, path: "/history", component: Harness }),
  ]) });
  ui.render(h(router.RouterProvider, { router: application }));
  await ui.waitFor(() => assert(ui.screen.getByRole("button", { name: "Compare schemas" })));
}

test("baseline selectors are frozen while a comparison is pending", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  let resolve!: (value: DatabaseSchemaComparison) => void;
  mock.method(view.historyApi, "compare", () => new Promise<DatabaseSchemaComparison>(done => { resolve = done; }));
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Compare schemas" }));
  await ui.waitFor(() => assert((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled));
  assert((ui.screen.getByLabelText("To") as HTMLSelectElement).disabled);
  await ui.act(async () => { resolve(comparison); });
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled, false));
  assert(ui.screen.getByText("These semantic contracts are equal. Authored comments and formatting are outside this comparison."));
});

test("snapshot and configuration changes expire a comparison and load fresh history", async () => {
  const load = mock.method(view.historyApi, "load", async () => historyData);
  mock.method(view.historyApi, "compare", async () => comparison);
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Compare schemas" }));
  await ui.waitFor(() => assert(ui.screen.getByText("These semantic contracts are equal. Authored comments and formatting are outside this comparison.")));
  const beforeSnapshot = load.mock.callCount();
  await ui.act(async () => { update({ saved, snapshotRevision: "snapshot-2" }); });
  await ui.waitFor(() => assert.equal(load.mock.callCount(), beforeSnapshot + 1));
  assert.equal(ui.screen.queryByText("These semantic contracts are equal. Authored comments and formatting are outside this comparison."), null);
  const beforeConfig = load.mock.callCount();
  await ui.act(async () => { update({ saved: { ...saved, configRevision: "config-2" }, snapshotRevision: "snapshot-2" }); });
  await ui.waitFor(() => assert.equal(load.mock.callCount(), beforeConfig + 1));
  assert(ui.screen.getByRole("button", { name: "Compare schemas" }));
});

test("planning offers known app graph origins while orphan snapshots remain comparison-only", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  await mount();
  assert((ui.screen.getByLabelText("From") as HTMLSelectElement).querySelector(`option[value="${orphan}"]`));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Plan migration" }));
  const baseline = await ui.screen.findByLabelText("Migration baseline") as HTMLSelectElement;
  assert(baseline.querySelector(`option[value="${first}"]`));
  assert(baseline.querySelector(`option[value="${second}"]`));
  assert.equal(baseline.querySelector(`option[value="${orphan}"]`), null);
});

test("a comparison completed after history invalidation cannot overwrite fresh history", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  let resolve!: (value: DatabaseSchemaComparison) => void;
  mock.method(view.historyApi, "compare", () => new Promise<DatabaseSchemaComparison>(done => { resolve = done; }));
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Compare schemas" }));
  await ui.waitFor(() => assert((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled));
  await ui.act(async () => { update({ saved, snapshotRevision: "new-history" }); });
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled, false));
  await ui.act(async () => { resolve({ ...comparison, storageChanged: true }); });
  assert.equal(ui.screen.queryByText("Comparison evidence and limits"), null);
});
