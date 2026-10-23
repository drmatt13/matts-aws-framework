import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { createElement as h } from "react";
import type { DraftEdit, SnapshotResponse } from "../shared/api";
import type { Snapshot } from "../shared/model";
import type { DeploymentInputEdit } from "../shared/deployment-inputs";
import { SnapshotBuilder } from "../server/snapshot";
import { connectionDescriptionId } from "../shared/descriptions";
import { aggregateConnections } from "../src/connections";
import { networkSettings, unusedNetworkCidr } from "../shared/networks";

let builder: SnapshotBuilder;
let baseline: Snapshot;
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let inspector: typeof import("../src/views/Inspector");
let dialogs: typeof import("../src/views/DraftControls");
let review: typeof import("../src/views/EditDialog");
let addMenu: typeof import("../src/views/AddMenu");
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
  addMenu = await import("../src/views/AddMenu");
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
    return { planId: "batch", ok: true, summaries: edits.map((edit) => edit.kind === "tags" ? `tags ${edit.entity}` : edit.kind === "placement" ? `placement ${edit.target}` : edit.kind === "network" ? `network ${edit.network}` : edit.kind === "removeNetwork" ? `remove ${edit.network}` : edit.kind === "databasePlacement" ? `database placement ${edit.database}` : edit.kind === "database" ? `database ${edit.database}` : edit.kind === "create" ? "create resource" : edit.kind === "clientEnvironment" ? "client mappings" : edit.kind === "field" ? `${edit.intent.field}: ${String(edit.intent.value ?? "inherit")}` : edit.kind === "triggers" ? edit.event : edit.kind === "nativeTrigger" ? edit.edge : edit.kind === "onFailure" ? edit.event : edit.value), changes: [{ file: "framework-config/settings.ts", diff: { unified: "combined", lines: [{ kind: "add", text: "// complete proposed draft", newLine: 1 }] } }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, impact: [] };
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
      h(addMenu.AddMenu),
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
function openSection(title: string) {
  const summary = [...document.querySelectorAll<HTMLElement>(".inspector-disclosure > details > summary")].find((summary) => summary.querySelector("span")?.textContent === title)!;
  assert.ok(summary, `section: ${title}`);
  if (!summary.closest("details")!.open) ui.fireEvent.click(summary);
}
function descriptionField(): HTMLTextAreaElement {
  const editor = document.querySelector<HTMLDetailsElement>(".description-editor");
  if (editor && !editor.open) ui.fireEvent.click(editor.querySelector("summary")!);
  return ui.screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
}
const memory = () => ui.screen.getByRole("spinbutton", { name: "Memory in MB" });
const changeMemory = () => ui.fireEvent.change(memory(), { target: { value: "768" } });
const count = () => ui.screen.getByLabelText("Pending inspector changes").textContent!;
const waitDialog = (name: string) => ui.waitFor(() => assert.equal(document.querySelector("dialog[open] h2")?.textContent, name));


test("inspectors prioritize controls, disclose supporting details, and reset scroll on selection", async () => {
  await mount();
  assert.ok(memory());
  assert.equal(document.querySelector<HTMLDetailsElement>(".description-editor")!.open, false);
  const build = [...document.querySelectorAll<HTMLDetailsElement>(".inspector-disclosure > details")].find((details) => details.querySelector("summary > span")?.textContent === "Build and runtime")!;
  assert.equal(build.open, false);
  assert.ok(!memory().closest("details"), "operational controls stay outside disclosures");
  assert.equal(document.querySelector(".inspector-section .field .name")?.textContent, "Deploy");
  assert.ok(!document.querySelector(".inspector")?.textContent?.includes("Source and identity"));
  openSection("Build and runtime");
  assert.ok(ui.screen.getByRole("combobox", { name: "Architecture" }));
  const content = document.querySelector<HTMLElement>(".inspector-content")!;
  const toolbar = document.querySelector(".inspector-toolbar")!;
  assert.ok(!content.contains(toolbar), "close remains outside the scrolled region");
  content.scrollTop = 240;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" }));
  await ui.waitFor(() => assert.ok(document.querySelector(".inspector-content") !== content, "selection replaces the scroll container"));
  assert.equal(document.querySelector(".inspector-content")!.scrollTop, 0);
  assert.equal(planCalls.length + applyCalls, 0, "inspecting and expanding never saves source");
});

test("tag metadata stays compact while collapsed drafts and errors remain discoverable", async () => {
  await mount("lambda:ws-connect-route");
  const section = document.querySelector<HTMLElement>(".declaration-tags")!;
  const details = section.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  assert.equal(details.open, false);
  assert.equal(summary.querySelector(".section-count")?.textContent, "1");
  openSection("Tags");
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Tag 1 key" }), { target: { value: "aws:reserved" } });
  ui.fireEvent.click(summary);
  assert.equal(details.open, false);
  assert.equal(summary.querySelector(".section-state")?.textContent, "Needs attention");
  assert.equal((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, true);
  openSection("Tags");
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Tag 1 key" }), { target: { value: "Team" } });
  ui.fireEvent.click(summary);
  assert.equal(summary.querySelector(".section-state")?.textContent, "Modified");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal(summary.querySelector(".section-state"), null);
  assert.equal(summary.querySelector(".section-count")?.textContent, "1");
  assert.equal(planCalls.length + applyCalls, 0);
});

test("workload build booleans share switches and preserve staged inheritance through review", async () => {
  await mount();
  openSection("Build and runtime");
  const fact = baseline.models.dev.fields[target]!.find(fact => fact.field === "lambda.bundling.minify")!;
  const minify = ui.screen.getByRole("switch", { name: "Minify" });
  assert.equal(ui.screen.queryByRole("combobox", { name: "Minify" }), null);
  assert.ok(ui.screen.getByRole("switch", { name: "Source maps" }));
  assert.equal(minify.getAttribute("aria-checked"), String(fact.effective));
  ui.fireEvent.click(minify);
  assert.equal(minify.getAttribute("aria-checked"), String(!fact.effective));
  ui.fireEvent.click(minify);
  assert.equal(ui.screen.queryByLabelText("Pending inspector changes"), null, "a second flip restores the declared setting");
  ui.fireEvent.click(minify);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "field", intent: { target, field: fact.field, value: !fact.effective } }]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(minify.getAttribute("aria-checked"), String(!fact.effective));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal(minify.getAttribute("aria-checked"), String(fact.effective));
  assert.equal(applyCalls, 0);
});

test("numeric defaults stay visible through overrides and restoring them stages inheritance for review", async () => {
  await mount();
  const fact = baseline.models.dev.fields[target]!.find((fact) => fact.field === "lambda.memorySize")!;
  const inherited = fact.inherited!.value;
  const row = memory().closest(".field")!;
  assert.equal(row.querySelector(".numeric-default > span")?.textContent, `Default: ${inherited} MB`);
  changeMemory();
  assert.equal((memory() as HTMLInputElement).value, "768");
  assert.equal(row.querySelector(".numeric-default > span")?.textContent, `Default: ${inherited} MB`);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use default memory" }));
  assert.equal((memory() as HTMLInputElement).value, "");
  assert.equal(memory().getAttribute("placeholder"), String(inherited));
  assert.ok(!ui.screen.queryByRole("button", { name: "Use default memory" }));
  assert.equal(applyCalls + planCalls.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.ok(planCalls[0]?.some((edit) => edit.kind === "field" && edit.intent.target === target && edit.intent.field === "lambda.memorySize" && edit.intent.inherit));
});

test("field errors and boolean help are associated with the controls they explain", async () => {
  await mount();
  const authentication = ui.screen.getByRole("switch", { name: "API user-pool authorizer" });
  const help = document.getElementById(authentication.getAttribute("aria-describedby")!);
  assert.ok(help?.closest(".field")?.contains(authentication), "boolean help stays in its setting row");
  assert.match(help!.textContent!, /Cognito user pool/);
  ui.fireEvent.change(memory(), { target: { value: "1" } });
  const descriptions = memory().getAttribute("aria-describedby")!.split(" ").map(id => document.getElementById(id));
  assert.ok(descriptions.every(Boolean), "every description resolves to visible content");
  assert.ok(descriptions.some(element => element!.getAttribute("role") === "alert"));
  assert.ok(descriptions.some(element => element!.textContent?.startsWith("Default:")));
  const route = ui.screen.getByRole("textbox", { name: "HTTP route /graphql" });
  ui.fireEvent.change(route, { target: { value: "invalid route" } });
  const routeDescriptions = route.getAttribute("aria-describedby")!.split(" ").map(id => document.getElementById(id));
  assert.equal(route.getAttribute("aria-invalid"), "true");
  assert.ok(routeDescriptions.every(Boolean));
  assert.ok(routeDescriptions.some(element => element!.getAttribute("role") === "alert"));
  assert.ok(routeDescriptions.some(element => element!.textContent?.startsWith("Browser path:")));
  assert.equal(planCalls.length + applyCalls, 0);
});

test("route tag ownership guidance stays inside the shared Tags section", async () => {
  const route = baseline.models.dev.routes.find(route => route.kind === "service")!;
  await mount(route.id);
  const section = document.querySelector<HTMLElement>(".declaration-tags")!;
  assert.equal(section.previousElementSibling?.tagName, "HEADER");
  assert.match(section.querySelector(".section-description")!.textContent!, /Route tags follow the workload declaration/);
  assert.equal(document.querySelector(".inspector-content > p"), null, "supporting copy shares the panel gutters");
  assert.equal(planCalls.length + applyCalls, 0);
});

test("placement-only workloads omit empty settings and secret-only bindings remain discoverable", async () => {
  const service = baseline.models.dev.targets.find(item => item.kind === "service")!;
  const secrets = [{ name: "EXAMPLE_SECRET", resource: "resource:example", display: "resources.example.arn" }];
  assert.ok(service);
  persisted = { ...baseline, models: { ...baseline.models, dev: { ...baseline.models.dev,
    fields: { ...baseline.models.dev.fields, [service.ref]: baseline.models.dev.fields[service.ref]!.filter(fact => fact.field === "deploy" || fact.field.endsWith("subnet")) },
    targets: baseline.models.dev.targets.map(item => item.ref === service.ref ? { ...item, environment: [], secrets } : item),
  } } };
  await mount(service.ref);
  assert.equal(ui.screen.queryByRole("heading", { name: "Settings" }), null);
  openSection("Environment");
  for (const secret of secrets) assert.ok(ui.screen.getByText(secret.name, { selector: "code" }));
  assert.equal(planCalls.length + applyCalls, 0);
});

test("every configurable workload places Tags before the shared Deployment section and previews its draft", async () => {
  for (const role of new Set(baseline.models.dev.targets.map((target) => target.role))) {
    const item = baseline.models.dev.targets.find((target) => target.role === role)!;
    if (!baseline.models.dev.fields[item.ref]?.some((fact) => fact.field === "deploy")) continue;
    await mount(item.ref);
    const section = document.querySelector(".inspector-content > .inspector-deployment")!;
    assert.ok(section, role);
    assert.ok(section.previousElementSibling?.matches(".declaration-tags"), role);
    assert.equal(section.previousElementSibling?.previousElementSibling?.tagName, "HEADER", role);
    assert.equal(section.querySelector("h3")?.textContent, "Deployment", role);
    assert.equal(section.querySelector(".field .name")?.textContent, "Deploy", role);
    const control = ui.within(section as HTMLElement).getByRole("combobox", { name: "Deploy" });
    ui.fireEvent.change(control, { target: { value: "none" } });
    assert.deepEqual([...section.querySelectorAll(".lane-line strong")].map((item) => item.textContent), ["Not enabled", "Not enabled"], role);
    assert.equal(applyCalls + planCalls.length, 0, "changing deployment only stages a draft");
    ui.cleanup();
  }
});

test("node descriptions stage with workload settings, review, save and reload in the inspector", async () => {
  await mount();
  const description = descriptionField();
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
  assert.equal((descriptionField()).value, value);
});

test("all selectable item kinds expose their authored description", async () => {
  for (const id of ["route:http:/graphql", "resource:cognito", "resource:cognito.userPool", "resource:openaiApiKey", "framework-stack:DevLambdaReplayStack", "envfile:dev", "local:postgres", "island:vpc:application", "prop:vpc:application:endpoint:s3"]) {
    await mount(id);
    const description = descriptionField();
    assert.equal(description.value, baseline.descriptions.values[id], id);
    assert.equal(description.disabled, false, id);
    ui.cleanup();
  }
});

test("read connection labels open compact evidence with line-numbered VS Code links", async () => {
  await mount("lambda:sign-out");
  openSection("Connections");
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
  ui.fireEvent.change(descriptionField(), { target: { value: "Used for account identity." } });
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
  assert.equal((descriptionField()).value, "Used for account identity.");
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
    const summary = document.querySelector<HTMLElement>(".trigger-editor > details > summary")!;
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
  ui.fireEvent.click(document.querySelector<HTMLElement>(".trigger-editor > details > summary")!);
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
  ui.fireEvent.click(document.querySelector<HTMLElement>(".trigger-editor > details > summary")!);
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
  ui.fireEvent.click(document.querySelector<HTMLElement>(".trigger-editor > details > summary")!);
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
  ui.fireEvent.change(descriptionField(), { target: { value: "Unsaved notes" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" }));
  await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal((descriptionField()).value, baseline.descriptions.values[target]);
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
  assert.ok(ui.screen.getByText("CloudFormation outputs", { selector: "summary > span" }));
  assert.ok(ui.screen.getByText((_text, element) => element?.tagName === "CODE" && element.textContent === "$queue.queueArn"));
  assert.ok(ui.screen.getByText("DEV_LAMBDA_REPLAY_QUEUE_ARN", { selector: "code" }));
  assert.equal(ui.screen.queryByText("ReplayDeadLetterQueueUrl"), null);
  assert.equal(ui.screen.queryByRole("button", { name: "Inspect stack infrastructure" }), null);
  assert.equal(ui.screen.queryByRole("heading", { name: "Infrastructure" }), null);
});

test("the stacks island distinguishes missing catalog declarations from missing CDK constructors", async () => {
  await mount("island:stacks");
  openSection("Island entries");
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

test("managed API routes show their target's environment cards and owning config", async () => {
  const sections = { http: "http", service: "services", webSocket: "websocket", agent: "agents" } as const;
  for (const [kind, section] of Object.entries(sections)) {
    const route = baseline.models.dev.routes.find((route) => route.kind === kind)!;
    assert.ok(route, `the repository has a ${kind} route`);
    await mount(route.id);
    const header = ui.screen.getByRole("complementary", { name: "Inspector" }).querySelector("header")!;
    assert.ok(ui.within(header).getByText(`Managed by framework-config/${section}`));
    assert.ok(ui.within(header).getByText(route.origin));
    const target = baseline.models.dev.targets.find((target) => target.ref === route.target)!;
    const cards = [...document.querySelectorAll(".lane-line")];
    assert.equal(cards.length, 2);
    assert.equal(cards[0]!.querySelector(".environment-name")?.textContent, "Development");
    assert.equal(cards[0]!.querySelector("strong")?.textContent, target.lanes.local || target.lanes.dev ? "Enabled" : "Not enabled");
    assert.equal(cards[0]!.querySelector(".small")?.textContent, target.lanes.local && target.lanes.dev ? "Your machine + AWS" : target.lanes.local ? "On your machine" : target.lanes.dev ? "In AWS" : undefined);
    assert.equal(cards[1]!.querySelector(".environment-name")?.textContent, "Production");
    assert.equal(cards[1]!.querySelector("strong")?.textContent, target.lanes.prod ? "Enabled" : "Not enabled");
    assert.equal(cards[1]!.querySelector(".small")?.textContent, target.lanes.prod ? "In AWS" : undefined);
    const control = ui.screen.getByRole("combobox", { name: "Deploy" });
    ui.fireEvent.change(control, { target: { value: "none" } });
    assert.equal(document.querySelector(".lane-line.dev strong")?.textContent, "Not enabled");
    assert.equal(document.querySelector(".lane-line.prod strong")?.textContent, "Not enabled");
    await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" })); });
    await waitDialog("Review 1 change");
    assert.deepEqual(planCalls.at(-1), [{ kind: "field", intent: { target: target.ref, field: "deploy", value: "none" } }], "route and target share the same deployment declaration");
    ui.cleanup();
  }
  await mount("island:apis");
  openSection("Island entries");
  for (const section of Object.values(sections)) assert.ok(ui.screen.getAllByText(`Managed by framework-config/${section}`).length);
});

test("declared catalog and workload tags precede deployment cards while derived fixtures and local services keep header-first cards", async () => {
  const tool = baseline.models.dev.targets.find((target) => target.role === "tool")!;
  const local = baseline.models.dev.localServices?.[0]?.id;
  for (const id of ["resource:cognito", "resource:cognito.userPool", "resource:openaiApiKey", "prop:vpc:application:endpoint:s3", "lambda:cognito-post-confirmation-trigger", tool.ref, ...(local ? [local] : [])]) {
    persisted = id === local ? { ...baseline, models: { dev: { ...baseline.models.dev, managedDatabase: undefined }, prod: { ...baseline.models.prod, managedDatabase: undefined } } } : baseline;
    await mount(id);
    const section = document.querySelector(".inspector-content > .inspector-deployment");
    assert.ok(section, id);
    if (baseline.models.dev.tagging?.[id]) {
      assert.ok(section.previousElementSibling?.matches(".declaration-tags"), id);
      assert.equal(section.previousElementSibling?.previousElementSibling?.tagName, "HEADER", id);
    } else assert.equal(section.previousElementSibling?.tagName, "HEADER", id);
    assert.deepEqual([...section.querySelectorAll(".environment-name")].map((item) => item.textContent), ["Development", "Production"], id);
    assert.equal(ui.screen.queryByRole("combobox", { name: "Deploy" }), null, "managed availability has no independent deployment override");
    assert.equal(applyCalls + planCalls.length, 0);
    if (id === "resource:cognito.userPool") {
      ui.fireEvent.click(ui.within(section as HTMLElement).getByRole("button", { name: "CognitoStack" }));
      await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Current selection").textContent, "resource:cognito"));
    }
    ui.cleanup();
  }
});

test("route cards retain disabled environments and show AWS-only development placement", async () => {
  const route = baseline.models.dev.routes.find((route) => route.kind === "webSocket")!;
  for (const enabled of [true, false]) {
    persisted = { ...baseline, models: { ...baseline.models, dev: { ...baseline.models.dev,
      targets: baseline.models.dev.targets.map((target) => target.ref === route.target ? { ...target, lanes: { ...target.lanes, local: false, dev: enabled, prod: false } } : target),
    } } };
    await mount(route.id);
    const cards = [...document.querySelectorAll(".lane-line")];
    assert.equal(cards[0]!.querySelector("strong")?.textContent, enabled ? "Enabled" : "Not enabled");
    assert.equal(cards[0]!.querySelector(".small")?.textContent, enabled ? "In AWS" : undefined);
    assert.equal(cards[1]!.querySelector("strong")?.textContent, "Not enabled");
    assert.equal(cards[1]!.querySelector(".small"), null);
    assert.equal(ui.screen.queryByRole("button", { name: "Review Changes" }), null, "opening a managed route stages no edits");
    ui.cleanup();
  }
});

test("WebSocket deployment choices preview each environment's own API flag", async () => {
  const target = baseline.models.dev.targets.find((target) => target.role === "webSocket")!;
  persisted = { ...baseline, models: {
    dev: { ...baseline.models.dev, webSocketApi: false },
    prod: { ...baseline.models.prod, webSocketApi: true },
  } };
  await mount(target.ref);
  const control = ui.screen.getByRole("combobox", { name: "Deploy" });
  assert.equal(ui.within(control).getByRole("option", { name: "Prod only" }).getAttribute("value"), "cloud-only");
  ui.fireEvent.change(control, { target: { value: "cloud-only" } });
  assert.equal(document.querySelector(".lane-line.dev strong")?.textContent, "Not enabled");
  assert.equal(document.querySelector(".lane-line.prod strong")?.textContent, "Enabled");
  assert.equal(applyCalls + planCalls.length, 0);
});

test("event Lambda local replay switches stage true or property removal through the shared draft", async () => {
  for (const [id, enabled] of [["cognito-custom-message", false], ["cognito-post-confirmation-trigger", true]] as const) {
    await mount(`lambda:${id}`);
    const control = ui.screen.getByRole("switch", { name: "Local replay" });
    assert.equal(control.getAttribute("aria-checked"), String(enabled));
    assert.equal(ui.screen.queryByRole("switch", { name: "API user-pool authorizer" }), null);
    const development = () => document.querySelector(".lane-line.dev .small")?.textContent;
    const replayLocation = "AWS first → captured → replayed on your machine";
    assert.equal(development(), enabled ? replayLocation : "In AWS");
    assert.equal(document.querySelector(".lane-line.prod .small")?.textContent, "In AWS");
    ui.fireEvent.click(control);
    assert.equal(control.getAttribute("aria-checked"), String(!enabled));
    assert.equal(development(), enabled ? "In AWS" : replayLocation, "the Development card previews the staged replay setting");
    assert.match(count(), /1 unsaved change/);
    ui.fireEvent.click(control);
    assert.equal(development(), enabled ? replayLocation : "In AWS", "restoring the setting also restores the Development card");
    assert.equal(ui.screen.queryByRole("button", { name: "Review Changes" }), null);
    ui.fireEvent.click(control);
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
  await ui.screen.findByRole("heading", { name: "cdk-app/.env.dev" });
  assert.ok(ui.screen.getByRole("heading", { name: "Required inputs (1)" }));
  const set = await ui.screen.findByRole("button", { name: `Set ${resource.fromEnv}` });
  await ui.waitFor(() => assert.equal((set as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(set);
  assert.ok(ui.screen.getByText(/A blank value will not satisfy this requirement/));
  assert.equal(planCalls.length + resourceCalls.length, 0, "guided editing does not force review");
});

test("local values edit inline, revert, review privately and reload after apply without reading the whole file", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "input" && item.fromEnv && !item.values)!;
  let stored = "";
  const inputPlans: { mode: string; edits: unknown; hash: string }[] = [];
  mock.method(apiModule.api, "resourceDetails", async () => ({ file: "cdk-app/.env.dev", inputFile: { exists: true, hash: "selected-hash" }, configured: true, value: stored, consumers: [], history: {} }));
  mock.method(apiModule.api, "inputDetails", async () => { throw new Error("Inline editing must read only the selected variable."); });
  mock.method(apiModule.api, "inputPlan", async (mode: "dev" | "prod", edits: readonly DeploymentInputEdit[], hash: string) => {
    inputPlans.push({ mode, edits, hash });
    return { planId: "local-value", ok: true, summaries: [`Update ${resource.fromEnv}`], changes: [{ file: "cdk-app/.env.dev", diff: { unified: "redacted", lines: [{ kind: "add" as const, newLine: 1, text: `${resource.fromEnv}=<updated value hidden>` }] } }] };
  });
  mock.method(apiModule.api, "inputApply", async () => {
    stored = "local-value-test";
    persisted = { ...baseline, revision: "local-value-saved" };
    return { status: "applied" as const, message: "Local value saved.", revision: persisted.revision };
  });
  await mount(resource.id);
  const field = await ui.screen.findByLabelText(`Value for ${resource.fromEnv}`) as HTMLTextAreaElement;
  await ui.waitFor(() => assert.equal(field.disabled, false));
  assert.equal(field.value, "");
  ui.fireEvent.change(field, { target: { value: "local-value-test" } });
  assert.equal(ui.screen.getByLabelText("Current selection").textContent, resource.id);
  assert.match(count(), /1 unsaved change/);
  assert.ok(ui.screen.getByRole("switch", { name: "Secret" }).matches(":disabled"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Revert value" }));
  assert.equal(field.value, "");
  assert.ok(!ui.screen.queryByLabelText("Pending inspector changes"));
  ui.fireEvent.change(field, { target: { value: "local-value-test" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(inputPlans, [{ mode: "dev", hash: "selected-hash", edits: [{ name: resource.fromEnv, value: "local-value-test" }] }]);
  assert.ok(!document.querySelector("dialog")!.textContent!.includes("local-value-test"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply All" }));
  await ui.waitFor(() => assert.ok(!ui.screen.queryByLabelText("Pending inspector changes")));
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText(`Value for ${resource.fromEnv}`) as HTMLTextAreaElement).value, "local-value-test"));
  assert.equal(planCalls.length + resourceCalls.length, 0);
});

test("blank local values show the effective default and constrained values offer a direct choice", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "input" && item.fromEnv)!;
  persisted = { ...baseline, models: { ...baseline.models, dev: { ...baseline.models.dev, resources: baseline.models.dev.resources.map((item) => item.id === resource.id ? { ...item, default: "bedrock", values: ["bedrock", "openai"], inputRequirement: undefined } : item) } } };
  mock.method(apiModule.api, "resourceDetails", async () => ({ file: "cdk-app/.env.dev", inputFile: { exists: true, hash: "enum-hash" }, configured: false, consumers: [], history: {} }));
  await mount(resource.id);
  const field = await ui.screen.findByRole("combobox", { name: `Value for ${resource.fromEnv}` });
  assert.ok(ui.within(ui.screen.getByRole("region", { name: "Local value" })).getByText("Using default"));
  ui.fireEvent.change(field, { target: { value: "openai" } });
  assert.match(count(), /1 unsaved change/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use default" }));
  assert.equal((field as HTMLSelectElement).value, "");
  assert.ok(!ui.screen.queryByLabelText("Pending inspector changes"));
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "Required input" }));
  assert.equal((field as HTMLSelectElement).disabled, true, "configuration and local file values review separately");
});

test("inline secrets stay masked and local value read errors can be retried", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "secret")!;
  let reads = 0;
  mock.method(apiModule.api, "resourceDetails", async () => {
    if (++reads === 1) throw new Error("Could not read the local file.");
    return { file: "cdk-app/.env.dev", inputFile: { exists: true, hash: "secret-hash" }, configured: true, value: "private-selected-sentinel", consumers: [], history: {} };
  });
  await mount(resource.id);
  await ui.screen.findByText("Could not read the local file.");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Retry value read" }));
  const field = await ui.screen.findByLabelText(`Value for ${resource.fromEnv}`) as HTMLInputElement;
  assert.equal(field.type, "password");
  assert.ok(!document.querySelector(".local-input")!.textContent!.includes("private-selected-sentinel"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: `Reveal ${resource.fromEnv}` }));
  assert.equal((ui.screen.getByLabelText(`Value for ${resource.fromEnv}`) as HTMLTextAreaElement).value, "private-selected-sentinel");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: `Hide ${resource.fromEnv}` }));
  assert.equal((ui.screen.getByLabelText(`Value for ${resource.fromEnv}`) as HTMLInputElement).type, "password");
  assert.equal(planCalls.length + resourceCalls.length, 0);
});

test("a missing environment file offers setup rather than an unusable value editor", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "input" && item.fromEnv)!;
  mock.method(apiModule.api, "resourceDetails", async () => ({ file: "cdk-app/.env.dev", inputFile: { exists: false, hash: "missing" }, configured: false, consumers: [], history: {} }));
  await mount(resource.id);
  await ui.screen.findByRole("button", { name: "Set up .env.dev" });
  assert.ok(!ui.screen.queryByLabelText(`Value for ${resource.fromEnv}`));
  assert.equal(planCalls.length + resourceCalls.length, 0);
});

test("the catalog-wide required switch participates in the unified resource draft", async () => {
  const resource = baseline.models.dev.resources.find((item) => item.kind === "input" && item.fromEnv)!;
  await mount(resource.id);
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "Required input" }));
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
  openSection("Build and runtime");
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
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "Secret" }));
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


test("all ten creation options enter the guarded wizard; review/back retains form and cancel writes nothing", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  const menu = ui.screen.getByRole("dialog", { name: "Add to application" });
  for (const label of ["Function", "Stack", "VPC", "Workflow", "Container service", "Container task", "API route", "Agent", "Input parameter", "Secret"]) assert.equal((ui.within(menu).getByRole("button", { name: label }) as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(ui.within(menu).getByRole("button", { name: "Input parameter" }));
  await waitDialog("Create input parameter");
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Stable identifier" }), { target: { value: "reviewedInput" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Environment variable" }), { target: { value: "REVIEWED_INPUT" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Declaration default (optional)" }), { target: { value: "kept" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review generated changes" }));
  await waitDialog("Review 1 change");
  await ui.waitFor(() => assert.equal(planCalls.length, 1));
  assert.equal(planCalls[0]![0]!.kind, "create");
  assert.equal(applyCalls, 0, "review is not approval to write");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  await waitDialog("Create input parameter");
  assert.equal((ui.screen.getByRole("textbox", { name: "Declaration default (optional)" }) as HTMLInputElement).value, "kept");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to resource types" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Input parameter" }));
  await waitDialog("Create input parameter");
  assert.equal((ui.screen.getByRole("textbox", { name: "Stable identifier" }) as HTMLInputElement).value, "reviewedInput");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Cancel creation" }));
  assert.equal(applyCalls, 0);
  assert.ok(!document.querySelector(".creation-wizard"));
});

test("creation tags use reviewed pairs and duplicate keys remain invalid after editing another field", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  ui.fireEvent.click(ui.within(ui.screen.getByRole("dialog", { name: "Add to application" })).getByRole("button", { name: "Input parameter" }));
  await waitDialog("Create input parameter");
  const wizard = ui.within(ui.screen.getByRole("dialog", { name: "Create input parameter" }));
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Stable identifier" }), { target: { value: "taggedInput" } });
  ui.fireEvent.click(wizard.getByRole("button", { name: "Add tag" }));
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Tag 1 key" }), { target: { value: "Team" } });
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Tag 1 value" }), { target: { value: "orders" } });
  ui.fireEvent.click(wizard.getByRole("button", { name: "Add tag" }));
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Tag 2 key" }), { target: { value: "Team" } });
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Description" }), { target: { value: "Metadata belongs in source" } });
  assert.equal((wizard.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement).disabled, true);
  assert.equal(planCalls.length, 0);
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Tag 2 key" }), { target: { value: "Cost" } });
  ui.fireEvent.click(wizard.getByRole("button", { name: "Review generated changes" }));
  await waitDialog("Review 1 change");
  const edit = planCalls[0]![0]!;
  assert.equal(edit.kind, "create");
  if (edit.kind === "create") assert.deepEqual(edit.request.tags, { Cost: "", Team: "orders" });
  assert.equal(applyCalls, 0);
});

test("inspector tag rows focus additions, show delete controls, and stage edits for review", async () => {
  await mount("lambda:ws-connect-route");
  openSection("Tags");
  const tags = ui.within(document.querySelector<HTMLElement>(".declaration-tags")!);
  assert.ok(tags.getByText("Key")); assert.ok(tags.getByText("Value"));
  assert.equal((tags.getByRole("textbox", { name: "Tag 1 value" }) as HTMLInputElement).value, "realtime");
  ui.fireEvent.click(tags.getByRole("button", { name: "Add tag" }));
  const key = tags.getByRole("textbox", { name: "Tag 2 key" });
  assert.equal(document.activeElement, key);
  assert.equal(tags.queryByRole("status"), null, "a fresh blank row is ready for typing without an immediate error");
  assert.equal((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, true);
  ui.fireEvent.change(key, { target: { value: "Team" } });
  ui.fireEvent.change(tags.getByRole("textbox", { name: "Tag 2 value" }), { target: { value: "realtime-ui" } });
  const remove = tags.getByRole("button", { name: "Remove tag Team" });
  assert.ok(remove.textContent?.includes("Delete"));
  ui.fireEvent.click(remove);
  assert.equal(tags.queryByRole("textbox", { name: "Tag 2 key" }), null);
  assert.equal(document.activeElement, tags.getByRole("textbox", { name: "Tag 1 key" }), "deletion restores focus to a remaining key");
  ui.fireEvent.change(tags.getByRole("textbox", { name: "Tag 1 value" }), { target: { value: "updated" } });
  assert.equal(planCalls.length + applyCalls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "tags", entity: "lambda:ws-connect-route", tags: { area: "updated" } }]);
});

test("tag validation identifies invalid fields and removing the final row returns focus to Add tag", async () => {
  await mount("lambda:ws-connect-route");
  openSection("Tags");
  const tags = ui.within(document.querySelector<HTMLElement>(".declaration-tags")!);
  const key = tags.getByRole("textbox", { name: "Tag 1 key" });
  const value = tags.getByRole("textbox", { name: "Tag 1 value" });
  ui.fireEvent.change(key, { target: { value: "aws:reserved" } });
  assert.equal(key.getAttribute("aria-invalid"), "true");
  assert.equal(value.getAttribute("aria-invalid"), "false");
  assert.equal(document.getElementById(key.getAttribute("aria-describedby")!), tags.getByRole("status"));
  ui.fireEvent.change(key, { target: { value: "Team" } });
  assert.equal(key.getAttribute("aria-invalid"), "false");
  assert.equal(key.getAttribute("aria-describedby"), null);
  ui.fireEvent.change(value, { target: { value: "<>" } });
  assert.equal(value.getAttribute("aria-invalid"), "true");
  assert.equal(key.getAttribute("aria-invalid"), "false");
  ui.fireEvent.click(tags.getByRole("button", { name: "Remove tag Team" }));
  assert.equal(document.activeElement, tags.getByRole("button", { name: "Add tag" }));
  assert.equal(tags.queryByRole("status"), null);
  assert.equal(planCalls.length + applyCalls, 0);
});

test("refreshing an older inspector snapshot restores inline WebSocket tag editing", async () => {
  const entity = "lambda:ws-connect-route";
  const { tags: _tags, ...fields } = baseline.source.editability[entity]!;
  persisted = { ...baseline, revision: "old-source-index", source: { ...baseline.source, editability: { ...baseline.source.editability, [entity]: fields } } };
  await mount(entity);
  openSection("Tags");
  assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 value" }) as HTMLInputElement).disabled, true);
  persisted = baseline;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Refresh editor" }));
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 value" }) as HTMLInputElement).disabled, false));
  assert.equal(ui.screen.queryByRole("button", { name: "Refresh editor" }), null);
  assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 value" }) as HTMLInputElement).value, "realtime");
  assert.equal(planCalls.length + applyCalls, 0, "refresh never writes declarations");
});

test("starting creation respects existing inspector changes and creation guards navigation", async () => {
  await mount(); changeMemory();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  assert.ok(count().includes("1 unsaved change"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard and Continue" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Secret" }));
  await waitDialog("Create secret");
  assert.equal(ui.screen.queryByLabelText(/secret value/i), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to resource types" }));
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Other view" }));
  await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  assert.equal(applyCalls + planCalls.length, 0);
});

test("VPC creator catches duplicate IDs and CIDR overlap without making a review request", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  ui.fireEvent.click(ui.within(ui.screen.getByRole("dialog", { name: "Add to application" })).getByRole("button", { name: "VPC" }));
  const id = ui.screen.getByRole("textbox", { name: "Stable identifier" });
  const cidr = ui.screen.getByRole("textbox", { name: "Private IPv4 /16" });
  const review = ui.screen.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement;
  ui.fireEvent.change(id, { target: { value: "application" } });
  assert.ok(review.disabled);
  assert.equal(id.getAttribute("aria-invalid"), "true");
  assert.ok(ui.screen.getByText(/This VPC identifier already exists/));
  ui.fireEvent.change(id, { target: { value: "analytics" } });
  ui.fireEvent.change(cidr, { target: { value: "10.0.0.0/16" } });
  assert.ok(review.disabled);
  assert.equal(cidr.getAttribute("aria-invalid"), "true");
  assert.ok(ui.screen.getByText(/This range overlaps VPC "application"/));
  ui.fireEvent.change(cidr, { target: { value: unusedNetworkCidr(baseline.models.dev.networks!)! } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Analytics workspace" } });
  assert.equal(review.disabled, false, ui.screen.queryAllByRole("status").map(node => node.textContent).join("\n"));
  assert.equal(planCalls.length, 0);
  ui.fireEvent.click(review);
  await ui.waitFor(() => assert.equal(planCalls.length, 1));
  const edit = planCalls[0]![0]!;
  assert.ok(edit.kind === "create" && edit.request.kind === "vpc" && edit.request.name === "Analytics workspace");
});

test("VPC endpoint service icons search, toggle and retain a typed selection through review", async () => {
  await mount("island:vpc:application");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Choose interface endpoint services" }));
  const search = ui.screen.getByRole("searchbox", { name: "Search interface endpoint services" });
  assert.equal(document.activeElement, search);
  const options = ui.screen.getByRole("list", { name: "Interface endpoint services" });
  assert.equal(ui.within(options).getAllByRole("button").length, baseline.models.dev.interfaceEndpointServices!.length);
  assert.equal(ui.within(options).queryByRole("button", { name: / · s3$/ }), null, "free gateway services keep their separate controls");
  ui.fireEvent.change(search, { target: { value: "cloudwatch logs" } });
  const logs = ui.screen.getByRole("button", { name: "CloudWatch Logs · logs" });
  assert.ok(logs.querySelector("img")!.getAttribute("src")!.endsWith("cloudwatch.svg"));
  ui.fireEvent.click(logs);
  assert.equal(logs.getAttribute("aria-pressed"), "true");
  ui.fireEvent.click(logs);
  assert.equal(logs.getAttribute("aria-pressed"), "false");
  ui.fireEvent.click(logs);
  ui.fireEvent.change(search, { target: { value: "ecr.api" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "ECR · API · ecr.api" }));
  assert.ok(ui.screen.getByRole("button", { name: "Remove logs endpoint" }));
  assert.ok(ui.screen.getByRole("button", { name: "Remove ecr.api endpoint" }));
  assert.equal(planCalls.length + applyCalls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Done" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0]!.find(edit => edit.kind === "network"), {
    kind: "network", network: "application", settings: { ...networkSettings(baseline.models.dev.networks!.find(network => network.id === "application")!), endpoints: ["logs", "ecr.api"] },
  });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.ok(ui.screen.getByRole("button", { name: "Remove logs endpoint" }));
  assert.ok(ui.screen.getByRole("button", { name: "Remove ecr.api endpoint" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove logs endpoint" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Remove logs endpoint" }), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Remove ecr.api endpoint" }), null);
  assert.equal(applyCalls, 0);
});

test("VPC settings use named switches and review only the selected network without global defaults", async () => {
  await mount("island:vpc:application");
  assert.equal(ui.screen.queryByRole("heading", { name: "Shared defaults" }), null);
  assert.equal(ui.screen.queryByRole("combobox", { name: "Default service type" }), null);
  assert.equal(ui.screen.queryByRole("switch", { name: "Minify" }), null);
  assert.equal(ui.screen.queryByRole("checkbox"), null);
  const settings = networkSettings(baseline.models.dev.networks!.find(network => network.id === "application")!);
  const expected = { ...settings };
  for (const [label, key] of [
    ["One NAT gateway (billed hourly and per GB)", "nat"],
    ["IPv6 egress-only gateway", "ipv6"],
    ["S3 gateway endpoint", "s3"],
    ["DynamoDB gateway endpoint", "dynamodb"],
  ] as const) {
    const control = ui.screen.getByRole("switch", { name: label });
    assert.equal(control.getAttribute("aria-checked"), String(settings[key]));
    assert.equal(control.textContent, settings[key] ? "On" : "Off");
    assert.equal(control.getAttribute("type"), "button");
    ui.fireEvent.click(ui.screen.getByLabelText(label));
    expected[key] = !settings[key];
    assert.equal(control.getAttribute("aria-checked"), String(expected[key]));
  }
  assert.equal(planCalls.length + applyCalls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "network", network: "application", settings: expected }]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(ui.screen.getByRole("switch", { name: "S3 gateway endpoint" }).getAttribute("aria-checked"), String(expected.s3));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal(ui.screen.getByRole("switch", { name: "S3 gateway endpoint" }).getAttribute("aria-checked"), String(settings.s3));
  assert.equal(applyCalls, 0);
});

test("VPC settings freeze every control while a review is being prepared", async () => {
  await mount("island:vpc:application");
  ui.fireEvent.click(ui.screen.getByRole("switch", { name: "S3 gateway endpoint" }));
  let finish!: () => void;
  reviewGate = new Promise<void>(resolve => { finish = resolve; });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  const controls = document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".inspector .fields input, .inspector .fields button");
  assert.ok(controls.length > 4);
  try { for (const control of controls) assert.equal(control.disabled, true, control.getAttribute("aria-label") ?? control.id); }
  finally { await ui.act(async () => { finish(); await reviewGate; }); }
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(ui.screen.getByRole("switch", { name: "S3 gateway endpoint" }).hasAttribute("disabled"), false);
});

test("stale configuration freezes VPC settings and workload placement", async () => {
  persisted = { ...baseline, models: { ...baseline.models, dev: { ...baseline.models.dev, stale: true } } };
  await mount("island:vpc:application");
  const settings = document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".inspector .fields input, .inspector .fields button");
  assert.ok(settings.length > 4);
  for (const control of settings) assert.equal(control.disabled, true);
  ui.cleanup();
  await mount(target);
  openSection("Production placement");
  assert.equal((ui.screen.getByRole("combobox", { name: "Workload VPC" }) as HTMLSelectElement).disabled, true);
  assert.equal((ui.screen.getByRole("combobox", { name: "Workload subnet" }) as HTMLSelectElement).disabled, true);
  assert.equal(planCalls.length + applyCalls, 0);
});

test("VPC creation switches preserve boolean choices through review without submitting the form", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  ui.fireEvent.click(ui.within(ui.screen.getByRole("dialog", { name: "Add to application" })).getByRole("button", { name: "VPC" }));
  await waitDialog("Create VPC");
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Stable identifier" }), { target: { value: "switch-review" } });
  const control = ui.screen.getByRole("switch", { name: "One NAT gateway (billed hourly and per GB)" });
  assert.equal(control.getAttribute("aria-checked"), "false");
  ui.fireEvent.click(control);
  assert.equal(control.getAttribute("aria-checked"), "true");
  assert.equal(planCalls.length, 0);
  ui.fireEvent.click([...document.querySelectorAll(".creation-wizard summary")].find(summary => summary.textContent === "Advanced settings")!);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Choose interface endpoint services" }));
  ui.fireEvent.change(ui.screen.getByRole("searchbox", { name: "Search interface endpoint services" }), { target: { value: "secretsmanager" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Secrets Manager · secretsmanager" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Done" }));
  assert.equal(planCalls.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review generated changes" }));
  await waitDialog("Review 1 change");
  const edit = planCalls[0]![0]!;
  assert.ok(edit.kind === "create" && edit.request.kind === "vpc" && edit.request.nat === true);
  assert.deepEqual(edit.request.endpoints, ["secretsmanager"]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(ui.screen.getByRole("switch", { name: "One NAT gateway (billed hourly and per GB)" }).getAttribute("aria-checked"), "true");
  assert.ok(ui.screen.getByRole("button", { name: "Remove secretsmanager endpoint" }));
  assert.equal(applyCalls, 0);
});

test("local PostgreSQL and RDS open the same application database workflow without writing source", async () => {
  for (const id of ["local:postgres", "resource:rds.database"]) {
    await mount(id);
    assert.ok(ui.screen.getByRole("heading", { name: "Application PostgreSQL" }));
    assert.deepEqual([...document.querySelectorAll(".database-environment strong")].map(node => node.textContent), ["Development", "Production"]);
    assert.ok(ui.screen.getByText(/data is not synchronized/));
    assert.ok(ui.screen.getByRole("heading", { name: "Database home" }));
    assert.equal(ui.screen.queryByRole("combobox", { name: "Deploy" }), null);
    openSection("Connected workloads");
    assert.ok(document.querySelector(".database-consumers")?.textContent?.includes("Direct writer"));
    assert.ok(document.querySelector(".database-consumers")?.textContent?.includes("task:db-migrate"));
    assert.equal(planCalls.length + applyCalls, 0);
    ui.cleanup();
  }
});

test("database placement stages a coordinated review, guards navigation, and restores the current home", async () => {
  const database = baseline.models.dev.managedDatabase!;
  const spare = { ...baseline.models.dev.networks![0]!, id: "database-destination", name: "Database destination", cidr: "10.99.0.0/16" };
  persisted = { ...baseline, models: {
    dev: { ...baseline.models.dev, networks: [...baseline.models.dev.networks!, spare] },
    prod: { ...baseline.models.prod, networks: [...baseline.models.prod.networks!, spare] },
  } };
  await mount("resource:rds.database");
  ui.fireEvent.click(ui.screen.getByText("Change placement"));
  const vpc = () => ui.screen.getByRole("combobox", { name: "Database VPC" }) as HTMLSelectElement;
  const subnet = () => ui.screen.getByRole("combobox", { name: "Database subnets" }) as HTMLSelectElement;
  assert.ok(![...vpc().options].some(option => option.value === "none" || !option.value));
  assert.deepEqual([...subnet().options].map(option => option.value), ["isolated", "private"]);
  ui.fireEvent.change(vpc(), { target: { value: spare.id } });
  ui.fireEvent.change(subnet(), { target: { value: "private" } });
  assert.ok(ui.screen.getByText("Coordinated placement review"));
  assert.match(document.querySelector(".database-placement-impact")!.textContent!, /task:db-migrate/);
  assert.equal(planCalls.length + applyCalls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "databasePlacement", database: database.id, vpc: spare.id, subnet: "private" }]);
  assert.equal(applyCalls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(vpc().value, spare.id);
  assert.equal(subnet().value, "private");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open node B" }));
  await waitDialog("Unsaved changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Restore current placement" }));
  assert.equal(vpc().value, database.networkId);
  assert.equal(subnet().value, database.subnet);
  assert.equal(ui.screen.queryByLabelText("Pending inspector changes"), null);
  assert.equal(applyCalls, 0);
});

test("managed PostgreSQL policy stays editable in development and retains its complete draft through review", async () => {
  assert.equal(baseline.models.dev.resources.find(resource => resource.id === "resource:rds")?.absent, true, "development uses local PostgreSQL while RDS stays declared");
  const database = baseline.models.dev.managedDatabase!;
  assert.ok(database, "the native RDS resource has a first-class declaration");
  await mount("resource:rds.database");
  assert.ok(ui.screen.getByRole("heading", { name: "Application PostgreSQL" }));
  assert.ok(ui.screen.getByRole("heading", { name: "Production RDS" }));
  assert.ok([...document.querySelectorAll("summary")].some(summary => summary.textContent === "Connection pool defaults"));
  assert.equal(ui.screen.queryByRole("combobox", { name: "Default service type" }), null, "database defaults need no service-type menu");
  assert.ok(ui.screen.getByText(/Independent data in development and production/));
  openSection("Availability and backups");
  const standby = () => ui.screen.getByRole("switch", { name: "Multi-AZ standby" });
  const replicas = () => ui.screen.getByRole("spinbutton", { name: "Read replicas" }) as HTMLInputElement;
  const retention = () => ui.screen.getByRole("spinbutton", { name: "Backup retention (days)" }) as HTMLInputElement;
  ui.fireEvent.click(standby());
  ui.fireEvent.change(replicas(), { target: { value: "2" } });
  assert.equal(standby().getAttribute("aria-checked"), "true");
  assert.equal(replicas().value, "2");
  assert.ok(ui.screen.getByText(/Multi-AZ upgrade staged/));
  assert.equal(planCalls.length + applyCalls, 0, "editing policy never writes or applies changes");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "database", database: database.id, settings: { ...database.authored, multiAz: true, readReplicaCount: 2 } }]);
  assert.equal(applyCalls, 0, "review requires a separate explicit apply");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(standby().getAttribute("aria-checked"), "true");
  assert.equal(replicas().value, "2");
  ui.fireEvent.change(retention(), { target: { value: "0" } });
  assert.match(ui.screen.getByRole("alert").textContent ?? "", /settings\.readReplicaCount requires positive settings\.backupRetentionDays/);
  assert.equal((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, true);
  assert.equal(planCalls.length, 1, "invalid replica policy is caught before a server review");
  assert.equal(applyCalls, 0);
  ui.fireEvent.change(retention(), { target: { value: "7" } });
  assert.equal((ui.screen.getByRole("button", { name: "Review Changes" }) as HTMLButtonElement).disabled, false);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[1], [{ kind: "database", database: database.id, settings: { ...database.authored, multiAz: true, readReplicaCount: 2, backupRetentionDays: 7 } }]);
  assert.equal(applyCalls, 0);
});

test("database callers' global pool defaults remain reviewable beside the database policy", async () => {
  await mount("resource:rds.database");
  openSection("Connection pool defaults");
  const input = ui.screen.getByRole("spinbutton", { name: "Maximum connections in connections" });
  const fact = baseline.models.dev.fields["defaults:database"]!.find(fact => fact.field === "defaults.database.pool.maxConnections")!;
  const value = Number(fact.effective) + 1;
  ui.fireEvent.change(input, { target: { value: String(value) } });
  assert.equal(planCalls.length + applyCalls, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review Changes" }));
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls[0], [{ kind: "field", intent: { target: "defaults:database", field: fact.field, value } }]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal((ui.screen.getByRole("spinbutton", { name: "Maximum connections in connections" }) as HTMLInputElement).value, String(value));
  assert.equal(applyCalls, 0);
});

test("VPC removal is unavailable while used and stages an unused declaration through review", async () => {
  const spare = { ...baseline.models.dev.networks![0]!, id: "spare", name: "Spare network", constructId: "SpareNetworkStack", cidr: "10.99.0.0/16", builtInProd: false };
  persisted = { ...baseline, models: {
    dev: { ...baseline.models.dev, networks: [...baseline.models.dev.networks!, spare] },
    prod: { ...baseline.models.prod, networks: [...baseline.models.prod.networks!, spare] },
  } };
  const openRemoval = () => {
    const summary = [...document.querySelectorAll("summary")].find(summary => summary.textContent === "Remove VPC")!;
    assert.ok(summary);
    if (!summary.parentElement!.hasAttribute("open")) ui.fireEvent.click(summary);
    return ui.screen.getByRole("button", { name: "Review VPC removal" }) as HTMLButtonElement;
  };
  await mount("island:vpc:application");
  assert.equal(openRemoval().disabled, true);
  assert.ok(ui.screen.getByText(/Reassign workloads, the database, and native resource references before removal/));
  assert.equal(planCalls.length, 0);
  ui.cleanup();
  await mount("island:vpc:spare");
  const removal = openRemoval();
  assert.equal(removal.disabled, false);
  ui.fireEvent.click(removal);
  await waitDialog("Review 1 change");
  assert.deepEqual(planCalls, [[{ kind: "removeNetwork", network: "spare" }]]);
  assert.equal(applyCalls, 0, "reviewing removal never applies it");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Editing" }));
  assert.equal(openRemoval().disabled, true, "a pending removal cannot be staged twice");
  assert.equal(planCalls.length, 1);
  assert.equal(applyCalls, 0);
});
