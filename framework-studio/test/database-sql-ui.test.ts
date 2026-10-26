import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import type { SavedSqlCommand, SqlCatalog, SqlExecutionResult, SqlExecutionReview } from "../shared/database-sql";
const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react"), view: typeof import("../src/views/DatabaseSql"), dom: { window: Window & typeof globalThis };
const command: SavedSqlCommand = { name: "seed_demo", kind: "seed", intent: "repeatable", description: "Fixture seed", parameters: ["label"], sql: "INSERT INTO demo_items(label) VALUES ($1) ON CONFLICT DO NOTHING" };
const path = "packages/database/sql/seed/seed_demo.sql";
const catalog: SqlCatalog = { directory: "packages/database/sql", commands: [{ path, revision: "revision-a", command }], issues: [], history: [], targets: [] };
const review: SqlExecutionReview = { id: "review-a", path, revision: "revision-a", command, targetId: "local:postgres", targetLabel: "Local PostgreSQL", targetIdentity: "target-a", parameters: ["demo"], confirmation: "Run seed_demo on Local PostgreSQL", expiresAt: "2099-01-01T00:00:00Z", effects: ["Review the actual target and statement"] };
before(async () => {
  const { JSDOM } = require("jsdom"); dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); view = await import("../src/views/DatabaseSql");
});
afterEach(() => { ui.cleanup(); mock.restoreAll(); });
after(() => dom.window.close());
async function open() {
  mock.method(view.databaseSqlApi, "load", async () => catalog);
  const mounted = ui.render(require("react").createElement(view.DatabaseSql, { active: true }));
  await ui.waitFor(() => assert.ok(mounted.getByRole("option", { name: "seed / seed_demo" })));
  ui.fireEvent.change(mounted.getByLabelText("Saved SQL command"), { target: { value: path } });
  return mounted;
}
test("execution errors remain visible inside the approval modal and never imply success", async () => {
  const mounted = await open(); mock.method(view.databaseSqlApi, "executionReview", async () => review); mock.method(view.databaseSqlApi, "execute", async () => { throw new Error("Source or target changed. Review again."); });
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  const dialog = await mounted.findByRole("dialog", { name: "Approve SQL execution" });
  ui.fireEvent.change(ui.within(dialog).getByLabelText("SQL execution confirmation"), { target: { value: review.confirmation } });
  ui.fireEvent.click(ui.within(dialog).getByRole("button", { name: "Execute reviewed SQL" }));
  await ui.waitFor(() => assert.match(ui.within(dialog).getByRole("alert").textContent!, /Source or target changed/));
  assert.equal(mounted.queryByLabelText("SQL execution result"), null);
});
test("confirmed results identify saved command/revision and disappear when the target changes", async () => {
  const mounted = await open(); mock.method(view.databaseSqlApi, "executionReview", async () => review);
  const result: SqlExecutionResult = { id: "operation-a", name: command.name, path, revision: "revision-a", targetLabel: "Local PostgreSQL", targetIdentity: "target-a", startedAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:01Z", status: "committed", database: "committed", message: "PostgreSQL confirmed COMMIT.", rowCount: 1, rows: [{ label: "demo" }], truncated: false };
  mock.method(view.databaseSqlApi, "execute", async () => result);
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" })); const dialog = await mounted.findByRole("dialog", { name: "Approve SQL execution" });
  ui.fireEvent.change(ui.within(dialog).getByLabelText("SQL execution confirmation"), { target: { value: review.confirmation } }); ui.fireEvent.click(ui.within(dialog).getByRole("button", { name: "Execute reviewed SQL" }));
  const section = await mounted.findByLabelText("SQL execution result"); assert.match(section.textContent!, /seed_demo.*committed/); assert.match(section.textContent!, /revision-a/);
  ui.fireEvent.change(mounted.getByLabelText("SQL database target"), { target: { value: "production" } });
  await ui.waitFor(() => assert.equal(mounted.queryByLabelText("SQL execution result"), null));
});
