import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { createElement as h } from "react";
import type { DraftEdit, SnapshotResponse } from "../shared/api";
import type { Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";

let builder: SnapshotBuilder;
let baseline: Snapshot;
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let inspector: typeof import("../src/views/Inspector");
let dialogs: typeof import("../src/views/DraftControls");
let review: typeof import("../src/views/EditDialog");
let apiModule: typeof import("../src/api");
let planCalls: (readonly DraftEdit[])[];
let resourceCalls: unknown[];
let applyCalls: number;
let failApply: boolean;
let failReview: boolean;
let reviewGate: Promise<void> | undefined;
let persisted: Snapshot;
let dom: { window: Window & typeof globalThis };
const target = "lambda:graphql-api";

before(async () => {
  const { JSDOM } = createRequire(import.meta.url)("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  // Match tsx's CommonJS loading of Studio's TSX, so the providers and hooks use
  // the same package instance rather than separate ESM/CommonJS contexts.
  const require = createRequire(import.meta.url);
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  ui.configure({ getElementError: (message) => new Error(message ?? "Element not found") });
  studio = await import("../src/studio"); inspector = await import("../src/views/Inspector"); dialogs = await import("../src/views/DraftControls"); review = await import("../src/views/EditDialog"); apiModule = await import("../src/api");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../..")); baseline = (await builder.refresh()).snapshot;
});
after(async () => { await builder.dispose(); dom.window.close(); });
afterEach(() => { ui.cleanup(); mock.restoreAll(); });
beforeEach(() => {
  persisted = baseline; planCalls = []; resourceCalls = []; applyCalls = 0; failApply = false; failReview = false; reviewGate = undefined;
  mock.method(apiModule.api, "planBatch", async (edits: readonly DraftEdit[]) => {
    planCalls.push(edits);
    await reviewGate;
    if (failReview) throw new Error("Could not validate changes. Try reviewing again.");
    return { planId: "batch", ok: true, summaries: edits.map((edit) => edit.kind === "field" ? `${edit.intent.field}: ${String(edit.intent.value ?? "inherit")}` : edit.value), changes: [{ file: "framework-config/settings.ts", diff: { unified: "combined", lines: [{ kind: "add", text: "// complete proposed draft", newLine: 1 }] } }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, impact: [] };
  });
  mock.method(apiModule.api, "applyBatch", async () => {
    applyCalls++; if (failApply) throw new Error("Source changed. Your draft is preserved.");
    const fields = (mode: "dev" | "prod") => Object.fromEntries(Object.entries(baseline.models[mode].fields).map(([target, facts]) => [target, facts.map((fact) => {
      const edit = planCalls.at(-1)?.find((edit) => edit.kind === "field" && edit.intent.target === target && edit.intent.field === fact.field);
      if (edit?.kind !== "field") return fact;
      return { ...fact, authored: edit.intent.inherit ? undefined : edit.intent.value, effective: edit.intent.inherit ? fact.inherited?.value : edit.intent.value };
    })]));
    persisted = { ...baseline, revision: "saved", models: { dev: { ...baseline.models.dev, fields: fields("dev") }, prod: { ...baseline.models.prod, fields: fields("prod") } } } as Snapshot;
    return { status: "applied", message: "Applied all changes.", revision: persisted.revision };
  });
  mock.method(apiModule.api, "snapshot", async () => response());
  mock.method(apiModule.api, "resourceDetails", async () => ({ configured: false, consumers: [], history: {} }));
  mock.method(apiModule.api, "resourcePlan", async (intent: unknown) => { resourceCalls.push(intent); await reviewGate; return { planId: "resource", resource: "resource:input", nextResource: "resource:input", ok: true, diagnostics: [], changes: [{ file: "framework-config/resources.ts", diff: { unified: "resource changes", lines: [] } }] }; });
});
function response(): SnapshotResponse { return { snapshot: persisted, evaluating: false, history: {}, commands: {}, busy: null }; }

async function mount(selected = target) {
  function Workbench() {
    const context = studio.useStudio();
    return h("div", null,
      h("button", { onClick: () => context.select("lambda:sign-in") }, "Open node B"),
      h("button", { onClick: () => context.select("island:lambda") }, "Open island"),
      h(router.Link, { to: "/other" }, "Other view"),
      h("output", { "aria-label": "Current selection" }, context.selected ?? "none"),
      h(inspector.Inspector),
      context.draftState.reviewOpen ? h(review.EditDialog, { review: context.draftState.review }) : null,
      h(dialogs.UnsavedChangesDialog));
  }
  function Root() {
    const search = router.useSearch({ strict: false }) as { select?: string };
    const navigate = router.useNavigate();
    const current = apiModule.useSnapshot().data!;
    return h(studio.StudioProvider, { response: current, selected: search.select, select: (id: string | undefined) => void navigate({ to: ".", search: { select: id } } as never), children: h(Workbench) });
  }
  const root = router.createRootRoute({ component: Root, validateSearch: (search) => ({ select: typeof search.select === "string" ? search.select : undefined }) });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: [`/?select=${encodeURIComponent(selected)}`] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null }), router.createRoute({ getParentRoute: () => root, path: "/other", component: () => null })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); client.setQueryData(["snapshot"], response());
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.screen.findByRole("complementary", { name: "Inspector" });
  return app;
}
const memory = () => ui.screen.getByRole("spinbutton", { name: "Memory in MB" });
const changeMemory = () => ui.fireEvent.change(memory(), { target: { value: "768" } });
const count = () => ui.screen.getByLabelText("Pending inspector changes").textContent!;
const waitDialog = (name: string) => ui.waitFor(() => assert.equal(document.querySelector("dialog[open] h2")?.textContent, name));

test("stack inspectors surface unattached status and the database's framework ownership in their headers", async () => {
  await mount("resource:referenceExamples");
  const panel = ui.screen.getByRole("complementary", { name: "Inspector" });
  assert.ok(ui.within(panel.querySelector("header")!).getByText("Not added to CDK app"));
  ui.cleanup();
  await mount("resource:rds");
  assert.ok(ui.within(ui.screen.getByRole("complementary", { name: "Inspector" }).querySelector("header")!).getByText("Framework managed"));
});

test("an exported framework stack shows symbolic CfnOutputs and root env names without generic infrastructure controls", async () => {
  await mount("framework-stack:DevLambdaReplayStack");
  assert.ok(ui.screen.getByRole("heading", { name: "DevLambdaReplayStack" }));
  assert.ok(ui.screen.getByText("Framework managed"));
  assert.ok(ui.screen.getByText("Not defined in resources"));
  assert.ok(ui.screen.getByRole("heading", { name: "CloudFormation outputs" }));
  assert.ok(ui.screen.getByText((_text, element) => element?.tagName === "CODE" && element.textContent === "$queue.queueArn"));
  assert.ok(ui.screen.getByText("DEV_LAMBDA_REPLAY_QUEUE_ARN", { selector: "code" }));
  assert.equal(ui.screen.queryByText("ReplayDeadLetterQueueUrl"), null);
  assert.equal(ui.screen.queryByRole("button", { name: "Inspect stack infrastructure" }), null);
  assert.equal(ui.screen.queryByRole("heading", { name: "Infrastructure" }), null);
});

test("the stacks island distinguishes missing catalog declarations from missing CDK constructors", async () => {
  await mount("island:stacks");
  for (const name of ["FrontendWebsiteS3Stack", "DevLambdaReplayStack", "WebSocketApiStack", "HttpApiGatewayStack"]) {
    const row = ui.screen.getByRole("button", { name }).closest("li")!;
    assert.ok(ui.within(row).getByText("Framework managed"));
    assert.ok(ui.within(row).getByText("Not defined in resources"));
    assert.equal(ui.within(row).queryByText("Not added to CDK app"), null);
  }
  for (const name of ["CognitoStack", "RdsStack", "ReferenceExampleStack"]) {
    const row = ui.screen.getByRole("button", { name }).closest("li")!;
    assert.equal(ui.within(row).queryByText("Not defined in resources"), null);
    if (name === "ReferenceExampleStack") assert.ok(ui.within(row).getByText("Not added to CDK app"));
  }
});

test("API node and island details identify the framework config managing each route", async () => {
  const sections = { http: "http", service: "services", webSocket: "websocket", agent: "agents" } as const;
  for (const [kind, section] of Object.entries(sections)) {
    const route = baseline.models.dev.routes.find((route) => route.kind === kind)!;
    assert.ok(route, `the repository has a ${kind} route`);
    await mount(route.id);
    const header = ui.screen.getByRole("complementary", { name: "Inspector" }).querySelector("header")!;
    assert.ok(ui.within(header).getByText(`Managed by framework-config/${section}`));
    assert.ok(ui.within(header).getByText(route.origin));
    ui.cleanup();
  }
  await mount("island:apis");
  for (const section of Object.values(sections)) assert.ok(ui.screen.getAllByText(`Managed by framework-config/${section}`).length);
});

test("event Lambda local replay switches stage true or property removal through the shared draft", async () => {
  for (const [id, enabled] of [["cognito-custom-message", false], ["cognito-post-confirmation-trigger", true]] as const) {
    await mount(`lambda:${id}`);
    const control = ui.screen.getByRole("switch", { name: "Local replay" });
    assert.equal(control.getAttribute("aria-checked"), String(enabled));
    assert.equal(ui.screen.queryByRole("switch", { name: "API user-pool authorizer" }), null);
    ui.fireEvent.click(control);
    assert.equal(control.getAttribute("aria-checked"), String(!enabled));
    assert.match(count(), /1 unsaved change/);
    await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); });
    await waitDialog("Review 1 change");
    assert.deepEqual(planCalls.at(-1), [{ kind: "field", intent: enabled
      ? { target: `lambda:${id}`, field: "events.localReplay", inherit: true }
      : { target: `lambda:${id}`, field: "events.localReplay", value: true } }]);
    ui.cleanup();
  }
  await mount();
  assert.equal(ui.screen.queryByRole("switch", { name: "Local replay" }), null);
});

test("required flags stage quietly and the connection inspector guides missing values into the file draft", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "input" && item.fromEnv)!;
  const requirement = { resource: resource.id, name: resource.fromEnv!, mode: "dev" as const, file: "cdk-app/.env.dev", required: true, status: "missing" as const, reasons: ["Marked required in the resource declaration."] };
  const fileResource = baseline.models.dev.resources.find((item) => item.id === "envfile:dev")!;
  const entry = { name: resource.fromEnv!, status: "missing" as const, sensitive: false, defaulted: false, targets: [resource.id], requirements: [requirement] };
  const edge = { id: "required-fixture", from: "envfile:dev", to: resource.id, relation: "supplies" as const, provenance: "source" as const, label: resource.fromEnv!, inputRequirement: requirement };
  persisted = { ...baseline, models: { ...baseline.models, dev: { ...baseline.models.dev,
    resources: baseline.models.dev.resources.map((item) => item.id === resource.id ? { ...item, required: true, default: undefined, inputRequirement: requirement } : item.id === fileResource.id ? { ...item, deploymentFile: { ...fileResource.deploymentFile!, exists: true, entries: [entry] } } : item), edges: [...baseline.models.dev.edges, edge] } } };
  mock.method(apiModule.api, "inputDetails", async () => ({ file: "cdk-app/.env.dev", hash: "fixture", entries: [] }));
  await mount(edge.id);
  assert.ok(ui.screen.getByText("Required value missing"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Edit .env.dev" }));
  await ui.screen.findByRole("heading", { name: ".env.dev" });
  assert.ok(ui.screen.getByRole("heading", { name: "Required inputs (1)" }));
  const set = await ui.screen.findByRole("button", { name: `Set ${resource.fromEnv}` });
  await ui.waitFor(() => assert.equal((set as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(set);
  assert.ok(ui.screen.getByText(/A blank value will not satisfy this requirement/));
  assert.equal(planCalls.length + resourceCalls.length, 0, "guided editing does not force review");
});

test("the catalog-wide required checkbox participates in the unified resource draft", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "input" && item.fromEnv)!;
  await mount(resource.id);
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Required input" }));
  assert.equal(resourceCalls.length, 0);
  assert.match(count(), /1 unsaved change/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await ui.waitFor(() => assert.equal(resourceCalls.length, 1));
  assert.equal((resourceCalls[0] as { required: boolean }).required, true);
});

test("actual switches stage immediately, five controls share one review, and Apply All commits once", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "API user-pool authorizer" }));
  assert.ok(document.querySelector("dialog[open]") === null); assert.equal(planCalls.length, 0);
  changeMemory(); ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Timeout in s" }), { target: { value: "25" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Architecture" }), { target: { value: "x86_64" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Log retention" }), { target: { value: "14" } });
  assert.match(count(), /5 unsaved changes/); assert.equal(planCalls.length, 0);
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); });
  await waitDialog("Review 5 changes"); assert.equal(planCalls[0].length, 5);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal((memory() as HTMLInputElement).value, "768"); assert.match(count(), /5 unsaved changes/);
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); });
  await waitDialog("Review 5 changes"); ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply All" }));
  await ui.waitFor(() => assert.ok(ui.screen.queryByLabelText("Pending inspector changes") === null));
  assert.equal(applyCalls, 1); assert.equal((memory() as HTMLInputElement).value, "768");
});

test("actual router node selection is guarded; Keep Editing and Discard and Continue work", async () => {
  await mount(); changeMemory(); ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" }));
  await waitDialog("Unsaved changes");
  assert.equal(ui.screen.getByLabelText("Current selection").textContent, target);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  await ui.waitFor(() => assert.ok(document.querySelector("dialog[open]") === null)); assert.equal((memory() as HTMLInputElement).value, "768");
  assert.equal(planCalls.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" })); await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard and Continue" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Current selection").textContent, "lambda:sign-in"));
  assert.ok(ui.screen.queryByLabelText("Pending inspector changes") === null);
});

test("closing, changing views and island selection all use the same navigation warning", async () => {
  const app = await mount(); changeMemory();
  for (const name of ["Close the inspector", "Open island", "Other view"]) {
    ui.fireEvent.click(ui.screen.getByRole(name === "Other view" ? "link" : "button", { name }));
    await waitDialog("Unsaved changes");
    assert.equal(ui.screen.getByLabelText("Current selection").textContent, target);
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
    await ui.waitFor(() => assert.ok(document.querySelector("dialog[open]") === null));
  }
  assert.equal(app.state.location.pathname, "/"); assert.equal((memory() as HTMLInputElement).value, "768");
});

test("Review Changes from the navigation warning opens immediately while validation is pending", async () => {
  let finish!: () => void;
  reviewGate = new Promise<void>((resolve) => { finish = resolve; });
  await mount(); changeMemory(); ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Timeout in s" }), { target: { value: "25" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open island" })); await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.within(document.querySelector("dialog[open]")! as HTMLElement).getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 2 changes"); assert.equal(planCalls[0].length, 2);
  assert.equal(document.querySelectorAll("dialog[open]").length, 1);
  assert.match(document.querySelector("dialog[open]")!.textContent!, /Checking all changes/);
  assert.ok((ui.screen.getByRole("button", { name: "Apply All" }) as HTMLButtonElement).disabled);
  await ui.act(async () => finish());
  assert.ok(ui.screen.getByLabelText("Changes to framework-config/settings.ts"));
  assert.equal(ui.screen.getByLabelText("Current selection").textContent, target);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" })); assert.equal((memory() as HTMLInputElement).value, "768");
});

test("resource review also opens immediately from the warning before TypeScript validation finishes", async () => {
  let finish!: () => void;
  reviewGate = new Promise<void>((resolve) => { finish = resolve; });
  const resource = baseline.models.dev.resources.find((resource) => resource.kind === "input" && !resource.absent)!;
  await mount(resource.id);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Resource group" }), { target: { value: "draftGroup" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close the inspector" })); await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.within(document.querySelector("dialog[open]")! as HTMLElement).getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.match(document.querySelector("dialog[open]")!.textContent!, /Checking all changes/);
  assert.equal(resourceCalls.length, 1);
  await ui.act(async () => finish());
  assert.ok(ui.screen.getByLabelText("Changes to framework-config/resources.ts"));
  assert.equal((ui.screen.getByRole("button", { name: "Apply All" }) as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal((ui.screen.getByRole("combobox", { name: "Resource group" }) as HTMLInputElement).value, "draftGroup");
});

test("review errors stay in the review dialog and can be retried without losing the draft", async () => {
  failReview = true;
  await mount(); changeMemory();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" })); await waitDialog("Unsaved changes");
  await ui.act(async () => { ui.fireEvent.click(ui.within(document.querySelector("dialog[open]")! as HTMLElement).getByRole("button", { name: "Review Changes" })); });
  await waitDialog("Review 1 change");
  assert.match(document.querySelector("dialog[open]")!.textContent!, /Could not validate changes/);
  assert.ok((ui.screen.getByRole("button", { name: "Apply All" }) as HTMLButtonElement).disabled);
  failReview = false;
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Retry Review" })); });
  assert.ok(ui.screen.getByLabelText("Changes to framework-config/settings.ts"));
  assert.equal(planCalls.length, 2);
  assert.equal((memory() as HTMLInputElement).value, "768");
});

test("invalid values are inline, failed applies preserve drafts, and beforeunload only protects dirty sessions", async () => {
  await mount();
  const exit = () => { const event = new dom.window.Event("beforeunload", { cancelable: true }); dom.window.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(exit(), false);
  ui.fireEvent.change(memory(), { target: { value: "1" } }); assert.equal(memory().getAttribute("aria-invalid"), "true");
  assert.ok((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled);
  changeMemory(); assert.equal(exit(), true); failApply = true;
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); }); await waitDialog("Review 1 change");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply All" }));
  await ui.waitFor(() => assert.ok(document.querySelector("dialog[open]") === null));
  assert.equal((memory() as HTMLInputElement).value, "768"); assert.match(count(), /1 unsaved change/); assert.match(count(), /Source changed/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" })); assert.equal(exit(), false);
});

test("resource controls and island service groups participate in the same shared session", async () => {
  const resource = baseline.models.dev.resources.find((resource) => resource.kind === "input" && !resource.absent)!;
  await mount(resource.id);
  await ui.waitFor(() => assert.ok(ui.screen.queryByText("Reading cdk-app/.env…") === null));
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Resource group" }), { target: { value: "draftGroup" } });
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Secret" }));
  assert.equal(resourceCalls.length, 0); assert.ok(ui.screen.getByLabelText("Pending inspector changes"));
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); }); await ui.screen.findByRole("button", { name: "Apply All" }); assert.equal(resourceCalls.length, 1);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard All" })); ui.cleanup();
  await mount("island:lambda");
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "Minify" }));
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Default service type" }), { target: { value: "defaults:webSocket" } });
  ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Timeout in s" }), { target: { value: "5" } });
  assert.match(count(), /2 unsaved changes/);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Default service type" }), { target: { value: "defaults:lambda" } });
  assert.equal(ui.screen.getByRole("switch", { name: "Minify" }).getAttribute("aria-checked"), "false");
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); }); await waitDialog("Review 2 changes"); assert.equal(planCalls[0].length, 2);
});
