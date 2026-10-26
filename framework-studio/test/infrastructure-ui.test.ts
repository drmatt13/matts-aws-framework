import assert from "./support/assert";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h } from "react";
import { SnapshotBuilder } from "../server/snapshot";
import type { SnapshotResponse } from "../shared/api";
import type { InfrastructureState } from "../shared/infrastructure";
import type { Mode, ModelResource } from "../shared/model";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let router: typeof import("@tanstack/react-router");
let studio: typeof import("../src/studio");
let component: typeof import("../src/views/Infrastructure");
let shell: typeof import("../src/views/Shell");
let inputs: typeof import("../src/views/DeploymentInputs");
let clientInputs: typeof import("../src/views/ClientEnvironment");
let controls: typeof import("../src/views/DraftControls");
let review: typeof import("../src/views/EditDialog");
let api: typeof import("../src/api");
let builder: SnapshotBuilder;
let response: SnapshotResponse;
const clients: import("@tanstack/react-query").QueryClient[] = [];

const ready: InfrastructureState = { mode: "dev", status: "ready", stale: false, generatedAt: "2026-10-17T12:00:00Z", inputs: { file: "cdk-app/.env.dev", modeSelection: "Isolated development", profile: "dev" }, inventory: {
  version: 1, stacks: [{ id: "App", name: "App", environment: "aws://111111111111/us-east-1", dependencies: [], owners: ["resource:cognito"] }],
  resources: [
    { id: "function", stack: "App", logicalId: "Handler", type: "AWS::Lambda::Function", classification: "framework", owners: ["lambda:graphql-api"] },
    { id: "role", stack: "App", logicalId: "HandlerRole", type: "AWS::IAM::Role", classification: "supporting", owners: ["lambda:graphql-api"] },
    { id: "unknown", stack: "App", logicalId: "Internal", type: "AWS::SSM::Parameter", classification: "unowned", owners: [] },
  ], dependencies: [{ from: "function", to: "role", kind: "reference" }], notes: ["No deployed status is queried."] } };

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); query = require("@tanstack/react-query"); router = require("@tanstack/react-router");
  studio = await import("../src/studio"); component = await import("../src/views/Infrastructure"); api = await import("../src/api");
  shell = await import("../src/views/Shell");
  inputs = await import("../src/views/DeploymentInputs");
  clientInputs = await import("../src/views/ClientEnvironment");
  controls = await import("../src/views/DraftControls"); review = await import("../src/views/EditDialog");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, busy: null };
});
after(async () => { await builder.dispose(); dom.window.close(); });
afterEach(() => { ui.cleanup(); clients.splice(0).forEach((client) => client.clear()); mock.restoreAll(); });

async function mount(navigate: (id: string) => void = () => {}, initialOwner?: string, environmentFile?: ModelResource, withShell = false) {
  function Workbench() {
    const context = studio.useStudio();
    if (withShell) return h(shell.Shell, null,
      h("button", { onClick: () => context.select("island:stacks") }, "Stacks island settings"),
      h("button", { onClick: () => {
        const fact = context.model.fields["lambda:graphql-api"]!.find((fact) => fact.field === "lambda.memorySize")!;
        context.draft.setField("lambda:graphql-api", fact, 768);
      } }, "Stage memory edit"));
    return h("div", null, environmentFile?.clientEnvironment ? null : h("button", { onClick: () => context.setMode("prod") }, "Production"), environmentFile ? h("div", null, h(environmentFile.clientEnvironment ? clientInputs.ClientEnvironmentFileView : inputs.EnvironmentFileView, { resource: environmentFile }), h(controls.DraftFooter), h(controls.UnsavedChangesDialog), context.draftState.reviewOpen ? h(review.EditDialog, { review: context.draftState.review }) : null) : h(component.InfrastructurePanel, { key: context.mode, onNavigate: navigate, initialOwner }));
  }
  function Root() {
    const search = router.useSearch({ strict: false }) as { select?: string };
    const select = router.useNavigate();
    return h(studio.StudioProvider, { response, selected: search.select, select: (id) => { if (id) navigate(id); void select({ to: ".", search: { select: id } } as never); }, children: h(Workbench) });
  }
  const root = router.createRootRoute({ component: Root, validateSearch: (search) => ({ select: typeof search.select === "string" ? search.select : undefined }) });
  // Off the map's path, where the shell itself hosts the inspector beside a workspace.
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/workbench"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/workbench", component: () => null })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  if (withShell) await ui.screen.findByRole("button", { name: /Configuration health/ });
  else if (environmentFile) await ui.screen.findByRole("heading", { name: environmentFile.clientEnvironment ? ".env" : environmentFile.path[0] });
  else await ui.screen.findByRole("button", { name: /Synthesize CDK|Refresh from CDK/ });
}

test("the header keeps source mode and automatic health while saved-source audits stay explicit", async () => {
  const commands: unknown[][] = [];
  mock.method(api.api, "command", async (...args: unknown[]) => { commands.push(args); return { command: "framework:check", exitCode: 0, output: "All checks passed", durationMs: 20 }; });
  await mount(() => {}, undefined, undefined, true);
  const header = document.querySelector(".bar")! as HTMLElement;
  assert.equal(ui.within(header).queryByRole("button", { name: "Check" }), null);
  assert.equal(ui.within(header).queryByRole("button", { name: "Infrastructure" }), null);
  assert.equal(ui.within(header).queryByRole("button", { name: "Undo" }), null);
  assert.equal(ui.screen.queryByRole("group", { name: "Source edit history" }), null);
  assert.ok(ui.within(header).getByRole("group", { name: "Source environment" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /Configuration health/ }));
  assert.ok(ui.screen.getByText(/Source validation checks the saved declarations/));
  assert.equal(commands.length, 0);
  ui.fireEvent.click(ui.screen.getByText("Additional checks", { selector: "summary" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check generated files and wiring" }));
  await ui.screen.findByRole("heading", { name: "framework:check passed" });
  assert.deepEqual(commands, [["framework:check", false]]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to configuration health" }));
  assert.ok(ui.screen.getByRole("heading", { name: "Configuration health" }));
});

test("Stacks settings synthesize explicitly, switch inventories, and block synthesis during drafts", async () => {
  const runs: Mode[] = [];
  mock.method(api.api, "infrastructure", async (mode: Mode) => mode === "dev" ? ready : { mode, status: "empty", stale: false });
  mock.method(api.api, "synthesize", async (mode: Mode) => { runs.push(mode); return { ...ready, mode }; });
  await mount(() => {}, undefined, undefined, true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Stacks island settings" }));
  await ui.screen.findByRole("searchbox", { name: "Search infrastructure" });
  assert.ok(ui.screen.getByRole("heading", { name: "CDK infrastructure" }));
  assert.equal(ui.screen.queryByText(/The framework has no shared defaults/), null);
  assert.deepEqual(runs, []);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Refresh from CDK" }));
  await ui.waitFor(() => assert.deepEqual(runs, ["dev"]));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  const synthesize = await ui.screen.findByRole("button", { name: "Synthesize CDK" });
  await ui.waitFor(() => assert.equal((synthesize as HTMLButtonElement).disabled, false));
  assert.equal(ui.screen.queryByRole("searchbox", { name: "Search infrastructure" }), null);
  assert.deepEqual(runs, ["dev"]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Stage memory edit" }));
  assert.equal((synthesize as HTMLButtonElement).disabled, true);
  assert.ok(ui.screen.getByText(/Apply or discard the current draft before synthesizing/));
});

test("a stack browses CDK inline and opens the Stacks inspector for all resources", async () => {
  let runs = 0;
  mock.method(api.api, "infrastructure", async () => ready);
  mock.method(api.api, "synthesize", async () => { runs++; return ready; });
  await mount(() => {}, undefined, undefined, true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Stacks island settings" }));
  const entries = await ui.screen.findByText("Island entries", { selector: "summary span" });
  ui.fireEvent.click(entries.closest("summary")!);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "CognitoStack" }));
  const disclosure = await ui.screen.findByText("CDK infrastructure", { selector: "summary span" });
  ui.fireEvent.click(disclosure.closest("summary")!);
  await ui.screen.findByRole("searchbox", { name: "Search infrastructure" });
  assert.ok(ui.screen.getByText("Internal", { selector: "strong" }), "stack ownership includes children with unknown owners");
  assert.equal(document.querySelector(".drawer"), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Show all infrastructure" }));
  await ui.screen.findByRole("heading", { name: "Stacks" });
  assert.ok(ui.screen.getByText("Internal", { selector: "strong" }));
  assert.equal(runs, 0);
});

function openMapping(name: string) {
  const button = ui.screen.getByRole("button", { name: `Edit mapping for ${name}` });
  if (button.getAttribute("aria-expanded") !== "true") ui.fireEvent.click(button);
}

test("client mappings give a searchable source overview and use the selected environment", async () => {
  const file = response.snapshot.models.dev.resources.find((resource) => resource.clientEnvironment)!;
  let selected = "";
  await mount((id) => { selected = id; }, undefined, file);
  for (const entry of file.clientEnvironment!.entries) assert.ok(ui.screen.getByText(entry.name, { selector: "strong code" }));
  assert.equal(document.querySelector(".client-mapping-controls"), null, "source controls stay collapsed until needed");
  assert.equal(ui.screen.queryByRole("button", { name: /^Generate \.env/ }), null);
  openMapping("VITE_LOCAL_WS_URL");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open source for VITE_LOCAL_WS_URL" }));
  assert.equal(selected, "resource:enableWebSocketApi");
  openMapping("VITE_USER_POOL_ID");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open source for VITE_USER_POOL_ID" }));
  assert.equal(selected, "resource:cognito");
  ui.fireEvent.change(ui.screen.getByRole("searchbox", { name: "Search client mappings" }), { target: { value: "CognitoStack" } });
  assert.equal(ui.screen.queryByText("VITE_LOCAL_WS_URL", { selector: "strong code" }), null);
  assert.ok(ui.screen.getByText("VITE_USER_POOL_ID", { selector: "strong code" }));
  ui.fireEvent.change(ui.screen.getByRole("searchbox", { name: "Search client mappings" }), { target: { value: "" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  openMapping("VITE_API_GATEWAY_URL");
  assert.equal((ui.screen.getByRole("combobox", { name: "Stack for VITE_API_GATEWAY_URL" }) as HTMLSelectElement).value, "FrontendWebsiteS3Stack");
  assert.equal((ui.screen.getByRole("combobox", { name: "Mapping for VITE_API_GATEWAY_URL" }) as HTMLSelectElement).value, "CloudFrontUrl");
  openMapping("VITE_LOCAL_WS_URL");
  assert.equal((ui.screen.getByRole("combobox", { name: "Source type for VITE_LOCAL_WS_URL" }) as HTMLSelectElement).value, "empty");
});

test("client fields can be added, remapped, disabled, reviewed and discarded without writing before apply", async () => {
  const file = response.snapshot.models.dev.resources.find((resource) => resource.clientEnvironment)!;
  let changes: readonly import("../shared/api").DraftEdit[] = [];
  mock.method(api.api, "planBatch", async (edits: readonly import("../shared/api").DraftEdit[]) => { changes = edits; return { planId: "mappings", ok: true, summaries: ["Client mappings"], changes: [], impact: [], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } } }; });
  await mount(() => {}, undefined, file);
  openMapping("VITE_USER_POOL_ID");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Mapping for VITE_USER_POOL_ID" }), { target: { value: "UserPoolClientId" } });
  assert.match(ui.screen.getByRole("button", { name: "Edit mapping for VITE_USER_POOL_ID" }).textContent!, /CognitoStack.UserPoolClientId/, "preview follows the unsaved source");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Generate VITE_LOCAL_WS_URL in Development" }));
  openMapping("VITE_LOCAL_WS_URL");
  assert.ok(ui.screen.getByRole("combobox", { name: "Source type for VITE_LOCAL_WS_URL" }).matches(":disabled"));
  openMapping("VITE_API_GATEWAY_URL");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Protocol for VITE_API_GATEWAY_URL" }), { target: { value: "https" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Hostname for VITE_API_GATEWAY_URL" }), { target: { value: "app.localhost" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Port input for VITE_API_GATEWAY_URL" }), { target: { value: "WS_TESTER_HOST_PORT" } });
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "Use URL override for VITE_API_GATEWAY_URL" }));
  assert.ok((ui.screen.getByRole("combobox", { name: "Override input for VITE_API_GATEWAY_URL" }) as HTMLSelectElement).disabled);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add field" }));
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "New client field name" }), { target: { value: "VITE_CUSTOM_REGION" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add" }));
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Source type for VITE_CUSTOM_REGION" }), { target: { value: "region" } });
  assert.ok((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, "incomplete references cannot be reviewed");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Stack for VITE_CUSTOM_REGION" }), { target: { value: "CognitoStack" } });
  assert.equal(changes.length, 0, "editing does not call the server");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await ui.screen.findByRole("button", { name: "Apply All" });
  await ui.waitFor(() => assert.equal(changes.length, 1));
  assert.equal(changes[0]!.kind, "clientEnvironment");
  if (changes[0]!.kind !== "clientEnvironment") return;
  assert.equal(changes[0]!.mappings.VITE_LOCAL_WS_URL!.dev.enabled, false);
  assert.deepEqual(changes[0]!.mappings.VITE_API_GATEWAY_URL!.dev, { kind: "endpoint", protocol: "https", host: "app.localhost", port: "WS_TESTER_HOST_PORT" });
  assert.deepEqual(changes[0]!.mappings.VITE_CUSTOM_REGION, { dev: { kind: "region", stack: "CognitoStack" }, prod: { kind: "empty" } });
  assert.deepEqual(changes[0]!.mappings.VITE_USER_POOL_ID!.prod, file.clientEnvironment!.mappings.VITE_USER_POOL_ID!.prod);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard All" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Edit mapping for VITE_CUSTOM_REGION" }), null);
  assert.equal(ui.screen.getByRole("button", { name: "Generate VITE_LOCAL_WS_URL in Development" }).getAttribute("aria-pressed"), "true");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove VITE_USER_POOL_CLIENT_ID" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Edit mapping for VITE_USER_POOL_CLIENT_ID" }), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.ok(ui.screen.getByRole("button", { name: "Edit mapping for VITE_USER_POOL_CLIENT_ID" }));
});

test("changing source types requires explicit choices, preserves output fallbacks and resets one field", async () => {
  const file = response.snapshot.models.dev.resources.find((resource) => resource.clientEnvironment)!;
  await mount(() => {}, undefined, file);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  openMapping("VITE_API_GATEWAY_URL");
  assert.ok(ui.screen.getByText(/Fallback outputs:/));
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "Allow empty VITE_API_GATEWAY_URL" }));
  assert.ok(ui.screen.getByText(/Fallback outputs:/), "unrelated options retain authored output fallbacks");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Stack for VITE_API_GATEWAY_URL" }), { target: { value: "CognitoStack" } });
  assert.equal((ui.screen.getByRole("combobox", { name: "Mapping for VITE_API_GATEWAY_URL" }) as HTMLSelectElement).value, "");
  assert.ok((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Mapping for VITE_API_GATEWAY_URL" }), { target: { value: "UserPoolDomainUrl" } });
  assert.equal((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Reset mapping for VITE_API_GATEWAY_URL" }));
  assert.ok(ui.screen.getByText(/Fallback outputs:/));
  assert.equal(ui.screen.queryByRole("button", { name: "Review Changes" }), null);
});

test("client field pills configure both environments and rename retains both recipes with duplicate validation", async () => {
  const file = response.snapshot.models.dev.resources.find((resource) => resource.clientEnvironment)!;
  let changes: readonly import("../shared/api").DraftEdit[] = [];
  mock.method(api.api, "planBatch", async (edits: readonly import("../shared/api").DraftEdit[]) => { changes = edits; return { planId: "rename", ok: true, summaries: ["Client mappings"], changes: [], impact: [], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } } }; });
  await mount(() => {}, undefined, file);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Generate VITE_USER_POOL_ID in Production" }));
  assert.equal(ui.screen.getByRole("button", { name: "Generate VITE_USER_POOL_ID in Development" }).getAttribute("aria-pressed"), "true");
  assert.equal(ui.screen.getByRole("button", { name: "Generate VITE_USER_POOL_ID in Production" }).getAttribute("aria-pressed"), "false");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Rename VITE_USER_POOL_ID" }));
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "New name for VITE_USER_POOL_ID" }), { target: { value: "VITE_AWS_REGION" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save name" }));
  assert.ok(ui.screen.getByRole("alert").textContent!.includes("already exists"));
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "New name for VITE_USER_POOL_ID" }), { target: { value: "bad name" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save name" }));
  assert.ok(ui.screen.getByRole("alert").textContent!.includes("VITE_"));
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "New name for VITE_USER_POOL_ID" }), { target: { value: "VITE_RENAMED_POOL" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save name" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Rename VITE_USER_POOL_ID" }), null);
  assert.ok(ui.screen.getByRole("button", { name: "Rename VITE_RENAMED_POOL" }));
  assert.equal(changes.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await ui.screen.findByRole("button", { name: "Apply All" });
  if (changes[0]?.kind !== "clientEnvironment") return assert.fail("Expected a client mapping draft");
  assert.equal(changes[0].mappings.VITE_USER_POOL_ID, undefined);
  assert.deepEqual(changes[0].mappings.VITE_RENAMED_POOL, { dev: file.clientEnvironment!.mappings.VITE_USER_POOL_ID!.dev, prod: { ...file.clientEnvironment!.mappings.VITE_USER_POOL_ID!.prod, enabled: false } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard All" }));
  assert.ok(ui.screen.getByRole("button", { name: "Rename VITE_USER_POOL_ID" }));
  assert.equal(ui.screen.getByRole("button", { name: "Generate VITE_USER_POOL_ID in Production" }).getAttribute("aria-pressed"), "true");
});

test("client environment switches honor the unsaved draft guard", async () => {
  const file = response.snapshot.models.dev.resources.find((resource) => resource.clientEnvironment)!;
  await mount(() => {}, undefined, file);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Generate VITE_LOCAL_WS_URL in Development" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  await ui.screen.findByRole("heading", { name: "Unsaved changes" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  assert.equal(ui.screen.getByRole("button", { name: "Development" }).getAttribute("aria-pressed"), "true");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Production" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard and Continue" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByRole("button", { name: "Production" }).getAttribute("aria-pressed"), "true"));
  assert.equal(ui.screen.getByRole("button", { name: "Generate VITE_LOCAL_WS_URL in Development" }).getAttribute("aria-pressed"), "true");
});

test("inventory search, type/owner filters and owner navigation use synthesis evidence without starting a job", async () => {
  let runs = 0; let selected = "";
  mock.method(api.api, "infrastructure", async () => ready);
  mock.method(api.api, "synthesize", async () => { runs++; return ready; });
  await mount((id) => { selected = id; });
  await ui.screen.findByRole("searchbox", { name: "Search infrastructure" });
  ui.fireEvent.change(ui.screen.getByRole("searchbox"), { target: { value: "IAM role" } });
  assert.ok(ui.screen.getByText("1 of 3 resources · 1 stacks"));
  ui.fireEvent.change(ui.screen.getByRole("searchbox"), { target: { value: "" } });
  ui.fireEvent.click(ui.screen.getByText("Filter resources", { selector: "summary" }));
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
  ui.fireEvent.click(ui.screen.getByText("Filter resources", { selector: "summary" }));
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
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Refresh from CDK" }));
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
  await ui.screen.findByRole("button", { name: "Synthesize CDK" });
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("button", { name: "Synthesize CDK" }) as HTMLButtonElement).disabled, false));
  assert.deepEqual(runs, []);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Synthesize CDK" }));
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
  assert.equal((ui.screen.getByRole("button", { name: "Synthesize CDK" }) as HTMLButtonElement).disabled, true);
  assert.equal(ui.screen.queryByText(/No successful synthesis/), null);
  assert.equal(runs, 0);
});

test("the inventory API rejects an old server's HTML fallback even when its HTTP status is successful", async () => {
  mock.method(globalThis, "fetch", async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
  for (const request of [() => api.api.infrastructure("dev"), () => api.api.synthesize("dev")]) {
    await assert.rejects(request(), (error: unknown) => error instanceof api.ApiError && error.status === 502 && /Restart npm run studio/.test(error.message));
  }
});

test("a logical inspector can reveal all app resources, including resources with no framework declaration", async () => {
  let selected = "";
  mock.method(api.api, "infrastructure", async () => ready);
  await mount((id) => { selected = id; }, "lambda:graphql-api");
  await ui.screen.findByRole("searchbox");
  assert.equal(ui.screen.queryByText("Internal", { selector: "strong" }), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Show all infrastructure" }));
  assert.equal(selected, "island:stacks");
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
  assert.ok(ui.screen.getByRole("link", { name: "Template: cdk-app/.env.dev.template" }));
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

test("a stale page blocks source writes before transport and explains how to reload the server", async () => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="studio-protocol"]')!;
  const original = meta.content;
  meta.content = "1";
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; throw new Error("A stale page must not send a write."); });
  try {
    await assert.rejects(api.api.applyBatch("not-sent"), (error: unknown) => error instanceof api.ApiError && error.status === 409 && /Restart npm run studio/.test(error.message));
    assert.equal(calls, 0);
  } finally { meta.content = original; }
});
