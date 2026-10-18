import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h } from "react";
import { SnapshotBuilder } from "../server/snapshot";
import type { SnapshotResponse } from "../shared/api";
import type { InfrastructureState } from "../shared/infrastructure";
import type { Mode, ModelResource } from "../shared/model";

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let router: typeof import("@tanstack/react-router");
let studio: typeof import("../src/studio");
let component: typeof import("../src/views/Infrastructure");
let inputs: typeof import("../src/views/DeploymentInputs");
let controls: typeof import("../src/views/DraftControls");
let review: typeof import("../src/views/EditDialog");
let api: typeof import("../src/api");
let builder: SnapshotBuilder;
let response: SnapshotResponse;
const clients: import("@tanstack/react-query").QueryClient[] = [];

const ready: InfrastructureState = { mode: "dev", status: "ready", stale: false, generatedAt: "2026-10-17T12:00:00Z", inputs: { file: "cdk-app/.env", modeSelection: "Isolated development", profile: "dev" }, inventory: {
  version: 1, stacks: [{ id: "App", name: "App", environment: "aws://111111111111/us-east-1", dependencies: [], owners: ["resource:cognito"] }],
  resources: [
    { id: "function", stack: "App", logicalId: "Handler", type: "AWS::Lambda::Function", classification: "framework", owners: ["lambda:graphql-api"] },
    { id: "role", stack: "App", logicalId: "HandlerRole", type: "AWS::IAM::Role", classification: "supporting", owners: ["lambda:graphql-api"] },
    { id: "unknown", stack: "App", logicalId: "Internal", type: "AWS::SSM::Parameter", classification: "unowned", owners: [] },
  ], dependencies: [{ from: "function", to: "role", kind: "reference" }], notes: ["No deployed status is queried."] } };

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); query = require("@tanstack/react-query"); router = require("@tanstack/react-router");
  studio = await import("../src/studio"); component = await import("../src/views/Infrastructure"); api = await import("../src/api");
  inputs = await import("../src/views/DeploymentInputs");
  controls = await import("../src/views/DraftControls"); review = await import("../src/views/EditDialog");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, history: {}, commands: {}, busy: null };
});
after(async () => { await builder.dispose(); dom.window.close(); });
afterEach(() => { ui.cleanup(); clients.splice(0).forEach((client) => client.clear()); mock.restoreAll(); });

async function mount(navigate: (id: string) => void = () => {}, initialOwner?: string, environmentFile?: ModelResource) {
  function Workbench() {
    const context = studio.useStudio();
    return h("div", null, h("button", { onClick: () => context.setMode("prod") }, "Production"), environmentFile ? h("div", null, h(inputs.EnvironmentFileView, { resource: environmentFile }), h(controls.DraftFooter), h(controls.UnsavedChangesDialog), context.draftState.reviewOpen ? h(review.EditDialog, { review: context.draftState.review }) : null) : h(component.InfrastructurePanel, { key: context.mode, onNavigate: navigate, initialOwner }));
  }
  function Root() { return h(studio.StudioProvider, { response, selected: undefined, select: (id) => { if (id) navigate(id); }, children: h(Workbench) }); }
  const root = router.createRootRoute({ component: Root });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  if (environmentFile) await ui.screen.findByRole("heading", { name: environmentFile.path[0] });
  else await ui.screen.findByRole("button", { name: "Synthesize development" });
}

test("inventory search, type/owner filters and owner navigation use synthesis evidence without starting a job", async () => {
  let runs = 0; let selected = "";
  mock.method(api.api, "infrastructure", async () => ready);
  mock.method(api.api, "synthesize", async () => { runs++; return ready; });
  await mount((id) => { selected = id; });
  await ui.screen.findByRole("searchbox", { name: "Search infrastructure" });
  ui.fireEvent.change(ui.screen.getByRole("searchbox"), { target: { value: "IAM role" } });
  assert.ok(ui.screen.getByText("1 of 3 resources · 1 stacks"));
  ui.fireEvent.change(ui.screen.getByRole("searchbox"), { target: { value: "" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Infrastructure owner" }), { target: { value: "__unknown" } });
  assert.ok(ui.screen.getByText("Internal", { selector: "strong" })); assert.equal(ui.screen.queryByText("HandlerRole", { selector: "strong" }), null);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Infrastructure owner" }), { target: { value: "lambda:graphql-api" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Infrastructure resource type" }), { target: { value: "AWS::IAM::Role" } });
  const row = ui.screen.getByText("HandlerRole", { selector: "strong" }).closest("details")!;
  ui.fireEvent.click(row.querySelector("summary")!);
  ui.fireEvent.click(ui.within(row).getByRole("button", { name: /graphql/ }));
  assert.equal(selected, "lambda:graphql-api"); assert.equal(runs, 0);
});

test("managed handler/API stacks stay out of browsing and RDS is marked as framework managed", async () => {
  const names = ["my-app-AsynchronousLambdaFunctionsStack", "my-app-WebSocketLambdaFunctionsStack", "my-app-WebSocketApiStack"];
  const inventory = ready.inventory!;
  const stacks = names.map((name) => ({ id: name, name, environment: "local", dependencies: [], owners: [] }));
  mock.method(api.api, "infrastructure", async () => ({ ...ready, inventory: { ...inventory, stacks: [...inventory.stacks, ...stacks, { id: "Rds", name: "my-app-RdsStack", environment: "local", dependencies: [], owners: ["resource:rds"] }], resources: [...inventory.resources, ...names.map((name) => ({ id: name, logicalId: name, stack: name, type: "AWS::Hidden::Fixture", classification: "unowned" as const, owners: [] })), { id: "database", logicalId: "Database", stack: "Rds", type: "AWS::RDS::DBInstance", classification: "framework" as const, owners: ["resource:rds.database"] }] } }));
  await mount(); await ui.screen.findByRole("searchbox");
  assert.equal(ui.screen.queryByText("AWS connection options (optional)"), null);
  assert.equal(ui.screen.queryByRole("textbox", { name: "Synthesis AWS profile" }), null);
  for (const name of names) assert.equal(ui.screen.queryByText(name), null);
  assert.equal(ui.screen.queryByRole("option", { name: "AWS::Hidden::Fixture" }), null);
  assert.ok(ui.screen.getByRole("option", { name: "my-app-RdsStack · Framework managed" }));
  const rdsSection = ui.screen.getByRole("heading", { name: "my-app-RdsStack" }).closest("section")!;
  assert.ok(ui.within(rdsSection).getByText("Framework managed"));
  assert.ok(ui.screen.getByText("4 of 4 resources · 2 stacks"));
});

test("a failed explicit synthesis keeps prior resources and shows the stale/error state", async () => {
  mock.method(api.api, "infrastructure", async () => ready);
  mock.method(api.api, "synthesize", async () => ({ ...ready, status: "failed", stale: true, error: "CDK configuration validation failed." } as InfrastructureState));
  await mount(); await ui.screen.findByRole("searchbox");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Synthesize development" }));
  await ui.screen.findByRole("alert");
  assert.ok(ui.screen.getByText(/Stale inventory/));
  assert.ok(ui.screen.getByText("HandlerRole", { selector: "strong" }));
});

test("switching environment reads its independent inventory and synthesizes only after an explicit click", async () => {
  const runs: string[] = [];
  mock.method(api.api, "infrastructure", async (mode: Mode) => mode === "dev" ? ready : { mode: "prod", status: "empty", stale: false });
  mock.method(api.api, "synthesize", async (mode: Mode) => { runs.push(mode); return { ...ready, mode }; });
  await mount(); await ui.screen.findByRole("searchbox");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  await ui.screen.findByRole("button", { name: "Synthesize production" });
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("button", { name: "Synthesize production" }) as HTMLButtonElement).disabled, false));
  assert.deepEqual(runs, []);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Synthesize production" }));
  await ui.screen.findByRole("searchbox");
  assert.deepEqual(runs, ["prod"]);
});

test("an outdated running server explains how to recover instead of offering a synthesis that returns Not Found", async () => {
  let runs = 0;
  mock.method(api.api, "infrastructure", async () => { throw new api.ApiError(404, "Not Found"); });
  mock.method(api.api, "synthesize", async () => { runs++; return ready; });
  await mount();
  const alert = await ui.screen.findByRole("alert");
  assert.match(alert.textContent!, /Restart npm run studio/);
  assert.match(alert.textContent!, /No AWS deployment is needed/);
  assert.equal((ui.screen.getByRole("button", { name: "Synthesize development" }) as HTMLButtonElement).disabled, true);
  assert.equal(ui.screen.queryByText(/No successful synthesis/), null);
  assert.equal(runs, 0);
});

test("the inventory API rejects an old server's HTML fallback even when its HTTP status is successful", async () => {
  mock.method(globalThis, "fetch", async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
  for (const request of [() => api.api.infrastructure("dev"), () => api.api.synthesize("dev")]) {
    await assert.rejects(request(), (error: unknown) => error instanceof api.ApiError && error.status === 404);
  }
});

test("a logical inspector can reveal all app resources, including resources with no framework declaration", async () => {
  mock.method(api.api, "infrastructure", async () => ready);
  await mount(() => {}, "lambda:graphql-api");
  await ui.screen.findByRole("searchbox");
  assert.equal(ui.screen.queryByText("Internal", { selector: "strong" }), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Show all infrastructure" }));
  assert.ok(ui.screen.getByText("Internal", { selector: "strong" }));
  assert.ok(ui.screen.getByText("3 of 3 resources · 1 stacks"));
});

function environmentFixture() {
  const original = response.snapshot.models.dev.resources.find((resource) => resource.id === "envfile:dev")!;
  return { ...original, deploymentFile: { ...original.deploymentFile!, exists: true } };
}

test("the file inspector loads all local variables privately and links only catalog names", async () => {
  let reads = 0; let selected = "";
  mock.method(api.api, "resourceDetails", async () => { reads++; throw new Error("A file inspector must not read a value."); });
  mock.method(api.api, "inputDetails", async () => ({ file: "cdk-app/.env.dev", hash: "baseline", entries: [{ name: "OPENAI_API_KEY", value: "private-ui-sentinel", sensitive: true }, { name: "PGADMIN_HOST_PORT", value: "5050", sensitive: false }] }));
  const file = environmentFixture();
  await mount((id) => { selected = id; }, undefined, file);
  await ui.screen.findByLabelText("Value for PGADMIN_HOST_PORT");
  assert.ok(ui.screen.getByRole("link", { name: "Reference: cdk-app/.env.dev.example" }));
  assert.ok(ui.screen.getByText("OPENAI_API_KEY", { selector: "code" }));
  assert.equal((ui.screen.getByLabelText("Value for OPENAI_API_KEY") as HTMLInputElement).type, "password");
  assert.equal(ui.screen.queryByText("private-ui-sentinel"), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "openaiApiKey" }));
  assert.equal(selected, "resource:openaiApiKey"); assert.equal(reads, 0);
});

test("file value edits and additions stay in one guarded draft and Review Changes opens the combined review", async () => {
  let plans = 0; let applies = 0;
  const requests: import("../shared/deployment-inputs").DeploymentInputEdit[][] = [];
  mock.method(api.api, "inputDetails", async () => ({ file: "cdk-app/.env.dev", hash: "baseline", entries: [{ name: "PGADMIN_HOST_PORT", value: "5050", sensitive: false }, { name: "TOKEN", value: "old-private", sensitive: true }] }));
  mock.method(api.api, "inputPlan", async (mode: Mode, edits: readonly import("../shared/deployment-inputs").DeploymentInputEdit[], hash: string) => { plans++; requests.push([...edits]); assert.equal(mode, "dev"); assert.equal(hash, "baseline"); return { planId: "input-plan", ok: true, summaries: edits.map((edit) => `${edit.create ? "Add" : "Update"} ${edit.name}`), changes: [] }; });
  mock.method(api.api, "inputApply", async () => { applies++; return { status: "applied", revision: "saved", message: "Saved inputs." }; });
  mock.method(api.api, "snapshot", async () => ({ ...response, snapshot: { ...response.snapshot, revision: "saved" } }));
  await mount(() => {}, undefined, environmentFixture());
  ui.fireEvent.change(await ui.screen.findByLabelText("Value for PGADMIN_HOST_PORT"), { target: { value: "6060" } });
  ui.fireEvent.change(ui.screen.getByLabelText("Value for TOKEN"), { target: { value: "new-private" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add environment variable" }));
  assert.equal((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, true, "unfinished additions are guarded and invalid");
  ui.fireEvent.change(ui.screen.getByLabelText("New variable name 1"), { target: { value: "NEW_SETTING" } });
  ui.fireEvent.change(ui.screen.getByLabelText("Value for NEW_SETTING"), { target: { value: "new-value" } });
  assert.equal(plans, 0); assert.equal(applies, 0);
  assert.ok(ui.screen.getByText("3 unsaved changes"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  const warning = await ui.screen.findByRole("dialog", { name: "Unsaved changes" });
  ui.fireEvent.click(ui.within(warning).getByRole("button", { name: "Review Changes" }));
  const dialog = await ui.screen.findByRole("dialog", { name: "Review 3 changes" });
  await ui.within(dialog).findByText("Update PGADMIN_HOST_PORT");
  assert.equal(plans, 1); assert.equal(requests[0].length, 3);
  assert.ok(ui.within(dialog).getByText("Add NEW_SETTING"));
  assert.equal(ui.within(dialog).queryByText("new-private"), null);
  ui.fireEvent.click(ui.within(dialog).getByRole("button", { name: "Back to Editing" }));
  assert.equal((ui.screen.getByLabelText("Value for PGADMIN_HOST_PORT") as HTMLTextAreaElement).value, "6060");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await ui.screen.findByText("Add NEW_SETTING");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply All" }));
  await ui.waitFor(() => assert.equal(applies, 1));
  await ui.waitFor(() => assert.equal(ui.screen.queryByText("3 unsaved changes"), null));
});
