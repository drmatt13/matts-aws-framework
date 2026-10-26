import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import type { CognitoOperationReview } from "../shared/identity-operations";
const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react"), view: typeof import("../src/views/CognitoManagement"), dom: { window: Window & typeof globalThis };
const selection = { profile: "dev", deployment: "campaign", region: "us-east-1" };
const review: CognitoOperationReview = { id: "review", subjectDigest: "digest", operation: { action: "create-group", group: "reader", description: "" }, target: { ...selection, mode: "prod", account: "111122223333", actorArn: "arn:aws:iam::111122223333:role/Test", poolId: "pool", poolArn: "arn:pool", fingerprint: "v1", requiredAttributes: [], passwordless: false, triggers: [] }, confirmation: "create-group reader pool account", productionConfirmation: "AUTHORIZE PRODUCTION reader pool account region", expiresAt: "2099-01-01", before: {}, noEffect: false, effects: ["One explicit operation"] };
before(async () => {
  const { JSDOM } = require("jsdom"); dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); view = await import("../src/views/CognitoManagement");
});
afterEach(() => { ui.cleanup(); mock.restoreAll(); }); after(() => dom.window.close());
test("production exact operation has two independent gates and lost response never implies success or retries", async () => {
  mock.method(view.cognitoManagementApi, "history", async () => []); mock.method(view.cognitoManagementApi, "review", async () => review);
  let writes = 0; mock.method(view.cognitoManagementApi, "apply", async () => { writes++; throw new Error("lost response"); });
  const mounted = ui.render(require("react").createElement(view.CognitoManagement, { selection }));
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review Cognito operation" })); const dialog = await mounted.findByRole("dialog", { name: "Approve Cognito operation" });
  const apply = ui.within(dialog).getByRole("button", { name: "Apply exact Cognito operation" }) as HTMLButtonElement;
  assert.equal(apply.disabled, true); ui.fireEvent.change(ui.within(dialog).getByLabelText("Cognito operation confirmation"), { target: { value: review.confirmation } }); assert.equal(apply.disabled, true);
  ui.fireEvent.change(ui.within(dialog).getByLabelText("Production Cognito operation authorization"), { target: { value: review.productionConfirmation } }); assert.equal(apply.disabled, false);
  ui.fireEvent.click(apply); await ui.waitFor(() => assert.match(mounted.getByRole("alert").textContent!, /outcome is not established/)); assert.equal(writes, 1); assert.equal(mounted.queryByRole("dialog"), null);
});
test("late review from another selected deployment never opens an approval", async () => {
  mock.method(view.cognitoManagementApi, "history", async () => []); let resolve!: (value: CognitoOperationReview) => void;
  mock.method(view.cognitoManagementApi, "review", () => new Promise<CognitoOperationReview>(done => { resolve = done; }));
  const mounted = ui.render(require("react").createElement(view.CognitoManagement, { selection })); ui.fireEvent.click(mounted.getByRole("button", { name: "Review Cognito operation" }));
  mounted.rerender(require("react").createElement(view.CognitoManagement, { selection: { ...selection, deployment: "other" } })); await ui.act(async () => resolve(review)); assert.equal(mounted.queryByRole("dialog"), null);
  assert.equal((mounted.getByRole("button", { name: "Review Cognito operation" }) as HTMLButtonElement).disabled, false);
});
test("inactive authentication panel retains entered subjects and rejects its late operation review", async () => {
  mock.method(view.cognitoManagementApi, "history", async () => []); let resolve!: (value: CognitoOperationReview) => void;
  mock.method(view.cognitoManagementApi, "review", () => new Promise<CognitoOperationReview>(done => { resolve = done; }));
  const render = (active: boolean) => require("react").createElement(view.CognitoManagement, { selection, active });
  const mounted = ui.render(render(true));
  ui.fireEvent.change(mounted.getByLabelText("Cognito management username"), { target: { value: "retained-subject" } });
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review Cognito operation" }));
  mounted.rerender(render(false)); await ui.act(async () => resolve(review));
  assert.equal(mounted.queryByRole("dialog"), null);
  mounted.rerender(render(true));
  assert.equal((mounted.getByLabelText("Cognito management username") as HTMLInputElement).value, "retained-subject");
  assert.equal((mounted.getByRole("button", { name: "Review Cognito operation" }) as HTMLButtonElement).disabled, false);
});
