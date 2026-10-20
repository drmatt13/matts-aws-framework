import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { createElement as h } from "react";
import type { DraftEdit, SnapshotResponse } from "../shared/api";
import type { Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { connectionDescriptionId } from "../shared/descriptions";
import { aggregateConnections } from "../src/connections";

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
    return { planId: "batch", ok: true, summaries: edits.map((edit) => edit.kind === "clientEnvironment" ? "client mappings" : edit.kind === "field" ? `${edit.intent.field}: ${String(edit.intent.value ?? "inherit")}` : edit.kind === "triggers" ? edit.event : edit.kind === "nativeTrigger" ? edit.edge : edit.kind === "onFailure" ? edit.event : edit.value), changes: [{ file: "framework-config/settings.ts", diff: { unified: "combined", lines: [{ kind: "add", text: "// complete proposed draft", newLine: 1 }] } }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, impact: [] };
  });
  mock.method(apiModule.api, "applyBatch", async () => {
    applyCalls++; if (failApply) throw new Error("Source changed. Your draft is preserved.");
    const fields = (mode: "dev" | "prod") => Object.fromEntries(Object.entries(baseline.models[mode].fields).map(([target, facts]) => [target, facts.map((fact) => {
      const edit = planCalls.at(-1)?.find((edit) => edit.kind === "field" && edit.intent.target === target && edit.intent.field === fact.field);
      if (edit?.kind !== "field") return fact;
      return { ...fact, authored: edit.intent.inherit ? undefined : edit.intent.value, effective: edit.intent.inherit ? fact.inherited?.value : edit.intent.value };
    })]));
    const descriptions = { ...baseline.descriptions.values };
    for (const edit of planCalls.at(-1) ?? []) if (edit.kind === "description") descriptions[edit.entity] = edit.value;
    persisted = { ...baseline, revision: "saved", descriptions: { values: descriptions }, models: { dev: { ...baseline.models.dev, fields: fields("dev") }, prod: { ...baseline.models.prod, fields: fields("prod") } } } as Snapshot;
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

test("node descriptions stage with workload settings, review, save and reload in the inspector", async () => {
  await mount();
  const description = ui.screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
  assert.equal(description.value, baseline.descriptions.values[target]);
  const value = "Updated GraphQL notes\nSecond paragraph.";
  ui.fireEvent.change(description, { target: { value } });
  changeMemory();
  assert.equal(planCalls.length, 0);
  assert.match(count(), /2 unsaved changes/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 2 changes");
  await ui.waitFor(() => assert.ok(planCalls[0]?.some((edit) => edit.kind === "description" && edit.entity === target && edit.value === value)));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply All" }));
  await ui.waitFor(() => assert.ok(ui.screen.queryByLabelText("Pending inspector changes") === null));
  assert.equal(persisted.descriptions.values[target], value);
  assert.equal((ui.screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value, value);
});

test("all selectable item kinds expose their authored description", async () => {
  for (const id of ["route:http:/graphql", "resource:cognito", "resource:cognito.userPool", "resource:openaiApiKey", "framework-stack:DevLambdaReplayStack", "envfile:dev", "local:postgres", "island:vpc", "prop:endpoint:s3"]) {
    await mount(id);
    const description = ui.screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    assert.equal(description.value, baseline.descriptions.values[id], id);
    assert.equal(description.disabled, false, id);
    ui.cleanup();
  }
});

test("read connection labels open compact evidence with line-numbered VS Code links", async () => {
  await mount("lambda:sign-out");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "TRUSTED_FRONTEND_ORIGINS" }));
  await ui.screen.findByRole("heading", { name: "TRUSTED_FRONTEND_ORIGINS" });
  const configuration = ui.screen.getByText("Configuration", { selector: "summary" });
  assert.equal(configuration.closest("details")!.open, false);
  ui.fireEvent.click(configuration);
  const evidence = baseline.models.dev.edges.find((edge) => edge.from === "lambda:sign-out" && edge.label === "TRUSTED_FRONTEND_ORIGINS")!.evidence!;
  for (const item of evidence) {
    const link = ui.screen.getByRole("link", { name: `${item.location.line} ${item.excerpt}` });
    assert.ok(link.getAttribute("href")?.startsWith("vscode://file/"));
    assert.ok(link.getAttribute("href")?.endsWith(`:${item.location.line}:${item.location.column}`));
  }
  assert.equal(planCalls.length, 0);
  ui.cleanup();
  const derived = baseline.models.dev.edges.find((edge) => edge.from === target && edge.label === "USER_POOL_ID")!;
  await mount(derived.id);
  ui.fireEvent.click(ui.screen.getByText("Configuration", { selector: "summary" }));
  assert.ok(ui.screen.getByText("Derived from the linked declaration."));
  assert.ok(ui.screen.getByRole("link", { name: /userPool: true/ }));
});

test("a plain connection has no filler context and optional descriptions review, save and reload", async () => {
  const edge = { id: "plain-connection", from: target, to: "resource:cognito", relation: "env" as const, provenance: "declared" as const, label: "Mapping" };
  persisted = { ...baseline, models: { dev: { ...baseline.models.dev, edges: [...baseline.models.dev.edges, edge] }, prod: { ...baseline.models.prod, edges: [...baseline.models.prod.edges, edge] } } };
  await mount(edge.id);
  assert.equal(ui.screen.queryByText("This relationship comes from the framework graph."), null);
  assert.equal(ui.screen.queryByText("Configuration", { selector: "summary" }), null);
  const add = ui.screen.getByText("Add description", { selector: "summary" });
  assert.equal(add.closest("details")!.open, false);
  ui.fireEvent.click(add);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Description" }), { target: { value: "Used for account identity." } });
  assert.equal(planCalls.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "description", entity: connectionDescriptionId(edge), value: "Used for account identity." }]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply All" }));
  await ui.waitFor(() => assert.equal(applyCalls, 1));
  await ui.waitFor(() => assert.equal(ui.screen.queryByLabelText("Pending inspector changes"), null));
  // The mock reloads the original graph; put this synthetic connection back for a fresh inspector.
  ui.cleanup();
  persisted = { ...persisted, models: { ...persisted.models, dev: { ...persisted.models.dev, edges: [...persisted.models.dev.edges, edge] } } };
  await mount(edge.id);
  ui.fireEvent.click(ui.screen.getByText("Description", { selector: "summary" }));
  assert.equal((ui.screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value, "Used for account identity.");
});

test("grouped relationships have separate description drafts and unique accessible fields", async () => {
  const group = aggregateConnections(baseline.models.dev, Object.values(baseline.models)).find((group) => group.members.length > 1)!;
  assert.ok(group);
  await mount(group.id);
  const members = [...document.querySelectorAll<HTMLDetailsElement>(".connection-map-member")].slice(0, 2);
  for (const [index, member] of members.entries()) {
    ui.fireEvent.click(member.querySelector("summary")!);
    ui.fireEvent.click(ui.within(member).getByText("Add description", { selector: "summary" }));
    ui.fireEvent.change(ui.within(member).getByRole("textbox", { name: "Description" }), { target: { value: `Relationship ${index + 1}` } });
  }
  const fields = ui.screen.getAllByRole("textbox", { name: "Description" });
  assert.equal(new Set(fields.map((field) => field.id)).size, 2);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 2 changes");
  assert.deepEqual(planCalls[0], group.members.slice(0, 2).map((member, index) => ({ kind: "description", entity: connectionDescriptionId(member.edge), value: `Relationship ${index + 1}` })));
});

test("event and public-field trigger flows stage through the shared review and keep native hooks occupied", async () => {
  for (const selected of ["lambda:cognito-pre-signup-trigger", "resource:cognito.userPool"]) {
    await mount(selected);
    const summary = ui.screen.getByText(/^Triggers/, { selector: "summary" });
    assert.equal(summary.closest("details")!.open, false);
    ui.fireEvent.click(summary);
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add trigger" }));
    if (selected.startsWith("lambda:")) {
      ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Cognito: \d+ usable$/ }));
      ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use userPool" }));
    } else {
      const selector = ui.screen.getByRole("combobox", { name: "Trigger event Lambda" });
      assert.equal(selector.querySelectorAll("option").length, baseline.models.dev.targets.filter((item) => item.role === "event").length + 1);
      ui.fireEvent.change(selector, { target: { value: "invocation-test-step" } });
    }
    const hooks = ui.screen.getByRole("combobox", { name: "Trigger Hook" });
    assert.equal((ui.within(hooks).getByRole("option", { name: "preSignUp · occupied" }) as HTMLOptionElement).disabled, true);
    assert.equal((hooks as HTMLSelectElement).value, "preAuthentication", "the first free hook is pre-selected");
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Next" }));
    const add = ui.screen.getByRole("button", { name: "Add trigger" }) as HTMLButtonElement;
    assert.equal(add.disabled, true, "the handler contract still needs acknowledging");
    ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Acknowledge trigger handler contract" }));
    assert.equal(add.disabled, false);
    assert.equal(ui.screen.queryByLabelText("Pending inspector changes"), null, "nothing stages before the trigger is added");
    ui.fireEvent.click(add);
    assert.equal(planCalls.length, 0);
    assert.match(count(), /1 unsaved change/);
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
    await waitDialog("Review 1 change");
    await ui.waitFor(() => assert.equal(planCalls.at(-1)?.[0]?.kind, "triggers"));
    const edit = planCalls.at(-1)![0]!;
    assert.ok(edit.kind === "triggers");
    assert.equal(edit.bindings[0]!.resource, "resource:cognito.userPool");
    assert.equal(edit.bindings[0]!.accepts, "cognito");
    assert.equal(applyCalls, 0);
    ui.cleanup(); planCalls = [];
  }
});

test("a native hook stages removal, can be restored, and reviews as one CDK source edit", async () => {
  await mount("lambda:cognito-pre-signup-trigger");
  ui.fireEvent.click(ui.screen.getByText(/^Triggers/, { selector: "summary" }));
  const edge = baseline.models.dev.edges.find((item) => item.relation === "trigger" && item.provenance === "source" && item.label === "preSignUp")!;
  assert.equal(edge.removal && "kind" in edge.removal ? edge.removal.kind : undefined, "property");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove native trigger preSignUp" }));
  assert.match(count(), /1 unsaved change/);
  assert.ok(ui.screen.getByText("Will be removed"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Restore native trigger preSignUp" }));
  assert.equal(ui.screen.queryByLabelText("Pending inspector changes"), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove native trigger preSignUp" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  await ui.waitFor(() => assert.deepEqual(planCalls.at(-1), [{ kind: "nativeTrigger", edge: edge.id }]));
  assert.equal(applyCalls, 0);
});

test("a declared trigger shows its pending removal until restored, and the edit form can remove it", async () => {
  const binding = { event: "invocation-test-step", id: "before-auth", key: "cognito.userPool/before-auth", adapter: "cognito", resource: "resource:cognito.userPool", accepts: "cognito", options: { operation: "preAuthentication" } };
  persisted = { ...baseline, models: { dev: { ...baseline.models.dev, triggers: [binding] }, prod: { ...baseline.models.prod, triggers: [binding] } } } as Snapshot;
  await mount("lambda:invocation-test-step");
  ui.fireEvent.click(ui.screen.getByText(/^Triggers/, { selector: "summary" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove trigger before-auth" }));
  assert.ok(ui.screen.getByText("Will be removed"));
  assert.match(count(), /1 unsaved change/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Restore trigger before-auth" }));
  assert.equal(ui.screen.queryByLabelText("Pending inspector changes"), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Edit trigger before-auth" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove trigger" }));
  assert.ok(ui.screen.getByRole("button", { name: "Restore trigger before-auth" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  await ui.waitFor(() => assert.deepEqual(planCalls.at(-1), [{ kind: "triggers", event: "invocation-test-step", bindings: [] }]));
});

const openAddTrigger = async (selected: string) => {
  await mount(selected);
  ui.fireEvent.click(ui.screen.getByText(/^Triggers/, { selector: "summary" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add trigger" }));
};

test("step one lists every service, explains requirements and starts settings from a usable field", async () => {
  await openAddTrigger("lambda:invocation-test-step");
  for (const label of ["Cognito", "EventBridge", "SQS", "SNS", "DynamoDB stream", "S3"]) assert.ok(ui.screen.getByRole("button", { name: new RegExp(`^${label}: \\d+ usable$`) }), label);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^SQS:/ }));
  assert.ok(ui.screen.getByRole("heading", { name: "Triggered by SQS" }));
  assert.ok(ui.screen.getByText(/invocation-test-step times out after \d+s/));
  assert.equal(ui.screen.queryByText("Stack is not added to the CDK app."), null, "a stack not yet in the CDK app still offers its fields");
  assert.ok(ui.screen.getByRole("button", { name: "Use processingQueue" }), "reference example queue can be used");
  assert.ok(ui.screen.getByText("processingQueue").closest("li")!.textContent!.includes("Stack not added to the CDK app yet"));
  ui.fireEvent.click(ui.screen.getByText("Add another SQS resource"));
  assert.ok(ui.screen.getByRole("button", { name: "Copy SQS field snippet" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "All services" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Cognito:/ }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use userPool" }));
  assert.equal(ui.screen.queryByRole("region", { name: /Triggered by/ }), null);
  assert.match(document.querySelector(".trigger-route")!.textContent!, /^Cognito · .*userPool.*→ invocation-test-step/);
  assert.ok(ui.screen.getByRole("combobox", { name: "Trigger Hook" }));
  assert.equal(planCalls.length, 0);
});

test("the checklist lists every remaining problem at once and the button enables only when none are left", async () => {
  await openAddTrigger("lambda:invocation-test-step");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^SQS:/ }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use processingQueue" }));
  assert.equal(ui.screen.getByText("Nothing to set", { exact: false }).tagName, "P", "an SQS trigger needs no settings");
  ui.fireEvent.click(ui.screen.getByText("Advanced options"));
  ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Trigger Batch size" }), { target: { value: "50" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Trigger attachment id" }), { target: { value: "Bad Id" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Next" }));
  const checklist = ui.screen.getByRole("list", { name: "Trigger checklist" });
  assert.match(checklist.textContent!, /batch window of at least one second/);
  assert.match(checklist.textContent!, /kebab-case attachment id/);
  assert.match(checklist.textContent!, /not added to the CDK app yet; synth fails until it is/, "an unattached stack warns without blocking");
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Acknowledge trigger handler contract" }));
  assert.equal((ui.screen.getByRole("button", { name: "Add trigger" }) as HTMLButtonElement).disabled, true);
  assert.ok(ui.screen.getByText(/^2 items left before this trigger can be added/));
  ui.fireEvent.click(ui.within(checklist).getAllByRole("button", { name: "Fix" })[0]!);
  ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Trigger Batch size" }), { target: { value: "" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Trigger attachment id" }), { target: { value: "orders" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Next" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add trigger" }));
  assert.match(count(), /1 unsaved change/);
  assert.ok(ui.screen.getByText("referenceExamples.processingQueue · sqs"));
});

test("a schedule needs no resource and builds its expression from a repeat interval", async () => {
  await openAddTrigger("lambda:invocation-test-step");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Schedule: no resource needed" }));
  assert.match(document.querySelector(".trigger-route")!.textContent!, /^Schedule → invocation-test-step/);
  ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Trigger every" }), { target: { value: "15" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Trigger unit" }), { target: { value: "minutes" } });
  assert.ok(ui.screen.getByText("rate(15 minutes)"));
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Trigger repeat" }), { target: { value: "daily" } });
  ui.fireEvent.change(ui.screen.getByLabelText("Trigger time"), { target: { value: "06:30" } });
  assert.ok(ui.screen.getByText("cron(30 6 * * ? *)"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Next" }));
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Acknowledge trigger handler contract" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add trigger" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await ui.waitFor(() => assert.equal(planCalls.at(-1)?.[0]?.kind, "triggers"));
  const edit = planCalls.at(-1)![0]!;
  assert.ok(edit.kind === "triggers");
  assert.deepEqual(edit.bindings, [{ event: "invocation-test-step", resource: "", adapter: "schedule", id: "schedule-trigger", key: "schedule/schedule-trigger", accepts: "schedule", options: { expression: "cron(30 6 * * ? *)" } }]);
});

test("an asynchronous trigger points to the failure destination, which stages and reviews as its own change", async () => {
  await openAddTrigger("lambda:invocation-test-step");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^SNS:/ }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use notificationsTopic" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Next" }));
  assert.match(ui.screen.getByRole("list", { name: "Trigger checklist" }).textContent!, /Failed runs are dropped after Lambda's two retries/);
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Acknowledge trigger handler contract" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add trigger" }));
  assert.ok(ui.screen.getByText("Dropped after Lambda's two retries."));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Set failure destination" }));
  const save = ui.screen.getByRole("button", { name: "Save destination" }) as HTMLButtonElement;
  assert.equal(save.disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Failure destination" }), { target: { value: "resource:referenceExamples.deadLetterQueue" } });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Failure retry attempts" }), { target: { value: "1" } });
  ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Failure maximum event age" }), { target: { value: "30" } });
  assert.ok(ui.screen.getByText(/from 60 to 21600 seconds/));
  ui.fireEvent.change(ui.screen.getByRole("spinbutton", { name: "Failure maximum event age" }), { target: { value: "" } });
  ui.fireEvent.click(save);
  assert.match(ui.screen.getByText(/^Sent to/).textContent!, /deadLetterQueue after 1 retry\./);
  assert.match(count(), /2 unsaved changes/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await ui.waitFor(() => assert.equal(planCalls.at(-1)?.length, 2));
  assert.deepEqual(planCalls.at(-1)!.find((edit) => edit.kind === "onFailure"), { kind: "onFailure", event: "invocation-test-step", value: { destination: "resource:referenceExamples.deadLetterQueue", retryAttempts: 1 } });
});

test("a local-replay Lambda rules out sources that wait for its response, and only replayable hooks stay selectable", async () => {
  await openAddTrigger("lambda:cognito-post-confirmation-trigger");
  const sqs = ui.screen.getByRole("button", { name: "SQS: unavailable" });
  assert.match(sqs.title, /uses local replay/);
  ui.fireEvent.click(sqs);
  assert.match(ui.screen.getByRole("note").textContent!, /Turn off local replay/);
  assert.equal(ui.screen.queryByRole("button", { name: "Use processingQueue" }), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "All services" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Cognito:/ }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use userPool" }));
  // postConfirmation is the only replayable hook, and native wiring already holds it.
  const hooks = ui.screen.getByRole("combobox", { name: "Trigger Hook" });
  assert.ok(ui.within(hooks).getAllByRole("option").filter((option) => !(option as HTMLOptionElement).disabled && (option as HTMLOptionElement).value).length === 0);
});

test("description edits use navigation guards and discard restores the authored text", async () => {
  await mount();
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Description" }), { target: { value: "Unsaved notes" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" }));
  await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal((ui.screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value, baseline.descriptions.values[target]);
  assert.equal(planCalls.length, 0);
});

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
  await ui.waitFor(() => assert.ok(ui.screen.queryByText("Reading the inputs file…") === null));
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
