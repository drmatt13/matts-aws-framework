import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h } from "react";
import { triggerAdapters } from "../../packages/framework/src/config/triggers";
import type { ModeModel, ModelResource, ModelTarget, Snapshot } from "../shared/model";
import type { TriggerBinding, TriggerCapability } from "../shared/triggers";
import { snapshot as browserSnapshot, location } from "./browser/support/scenarios";

let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let triggers: typeof import("../src/views/Triggers");
let dom: { window: Window & typeof globalThis };
const disposals: (() => void)[] = [];

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Node", "MutationObserver", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  ui = require("@testing-library/react");
  router = require("@tanstack/react-router");
  query = require("@tanstack/react-query");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  studio = await import("../src/studio");
  triggers = await import("../src/views/Triggers");
});
afterEach(() => { ui.cleanup(); for (const dispose of disposals.splice(0)) dispose(); });
after(() => dom.window.close());

const event = "trigger-fixture";
const source = (name: string): ModelResource => ({ id: `resource:fixtures.${name}`, kind: "member", parent: "resource:fixtures", path: ["fixtures", name], absent: false });
const resources = [source("bus"), source("bucket"), source("topic"), source("queue"), source("importedQueue")];

function fixture(binding: TriggerBinding): Snapshot {
  const snapshot = browserSnapshot().snapshot;
  const capability = (name: string, adapter: string, type: string, owned = true): TriggerCapability => ({
    resource: `resource:fixtures.${name}`, stack: "resource:fixtures", name, location, owned,
    canonicalTypes: [type], adapters: adapter ? [{ kind: adapter }] : [],
    facts: { fifo: false, eventBridge: binding.options.delivery === "eventbridge", notificationResource: false },
  });
  const model = (original: ModeModel): ModeModel => {
    const target: ModelTarget = { ...original.targets[0]!, ref: `lambda:${event}`, id: event, title: event, role: "event" };
    return { ...original, targets: [target], routes: [], resources, edges: [], triggerAdapters: triggerAdapters(), triggers: [binding] };
  };
  return { ...snapshot, models: { dev: model(snapshot.models.dev), prod: model(snapshot.models.prod) }, source: {
    ...snapshot.source,
    triggerCapabilities: [capability("bus", "eventbridge", "aws-events:IEventBus"), capability("bucket", "s3", "aws-s3:Bucket"), capability("topic", "sns", "aws-sns:ITopic"), capability("queue", "sqs", "aws-sqs:IQueue"), capability("importedQueue", "sqs", "aws-sqs:IQueue", false)],
  } };
}

async function edit(adapter: string, options: Readonly<Record<string, unknown>>) {
  const name = adapter === "eventbridge" ? "bus" : adapter === "s3" ? "bucket" : "topic";
  const binding: TriggerBinding = { event, id: "existing-trigger", key: `fixtures.${name}/existing-trigger`, adapter, resource: `resource:fixtures.${name}`, accepts: adapter, options };
  const response = { snapshot: fixture(binding), evaluating: false, commands: {}, busy: null };
  let current: ReturnType<typeof studio.useStudio>;
  function Workbench() {
    current = studio.useStudio();
    return h(triggers.Triggers, { target: current.model.targets[0] });
  }
  function Root() {
    return h(studio.StudioProvider, { response, selected: `lambda:${event}`, select: () => {}, children: h(Workbench) });
  }
  const root = router.createRootRoute({ component: Root, validateSearch: () => ({ select: `lambda:${event}` }) });
  const app = router.createRouter({ routeTree: root, history: router.createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  disposals.push(() => { client.clear(); app.history.destroy(); });
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("button", { name: "Edit trigger existing-trigger", hidden: true })));
  ui.fireEvent.click(document.querySelector("[data-slot=trigger-editor] > details > summary")!);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Edit trigger existing-trigger" }));
  return () => current!.draft.triggers(event)[0]!;
}

const change = (name: string, value: string) => ui.fireEvent.change(ui.screen.getByLabelText(name), { target: { value } });
const next = () => ui.fireEvent.click(ui.screen.getByRole("button", { name: "Next" }));
const back = () => ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back" }));
const save = () => ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save trigger" }));

test("EventBridge guided values and invalid JSON survive Confirm and Back before corrected settings stage", async () => {
  const binding = await edit("eventbridge", { eventPattern: { source: ["before"] } });
  change("Trigger event source", "orders.created, orders.updated");
  change("Trigger detail type", "OrderPlaced");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Edit full pattern as JSON" }));
  const pattern = ui.screen.getByRole("textbox", { name: "Trigger Event pattern" }) as HTMLTextAreaElement;
  assert.deepEqual(JSON.parse(pattern.value), { source: ["orders.created", "orders.updated"], detailType: ["OrderPlaced"] });
  change("Trigger Event pattern", '{"source":');
  next();
  assert.equal((ui.screen.getByRole("button", { name: "Save trigger" }) as HTMLButtonElement).disabled, true);
  back();
  assert.equal((ui.screen.getByLabelText("Trigger Event pattern") as HTMLTextAreaElement).value, '{"source":');
  assert.equal(document.activeElement, ui.screen.getByLabelText("Trigger Event pattern"));
  change("Trigger Event pattern", '{"source":["corrected"],"detail":{"status":["ready"]}}');
  next();
  save();
  assert.deepEqual(binding().options.eventPattern, { source: ["corrected"], detail: { status: ["ready"] } });
});

test("S3 basic selections can switch to specific JSON events without losing the selected values", async () => {
  const binding = await edit("s3", { delivery: "notification", eventTypes: ["s3:ObjectCreated:*"], acknowledgeRecursionRisk: true });
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Trigger on object removed" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Choose specific S3 events" }));
  const events = ui.screen.getByRole("textbox", { name: "Trigger S3 event types (JSON array)" }) as HTMLTextAreaElement;
  assert.deepEqual(JSON.parse(events.value), ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"]);
  change("Trigger S3 event types (JSON array)", '["s3:ObjectCreated:Put"]');
  next();
  back();
  assert.equal((ui.screen.getByLabelText("Trigger S3 event types (JSON array)") as HTMLTextAreaElement).value, '["s3:ObjectCreated:Put"]');
  next();
  save();
  assert.deepEqual(binding().options.eventTypes, ["s3:ObjectCreated:Put"]);
});

test("S3 EventBridge delivery keeps the basic event choices and omits notification-only JSON actions", async () => {
  await edit("s3", { delivery: "eventbridge", eventTypes: ["s3:ObjectCreated:*"], acknowledgeRecursionRisk: true });
  assert.ok(ui.screen.getByRole("checkbox", { name: "Trigger on object created" }));
  assert.ok(ui.screen.getByRole("checkbox", { name: "Trigger on object removed" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Choose specific S3 events" }), null);
  assert.equal(ui.screen.queryByRole("combobox", { name: "Trigger Delivery" }), null, "the only available delivery remains explanatory text");
});

test("optional booleans reset to Default and owned resource selection keeps imported queues unavailable", async () => {
  const binding = await edit("eventbridge", { eventPattern: { source: ["orders"] } });
  ui.fireEvent.click(ui.screen.getByText("Advanced options"));
  const enabled = ui.screen.getByRole("combobox", { name: "Trigger Enabled" }) as HTMLSelectElement;
  assert.equal(enabled.value, "");
  change("Trigger Enabled", "false");
  change("Trigger Enabled", "");
  const destination = ui.screen.getByRole("combobox", { name: "Trigger Dead-letter queue" });
  assert.equal((ui.within(destination).getByRole("option", { name: "fixtures.importedQueue · imported" }) as HTMLOptionElement).disabled, true);
  change("Trigger Dead-letter queue", "resource:fixtures.queue");
  next();
  save();
  assert.equal(Object.hasOwn(binding().options, "enabled"), false);
  assert.deepEqual(binding().options.deadLetterQueue, { $cdk: "@repo/framework/cdk-resource", path: ["fixtures", "queue"], optional: false });
});

test("optional enum selection returns to its unstaged default", async () => {
  const binding = await edit("sns", {});
  ui.fireEvent.click(ui.screen.getByText("Advanced options"));
  const scope = ui.screen.getByRole("combobox", { name: "Trigger Filter scope" }) as HTMLSelectElement;
  assert.equal(scope.value, "");
  change("Trigger Filter scope", "MessageBody");
  change("Trigger Filter scope", "");
  next();
  save();
  assert.equal(Object.hasOwn(binding().options, "filterScope"), false);
});

test("changing the source starts its new adapter from defaults and clears prior guided text", async () => {
  await edit("eventbridge", { eventPattern: { source: ["before"] } });
  change("Trigger event source", "draft-value");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Change" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Schedule: no resource needed" }));
  assert.ok(ui.screen.getByText("rate(1 hour)"));
  assert.equal(ui.screen.queryByLabelText("Trigger event source"), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Change" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "All services" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^EventBridge:/ }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Use bus" }));
  assert.equal((ui.screen.getByLabelText("Trigger event source") as HTMLInputElement).value, "");
});
