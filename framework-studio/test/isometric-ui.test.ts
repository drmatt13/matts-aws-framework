import assert from "./support/assert";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h, useState } from "react";
import type { SnapshotResponse } from "../shared/api";
import { SnapshotBuilder } from "../server/snapshot";
import { landscapeFocus, SEARCH_FADE } from "../src/scene/focus";
import { SceneRenderer, type RenderState } from "../src/scene/render";
import { fitScene } from "../src/scene/fit";
import { iconUrl } from "../src/icons";
import { buildScene } from "../src/scene/build";
import { filterSceneByTag } from "../src/scene/tag-filter";
import { UNTAGGED_FILTER } from "../src/tag-groups";
import { connectionMidpoint } from "../src/scene/routing";
import { screenToWorld, worldToScreen, type Camera, type Viewport } from "../src/scene/camera";
import { catalogAvailability } from "../src/deployment";
import { BAND_TRIM, DECK, hexRgb, ICON_TINT, ISLAND_TRIM } from "../src/scene/look";
import { NODE_CAPTION, NODE_DEPLOYMENT_TAG, SUBNET_LABEL, subnetLabelPresentation, subnetLabelRect, rectanglesOverlap } from "../src/scene/labels";
import { project } from "../src/scene/iso";
import { insidePolygon, pickEntity, pickIsland } from "../src/scene/picking";
import { islandDrawOrder, islandSlabs } from "../src/scene/slabs";
import { connectionHoverEase, EDGE_HOVER_DURATION } from "../src/scene/connections";

let builder: SnapshotBuilder;
let response: SnapshotResponse;
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let map: typeof import("../src/views/Isometric");
let shell: typeof import("../src/views/Shell");
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const images: { src: string; alpha: number }[] = [];
const strokes: string[] = [];
const labels: string[] = [];
const labelPaints: { text: string; alpha: number; x: number; y: number; font: string }[] = [];
const iconStrokes: { icon: string; color: string; width: number }[] = [];
const pathStrokes: { color: string; width: number; dash: number[] }[] = [];
const paintOrder: ({ kind: "highlight"; clipped: boolean } | { kind: "image" })[] = [];
let measurements = 0;
let glyphWidth = 6;

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLCanvasElement", "HTMLDialogElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => frames.delete(id) });
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  Object.defineProperty(globalThis, "Path2D", { configurable: true, value: class { moveTo() {} lineTo() {} closePath() {} arc() {} roundRect() {} } });
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class { src = ""; complete = true; naturalWidth = 48; onload = null; } });
  const gradient = () => ({ addColorStop() {} });
  let activeClip: Path2D | undefined;
  let lineDash: number[] = [];
  const paintStack: { alpha: number; stroke: string; width: number; dash: number[]; clip: Path2D | undefined }[] = [];
  let paintedIcon = "";
  const context = new Proxy({
    globalAlpha: 1,
    strokeStyle: "",
    lineWidth: 1,
    stroke(path?: Path2D) {
      strokes.push(this.strokeStyle);
      if (this.strokeStyle === "rgba(167, 215, 255, 0.85)" || this.strokeStyle === "rgba(207, 229, 248, 0.6)") paintOrder.push({ kind: "highlight", clipped: !!activeClip });
      if (path) pathStrokes.push({ color: this.strokeStyle, width: this.lineWidth, dash: [...lineDash] });
      if (paintedIcon) iconStrokes.push({ icon: paintedIcon, color: this.strokeStyle, width: this.lineWidth });
      paintedIcon = "";
    },
    fillText(text: string, x: number, y: number) { labels.push(text); labelPaints.push({ text, alpha: this.globalAlpha, x, y, font: String((this as unknown as { font: string }).font) }); },
    clip(path?: Path2D) { activeClip = path ?? new Path2D(); },
    setLineDash(dash: number[]) { lineDash = [...dash]; },
    save() { paintStack.push({ alpha: this.globalAlpha, stroke: this.strokeStyle, width: this.lineWidth, dash: [...lineDash], clip: activeClip }); },
    restore() {
      const saved = paintStack.pop();
      if (!saved) return;
      this.globalAlpha = saved.alpha; this.strokeStyle = saved.stroke; this.lineWidth = saved.width; lineDash = saved.dash; activeClip = saved.clip;
    },
    createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: (text: string) => { measurements++; return { width: text.length * glyphWidth, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * glyphWidth, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }; },
    drawImage(image: { src: string }) { images.push({ src: image.src, alpha: this.globalAlpha }); paintOrder.push({ kind: "image" }); paintedIcon = image.src; },
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    // Layout is simulated, but tooltip bounds must differ from the canvas: the
    // measured card and the pointer corridor now share this geometry.
    const tooltip = this.classList.contains("landscape-hover");
    const width = tooltip ? Math.min(360, Number.parseFloat(this.style.maxWidth) || 360) : 1920;
    const height = tooltip ? Math.min(240, Number.parseFloat(this.style.maxHeight) || 240) : 1000;
    const left = tooltip ? Number.parseFloat(this.style.left) || 0 : 0;
    const top = tooltip ? Number.parseFloat(this.style.top) || 0 : 0;
    return { x: left, y: top, width, height, top, left, right: left + width, bottom: top + height, toJSON() {} };
  };
  dom.window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  class Pointer extends dom.window.MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, options: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; this.pointerType = options.pointerType ?? "mouse"; }
  }
  Object.defineProperty(dom.window, "PointerEvent", { configurable: true, value: Pointer });
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: Pointer });
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  studio = await import("../src/studio"); map = await import("../src/views/Isometric"); shell = await import("../src/views/Shell");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, busy: null };
});
after(async () => { await builder.dispose(); dom.window.close(); });
afterEach(() => { ui.cleanup(); frames.clear(); images.length = 0; strokes.length = 0; labels.length = 0; labelPaints.length = 0; iconStrokes.length = 0; pathStrokes.length = 0; paintOrder.length = 0; glyphWidth = 6; });

interface Debug { search(): { active: boolean; nodes: string[]; opacityOf(id: string): number }; stats(): { focus: string }; tagFilter(): { key: string; value?: string | null; muted: readonly string[] } }
const debug = () => (dom.window as unknown as { __studioLandscape: Debug }).__studioLandscape;
const search = () => ui.screen.getByRole("searchbox", { name: "Search isometric map" });
const draw = async () => ui.act(async () => {
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(performance.now() + 500);
});

async function mount(withInspector = false, selection?: string, initialResponse = response) {
  let updateResponse: (next: SnapshotResponse) => void;
  function Workbench() {
    const context = studio.useStudio();
    return h(shell.Shell, null, h("output", { "aria-label": "Selection" }, context.selected ?? "none"), h(map.Isometric),
      withInspector ? h("button", { onClick: () => context.setMode(context.mode === "dev" ? "prod" : "dev") }, "Switch environment") : null,
      null);
  }
  function Root() {
    const [current, setCurrent] = useState(initialResponse);
    updateResponse = setCurrent;
    const search = router.useSearch({ strict: false }) as { select?: string };
    const navigate = router.useNavigate();
    return h(studio.StudioProvider, { response: current, selected: search.select, select: (id: string | undefined) => void navigate({ to: ".", search: { select: id } } as never), children: h(Workbench) });
  }
  const root = router.createRootRoute({ component: Root, validateSearch: (search) => ({ select: typeof search.select === "string" ? search.select : undefined }) });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: [selection ? `/?select=${encodeURIComponent(selection)}` : "/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.waitFor(() => assert.ok(document.querySelector(".landscape, .empty"))); await draw();
  return async (next: SnapshotResponse) => { await ui.act(async () => updateResponse(next)); await draw(); };
}

test("permission connections show generated principal and scope while local database links show no cloud IAM", async () => {
  const launch = response.snapshot.models.dev.edges.find(edge => edge.relation === "runsTask")!;
  await mount(true, launch.id);
  assert.ok(ui.screen.getByRole("heading", { name: "Runs task" }), "the To row names the task the heading would repeat");
  const permissions = document.querySelector<HTMLDetailsElement>(".connection-authorization")!;
  assert.ok(permissions);
  assert.equal(permissions.open, false, "permissions start behind a disclosure");
  assert.equal(document.querySelector(".connection-header .authorization-badge"), null);
  ui.fireEvent.click(ui.within(permissions).getByText("Permissions", { selector: "summary" }));
  assert.equal(permissions.open, true);
  assert.ok(ui.screen.getByText("iam:PassRole"));
  assert.ok(ui.screen.getAllByText(/Lambda execution role/).length);
  assert.ok(ui.screen.getByText(/iam:PassedToService = ecs-tasks.amazonaws.com/));
  assert.ok(ui.screen.getByText("Applies when this workload runs in AWS."));
  assert.ok(ui.screen.getByText("IAM grant"));
  assert.equal(ui.screen.queryByText("Cloud IAM intent"), null);
  ui.cleanup();
  const local = response.snapshot.models.dev.edges.find(edge => edge.relation === "database" && edge.to === "local:postgres")!;
  await mount(true, local.id);
  assert.ok(ui.screen.getByRole("heading", { name: "Connects to database" }), "the To row names Local PostgreSQL");
  ui.fireEvent.click(ui.screen.getByText("Permissions", { selector: ".connection-authorization > summary" }));
  assert.ok(ui.screen.getAllByText("Local connection").length);
  assert.equal(ui.screen.queryByText("rds-db:connect"), null);
});

test("connection inspection keeps secret environment names ahead of optional permissions", async () => {
  const source = response.snapshot.models.dev.edges.find(edge => edge.relation === "env" && edge.authorization?.kind === "iam")
    ?? response.snapshot.models.dev.edges.find(edge => edge.relation === "secret" && edge.authorization?.kind === "iam");
  assert.ok(source, "a real secret delivery relationship is available");
  await mount(true, source.id);
  assert.ok(ui.screen.getByRole("heading", { name: `${source.relation === "env" ? "Reads" : "Loads secret"}: ${source.label}` }));
  assert.equal(document.querySelector(".connection-header .authorization-badge"), null);
  assert.equal(document.querySelector<HTMLDetailsElement>(".connection-authorization")?.open, false);
});

test("conditional deployment inspection names its framework input and points from that input to the workload", async () => {
  const condition = response.snapshot.models.dev.edges.find(edge => edge.relation === "deployWhen" && edge.to === "lambda:ws-connect-route")!;
  assert.ok(condition);
  await mount(true, condition.id);
  assert.ok(ui.screen.getByRole("heading", { name: "Conditional Deployment" }), "the From row names the input the heading would repeat as $enableWebSocketApi");
  const endpoints = document.querySelector(".connection-header .connection-endpoints")!;
  assert.ok(endpoints);
  const rows = [...endpoints.querySelectorAll("div")].map(row => ({ direction: row.querySelector("dt")?.textContent, label: row.querySelector("button")?.textContent }));
  assert.deepEqual(rows, [{ direction: "From", label: "Input: enableWebSocketApi" }, { direction: "To", label: "WebSocket: $connect" }]);
  assert.ok(ui.screen.getByText('Deploys when enableWebSocketApi equals "true".'));
});

test("purpose filters replace IAM filtering and do not arm source edits", async () => {
  await mount();
  assert.equal(ui.screen.queryByRole("button", { name: "Only IAM grants" }), null);
  const categories = ui.within(ui.screen.getByRole("group", { name: "Background connections" })).getAllByRole("button");
  assert.equal(categories.length, 3);
  assert.deepEqual(categories.map(button => button.getAttribute("aria-pressed")), ["false", "false", "true"]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Resource interactions" })); await draw();
  assert.equal(ui.screen.getByRole("button", { name: "Resource interactions" }).getAttribute("aria-pressed"), "false");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
});

test("connection filters omit unused purposes and return when source adds those relationships", async () => {
  const onlyRoutes = (mode: "dev" | "prod") => ({ ...response.snapshot.models[mode], edges: response.snapshot.models[mode].edges.filter(edge => edge.relation === "routes") });
  const sparse = { ...response, snapshot: { ...response.snapshot, models: { dev: onlyRoutes("dev"), prod: onlyRoutes("prod") } } };
  const update = await mount(false, undefined, sparse);
  const filterNames = () => ui.within(ui.screen.getByRole("group", { name: "Background connections" })).getAllByRole("button").map(button => button.textContent);
  assert.deepEqual(filterNames(), ["Routes and events"]);
  await update(response);
  assert.deepEqual(filterNames(), ["Routes and events", "Environment and secrets", "Resource interactions"]);
});

test("the inputs island opens the shared creator even after using the global chooser", async () => {
  await mount(true, "island:inputs");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  const chooser = ui.within(ui.screen.getByRole("dialog", { name: "Add to application" }));
  ui.fireEvent.click(chooser.getByRole("button", { name: "Close add menu" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Create input parameter or secret" }));
  const wizard = await ui.screen.findByRole("dialog", { name: "Create input parameter or secret" });
  const controls = ui.within(wizard);
  assert.equal(controls.getByRole("switch", { name: "Secret" }).getAttribute("aria-checked"), "false");
  ui.fireEvent.click(controls.getByRole("switch", { name: "Secret" }));
  assert.equal(controls.getByRole("switch", { name: "Secret" }).getAttribute("aria-checked"), "true");
  ui.fireEvent.click(controls.getByRole("button", { name: "Cancel creation" }));
  assert.equal(ui.screen.queryByRole("dialog"), null);
});

test("an input group inspects through its entries and adds a new input into itself", async () => {
  await mount(true, "resource:langgraph");
  assert.ok(ui.screen.getByText("Input group"));
  assert.equal(ui.screen.queryByRole("region", { name: "Deployment" }), null);
  const entries = ui.within(ui.screen.getByRole("region", { name: "Entries" }));
  for (const name of ["modelProvider", "bedrockModelId", "bedrockMantleModelId", "openaiModelId"]) assert.ok(entries.getByRole("button", { name }));
  assert.ok(entries.getByText("LANGGRAPH_MODEL_PROVIDER"));
  assert.ok(entries.getByText("Default · bedrock-mantle"));
  const workloads = ui.within(ui.screen.getByRole("region", { name: "Used by" }));
  assert.ok(workloads.getByRole("button", { name: "example-agent" }));
  assert.ok(workloads.getByText("Reads all 4 entries"));
  assert.ok(ui.screen.getByText("Environment file sources"));
  // A group's tags are its entries' tags; it has none of its own.
  assert.ok(ui.screen.getByText(/owns no AWS resource, so it has no tags of its own/));
  ui.fireEvent.click(entries.getByRole("button", { name: "Add input" }));
  const wizard = ui.within(await ui.screen.findByRole("dialog", { name: "Create input parameter or secret" }));
  assert.ok(wizard.getByText("resources.langgraph"));
  ui.fireEvent.click(wizard.getByRole("button", { name: "Cancel creation" }));
  // An entry opens its own inspector, names its group, and keeps the group's building selected on the map.
  ui.fireEvent.click(entries.getByRole("button", { name: "modelProvider" })); await draw();
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "resource:langgraph.modelProvider");
  assert.ok(ui.screen.getByText("In input group"));
  assert.equal(ui.screen.queryByRole("region", { name: "Deployment" }), null);
  assert.equal(ui.screen.queryByRole("combobox", { name: "Deploy" }), null);
  assert.ok(debug().search().nodes.includes("resource:langgraph"));
  assert.ok(debug().search().nodes.includes("agent:example-agent"));
});

test("inferred infrastructure keeps its summary and owner navigation without a disabled Deploy selector", async () => {
  await mount(true, "gateway:http");
  const deployment = ui.within(ui.screen.getByRole("region", { name: "Deployment" }));
  assert.ok(deployment.getByText(/framework manages this gateway/));
  assert.equal(deployment.queryByRole("combobox", { name: "Deploy" }), null);
  ui.fireEvent.click(deployment.getByText(/Configure owners/, { selector: "summary" }));
  ui.fireEvent.click(deployment.getByRole("button", { name: "Configure /sign-out" }));
  await draw();
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:sign-out");
  assert.ok(ui.screen.getByRole("combobox", { name: "Deploy" }), "the owner retains its editable setting");
});

test("input and environment grouping inspectors omit deployment controls", async () => {
  for (const id of ["resource:openaiApiKey", "envfile:dev", "client-envfile", "island:inputs", "island:environment", "island:client-environment"]) {
    await mount(true, id);
    assert.equal(ui.screen.queryByRole("region", { name: "Deployment" }), null, id);
    assert.equal(ui.screen.queryByRole("combobox", { name: "Deploy" }), null, id);
    ui.cleanup();
  }
});

test("parameter choices survive switching to a secret and reopening the resource chooser", async () => {
  await mount(true, "island:inputs");
  const start = () => ui.fireEvent.click(ui.screen.getByRole("button", { name: "Create input parameter or secret" }));
  const wizard = () => ui.within(ui.screen.getByRole("dialog", { name: "Create input parameter or secret" }));
  start();
  ui.fireEvent.change(wizard().getByRole("textbox", { name: "Stable identifier" }), { target: { value: "preservedInput" } });
  ui.fireEvent.change(wizard().getByRole("textbox", { name: "Declaration default (optional)" }), { target: { value: "enabled" } });
  ui.fireEvent.click(wizard().getByText("Advanced settings"));
  ui.fireEvent.change(wizard().getByRole("textbox", { name: "Allowed string values (comma-separated)" }), { target: { value: "enabled, disabled" } });
  ui.fireEvent.click(wizard().getByRole("switch", { name: "Secret" }));
  ui.fireEvent.click(wizard().getByRole("button", { name: "Back to resource types" }));
  const chooser = ui.within(ui.screen.getByRole("dialog", { name: "Add to application" }));
  ui.fireEvent.click(chooser.getByRole("button", { name: "Input parameter or secret" }));
  assert.equal(wizard().getByRole("switch", { name: "Secret" }).getAttribute("aria-checked"), "true");
  ui.fireEvent.click(wizard().getByRole("switch", { name: "Secret" }));
  assert.equal((wizard().getByRole("textbox", { name: "Declaration default (optional)" }) as HTMLInputElement).value, "enabled");
  ui.fireEvent.click(wizard().getByText("Advanced settings"));
  assert.equal((wizard().getByRole("textbox", { name: "Allowed string values (comma-separated)" }) as HTMLInputElement).value, "enabled, disabled");
  ui.fireEvent.click(wizard().getByRole("button", { name: "Cancel creation" }));
  start();
  assert.equal((wizard().getByRole("textbox", { name: "Declaration default (optional)" }) as HTMLInputElement).value, "");
  ui.fireEvent.click(wizard().getByText("Advanced settings"));
  assert.equal((wizard().getByRole("textbox", { name: "Allowed string values (comma-separated)" }) as HTMLInputElement).value, "", "a new creation starts without the cancelled form's parameter settings");
});

test("new WebSocket creation labels its guarded handshake condition and retains Off", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Add to application" }));
  ui.fireEvent.click(ui.within(ui.screen.getByRole("dialog", { name: "Add to application" })).getByRole("button", { name: "Function" }));
  const wizard = ui.within(ui.screen.getByRole("dialog", { name: "Create function" }));
  ui.fireEvent.change(wizard.getByRole("textbox", { name: "Stable identifier" }), { target: { value: "conditional-action" } });
  ui.fireEvent.change(wizard.getByRole("combobox", { name: "Function category" }), { target: { value: "webSocket" } });
  const deploy = wizard.getByRole("combobox", { name: "Execution lanes" }) as HTMLSelectElement;
  assert.equal(deploy.selectedOptions[0]!.textContent, "Use $connect condition");
  assert.match(document.getElementById(deploy.getAttribute("aria-describedby")!)!.textContent!, /ENABLE_WEBSOCKET_API equals "true"/);
  for (const value of ["local-only", "cloud-only"]) assert.equal(deploy.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!.disabled, true);
  assert.equal(deploy.querySelector<HTMLOptionElement>('option[value="none"]')!.disabled, false);
  ui.fireEvent.change(deploy, { target: { value: "local-only" } });
  assert.equal((wizard.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement).disabled, true, "an incompatible selected setting is rejected rather than broadened");
  ui.fireEvent.change(deploy, { target: { value: "none" } });
  assert.equal((wizard.getByRole("button", { name: "Review generated changes" }) as HTMLButtonElement).disabled, false);
});

test("event inspectors keep connection and trigger component identities distinct across refresh", async () => {
  const event = response.snapshot.models.dev.targets.find(target => target.role === "event")!;
  assert.ok(event, "the real framework fixture includes an event Lambda");
  const errors: string[] = [];
  const captured = mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  try {
    const update = await mount(true, event.ref);
    await update({ ...response, snapshot: { ...response.snapshot, revision: `${response.snapshot.revision}-refreshed` } });
    assert.equal(errors.filter(message => /same key|Encountered two children/.test(message)).length, 0, errors.join("\n"));
    assert.ok(ui.screen.getByRole("heading", { name: event.title }));
  } finally { captured.mock.restore(); }
});

test("empty graphs show guidance and mount the renderer and wheel controls when source recovers", async () => {
  const emptyModel = (mode: "dev" | "prod") => ({ ...response.snapshot.models[mode], targets: [], routes: [], resources: [], edges: [], networks: [], localServices: [], managedDatabase: undefined });
  const empty = { ...response, snapshot: { ...response.snapshot, revision: `${response.snapshot.revision}-empty`, models: { dev: emptyModel("dev"), prod: emptyModel("prod") } } };
  const update = await mount(false, undefined, empty);
  assert.ok(ui.screen.getByText(/graph did not load/));
  assert.equal(document.querySelector("canvas"), null);
  for (let attempt = 0; attempt < 2; attempt++) {
    await update(response);
    assert.ok(search());
    const canvas = document.querySelector("canvas")!;
    assert.ok(canvas, "a recovered graph mounts its renderer");
    const camera = () => (dom.window as unknown as { __studioLandscape: { camera(): Camera } }).__studioLandscape.camera();
    const before = camera().zoom;
    ui.fireEvent.wheel(canvas, { deltaY: -100, deltaMode: 0, clientX: 300, clientY: 200 }); await draw();
    assert.ok(camera().zoom > before, "wheel zoom is registered on the recovered canvas");
    await update(empty);
    assert.ok(ui.screen.getByText(/graph did not load/));
    assert.equal(document.querySelector("canvas"), null);
  }
  await update(response);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fit the whole application" })); await draw();
});

test("an empty development graph retains source controls to open the working production graph", async () => {
  const development = response.snapshot.models.dev;
  const emptyDevelopment = { ...development, targets: [], routes: [], resources: [], edges: [], networks: [], localServices: [], managedDatabase: undefined };
  await mount(false, undefined, { ...response, snapshot: { ...response.snapshot, models: { ...response.snapshot.models, dev: emptyDevelopment } } });
  assert.ok(ui.screen.getByText(/development graph did not load/));
  assert.equal(ui.screen.queryByRole("group", { name: "Source edit history" }), null);
  const environment = () => ui.within(ui.screen.getByRole("group", { name: "Source environment" }));
  ui.fireEvent.click(environment().getByRole("button", { name: "Production" }));
  await ui.waitFor(() => assert.ok(ui.screen.queryByRole("searchbox", { name: "Search isometric map" })));
  await draw();
  assert.ok(document.querySelector("canvas"), "the alternate source mode mounts its working map");
  assert.equal(environment().getByRole("button", { name: "Production" }).getAttribute("aria-pressed"), "true");
  assert.ok(ui.screen.queryByText(/graph did not load/) === null);
  ui.fireEvent.click(environment().getByRole("button", { name: "Development" }));
  await ui.screen.findByText(/development graph did not load/);
  assert.equal(ui.screen.queryByRole("group", { name: "Source edit history" }), null);
  assert.equal(environment().getByRole("button", { name: "Development" }).getAttribute("aria-pressed"), "true");
  assert.ok(document.querySelector("canvas") === null);
});

test("drag cursors track gesture completion and cancellation without renderer statistics updates", async () => {
  await mount();
  const canvas = document.querySelector("canvas")!;
  assert.equal(canvas.style.cursor, "grab");
  const startDrag = () => {
    ui.fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 2, clientY: 2 });
    ui.fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 42, clientY: 42 });
    assert.equal(canvas.style.cursor, "grabbing");
  };
  startDrag();
  ui.fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 42, clientY: 42 });
  assert.equal(canvas.style.cursor, "grab");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none", "a pan never selects a resource");
  startDrag();
  ui.fireEvent.pointerCancel(canvas, { pointerId: 1 });
  assert.equal(canvas.style.cursor, "grab");
});

test("clearing map search and tag filters returns focus to their surviving controls", async () => {
  await mount();
  ui.fireEvent.change(search(), { target: { value: "graphql" } });
  const clear = ui.screen.getByRole("button", { name: "Clear map search" });
  clear.focus();
  ui.fireEvent.click(clear);
  assert.equal((search() as HTMLInputElement).value, "");
  assert.equal(document.activeElement, search());
  const key = ui.screen.getByRole("combobox", { name: "Filter map by tag key" }) as HTMLSelectElement;
  const available = [...key.options].find(option => option.value);
  assert.ok(available, "the fixture contains declared tags");
  ui.fireEvent.change(key, { target: { value: available.value } });
  const reset = ui.screen.getByRole("button", { name: "Clear tag filter" });
  reset.focus();
  ui.fireEvent.click(reset);
  assert.equal(key.value, "");
  assert.equal(document.activeElement, key);
});

test("the keyboard entity navigator dismisses its preview before Escape returns focus to the canvas", async () => {
  await mount();
  const list = ui.screen.getByRole("list", { name: "Entities in the landscape" });
  assert.ok(list.classList.contains("landscape-entity-list"), "the list becomes visible on keyboard focus");
  assert.match(list.textContent!, /Escape to return to the map/);
  const buttons = ui.within(list).getAllByRole("button");
  await ui.act(async () => buttons[0]!.focus());
  ui.fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
  assert.equal(document.activeElement, buttons[1]);
  ui.fireEvent.keyDown(buttons[1]!, { key: "End" });
  assert.equal(document.activeElement, buttons.at(-1));
  ui.fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  assert.equal(document.activeElement, buttons.at(-1), "the first Escape dismisses information without moving focus");
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  ui.fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  assert.equal(document.activeElement, document.querySelector("canvas"));
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none", "keyboard navigation does not change source selection");
});

test("Resources opens from the toolbar, inspects in place and Back returns to the same search and type", async () => {
  await mount();
  assert.equal(ui.screen.queryByRole("complementary"), null, "the panel starts closed");
  const toggle = ui.screen.getByRole("button", { name: "Resources" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  ui.fireEvent.click(toggle);
  const panel = ui.screen.getByRole("complementary", { name: "Resources" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(panel.textContent!, /map shows declarations/);
  ui.fireEvent.change(search(), { target: { value: "graphql" } });
  const results = ui.within(panel);
  assert.ok(results.getByRole("button", { name: /graphql-api.*HTTP Lambda/ }));
  assert.equal(results.queryByRole("button", { name: /sign-in/ }), null);
  assert.ok(panel.querySelector('.resource-row img[src$="aws/lambda.svg"]'), "rows reuse the shared icon registry");
  ui.fireEvent.change(results.getByRole("combobox", { name: "Map resource type" }), { target: { value: "HTTP Lambda" } });
  ui.fireEvent.click(results.getByRole("button", { name: /graphql-api.*HTTP Lambda/ }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:graphql-api"));
  assert.equal(ui.screen.getByRole("complementary", { name: "Inspector" }), panel, "the inspector replaces the list in the same panel");
  assert.equal(ui.screen.queryByRole("complementary", { name: "Resources" }), null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  const back = ui.screen.getByRole("button", { name: "Back to Resources" });
  assert.equal(document.activeElement, back, "opening a row keeps the keyboard in the panel");
  ui.fireEvent.click(back);
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("complementary", { name: "Resources" })));
  assert.equal((search() as HTMLInputElement).value, "graphql");
  assert.equal((ui.screen.getByRole("combobox", { name: "Map resource type" }) as HTMLSelectElement).value, "HTTP Lambda");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none", "Back ends the selection");
  const opened = document.activeElement as HTMLElement;
  assert.equal(opened.dataset.resourceId, "lambda:graphql-api", "focus returns to the row that was opened");
  ui.fireEvent.click(opened);
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" }), "the row reopens its inspector"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close panel" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none"));
  assert.equal(ui.screen.queryByRole("complementary"), null);
  assert.equal(document.activeElement, document.querySelector("canvas"), "closing returns the keyboard to the map");
  assert.equal((search() as HTMLInputElement).value, "graphql");
  ui.fireEvent.click(toggle);
  assert.ok(ui.screen.getByRole("complementary", { name: "Resources" }));
  ui.fireEvent.click(toggle);
  assert.equal(ui.screen.queryByRole("complementary"), null);
});

test("resource browsing previews successive rows with animated connections and leaves selection and camera alone", async () => {
  const render = mock.method(SceneRenderer.prototype, "render");
  try {
    await mount();
    // Enable ordinary selection animation, even under this suite's reduced-motion default.
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Resume motion" }));
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Resources" }));
    await draw();
    const last = () => render.mock.calls.at(-1)!.arguments[0] as RenderState;
    const camera = { ...last().camera };
    const panel = ui.screen.getByRole("complementary", { name: "Resources" });
    const rows = [...panel.querySelectorAll<HTMLButtonElement>(".resource-row")];
    for (const row of rows.slice(0, 8)) {
      pathStrokes.length = 0;
      ui.fireEvent.pointerEnter(row, { pointerType: "mouse" }); await draw();
      assert.equal(last().selected, row.dataset.resourceId);
      assert.equal(last().focus.kind, "selection");
      assert.equal(last().motion, true, "preview animates highlighted connections using the user's motion setting");
      assert.deepEqual(last().camera, camera);
      assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
      assert.ok(ui.screen.getByRole("complementary", { name: "Resources" }));
      assert.equal(render.mock.calls.at(-1)!.result!.animating, true);
      assert.ok(pathStrokes.some(stroke => Math.abs(stroke.width - 2.2 / camera.zoom) < 1e-8 && Number(/, ([\d.]+)\)$/.exec(stroke.color)?.[1]) > 0.94), `connections receive the selection highlight for ${row.dataset.resourceId}`);
      ui.fireEvent.pointerLeave(row, { pointerType: "mouse" });
    }
    await draw();
    assert.equal(last().selected, undefined);
    assert.equal(last().focus.kind, "all");
    assert.equal(last().motion, true, "the user's motion setting is preserved");
    await ui.act(async () => rows[0]!.focus()); await draw();
    assert.equal(last().selected, rows[0]!.dataset.resourceId, "keyboard focus previews too");
    ui.fireEvent.keyDown(rows[0]!, { key: "ArrowDown" }); await draw();
    assert.equal(last().selected, rows[1]!.dataset.resourceId);
    ui.fireEvent.pointerEnter(rows[2]!, { pointerType: "mouse" }); await draw();
    assert.equal(last().selected, rows[2]!.dataset.resourceId);
    ui.fireEvent.pointerLeave(rows[2]!); await draw();
    assert.equal(last().selected, rows[1]!.dataset.resourceId, "leaving the pointer preview restores keyboard emphasis");
    ui.fireEvent.change(search(), { target: { value: "graphql" } }); await draw();
    assert.equal(last().selected, undefined, "filtering away a row clears its preview");
    assert.equal(last().focus.kind, "search");
    const graphql = panel.querySelector<HTMLButtonElement>('[data-resource-id="lambda:graphql-api"]')!;
    ui.fireEvent.pointerEnter(graphql, { pointerType: "mouse" }); await draw();
    assert.equal(last().focus.kind, "selection", "preview takes precedence over search");
    ui.fireEvent.click(graphql);
    await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:graphql-api")); await draw();
    assert.equal(last().selected, "lambda:graphql-api");
    assert.equal(last().motion, true, "committing selection restores normal animation");
    assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" }));
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close panel" }));
    await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none")); await draw();
    assert.equal(last().selected, undefined, "closing cannot retain an unmounted preview");
  } finally { render.mock.restore(); }
});

test("resource rows show the map's hover content, stay readable under the pointer and dismiss with Escape", async () => {
  await mount();
  const mapCard = await hoverOver("lambda:sign-out");
  const expected = mapCard.textContent;
  ui.fireEvent.pointerLeave(document.querySelector("canvas")!); await draw();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Resources" }));
  const panel = ui.screen.getByRole("complementary", { name: "Resources" });
  const row = panel.querySelector<HTMLButtonElement>('[data-resource-id="lambda:sign-out"]')!;
  ui.fireEvent.pointerEnter(row);
  assert.equal(ui.screen.queryByRole("tooltip"), null, "passing over a row does not flash a card");
  const card = await ui.screen.findByRole("tooltip");
  assert.equal(card.textContent, expected, "the list and map use the same description and deployment facts");
  assert.equal(row.getAttribute("aria-describedby"), card.id);
  assert.equal(row.getAttribute("title"), null, "no competing native tooltip");
  assert.equal(card.parentElement, document.body, "the scrollable panel cannot clip the preview");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
  ui.fireEvent.pointerLeave(row); ui.fireEvent.pointerEnter(card);
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.getByRole("tooltip"), card, "the pointer can cross into the card to read it");
  ui.fireEvent.keyDown(document.body, { key: "Escape" });
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  assert.equal(row.hasAttribute("aria-describedby"), false);
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.queryByRole("tooltip"), null, "Escape remains dismissed until another interaction");
  ui.fireEvent.pointerEnter(row);
  await ui.screen.findByRole("tooltip");
  ui.fireEvent.click(row);
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" })));
  assert.equal(ui.screen.queryByRole("tooltip"), null, "inspection removes the preview");
});

test("resource previews follow keyboard focus, include source warnings, and ignore touch focus", async context => {
  const broken = (model: typeof response.snapshot.models.dev) => ({ ...model, targets: model.targets.map(target => target.ref === "lambda:graphql-api" ? { ...target, implementation: { ready: false, problems: ["Configured handler index.ts is missing."] } } : target) });
  await mount(false, undefined, { ...response, snapshot: { ...response.snapshot, models: { dev: broken(response.snapshot.models.dev), prod: broken(response.snapshot.models.prod) } } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Resources" }));
  const panel = ui.screen.getByRole("complementary", { name: "Resources" });
  const row = panel.querySelector<HTMLButtonElement>('[data-resource-id="lambda:graphql-api"]')!;
  await ui.act(async () => row.focus());
  assert.match(ui.screen.getByRole("tooltip").textContent!, /Configured handler index.ts is missing/);
  ui.fireEvent.keyDown(row, { key: "ArrowDown" });
  const next = document.activeElement as HTMLElement;
  assert.equal(ui.screen.getByRole("tooltip").querySelector("strong")?.textContent, next.querySelector("strong")?.textContent);
  const list = panel.querySelector<HTMLElement>(".resource-browser-list")!;
  context.mock.method(list, "getBoundingClientRect", () => new dom.window.DOMRect(600, 50, 320, 400));
  context.mock.method(next, "getBoundingClientRect", () => new dom.window.DOMRect(600, 380, 320, 44));
  ui.fireEvent.scroll(list);
  assert.equal(ui.screen.getByRole("tooltip").querySelector("strong")?.textContent, next.querySelector("strong")?.textContent, "scrolling a keyboard-focused row into view retains its preview");
  ui.fireEvent.keyDown(next, { key: "Escape" });
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  assert.equal(document.activeElement, next, "Escape keeps the reader's place in the list");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
  await ui.act(async () => { next.blur(); next.focus(); });
  ui.fireEvent.wheel(list);
  assert.equal(ui.screen.queryByRole("tooltip"), null, "an explicit wheel scroll dismisses even a focused preview");
  ui.fireEvent.pointerEnter(row, { pointerType: "touch" });
  ui.fireEvent.pointerDown(row, { pointerType: "touch" });
  await ui.act(async () => row.focus());
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.queryByRole("tooltip"), null, "touch goes straight to inspection even when another row previously had keyboard focus");
  ui.fireEvent.keyDown(row, { key: "ArrowDown" });
  assert.ok(ui.screen.getByRole("tooltip"), "keyboard navigation resumes previews after a touch interaction");
});

test("scrolling, filtering and closing Resources clear the preview and pending opens", async () => {
  await mount();
  const toggle = ui.screen.getByRole("button", { name: "Resources" });
  ui.fireEvent.click(toggle);
  const panel = ui.screen.getByRole("complementary", { name: "Resources" });
  const row = panel.querySelector<HTMLButtonElement>('[data-resource-id="lambda:sign-out"]')!;
  ui.fireEvent.pointerEnter(row); await ui.screen.findByRole("tooltip");
  ui.fireEvent.scroll(panel.querySelector(".resource-browser-list")!);
  assert.equal(ui.screen.queryByRole("tooltip"), null, "a scrolling list does not leave a floating stale card");
  ui.fireEvent.pointerEnter(row); await ui.screen.findByRole("tooltip");
  ui.fireEvent.change(search(), { target: { value: "graphql" } });
  assert.equal(ui.screen.queryByRole("tooltip"), null, "a removed row loses its tooltip");
  const remaining = panel.querySelector<HTMLButtonElement>(".resource-row")!;
  ui.fireEvent.pointerEnter(remaining);
  ui.fireEvent.click(toggle);
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.queryByRole("tooltip"), null, "a queued open cannot outlive its panel");
});

test("a map selection opens the inspector directly, and Back from it opens Resources", async () => {
  await mount(false, "lambda:sign-in");
  assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" }));
  assert.equal(document.querySelector(".inspector-content .ref")!.textContent, "lambda:sign-in");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^graphql-api, HTTP Lambda/ }));
  await ui.waitFor(() => assert.equal(document.querySelector(".inspector-content .ref")!.textContent, "lambda:graphql-api"));
  assert.equal(document.querySelectorAll(".workspace-panel").length, 1, "another selection reuses the open panel");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Resources" }));
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("complementary", { name: "Resources" })));
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none", "Back ends the selection");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^sign-in, HTTP Lambda/ }));
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" })));
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 2, clientY: 2 });
  ui.fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 2, clientY: 2 });
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none"));
  assert.ok(ui.screen.getByRole("complementary", { name: "Resources" }), "clearing the selection on the map returns to the open list");
});

test("Back, Close and the Resources toggle keep unsaved inspector edits behind the navigation warning", async () => {
  await mount(false, "lambda:graphql-api");
  const description = () => document.querySelector<HTMLTextAreaElement>('.workspace-panel textarea[aria-label="Description"]')!;
  ui.fireEvent.change(description(), { target: { value: "Pending panel edit" } });
  for (const name of ["Back to Resources", "Close panel", "Resources"]) {
    ui.fireEvent.click(ui.screen.getByRole("button", { name }));
    await ui.waitFor(() => assert.ok(document.querySelector("dialog[open]"), `${name} asks first`));
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep Editing" }));
    await ui.waitFor(() => assert.equal(document.querySelector("dialog[open]"), null));
    assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" }));
    assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:graphql-api");
    assert.equal(description().value, "Pending panel edit");
  }
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to Resources" }));
  await ui.waitFor(() => assert.ok(document.querySelector("dialog[open]")));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard and Continue" }));
  await ui.waitFor(() => assert.ok(ui.screen.getByRole("complementary", { name: "Resources" })));
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
  assert.equal(document.querySelector("dialog[open]"), null);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close panel" }));
  assert.equal(ui.screen.queryByRole("complementary"), null);
  assert.equal(document.querySelector("dialog[open]"), null, "nothing pending, nothing to confirm");
});

test("missing implementation is visible at its canonical map resource without changing topology", async () => {
  const breakImplementation = (model: typeof response.snapshot.models.dev) => ({ ...model, targets: model.targets.map(target => target.ref === "lambda:graphql-api" ? { ...target, implementation: { ready: false, problems: ["Configured handler index.ts is missing."] } } : target) });
  const failed = { ...response, snapshot: { ...response.snapshot, models: { dev: breakImplementation(response.snapshot.models.dev), prod: breakImplementation(response.snapshot.models.prod) } } };
  const healthyScene = buildScene(response.snapshot.models.dev), brokenScene = buildScene(failed.snapshot.models.dev);
  assert.deepEqual(brokenScene.nodes.map(node => [node.id, node.gx, node.gy]), healthyScene.nodes.map(node => [node.id, node.gx, node.gy]));
  assert.deepEqual(brokenScene.nodes.find(node => node.id === "lambda:graphql-api")?.sourceProblems, ["Configured handler index.ts is missing."]);
  await mount(false, undefined, failed);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Resources" }));
  const list = ui.screen.getByRole("complementary", { name: "Resources" });
  const resource = ui.within(list).getByRole("button", { name: /graphql-api.*Needs attention/ });
  ui.fireEvent.click(resource);
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:graphql-api"));
});

test("the map has one look and the real renderer fades nonmatches while highlighting matching icons", async () => {
  dom.window.localStorage.setItem("framework-studio:isometric-look", "classic");
  await mount();
  assert.ok(ui.screen.queryByRole("button", { name: "Graphite look" }) === null);
  images.length = 0;
  ui.fireEvent.change(search(), { target: { value: "graphql" } }); await draw();
  assert.equal(debug().search().active, true);
  assert.ok(debug().search().nodes.includes("lambda:graphql-api"));
  assert.equal(debug().search().opacityOf("lambda:sign-in"), SEARCH_FADE);
  const lambdas = images.filter((image) => image.src === iconUrl("lambda"));
  assert.ok(lambdas.some((image) => image.alpha === 1), "a matching Lambda stays opaque");
  assert.ok(lambdas.some((image) => image.alpha === SEARCH_FADE), "unmatched Lambda icons are transparent");
});

test("clicking a faded node overrides search; clicking empty canvas restores the retained query", async () => {
  await mount();
  ui.fireEvent.change(search(), { target: { value: "graphql" } }); await draw();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^sign-in, HTTP Lambda/ }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:sign-in")); await draw();
  assert.equal(debug().stats().focus, "selection");
  assert.equal(debug().search().active, false);
  assert.equal((search() as HTMLInputElement).value, "graphql");
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 2, clientY: 2 });
  ui.fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 2, clientY: 2 });
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none")); await draw();
  assert.equal(debug().search().active, true);
  assert.equal((search() as HTMLInputElement).value, "graphql");
  assert.equal(debug().search().opacityOf("lambda:sign-in"), SEARCH_FADE);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Clear map search" })); await draw();
  assert.equal(debug().stats().focus, "all");
  assert.equal(debug().search().opacityOf("lambda:sign-in"), 1);
});

test("zero-result searches fade the whole map and whitespace restores the overview", async () => {
  await mount();
  ui.fireEvent.change(search(), { target: { value: "not-a-real-entity-987654" } }); await draw();
  assert.ok(ui.screen.getByText("0 matches"));
  assert.equal(debug().search().nodes.length, 0);
  assert.equal(debug().search().opacityOf("lambda:graphql-api"), SEARCH_FADE);
  ui.fireEvent.change(search(), { target: { value: "   " } }); await draw();
  assert.equal(debug().stats().focus, "all");
});

test("network fixtures can be selected from the map's accessible item list", async () => {
  await mount();
  ui.fireEvent.click(document.querySelector('button[data-entity-id="prop:vpc:application:endpoint:s3"]')!);
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "prop:vpc:application:endpoint:s3"));
  await draw();
  assert.equal(debug().stats().focus, "selection");
  ui.fireEvent.click(document.querySelector('button[data-entity-id="prop:vpc:application:internet-gateway"]')!);
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "prop:vpc:application:internet-gateway"));
});

test("gateways and endpoints use pointer cursors and open their inspectors from the canvas", async () => {
  await mount(true);
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { kind: string; id: string } | undefined } }).__studioLandscape;
  const canvas = document.querySelector("canvas")!;
  for (const prop of scene.props) {
    const hull = prop.geometry.hull;
    const center = { x: 0, y: 0 };
    for (let index = 0; index < hull.length; index += 2) { center.x += hull[index]! / (hull.length / 2); center.y += hull[index + 1]! / (hull.length / 2); }
    const at = worldToScreen(state.camera(), state.viewport(), center);
    assert.equal(state.pickAt(at.x, at.y)?.id, prop.id);
    ui.fireEvent.pointerMove(canvas, { clientX: at.x, clientY: at.y }); await draw();
    assert.equal(canvas.style.cursor, "pointer", prop.id);
    ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
    ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 }); await draw();
    await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, prop.id));
  }
  ui.fireEvent.pointerLeave(canvas); await draw();
  assert.equal(canvas.style.cursor, "grab");
});

test("missing required connections paint red X markers and clicking the marker selects its guidance", async () => {
  const original = response;
  const edge = response.snapshot.models.dev.edges.find((edge) => edge.relation === "supplies" && edge.from === "envfile:dev")!;
  assert.ok(edge);
  const issue = { resource: edge.to, name: edge.label, mode: "dev" as const, file: "cdk-app/.env.dev", required: true, status: "missing" as const, reasons: ["Required by fixture."] };
  const model = { ...response.snapshot.models.dev, edges: response.snapshot.models.dev.edges.map((item) => item.id === edge.id ? { ...item, inputRequirement: issue } : item) };
  response = { ...response, snapshot: { ...response.snapshot, models: { ...response.snapshot.models, dev: model } } };
  try {
    await mount();
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Environment and secrets" })); await draw();
    assert.ok(strokes.includes("#ff5f6d"), "the actual renderer strokes the error marker in red");
    const scene = buildScene(model, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
    // The supplied input may stand in its group, so the marker sits on the drawn connection that carries it.
    const drawn = scene.edges.find((connection) => connection.members.some((member) => member.edge.id === edge.id))!;
    const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { kind: string; id: string } } }).__studioLandscape;
    const at = worldToScreen(state.camera(), state.viewport(), connectionMidpoint(scene.routes[drawn.id]!.points));
    assert.deepEqual(state.pickAt(at.x, at.y)?.id, drawn.id, "the painted marker and hit area agree");
    const canvas = document.querySelector("canvas")!;
    ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
    ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 });
    await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, drawn.id));
    assert.equal(debug().stats().focus, "selection");
  } finally { response = original; }
});

test("connections over terrain receive hover and clicks while clear terrain still opens its island", async () => {
  await mount(true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Routes and events" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Environment and secrets" })); await draw();
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
  const slabs = islandDrawOrder(islandSlabs(scene));
  const state = (dom.window as unknown as { __studioLandscape: {
    camera(): Camera; viewport(): Viewport;
    cards(): { x: number; y: number; width: number; height: number }[];
    badges(): { x: number; y: number; width: number; height: number }[];
    connections(): { points: { x: number; y: number }[] }[];
    pickAt(x: number, y: number): { kind: string; id: string } | undefined;
  } }).__studioLandscape;
  const at = state.connections().flatMap((connection) => connection.points.slice(2, -2)).find((point) => {
    const world = screenToWorld(state.camera(), state.viewport(), point);
    return pickIsland(world, slabs)
      && ![...scene.nodes, ...scene.props].some((node) => insidePolygon(world.x, world.y, node.geometry.hull))
      && ![...state.cards(), ...state.badges()].some((card) => point.x >= card.x && point.x <= card.x + card.width && point.y >= card.y && point.y <= card.y + card.height);
  });
  assert.ok(at, "a regular connection crosses terrain away from node controls");
  const hit = state.pickAt(at.x, at.y)!;
  assert.equal(hit.kind, "edge", "the line has priority over its underlying slab");
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerMove(canvas, { clientX: at.x, clientY: at.y }); await draw();
  assert.ok(await ui.screen.findByRole("tooltip"));
  ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, hit.id));
  assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" }).querySelector(".connection-header"));

  const clear = scene.tiles.map((tile) => worldToScreen(state.camera(), state.viewport(), project({ x: tile.gx, y: tile.gy, h: tile.h })))
    .find((point) => state.pickAt(point.x, point.y)?.kind === "island");
  assert.ok(clear, "terrain away from lines and nodes remains selectable");
  const island = state.pickAt(clear.x, clear.y)!;
  ui.fireEvent.pointerDown(canvas, { clientX: clear.x, clientY: clear.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { clientX: clear.x, clientY: clear.y, button: 0 });
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, island.id));
});

test("connection filter pills hide background wires and preserve selected resource connections", async () => {
  await mount(true); await draw();
  const group = ui.screen.getByRole("group", { name: "Background connections" });
  const pills = ui.within(group).getAllByRole("button");
  assert.deepEqual(pills.map(pill => pill.textContent), ["Routes and events", "Environment and secrets", "Resource interactions"]);
  assert.deepEqual(pills.map(pill => pill.getAttribute("aria-pressed")), ["false", "false", "true"]);
  assert.equal(pills[0]!.style.getPropertyValue("--swatch"), "#a374ff");
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) });
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const edge = scene.edges.find(edge => edge.from === "gateway:http" && edge.category === "routes")!;
  const pickablePoint = () => scene.routes[edge.id]!.points.map(point => worldToScreen(state.camera(), state.viewport(), point)).find(point => state.pickAt(point.x, point.y)?.id === edge.id);
  assert.equal(pickablePoint(), undefined, "route wires are hidden on page load");
  ui.fireEvent.click(pills[0]!); await draw();
  const at = pickablePoint(); assert.ok(at, "the enabled wire can be picked");
  for (const pill of pills) if (pill.getAttribute("aria-pressed") === "true") ui.fireEvent.click(pill);
  await draw();
  assert.ok(pills.every(pill => pill.getAttribute("aria-pressed") === "false"));
  assert.notEqual(state.pickAt(at.x, at.y)?.id, edge.id, "a hidden background wire cannot intercept the canvas");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
  strokes.length = 0;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^HTTP API, Framework-managed API Gateway/ }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "gateway:http")); await draw();
  assert.ok(strokes.includes("rgba(163, 116, 255, 0.95)"), "selected resource connections still receive their normal highlight");
  assert.ok(pickablePoint(), "the selected resource's hidden-category links become pickable");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close panel" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none")); await draw();
  assert.equal(pickablePoint(), undefined, "clearing selection restores the unchanged filters");
  ui.fireEvent.click(ui.within(group).getByRole("button", { name: "Routes and events" })); await draw();
  assert.ok(pickablePoint(), "toggling a category back on restores its wires");
});

test("resource structure is available during inspection and hidden again when selection clears", async () => {
  await mount(true, "resource:rds"); await draw();
  assert.equal(ui.screen.queryByRole("button", { name: "Resource structure" }), null);
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) });
  const edge = scene.edges.find(edge => edge.edge.relation === "contains" && edge.from === "resource:rds")!;
  assert.ok(edge);
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const pickable = () => scene.routes[edge.id]!.points.map(point => worldToScreen(state.camera(), state.viewport(), point)).some(point => state.pickAt(point.x, point.y)?.id === edge.id);
  assert.ok(pickable(), "selecting the stack reveals its database relationship");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Close panel" })); await draw();
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none"));
  assert.equal(pickable(), false, "structural links do not clutter or intercept the overview");
});

test("the real renderer filters background categories without hiding inspected connections", () => {
  const source = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const edge = source.edges.find(edge => edge.from === "gateway:http" && edge.category === "routes")!;
  const scene = { ...source, edges: [edge] };
  const renderer = new SceneRenderer(document.createElement("canvas")); renderer.setScene(scene);
  const viewport = { width: 1920, height: 1000 };
  const state: RenderState = { camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: false, focus: landscapeFocus(scene), categories: new Set() };
  const prefix = `rgba(${hexRgb(edge.style.color).join(", ")}, `;
  const paint = (overrides: Partial<RenderState> = {}) => {
    pathStrokes.length = 0; renderer.render({ ...state, ...overrides });
    return pathStrokes.filter(stroke => stroke.color.startsWith(prefix));
  };
  assert.equal(paint().length, 0);
  assert.equal(paint({ hoveredEdge: edge.id }).length, 0, "stale hover cannot reveal a hidden background wire");
  assert.ok(paint({ selected: edge.from }).length);
  assert.ok(paint({ selected: edge.to }).length);
  assert.ok(paint({ selected: edge.id }).length, "a connection opened from the accessible list remains visible");
  assert.ok(paint({ categories: new Set([edge.category]) }).length);
  renderer.dispose();
});

test("the real renderer strokes connections leaving the APIs island in purple and those leaving a Lambda or container in orange", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Routes and events" }));
  await draw();
  assert.ok(strokes.some((style) => style.startsWith(`rgba(${hexRgb(ICON_TINT.lambda).join(", ")},`)), "connections match the orange compute icons");
  const purple = strokes.filter((style) => style.startsWith("rgba(163, 116, 255,"));
  const leaving = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) }).edges.filter((edge) => edge.edge.relation === "routes" && edge.from.startsWith("gateway:")).length;
  assert.ok(purple.length >= leaving, `${purple.length} purple strokes for ${leaving} route connections`);
  strokes.length = 0;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^HTTP API, Framework-managed API Gateway/ }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "gateway:http")); await draw();
  assert.ok(strokes.includes("rgba(163, 116, 255, 0.95)"), "a selected API connection lights in the same purple");
});

test("Routes and events controls native triggers independently of Resource interactions and preserves source styling", () => {
  const source = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const trigger = source.edges.find(edge => edge.edge.relation === "trigger" && !edge.otherLens)!;
  assert.ok(trigger);
  const scene = { ...source, edges: [trigger] };
  const renderer = new SceneRenderer(document.createElement("canvas")); renderer.setScene(scene);
  const viewport = { width: 1920, height: 1000 };
  const state: RenderState = { camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: false, focus: landscapeFocus(scene) };
  const prefix = `rgba(${hexRgb(trigger.style.color).join(", ")}, `;
  const paint = (categories: RenderState["categories"], selected?: string) => {
    pathStrokes.length = 0;
    renderer.render({ ...state, categories, selected, focus: landscapeFocus(scene, selected) });
    return pathStrokes.find(stroke => stroke.color.startsWith(prefix) && Math.abs(stroke.width - (selected ? 2.2 : 1.2) / state.camera.zoom) < 1e-8);
  };
  assert.equal(paint(new Set(["interactions"])), undefined, "Resource interactions does not reveal event triggers");
  const shown = paint(new Set(["routes"]));
  assert.ok(shown, "Routes and events reveals the source-coloured trigger");
  assert.deepEqual(shown.dash, []);
  assert.equal(paint(new Set()), undefined, "turning Routes and events off hides the trigger");
  assert.ok(paint(new Set(), trigger.from), "inspecting its resource still reveals the trigger");
  renderer.dispose();
});

test("a separate grant stays source-coloured and solid while a missing read keeps its own marker", () => {
  const model = response.snapshot.models.dev;
  const read = model.edges.find(edge => edge.relation === "env" && edge.to.startsWith("resource:cognito"))!;
  assert.ok(read);
  const missingRead = { ...read, inputRequirement: { resource: read.to, name: read.label, mode: "dev" as const, file: "cdk-app/.env.dev", required: true, status: "missing" as const, reasons: [] } };
  const grant = { ...read, id: "edge:test-grant", relation: "grant" as const, label: "grantRead()", provenance: "declared" as const };
  const scene = buildScene({ ...model, edges: [missingRead, grant] });
  assert.equal(scene.edges.length, 2);
  const edge = scene.edges.find(edge => edge.edge.id === grant.id)!;
  const renderer = new SceneRenderer(document.createElement("canvas")); renderer.setScene(scene);
  const viewport = { width: 1920, height: 1000 };
  const state: RenderState = { camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: false, focus: landscapeFocus(scene) };
  const prefix = `rgba(${hexRgb(ICON_TINT.lambda).join(", ")}, `;
  for (const overrides of [{}, { hoveredEdge: edge.id }, { selected: edge.id, focus: landscapeFocus(scene, edge.id) }]) {
    pathStrokes.length = 0; strokes.length = 0;
    renderer.render({ ...state, ...overrides });
    const alpha = "selected" in overrides || "hoveredEdge" in overrides ? 0.95 : 0.3;
    const arc = pathStrokes.find(stroke => stroke.color === `${prefix}${alpha})`);
    assert.ok(arc, "the actual curve keeps the Lambda icon's orange, including its highlighted pass");
    assert.deepEqual(arc.dash, [], "the actual curve is solid in each interaction state");
    assert.ok(strokes.includes("#ff5f6d"), "missing input guidance remains visible as a red X marker");
  }
  renderer.dispose();
});

test("the real renderer draws resting connections a little stronger, and those outside the viewed environment at a quarter of that", async () => {
  await mount();
  await draw();
  const alphas = new Set(strokes.flatMap((style) => { const match = /^rgba\(\d+, \d+, \d+, ([\d.]+)\)$/.exec(style); return match ? [Number(match[1])] : []; }));
  assert.ok(alphas.has(0.3), "a resting connection in this environment");
  assert.ok(alphas.has(0.075), "a resting connection the environment leaves out, at a quarter of the strength");
  assert.ok(!alphas.has(0.6), "nothing is emphasised above the resting strength");
  assert.ok(!alphas.has(0.24), "the old resting strength is gone");
});

async function hoverConnection(member: string) {
  await approachCanvasAfresh();
  const state = (dom.window as unknown as { __studioLandscape: {
    connections(): { id: string; members: string[]; points: { x: number; y: number }[] }[];
    pickAt(x: number, y: number): { id: string } | undefined;
  } }).__studioLandscape;
  const edge = state.connections().find(connection => connection.members.includes(member));
  assert.ok(edge, "the relationship is drawn");
  const at = edge.points.find(point => state.pickAt(point.x, point.y)?.id === edge.id);
  assert.ok(at, "the connection is pickable");
  ui.fireEvent.pointerMove(document.querySelector("canvas")!, { clientX: at.x, clientY: at.y });
  await draw();
  return ui.screen.findByRole("tooltip");
}

test("MFA read and permission arcs have independent hovers and inspection", async () => {
  await mount(true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Environment and secrets" })); await draw();
  const edges = response.snapshot.models.dev.edges.filter(edge => edge.from === "lambda:mfa");
  const read = edges.find(edge => edge.relation === "env" && edge.to.startsWith("resource:cognito."))!;
  const grant = edges.find(edge => edge.relation === "grant")!;
  assert.ok(read); assert.ok(grant);
  const reads = await hoverConnection(read.id);
  assert.equal(reads.querySelector("strong")?.textContent, "Reads: 3 environment values");
  assert.equal(ui.within(reads).queryByText(/^IAM:/), null);
  const permission = await hoverConnection(grant.id);
  assert.equal(permission.querySelector("strong")?.textContent, "Allow AWS actions: cognito.userPool");
  assert.equal(ui.within(permission).getByText("Permissions", { selector: ".landscape-hover-section-label" }).textContent, "Permissions");
  assert.equal(permission.querySelector(".landscape-hover-permission-copy")?.textContent, "cognito-idp:AdminGetUser");
  const state = (dom.window as unknown as { __studioLandscape: { connections(): { id: string; members: string[]; points: { x: number; y: number }[] }[]; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const connection = state.connections().find(connection => connection.members.includes(grant.id))!;
  assert.equal(connection.members.length, 1);
  const at = connection.points.find(point => state.pickAt(point.x, point.y)?.id === connection.id)!;
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 }); await draw();
  assert.ok(ui.screen.getByRole("heading", { name: "Allow AWS actions" }), "the To row names cognito.userPool");
  assert.equal(document.querySelectorAll(".connection-map-member").length, 0, "the grant inspector contains no environment-read members");
});

test("HTTP and WebSocket route hovers retain routing purpose in both environments with secondary IAM details", async () => {
  const http = response.snapshot.models.dev.edges.find(edge => edge.relation === "routes" && edge.label === "/api/test/start-workflow")!;
  const websocket = response.snapshot.models.dev.edges.find(edge => edge.relation === "routes" && edge.to === "lambda:ws-custom-action-route")!;
  assert.ok(http); assert.ok(websocket);
  const detail = "The framework manages this API route from its declaration.";
  const annotate = (model: typeof response.snapshot.models.dev) => ({ ...model, edges: model.edges.map(edge => edge.id === http.id ? { ...edge, detail } : edge) });
  const initial = { ...response, snapshot: { ...response.snapshot, models: { dev: annotate(response.snapshot.models.dev), prod: annotate(response.snapshot.models.prod) } } };
  await mount(true, undefined, initial);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Routes and events" })); await draw();
  for (const mode of ["dev", "prod"] as const) {
    if (mode === "prod") { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw(); }
    for (const source of [http, websocket]) {
      const popup = await hoverConnection(source.id);
      assert.equal(popup.querySelector("strong")?.textContent, `Routes to: ${source.label}`);
      assert.deepEqual(hoverEndpoints(popup), source === http ? { From: ["HTTP API", "API Gateway"], To: ["/test/start-workflow", "HTTP Lambda"] }
        : { From: ["WebSocket API", "API Gateway"], To: ["customAction", "WebSocket Lambda"] });
      assert.equal(popup.querySelector(".landscape-hover-permission-copy")?.textContent, "lambda:InvokeFunction");
      assert.ok(!popup.textContent?.includes("Cloud IAM intent"));
      assert.ok(!popup.textContent?.includes("Not generated in this AWS graph"));
      if (source === http) {
        assert.equal(ui.within(popup).queryByText(detail), null, "raw implementation details belong in the inspector");
      }
    }
  }
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Connection: WebSocket API to WebSocket: customAction,/ }));
  await ui.waitFor(() => assert.ok([...document.querySelectorAll(".connection-endpoints")].some(element => element.textContent?.includes("FromAPI: customActionToWebSocket: customAction"))));
  assert.equal(document.querySelector(".connection-header .authorization-badge"), null);
});

test("grouped route previews and member summaries retain each route name without IAM badges", async () => {
  const source = response.snapshot.models.dev.edges.find(edge => edge.relation === "routes" && edge.to === "lambda:ws-custom-action-route")!;
  const append = (model: typeof response.snapshot.models.dev) => {
    const original = model.edges.find(edge => edge.id === source.id)!;
    return { ...model, edges: [...model.edges, { ...original, id: `${original.id}:second-route`, label: "anotherAction" }] };
  };
  await mount(true, undefined, { ...response, snapshot: { ...response.snapshot, models: { dev: append(response.snapshot.models.dev), prod: append(response.snapshot.models.prod) } } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Routes and events" })); await draw();
  const popup = await hoverConnection(source.id);
  assert.equal(popup.querySelector("strong")?.textContent, "Routes to: 2 API routes");
  const rows = ui.within(ui.within(popup).getByRole("list", { name: "Connection members" }));
  assert.ok(rows.getByText(source.label));
  assert.ok(rows.getByText("anotherAction"));
  assert.equal(popup.querySelectorAll(".landscape-hover-permission-copy").length, 1, "shared permissions appear once below the member rows");
  assert.equal(popup.querySelector(".landscape-hover-permission-copy")?.textContent, "lambda:InvokeFunction");
  for (const row of rows.getAllByRole("listitem")) assert.deepEqual(visibleTags(row), [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Connection: WebSocket API to WebSocket: customAction,/ }));
  await ui.waitFor(() => assert.equal(document.querySelectorAll(".connection-map-member").length, 2));
  const summaries = [...document.querySelectorAll(".connection-map-member > summary")];
  assert.ok(summaries.some(summary => summary.textContent?.includes(source.label)));
  assert.ok(summaries.some(summary => summary.textContent?.includes("anotherAction")));
  assert.ok(summaries.every(summary => !summary.textContent?.includes("Routes to: ")), "member rows name their route; the heading already names the shared purpose, as hover rows do");
  assert.equal(document.querySelector(".connection-map-label .authorization-badge"), null);
});

test("clicking a disabled wire explains its endpoints in the inspector and the notice follows the mode", async () => {
  await mount(true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Environment and secrets" })); await draw();
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
  // A single wire, rather than a group's bundled supply, opens the one-connection notice.
  const edge = scene.edges.find((edge) => edge.edge.from === "envfile:prod" && edge.edge.relation === "supplies" && edge.members.length === 1)!;
  assert.ok(edge);
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const at = scene.routes[edge.id]!.points.map((point) => worldToScreen(state.camera(), state.viewport(), point))
    .find((point) => state.pickAt(point.x, point.y)?.id === edge.id);
  assert.ok(at, "a disabled wire remains pickable");
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  const notice = await ui.screen.findByRole("note", { name: "Connection deployment status" });
  assert.deepEqual(visibleTags(document.querySelector(".connection-header")!), [["hover-tag off", "Dev"], ["hover-tag prod", "Prod"]]);
  assert.ok(notice.textContent?.includes("Disabled in Development"));
  assert.ok(notice.textContent?.includes(".env.prod"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("note", { name: "Connection deployment status" }), null));
});

test("a bundle member names only the end and the value its heading does not", async () => {
  const id = "connection:resource%3Aclient:client-envfile:maps";
  await mount(true, id);
  const map = await ui.screen.findByRole("region", { name: "Connection details" });
  const heading = document.querySelector(".connection-header h2")!.textContent!;
  assert.match(heading, /^Maps: \d+ client variables$/);
  const members = [...map.querySelectorAll<HTMLDetailsElement>(".connection-map-member")];
  assert.ok(members.length > 1);
  for (const member of members) {
    assert.ok(!member.querySelector("summary")!.textContent!.includes("Maps into:"), "rows do not repeat the shared purpose");
    member.open = true;
  }
  await ui.waitFor(() => assert.ok(map.querySelector(".connection-map-detail .connection-endpoints")));
  for (const member of members) {
    const rows = [...member.querySelectorAll(".connection-map-detail .connection-endpoints > div")].map(row => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
    // Every member maps a different input field into the same Client environment.
    assert.equal(rows.length, 1, "the shared To is the heading's");
    assert.equal(rows[0]![0], "From");
    assert.match(rows[0]![1]!, /^Input: client\./);
  }
});

test("inspector connection rows lead with the connection and keep the other end as their supporting line", async () => {
  await mount(true, "agent:example-agent");
  const summary = await ui.screen.findByText("Connections", { selector: ".inspector-disclosure summary span" });
  (summary.closest("details") as HTMLDetailsElement).open = true;
  const rows = [...document.querySelectorAll<HTMLLIElement>(".connection-relations > li")];
  assert.ok(rows.length > 3);
  for (const row of rows) {
    const [title, pills, endpoint] = [...row.children];
    assert.ok(title?.matches("button.relation-title"), "the connection leads");
    assert.match(title!.textContent!, /^[^:]+: \S/, "with its action and value");
    assert.ok(pills?.matches(".environment-pills"));
    assert.ok(endpoint?.matches(".relation-endpoint"));
    assert.match(endpoint!.textContent!, /^(To|From) /);
  }
  assert.ok(rows.some(row => row.textContent?.includes("Reads: OPENAI_API_KEY_SECRET_ARN")), "long identifiers keep their own line instead of a narrow column");
});

test("clicking a grouped connection opens every mapping and retains it across environments", async () => {
  await mount(true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Environment and secrets" })); await draw();
  const id = "connection:resource%3Acognito:client-envfile:maps";
  assert.ok(!labels.includes("4"), "connection labels stay off the canvas");
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) });
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const at = scene.routes[id]!.points.map((point) => worldToScreen(state.camera(), state.viewport(), point)).find((point) => state.pickAt(point.x, point.y)?.id === id);
  assert.ok(at, "the grouped line is pickable");
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerMove(canvas, { clientX: at.x, clientY: at.y });
  await draw();
  const popup = await ui.screen.findByRole("tooltip");
  assert.ok(popup.textContent?.includes("Maps: 4 client variables"));
  assert.deepEqual(hoverEndpoints(popup), { From: ["cognito", "Stack"], To: ["Client environment", "Environment file"] });
  assert.ok(!popup.textContent?.includes("Maps into:"), "homogeneous member rows do not repeat the shared purpose");
  const hoverRows = ui.within(popup).getAllByRole("listitem");
  assert.equal(hoverRows.length, 4);
  assert.equal(popup.querySelector(".landscape-hover-heading .environment-pills"), null, "aggregate headers cannot imply that every member has the same availability");
  for (const row of hoverRows) {
    assert.deepEqual(visibleTags(row), [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]]);
    assert.deepEqual(tagsOf(row), [["hover-tag dev", "Dev: connection enabled in development"], ["hover-tag prod", "Prod: connection enabled in production"]]);
  }
  ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  const map = await ui.screen.findByRole("region", { name: "Connection details" });
  assert.deepEqual(visibleTags(document.querySelector(".connection-header")!), [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]]);
  assert.equal(map.querySelectorAll(".connection-map-member").length, 4);
  assert.deepEqual(visibleTags(map.querySelector("summary")!), [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]]);
  assert.ok(!map.textContent?.includes("→"), "connection rows omit repeated arrows");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, id);
  ui.fireEvent.click(map.querySelector("summary")!);
  assert.ok(map.querySelector(".connection-map-detail .connection-details"), "original details are retained without a repeated header");
  ui.fireEvent.click(map.querySelector("summary")!);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("note", { name: "Connection deployment status" }), null));
  assert.equal(ui.screen.getByLabelText("Selection").textContent, id);
  assert.equal(ui.screen.getByRole("region", { name: "Connection details" }).querySelectorAll(".connection-map-member").length, 4);
});

test("connections available in both environments retain two pills in every inspector row", async () => {
  await mount(true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Connection: Stack: cognito to Environment file: Client environment, / }));
  const map = await ui.screen.findByRole("region", { name: "Connection details" });
  const expected = [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]];
  assert.deepEqual(visibleTags(document.querySelector(".connection-header")!), expected);
  const rows = [...map.querySelectorAll<HTMLElement>(".connection-map-member > summary")];
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.deepEqual(visibleTags(row), expected);
    assert.ok(!row.textContent?.includes("Client environment"), "summaries show each relationship without repeating shared endpoints");
  }
});

test("in Development the real renderer strokes the unbuilt VPC as one deck with a single violet rim", async () => {
  await mount(true);
  await draw();
  const [r, g, b] = hexRgb(ISLAND_TRIM["island:vpc"]!);
  assert.ok(strokes.includes(`rgba(${r}, ${g}, ${b}, ${DECK.rim})`), "the dashed rim of the whole deck");
  assert.ok(strokes.includes(`rgba(${r}, ${g}, ${b}, ${DECK.wallEdge})`), "the dashed edge along its walls");
  const subnetStrokes = () => strokes.filter(style => ["band:public", "band:private"].some(band => style.startsWith(`rgba(${hexRgb(BAND_TRIM[band]!).join(", ")},`)));
  assert.deepEqual(subnetStrokes(), [], "the deck is one surface in the VPC violet: no subnet takes its own colour");
  strokes.length = 0;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  assert.ok(subnetStrokes().length > 0, "production terraces keep their subnet colours");
});

test("production subnet headings stay horizontal and legible across zoom; development draws none", () => {
  const renderer = new SceneRenderer(document.createElement("canvas"));
  const viewport = { width: 3840, height: 2160 };
  for (const mode of ["dev", "prod"] as const) {
    const full = buildScene(response.snapshot.models[mode]);
    for (const island of full.islands.filter(island => island.region === "network")) {
      const scene = { ...full, islands: [island], nodes: full.nodes.filter(node => node.island === island.id), props: full.props.filter(prop => prop.serves.some(id => island.bands.some(band => band.id === id))), frames: full.frames.filter(frame => frame.members.includes(island.id)), edges: [], routes: {} };
      const { bounds, bands: slabBands } = islandSlabs(scene)[0]!;
      const rimEndWorldX = Math.max(...slabBands.flatMap(band => band.top.filter((_, at) => at % 2 === 0)));
      for (const zoom of [0.05, 0.18, 0.3, 0.45, 0.7, 1, 1.8, 2.5]) {
        const camera = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom };
        labelPaints.length = 0;
        renderer.setScene(scene);
        renderer.render({ camera, viewport, dpr: 1, time: 0, motion: false, focus: landscapeFocus(scene) });
        const headings = labelPaints.filter(label => /subnet$/i.test(label.text));
        if (mode === "dev") assert.deepEqual(headings, [], `${mode} at ${zoom} has no subnet headings`);
        else {
          assert.deepEqual(headings.map(label => label.text).sort(), ["Isolated subnet", "Private subnet", "Public subnet"], `${island.id} at ${zoom} shows all section headings`);
          const alpha = subnetLabelPresentation(zoom).alpha;
          assert.ok(headings.every(label => label.font === `600 ${SUBNET_LABEL.fontSize * subnetLabelPresentation(zoom).scale}px Barlow, system-ui, sans-serif` && Math.abs(label.alpha - alpha) < 0.0001), "every heading keeps legible screen-space typography and fades continuously with node captions");
          let previous: ReturnType<typeof subnetLabelRect> | undefined;
          headings.forEach((label, at) => {
            const band = island.bands[at]!;
            const anchor = worldToScreen(camera, viewport, project({ x: (band.gx0 + band.gx1) / 2, y: island.gy0, h: band.h }));
            const scale = subnetLabelPresentation(zoom).scale;
            const width = (band.title.length * glyphWidth + SUBNET_LABEL.padding * 2 + SUBNET_LABEL.cue) * scale;
            const rimEndX = worldToScreen(camera, viewport, { x: rimEndWorldX, y: 0 }).x;
            const rect = subnetLabelRect(anchor, width, SUBNET_LABEL.height * scale, scale, rimEndX, previous);
            if (previous) assert.ok(!rectanglesOverlap(rect, previous, Math.max(SUBNET_LABEL.minSpacing, SUBNET_LABEL.gap * scale) - 0.0001), "overview headings retain clear spacing along their rim");
            previous = rect;
            assert.ok(Math.abs(label.x - (rect.x + (SUBNET_LABEL.padding + SUBNET_LABEL.cue) * scale)) < 0.0001);
            assert.ok(Math.abs(label.y - (rect.y + rect.height / 2)) < 0.0001, "all subnet names keep the same top-right gap from their terrace, never independent collision lifts");
          });
          const pan = { x: camera.x + 2400, y: camera.y + 1200, zoom };
          labelPaints.length = 0;
          renderer.render({ camera: pan, viewport, dpr: 1, time: 1, motion: false, focus: landscapeFocus(scene) });
          const panned = labelPaints.filter(label => /subnet$/i.test(label.text));
          assert.equal(panned.length, 3, "pan never hides or reflows headings at viewport edges");
          panned.forEach((label, at) => {
            assert.ok(Math.abs(label.x - headings[at]!.x + 2400 * zoom) < 0.0001);
            assert.ok(Math.abs(label.y - headings[at]!.y + 1200 * zoom) < 0.0001);
          });
        }
      }
      const top = islandSlabs(scene)[0]!.bands.flatMap(band => band.top.filter((_, at) => at % 2 === 1));
      labelPaints.length = 0;
      renderer.render({ camera: { x: (bounds.minX + bounds.maxX) / 2, y: Math.min(...top) - viewport.height / 2 - 20, zoom: 1 }, viewport, dpr: 1, time: 0, motion: false, focus: landscapeFocus(scene) });
      assert.equal(labelPaints.filter(label => /subnet$/i.test(label.text)).length, mode === "prod" ? 3 : 0, "headings continue beyond the canvas edges without disappearing or relocating");
    }
  }
  renderer.dispose();
});

test("selected and hovered island outlines paint with terrain beneath resource nodes", () => {
  const renderer = new SceneRenderer(document.createElement("canvas"));
  const viewport = { width: 1920, height: 1000 };
  for (const mode of ["dev", "prod"] as const) {
    const full = buildScene(response.snapshot.models[mode]);
    for (const island of full.islands.filter(island => island.region === "network")) {
      const scene = { ...full, islands: [island], nodes: full.nodes.filter(node => node.island === island.id), props: full.props.filter(prop => prop.serves.some(id => island.bands.some(band => band.id === id))), frames: full.frames.filter(frame => frame.members.includes(island.id)), edges: [], routes: {} };
      const { bounds } = islandSlabs(scene)[0]!;
      const camera = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom: 0.5 };
      renderer.setScene(scene);
      for (const highlight of [{ selected: island.id }, { hoveredIsland: island.id }]) {
        paintOrder.length = 0;
        renderer.render({ camera, viewport, dpr: 1, time: 0, motion: false, focus: landscapeFocus(scene), ...highlight });
        const firstIcon = paintOrder.findIndex(paint => paint.kind === "image");
        assert.ok(firstIcon >= 0, "the real renderer paints resource icons");
        const unrestricted = paintOrder.flatMap((paint, at) => paint.kind === "highlight" && !paint.clipped ? [at] : []);
        assert.equal(unrestricted.length, 1, "the foundation gets one complete outline");
        assert.ok(unrestricted[0]! < firstIcon, "the complete outline never overlays standing resources");
        assert.equal(paintOrder.filter(paint => paint.kind === "highlight" && paint.clipped).length, island.bands.length, "each terrace paints only its own portion before its resources");
      }
    }
  }
  renderer.dispose();
});

test("unused production VPCs and their fixtures paint identically to used production VPCs", () => {
  const model = response.snapshot.models.prod;
  const network = { ...model.networks![0]!, natGateway: true, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["account", "execute-api", "apprunner.requests", "bedrock-fips"] };
  const scenes = [false, true].map(builtInProd => buildScene({ ...model, networks: [{ ...network, builtInProd }] }));
  const renderer = new SceneRenderer(document.createElement("canvas"));
  const viewport = { width: 1920, height: 1000 }, camera = fitScene(scenes[0]!, viewport);
  const paint = (scene: ReturnType<typeof buildScene>) => {
    images.length = 0; strokes.length = 0; labelPaints.length = 0;
    renderer.setScene(scene);
    renderer.render({ camera, viewport, dpr: 1, time: 0, motion: false, focus: landscapeFocus(scene) });
    return { icons: [...images], strokes: [...strokes], labels: [...labelPaints] };
  };
  const unused = paint(scenes[0]!);
  assert.deepEqual(unused, paint(scenes[1]!), "unused networks have the same opacity, solid trim and fixtures");
  assert.ok(unused.icons.some(icon => icon.src === iconUrl("internetGateway") && icon.alpha === 0.9));
  for (const src of ["/icons/aws/endpoints/organizations.svg", "/icons/aws/api-gateway.svg", "/icons/aws/endpoints/app-runner.svg", "/icons/aws/endpoints/bedrock.svg"]) {
    assert.ok(unused.icons.some(icon => icon.src === src && icon.alpha === 0.9), `mini badge paints the local AWS SVG: ${src}`);
  }
  assert.ok(scenes[0]!.props.every(prop => prop.presence === "other"), "actual deployment evidence remains unchanged");
  renderer.dispose();
});

interface Pointing {
  screenOf(id: string): { building: { x: number; y: number }; card?: { x: number; y: number } } | undefined;
  hullOf(id: string): { x: number; y: number }[] | undefined;
  pickAt(x: number, y: number): { kind: string; id: string } | undefined;
}
const pointing = () => (dom.window as unknown as { __studioLandscape: Pointing }).__studioLandscape;

/** Moves the pointer onto an entity's label card, or the middle of its silhouette when no card is drawn, where the real picker finds it. */
async function hoverOver(id: string) {
  await approachCanvasAfresh();
  await draw();
  const point = nodePoint(id);
  ui.fireEvent.pointerMove(document.querySelector("canvas")!, { pointerId: 1, clientX: point.x, clientY: point.y });
  await draw();
  return ui.screen.findByRole("tooltip");
}

/** A new deliberate hover approaches outside the previous card, which can cover nearby entities. */
async function approachCanvasAfresh() {
  if (!document.querySelector(".canvas-tooltip")) return;
  ui.fireEvent.pointerLeave(document.querySelector("canvas")!); await draw();
  await ui.waitFor(() => assert.equal(document.querySelector(".canvas-tooltip"), null));
}

function nodePoint(id: string) {
  const at = pointing().screenOf(id);
  assert.ok(at, `${id} stands in the landscape`);
  const hull = pointing().hullOf(id) ?? [];
  const middle = hull.length ? { x: hull.reduce((sum, p) => sum + p.x, 0) / hull.length, y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length } : undefined;
  const point = at.card ?? middle ?? at.building;
  assert.equal(pointing().pickAt(point.x, point.y)?.id, id, "the pointer is over the entity");
  return point;
}

const tagsOf = (card: HTMLElement) => [...card.querySelectorAll(".hover-tag")].map((tag) => [tag.className, tag.textContent]);

const hoverEndpoints = (card: HTMLElement) => Object.fromEntries([...card.querySelectorAll(".landscape-hover-endpoints > div")].map(row => [
  row.querySelector("dt")?.textContent,
  [row.querySelector(".landscape-hover-endpoint-name")?.textContent, row.querySelector(".landscape-hover-endpoint-kind")?.textContent],
]));

/** The visible words of a pill; the hidden text after the colon says where, for assistive technology. */
const visibleTags = (card: HTMLElement) => [...card.querySelectorAll(".hover-tag")].map((tag) => [tag.className, tag.firstChild?.textContent]);

test("hovering a node shows its authored description and a Dev and a Prod pill", async () => {
  await mount();
  const card = await hoverOver("lambda:sign-out");
  const text = card.textContent ?? "";
  assert.ok(text.includes(response.snapshot.descriptions.values["lambda:sign-out"]!), "the authored description");
  assert.ok(!/IAM relationships?/.test(text), "resource previews leave permission counts to inspection");
  assert.deepEqual(visibleTags(card), [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]]);
  assert.deepEqual(tagsOf(card), [["hover-tag dev", "Dev: Your machine"], ["hover-tag prod", "Prod: AWS Lambda · outside the VPC"]]);
  assert.ok(!text.includes("Runs in development and production."), "the generic lane line is gone");
  assert.ok(!text.includes("Enabled in development"), "the generic presence line is gone");
  assert.ok(!text.includes("Click to inspect"), "no how-to caption under the description");
});

test("map previews wait for dwell, keep a stable anchor and remain readable across the pointer corridor", async () => {
  await mount(true, "lambda:sign-out");
  const canvas = document.querySelector("canvas")!;
  const point = nodePoint("lambda:sign-out");
  ui.fireEvent.pointerMove(canvas, { clientX: point.x, clientY: point.y }); await draw();
  assert.equal(ui.screen.queryByRole("tooltip"), null, "scanning the canvas does not flash previews");
  assert.equal(canvas.style.cursor, "pointer", "the resource cursor responds before the tooltip dwell");
  const card = await ui.screen.findByRole("tooltip");
  const placement = { left: card.style.left, top: card.style.top };
  assert.equal(pointing().pickAt(point.x + 1, point.y)?.id, "lambda:sign-out");
  ui.fireEvent.pointerMove(canvas, { clientX: point.x + 1, clientY: point.y }); await draw();
  assert.equal(ui.screen.getByRole("tooltip"), card);
  assert.deepEqual({ left: card.style.left, top: card.style.top }, placement, "a small pointer movement does not move text under the reader");
  const bounds = card.getBoundingClientRect();
  const corridor = { x: bounds.left + bounds.width / 2, y: bounds.top - 4 };
  assert.notEqual(pointing().pickAt(corridor.x, corridor.y)?.id, "lambda:sign-out", "the crossing leaves the resource's picking silhouette");
  ui.fireEvent.pointerMove(canvas, { clientX: corridor.x, clientY: corridor.y }); await draw();
  assert.equal(ui.screen.getByRole("tooltip"), card, "terrain behind the short crossing corridor cannot replace the card");
  ui.fireEvent.pointerLeave(canvas); ui.fireEvent.pointerEnter(card);
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.getByRole("tooltip"), card, "entering the card preserves it beyond the leave grace");
  canvas.focus();
  ui.fireEvent.keyDown(canvas, { key: "Escape" });
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  assert.equal(document.activeElement, canvas);
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:sign-out", "dismissal retains inspection");
  ui.fireEvent.pointerMove(canvas, { clientX: point.x, clientY: point.y }); await draw();
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.queryByRole("tooltip"), null, "the same stationary entity cannot reopen an escaped preview");
  ui.fireEvent.keyDown(canvas, { key: "Escape" });
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none"));
});

test("touch pointer movement does not open a hover card and tapping still inspects the resource", async () => {
  await mount();
  const canvas = document.querySelector("canvas")!;
  const point = nodePoint("lambda:sign-out");
  ui.fireEvent.pointerMove(canvas, { pointerId: 8, pointerType: "touch", clientX: point.x, clientY: point.y }); await draw();
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  ui.fireEvent.pointerDown(canvas, { pointerId: 8, pointerType: "touch", clientX: point.x, clientY: point.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { pointerId: 8, pointerType: "touch", clientX: point.x, clientY: point.y, button: 0 }); await draw();
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:sign-out"));
  assert.ok(ui.screen.getByRole("complementary", { name: "Inspector" }));
  assert.equal(ui.screen.queryByRole("tooltip"), null);
});

test("keyboard connection previews expose each member's environments and scroll without moving trigger focus", async () => {
  const original = response.snapshot.models.dev;
  const scene = buildScene(original, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) });
  const group = scene.edges.find(edge => edge.from === "lambda:graphql-api" && edge.edge.relation === "env" && edge.members.length > 1)!;
  assert.ok(group);
  const devOnly = group.members[0]!.edge.id;
  const prod = { ...response.snapshot.models.prod, edges: response.snapshot.models.prod.edges.filter(edge => edge.id !== devOnly) };
  await mount(true, undefined, { ...response, snapshot: { ...response.snapshot, models: { dev: original, prod } } });
  const list = ui.screen.getByRole("list", { name: "Entities in the landscape" });
  const trigger = [...list.querySelectorAll<HTMLButtonElement>("button")].find(button => button.dataset.hoverId === group.id)!;
  assert.ok(trigger);
  await ui.act(async () => trigger.focus());
  const card = ui.screen.getByRole("tooltip");
  assert.equal(card.parentElement, document.body, "the accessible navigator cannot clip its preview");
  assert.equal(trigger.getAttribute("aria-describedby"), card.id);
  assert.equal(card.querySelector(".landscape-hover-heading .environment-pills"), null);
  const rows = ui.within(ui.within(card).getByRole("list", { name: "Connection members" })).getAllByRole("listitem");
  assert.equal(rows.length, group.members.length);
  for (const member of group.members) {
    const row = rows.find(row => row.querySelector(".landscape-hover-entry-name")?.textContent === member.edge.label);
    assert.ok(row, member.edge.label);
    assert.deepEqual(visibleTags(row), [["hover-tag dev", "Dev"], [member.edge.id === devOnly ? "hover-tag off" : "hover-tag prod", "Prod"]]);
  }
  Object.defineProperties(card, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 240 } });
  ui.fireEvent.keyDown(trigger, { key: "PageDown" });
  assert.ok(card.scrollTop > 0 && card.scrollTop < 900, "PageDown reveals overflow without changing the focused relationship");
  assert.equal(document.activeElement, trigger);
  ui.fireEvent.keyDown(trigger, { key: "PageUp" });
  assert.equal(card.scrollTop, 0);
  assert.equal(document.activeElement, trigger);
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none");
  ui.fireEvent.keyDown(trigger, { key: "Escape" });
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  assert.equal(trigger.hasAttribute("aria-describedby"), false);
  assert.equal(document.activeElement, trigger);
});

test("input group hovers label every entry with its own environments and omit aggregate pills", async () => {
  await mount();
  const card = await hoverOver("resource:client");
  assert.equal(card.querySelector(".landscape-hover-tags"), null);
  const rows = [...card.querySelectorAll<HTMLElement>(".landscape-hover-entries > li")];
  assert.deepEqual(rows.map(row => row.querySelector(".landscape-hover-entry-name")?.textContent), ["apiPort", "webSocketPort", "webSocketTesterPort", "apiUrl"]);
  for (const row of rows) assert.deepEqual(visibleTags(row), [["hover-tag dev", "Dev"], ["hover-tag off", "Prod"]]);
  assert.equal(card.querySelector(".landscape-hover-subtitle")?.textContent, "Input group · 4 inputs");
  assert.ok(!card.textContent?.includes("Not declared"), "the unlit Prod pill already says it");
  assert.ok(!card.textContent?.includes("Holds apiPort"), "the list replaces the prose name summary");
});

test("supply hovers put environment pills beside each parameter", async () => {
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Environment and secrets" })); await draw();
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) });
  const edge = scene.edges.find(edge => edge.from === "envfile:dev" && edge.to === "resource:client" && edge.edge.relation === "supplies")!;
  assert.ok(edge);
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport } }).__studioLandscape;
  const point = scene.routes[edge.id]!.points.map(point => worldToScreen(state.camera(), state.viewport(), point)).find(point => pointing().pickAt(point.x, point.y)?.id === edge.id);
  assert.ok(point, "the supply wire is pickable");
  ui.fireEvent.pointerMove(document.querySelector("canvas")!, { clientX: point.x, clientY: point.y }); await draw();
  const card = await ui.screen.findByRole("tooltip");
  assert.equal(card.querySelector(".landscape-hover-tags"), null);
  const rows = [...card.querySelectorAll<HTMLElement>(".landscape-hover-entries > li")];
  assert.equal(rows.length, edge.members.length);
  for (const [at, row] of rows.entries()) {
    const parameter = response.snapshot.models.dev.resources.find(resource => resource.id === edge.members[at]!.edge.to)!;
    assert.equal(row.querySelector(".landscape-hover-entry-name")?.textContent, parameter.path.at(-1));
    assert.deepEqual(tagsOf(row), [["hover-tag dev", "Dev: supplied by this file in development"], ["hover-tag off", "Prod: not supplied by this file"]]);
  }
  assert.deepEqual(hoverEndpoints(card), { From: ["cdk-app/.env.dev", "Environment file"], To: ["client", "Input group"] });
});

test("an environment that does not deploy the item keeps its pill, dark", async () => {
  await mount();
  const devOnly = await hoverOver("service:example-service");
  assert.deepEqual(visibleTags(devOnly), [["hover-tag dev", "Dev"], ["hover-tag off", "Prod"]]);
  assert.equal(tagsOf(devOnly)[1]![1], "Prod: not deployed");
  const prodOnly = await hoverOver("task:db-migrate");
  assert.deepEqual(visibleTags(prodOnly), [["hover-tag off", "Dev"], ["hover-tag prod", "Prod"]]);
});

test("hovering a framework-managed resource labels it, and an undescribed node asks for a description", async () => {
  await mount();
  const card = await hoverOver("resource:rds");
  assert.deepEqual(visibleTags(card), [["hover-tag off", "Dev"], ["hover-tag prod", "Prod"]]);
  assert.equal(card.querySelector(".resource-status.managed")?.textContent, "Framework managed");
  const unused = await hoverOver("resource:referenceExamples");
  assert.deepEqual(visibleTags(unused), [["hover-tag off", "Dev"], ["hover-tag off", "Prod"]], "both go dark");
  assert.equal(unused.querySelector(".landscape-hover-note")?.textContent, "Not added to the CDK app");

  const original = response;
  const { ["lambda:sign-out"]: _removed, ...descriptions } = response.snapshot.descriptions.values;
  response = { ...response, snapshot: { ...response.snapshot, descriptions: { values: descriptions } } };
  try {
    ui.cleanup(); frames.clear();
    await mount();
    const bare = await hoverOver("lambda:sign-out");
    assert.ok(bare.textContent?.includes("No description yet."), "an undescribed node says so");
    assert.equal(bare.querySelectorAll(".hover-tag").length, 2, "the deployment labels stay");
  } finally { response = original; }
});

test("pointer bursts resolve the latest hover once per frame, and leaving cancels pending work", async () => {
  await mount(); await draw();
  const canvas = document.querySelector("canvas")!;
  const id = "lambda:sign-out";
  const hull = pointing().hullOf(id)!;
  const point = pointing().screenOf(id)!.card ?? {
    x: hull.reduce((sum, p) => sum + p.x, 0) / hull.length,
    y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length,
  };
  assert.equal(pointing().pickAt(point.x, point.y)?.id, id);
  for (let at = 0; at < 100; at++) ui.fireEvent.pointerMove(canvas, { clientX: at, clientY: 0 });
  ui.fireEvent.pointerMove(canvas, { clientX: point.x, clientY: point.y });
  assert.equal(frames.size, 1, "a burst schedules a single hit test");
  assert.equal(ui.screen.queryByRole("tooltip"), null);
  await draw();
  assert.ok((await ui.screen.findByRole("tooltip")).textContent?.includes("sign-out"));
  ui.fireEvent.pointerLeave(canvas); await draw();
  ui.fireEvent.pointerMove(canvas, { clientX: point.x, clientY: point.y });
  ui.fireEvent.pointerLeave(canvas); await draw();
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("tooltip"), null, "the crossing grace ends without reopening cancelled work"));
  await ui.act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(ui.screen.queryByRole("tooltip"), null, "a queued hover cannot reopen a tooltip after leaving");
});

test("painted labels keep clear of icon and lock silhouettes and remain pickable across zooms and environments", () => {
  const badgesByZoom = new Map<number, unknown>();
  for (const model of Object.values(response.snapshot.models)) {
    const scene = buildScene(model, { layoutModels: Object.values(response.snapshot.models), resourceAvailability: catalogAvailability(response.snapshot.models) });
    const renderer = new SceneRenderer(document.createElement("canvas"));
    renderer.setScene(scene);
    const selected = scene.nodes.find((node) => node.id === "resource:cognito")!;
    for (const zoom of [0.18, 0.36, 0.54, 0.56, 0.9, 1.4]) {
      const camera = { ...selected.geometry.top, zoom };
      const viewport = { width: 960, height: 700 };
      const { cards, badges } = renderer.render({ camera, viewport, selected: selected.id, dpr: 1, time: 1, motion: false, focus: landscapeFocus(scene, selected.id) });
      const tagGeometry = badges.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }));
      if (badgesByZoom.has(zoom)) assert.deepEqual(tagGeometry, badgesByZoom.get(zoom), "mode switches preserve every deployment tag and its position");
      else badgesByZoom.set(zoom, tagGeometry);
      assert.ok(cards.some((card) => card.id === selected.id), `selected stack keeps its label at ${zoom}`);
      assert.ok(cards.length >= 3, "captions remain useful in a dense stack island");
      const buildings = [...scene.nodes, ...scene.props].map((item) => {
        const points = Array.from({ length: item.geometry.hull.length / 2 }, (_, at) => worldToScreen(camera, viewport, { x: item.geometry.hull[at * 2]!, y: item.geometry.hull[at * 2 + 1]! }));
        const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y));
        return { x, y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y };
      });
      for (const card of cards) {
        const node = scene.nodes.find((node) => node.id === card.id)!;
        const tile = project({ x: node.gx, y: node.gy, h: node.h });
        const anchor = worldToScreen(camera, viewport, { x: tile.x, y: tile.y + NODE_CAPTION.offset });
        assert.ok(Math.abs(card.x + card.width / 2 - anchor.x) < 1e-8, "caption stays centred on its plinth");
        assert.ok(Math.abs(card.y + card.height - anchor.y) < 1e-8, "caption stays above its plaque when zooming");
        assert.ok(buildings.every((building) => !rectanglesOverlap(card, building, 0)), `${card.id} clears icons and lock/role badges`);
        assert.ok(cards.every((other) => card === other || !rectanglesOverlap(card, other, 0)));
        const centre = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
        assert.equal(pickEntity(centre, centre, cards, []), card.id);
      }
      const focus = landscapeFocus(scene, selected.id);
      assert.deepEqual(renderer.render({ camera, viewport, selected: selected.id, hovered: cards[0]!.id, dpr: 1, time: 2, motion: false, focus }).cards, cards, "hover changes no caption positions or sizes");
      const overview = renderer.render({ camera, viewport, dpr: 1, time: 3, motion: false, focus: landscapeFocus(scene) }).cards;
      assert.deepEqual(overview, cards, "selection changes styling, never caption placement");
    }
    renderer.dispose();
  }
});

test("stationary animation reuses text placement and invalidates on camera, focus, font and scene changes", () => {
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const renderer = new SceneRenderer(document.createElement("canvas"));
  renderer.setScene(scene);
  const viewport = { width: 1920, height: 1000 };
  let state: RenderState = { camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: true,
    selected: "lambda:graphql-api", focus: landscapeFocus(scene, "lambda:graphql-api") };
  const checkFresh = () => {
    const cached = renderer.render(state);
    const cachedLabels = labels.splice(0);
    const fresh = new SceneRenderer(document.createElement("canvas"));
    fresh.setScene(scene);
    const expected = fresh.render(state);
    assert.deepEqual(cached.cards, expected.cards);
    assert.deepEqual(cached.badges, expected.badges);
    assert.deepEqual(cachedLabels, labels.splice(0), "cached placement paints the same text as a fresh renderer");
    fresh.dispose();
  };
  renderer.render(state); labels.length = 0;
  const measured = measurements;
  renderer.render({ ...state, time: 2 }); labels.length = 0;
  assert.equal(measurements, measured, "packet animation does not remeasure stationary titles");
  checkFresh();
  // Reused camera objects must not conceal a change from the cache.
  (state.camera as { zoom: number }).zoom = 0.9;
  checkFresh();
  state = { ...state, hovered: "lambda:sign-in" }; checkFresh();
  state = { ...state, selected: undefined, focus: landscapeFocus(scene) }; checkFresh();
  // A late font can change card sizes, truncation and title collisions.
  glyphWidth = 9;
  renderer.fontsChanged();
  checkFresh();
  renderer.setScene({ ...scene }); checkFresh();
  renderer.dispose();
});

test("deployment tags leave the full caption width available and select their owning node", () => {
  const source = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const node = source.nodes.find((node) => node.id === "resource:cognito")!;
  const camera = { ...node.geometry.top, zoom: 0.8 }, viewport = { width: 960, height: 700 };
  const state: RenderState = { camera, viewport, dpr: 1, time: 1, motion: false, focus: landscapeFocus(source) };
  let name: string | undefined, width: number | undefined;
  for (const badge of [undefined, "dev", "prod", "off"] as const) {
    const scene = { ...source, nodes: source.nodes.map((item) => item.id === node.id ? { ...item, badge, label: "LongFrameworkStackDeploymentNameWithOutputs" } : item) };
    const renderer = new SceneRenderer(document.createElement("canvas")); renderer.setScene(scene);
    labels.length = 0;
    const frame = renderer.render(state), card = frame.cards.find((card) => card.id === node.id)!;
    assert.ok(card);
    const text = labels.find((label) => label.startsWith("LongFramework"));
    if (!badge) { name = text; width = card.width; }
    assert.equal(text, name, "environment metadata does not truncate the name further");
    assert.equal(card.width, width, "name pills have identical width with or without a deployment tag");
    const tag = frame.badges.find((tag) => tag.id === node.id);
    if (badge) {
      assert.ok(tag);
      const tile = project({ x: node.gx, y: node.gy, h: node.h });
      const anchor = worldToScreen(camera, viewport, { x: tile.x, y: tile.y + NODE_DEPLOYMENT_TAG.offset });
      assert.equal(tag.x + tag.width / 2, anchor.x);
      assert.equal(tag.y + tag.height / 2, anchor.y);
      assert.ok(frame.cards.every((caption) => !rectanglesOverlap(tag, caption)));
      assert.equal(pickEntity(anchor, anchor, [...frame.badges, ...frame.cards], []), node.id);
    } else assert.equal(tag, undefined, "nodes available in both environments have no tag");
    renderer.dispose();
  }
});

test("WebSocket and managed lock badges paint identical borders", () => {
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const renderer = new SceneRenderer(document.createElement("canvas"));
  // Compare the same presence state; painter order can encounter a ghost lock first.
  renderer.setScene({ ...scene, nodes: scene.nodes.map(node => ({ ...node, presence: "built" as const })) });
  const viewport = { width: 1920, height: 1000 };
  renderer.render({ camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: false, focus: landscapeFocus(scene) });
  const socket = iconStrokes.find(({ icon }) => icon === iconUrl("webSocket"));
  const lock = iconStrokes.find(({ icon }) => icon === iconUrl("managed"));
  assert.ok(socket); assert.ok(lock);
  assert.deepEqual({ color: socket.color, width: socket.width }, { color: lock.color, width: lock.width });
  renderer.dispose();
});

test("distant captions and deployment tags fade together, reverse continuously and settle", () => {
  const source = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const node = { ...source.nodes.find(({ id }) => id === "lambda:sign-out")!, badge: "dev" as const };
  const scene = { ...source, nodes: [node], props: [], edges: [], routes: {} };
  const renderer = new SceneRenderer(document.createElement("canvas"));
  renderer.setScene(scene);
  const state: RenderState = { camera: { ...node.geometry.top, zoom: 0.3 }, viewport: { width: 960, height: 700 },
    dpr: 1, time: 1, motion: true, focus: landscapeFocus(scene) };
  const paint = (time: number, hovered?: string, motion = true) => {
    labelPaints.length = 0;
    const frame = renderer.render({ ...state, time, hovered, motion });
    const card = frame.cards.find(({ id }) => id === node.id)!;
    assert.ok(card);
    const alpha = labelPaints.find(({ y }) => y === card.y + card.height / 2 + 0.5)!.alpha;
    assert.ok(frame.badges.some(({ id }) => id === node.id), "deployment tag stays visible at distant zoom");
    assert.equal(labelPaints.find(({ text }) => text === "DEV")!.alpha, alpha, "tag and name share hover opacity");
    return { frame, alpha };
  };
  const resting = paint(1);
  const entering = paint(2, node.id);
  assert.equal(entering.alpha, resting.alpha);
  assert.equal(entering.frame.animating, true);
  const middle = paint(2 + NODE_CAPTION.hoverDuration / 2, node.id);
  assert.ok(middle.alpha > resting.alpha && middle.alpha < 1);
  assert.equal(paint(2.3, node.id).alpha, 1);
  assert.equal(paint(2.31, node.id).frame.animating, false);
  assert.equal(paint(3).alpha, 1, "leaving starts from the current opacity");
  const leaving = paint(3 + NODE_CAPTION.hoverDuration / 2);
  assert.ok(leaving.alpha > resting.alpha && leaving.alpha < 1);
  assert.equal(paint(3 + NODE_CAPTION.hoverDuration / 2, node.id).alpha, leaving.alpha, "reversing does not jump");
  assert.ok(paint(3 + NODE_CAPTION.hoverDuration, node.id).alpha > leaving.alpha);
  paint(4);
  const settled = paint(4.3);
  assert.equal(settled.alpha, resting.alpha);
  assert.equal(settled.frame.animating, false);
  assert.deepEqual(settled.frame.cards, resting.frame.cards, "hover never moves captions");
  assert.equal(paint(5, node.id, false).alpha, 1, "reduced motion applies hover immediately");
  assert.equal(paint(5.1, undefined, false).frame.animating, false);
  for (const zoom of [0.18, 0.3, 0.54, 0.56, 0.9]) {
    const frame = renderer.render({ ...state, camera: { ...state.camera, zoom }, motion: false });
    assert.ok(frame.badges.some(({ id }) => id === node.id), `tag has no hard zoom cutoff at ${zoom}`);
  }
  renderer.dispose();
});

test("connection hover fades quickly while environment changes update immediately", () => {
  const source = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const edge = source.edges.find((edge) => edge.category === "interactions" && edge.style.color === ICON_TINT.lambda && !edge.otherLens &&
    [edge.from, edge.to].every((id) => ["built", "present"].includes(nodes.get(id)?.presence ?? "")))!;
  assert.ok(edge);
  const scene = { ...source, edges: [edge] };
  const renderer = new SceneRenderer(document.createElement("canvas"));
  renderer.setScene(scene);
  const viewport = { width: 1920, height: 1000 };
  const state: RenderState = { camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: true, focus: landscapeFocus(scene) };
  const prefix = `rgba(${hexRgb(edge.style.color).join(", ")}, `;
  const paint = (time: number, hoveredEdge?: string, motion = true) => {
    pathStrokes.length = 0;
    const frame = renderer.render({ ...state, time, hoveredEdge, motion });
    // Nodes now share this colour; connections are painted after their icon outlines.
    const stroke = pathStrokes.filter(({ color }) => color.startsWith(prefix)).at(-1)!;
    assert.ok(stroke);
    return { frame, ...stroke, alpha: Number(stroke.color.slice(prefix.length, -1)) };
  };
  const resting = paint(1);
  assert.equal(paint(2, edge.id).alpha, resting.alpha);
  const middle = paint(2 + EDGE_HOVER_DURATION / 2, edge.id);
  assert.ok(middle.alpha > resting.alpha && middle.alpha < 0.95);
  assert.ok(middle.alpha > resting.alpha + (0.95 - resting.alpha) * 0.9, "ease-out responds strongly before its soft finish");
  assert.ok(middle.width > resting.width);
  assert.equal(paint(2.1, edge.id).alpha, 0.95);
  paint(3);
  assert.ok(paint(3 + EDGE_HOVER_DURATION / 2).alpha < 0.95);
  assert.equal(paint(3.1).alpha, resting.alpha);
  assert.equal(paint(3.2).frame.animating, false);
  paint(4, edge.id);
  paint(4 + EDGE_HOVER_DURATION / 2, edge.id);
  renderer.setScene({ ...scene, edges: [{ ...edge, otherLens: "prod" as const }] });
  const switched = paint(4.05);
  assert.ok(switched.alpha < resting.alpha, "new environment's resting strength applies on its first frame");
  assert.equal(switched.frame.animating, false, "switching cancels the prior hover fade");
  renderer.setScene(scene);
  assert.equal(paint(4.06).alpha, resting.alpha);
  renderer.setScene({ ...scene });
  assert.equal(paint(5, edge.id).alpha, 0.95, "hover retained through an environment switch also applies immediately");
  assert.equal(paint(6, undefined, false).alpha, resting.alpha, "reduced motion bypasses hover transitions");
  assert.equal(connectionHoverEase(0), 0);
  assert.equal(connectionHoverEase(1), 1);
  let previous = 0;
  for (let step = 1; step <= 100; step++) {
    const value = connectionHoverEase(step / 100);
    assert.ok(value >= previous && value <= 1, "the easing never reverses or overshoots");
    previous = value;
  }
  renderer.dispose();
});

test("only visible moving content requests more animation frames", () => {
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models) });
  const renderer = new SceneRenderer(document.createElement("canvas"));
  renderer.setScene(scene);
  const viewport = { width: 1920, height: 1000 };
  const state: RenderState = { camera: fitScene(scene, viewport), viewport, dpr: 1, time: 1, motion: true, focus: landscapeFocus(scene) };
  const prop = scene.props[0]!.id;
  assert.equal(renderer.render({ ...state, selected: prop, focus: landscapeFocus(scene, prop) }).animating, false);
  const selected = "lambda:graphql-api";
  const focus = landscapeFocus(scene, selected);
  assert.equal(renderer.render({ ...state, selected, focus }).animating, true);
  assert.equal(renderer.render({ ...state, selected, focus, motion: false }).animating, false);
  assert.equal(renderer.render({ ...state, selected, focus, camera: { x: -1e7, y: -1e7, zoom: 1 } }).animating, false);
  renderer.setScene({ ...scene, edges: [], routes: {} });
  assert.equal(renderer.render({ ...state, selected, focus }).animating, false, "selecting a node does not animate its island; only connection packets keep repainting");
  renderer.dispose();
});

test("compact tag filtering persists without grouping, moving topology or clearing the selected entity", async () => {
  const storageKey = "framework-studio:isometric-tag-filter";
  const value = response.snapshot.models.dev.tagging!["lambda:sign-in"]!.effective.area!;
  dom.window.localStorage.removeItem(storageKey);
  await mount();
  assert.equal(ui.screen.queryByRole("combobox", { name: "Group map by tag" }), null);
  const picker = ui.screen.getByRole("combobox", { name: "Filter map by tag key" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^graphql-api, HTTP Lambda/ })); await draw();
  ui.fireEvent.change(picker, { target: { value: "area" } }); await draw();
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Filter map by tag value" }), { target: { value: JSON.stringify(value) } }); await draw();
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(storageKey)!), { key: "area", value });
  assert.ok(!debug().tagFilter().muted.includes("lambda:sign-in"));
  assert.ok(debug().tagFilter().muted.includes("lambda:graphql-api"));
  assert.equal(debug().search().active, false, "tag filtering does not use the stronger search fade");
  assert.equal(debug().stats().focus, "selection");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:graphql-api");
  assert.ok(ui.screen.getByRole("button", { name: "Serverless compute island settings" }));
  ui.cleanup(); frames.clear();
  await mount();
  assert.equal((ui.screen.getByRole("combobox", { name: "Filter map by tag key" }) as HTMLSelectElement).value, "area");
  assert.equal((ui.screen.getByRole("combobox", { name: "Filter map by tag value" }) as HTMLSelectElement).value, JSON.stringify(value));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Clear tag filter" })); await draw();
  assert.deepEqual(debug().tagFilter().muted, []);
  dom.window.localStorage.removeItem(storageKey);
});

test("tag dropdown totals and selected-match feedback update with the active mode", async () => {
  dom.window.localStorage.removeItem("framework-studio:isometric-tag-filter");
  const id = "resource:rds";
  const modelFor = (mode: "dev" | "prod") => {
    const model = response.snapshot.models[mode];
    const facts = model.tagging![id]!;
    return { ...model, tagging: { ...model.tagging, [id]: { ...facts, effective: { ModeOnly: "production" } } } };
  };
  await mount(true, undefined, { ...response, snapshot: { ...response.snapshot, models: { dev: modelFor("dev"), prod: modelFor("prod") } } });
  const key = ui.screen.getByRole("combobox", { name: "Filter map by tag key" }) as HTMLSelectElement;
  assert.ok(![...key.options].some(option => option.value === "ModeOnly"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  await ui.waitFor(() => assert.ok([...key.options].some(option => option.value === "ModeOnly")));
  ui.fireEvent.change(key, { target: { value: "ModeOnly" } }); await draw();
  assert.ok(ui.screen.getByRole("option", { name: "production (1)" }));
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Filter map by tag value" }), { target: { value: JSON.stringify("production") } }); await draw();
  assert.ok(ui.screen.getByText("1 matching entity in production"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  assert.ok(ui.screen.getByRole("option", { name: "production (no matches)" }));
  assert.ok(ui.screen.getByText("0 matching entities in development"));
  dom.window.localStorage.removeItem("framework-studio:isometric-tag-filter");
});

test("the first tag selector offers no-tags filtering, restores it after reload, and clears it", async () => {
  const storageKey = "framework-studio:isometric-tag-filter";
  dom.window.localStorage.removeItem(storageKey);
  await mount(true);
  const key = ui.screen.getByRole("combobox", { name: "Filter map by tag key" });
  assert.ok(ui.within(key).getByRole("option", { name: /^Untagged \(\d+\)$/ }));
  ui.fireEvent.change(key, { target: { value: UNTAGGED_FILTER } }); await draw();
  assert.equal(ui.screen.queryByRole("combobox", { name: "Filter map by tag value" }), null);
  assert.ok(debug().tagFilter().muted.includes("lambda:sign-in"));
  assert.ok(ui.screen.getByText(/matching entities in development/));
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(storageKey)!), { key: UNTAGGED_FILTER, value: null });
  ui.cleanup(); frames.clear();
  await mount(true);
  assert.equal((ui.screen.getByRole("combobox", { name: "Filter map by tag key" }) as HTMLSelectElement).value, UNTAGGED_FILTER);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  assert.ok(ui.screen.getByText(/matching entities in production/));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Clear tag filter" })); await draw();
  assert.deepEqual(debug().tagFilter().muted, []);
  assert.equal(document.activeElement, ui.screen.getByRole("combobox", { name: "Filter map by tag key" }));
  dom.window.localStorage.removeItem(storageKey);
});

test("filtered resources use exactly the existing disabled-resource paint without compounding existing opacity", () => {
  const model = response.snapshot.models.dev, topology = buildScene(model), node = topology.nodes.find(node => node.id === "lambda:graphql-api")!;
  const base = { ...topology, nodes: [node], props: [], edges: [], routes: {} };
  const value = model.tagging!["lambda:sign-in"]!.effective.area!;
  const filtered = filterSceneByTag(base, model, "area", value);
  const disabled = { ...base, nodes: [{ ...node, presence: "other" as const }] };
  const viewport = { width: 1920, height: 1000 }, camera = fitScene(base, viewport);
  const renderer = new SceneRenderer(document.createElement("canvas"));
  const paint = (scene: ReturnType<typeof buildScene>) => {
    images.length = 0; iconStrokes.length = 0; labelPaints.length = 0;
    renderer.setScene(scene);
    renderer.render({ camera, viewport, dpr: 1, time: 0, motion: false, focus: landscapeFocus(scene) });
    return { images: [...images], icons: [...iconStrokes], captions: [...labelPaints] };
  };
  const native = paint(disabled), tagged = paint(filtered);
  assert.deepEqual(tagged, native);
  assert.ok(tagged.images.some(image => image.alpha === 0.32));
  assert.deepEqual(paint(filterSceneByTag(disabled, model, "area", value)), native, "an already disabled node is not faded twice");
  renderer.dispose();
});

test("saved filters whose source tags disappeared show a clear zero-match state and can be cleared", async () => {
  const storageKey = "framework-studio:isometric-tag-filter";
  dom.window.localStorage.setItem(storageKey, JSON.stringify({ key: "removed-key", value: "former-value" }));
  try {
    await mount();
    assert.ok(ui.screen.getByRole("option", { name: "removed-key (unavailable in this mode)" }));
    assert.ok(ui.screen.getByRole("option", { name: "former-value (no matches)" }));
    assert.ok(ui.screen.getByText("0 matching entities in development"));
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Clear tag filter" })); await draw();
    assert.deepEqual(debug().tagFilter().muted, []);
  } finally { dom.window.localStorage.removeItem(storageKey); }
});

test("a member overriding every stack tag still shows its parent and removal previews inheritance", async () => {
  const original = response;
  const member = response.snapshot.models.dev.resources.find(resource => resource.kind === "member" && resource.parent && !resource.frameworkManaged)!;
  const parent = member.parent!;
  const tagging = (entity: string, value: string) => ({ authored: { Team: value }, effective: { Team: value }, provenance: { Team: { entity, kind: "declared" as const } }, aws: { kind: "owned" as const, note: "Owned resource" } });
  response = { ...response, snapshot: { ...response.snapshot,
    models: { dev: { ...response.snapshot.models.dev, tagging: { ...response.snapshot.models.dev.tagging, [parent]: tagging(parent, "platform"), [member.id]: tagging(member.id, "orders") } }, prod: { ...response.snapshot.models.prod, tagging: { ...response.snapshot.models.prod.tagging, [parent]: tagging(parent, "platform"), [member.id]: tagging(member.id, "orders") } } },
    source: { ...response.snapshot.source, editability: { ...response.snapshot.source.editability, [member.id]: { ...response.snapshot.source.editability[member.id], tags: { kind: "literal", text: '{ Team: "orders" }' } } } },
  } };
  try {
    await mount(true, member.id);
    ui.fireEvent.click(document.querySelector(".declaration-tags summary")!);
    assert.ok(ui.screen.getByText("Overridden"));
    assert.ok(ui.screen.getByText("platform"));
    assert.ok(ui.screen.getByRole("button", { name: parent.replace(/^resource:/, "resources.") }));
    ui.fireEvent.click(ui.screen.getByRole("button", { name: "Remove tag Team" }));
    assert.ok(ui.screen.getByText("Inherited", { exact: true }));
    assert.equal(ui.screen.queryByText("Overridden"), null);
    assert.equal(ui.screen.queryByRole("textbox", { name: "Tag 1 value" }), null);
    assert.ok(ui.screen.getByText("Unsaved · Review Changes to save."));
  } finally { response = original; }
});

test("existing workload, catalog, network and database inspectors expose tag controls in a disclosure below their header", async () => {
  const model = response.snapshot.models.dev;
  for (const selected of ["lambda:graphql-api", "resource:cognito", "resource:cognito.userPool", "island:vpc:application", model.managedDatabase!.resource]) {
    await mount(true, selected);
    const section = document.querySelector<HTMLElement>(".inspector-content > .declaration-tags")!;
    assert.ok(section, selected);
    assert.equal(section.previousElementSibling?.tagName, "HEADER", `${selected} tags are immediately visible after its header`);
    assert.equal(section.querySelector("details")!.open, false);
    ui.fireEvent.click(section.querySelector("summary")!);
    const tags = ui.within(section);
    assert.equal((tags.getByRole("button", { name: "Add tag" }) as HTMLButtonElement).disabled, false, selected);
    const next = tags.queryAllByRole("textbox").length / 2 + 1;
    ui.fireEvent.click(tags.getByRole("button", { name: "Add tag" }));
    ui.fireEvent.change(tags.getByRole("textbox", { name: `Tag ${next} key` }), { target: { value: "StudioTest" } });
    ui.fireEvent.change(tags.getByRole("textbox", { name: `Tag ${next} value` }), { target: { value: "reviewed" } });
    assert.ok(tags.getByText("Unsaved · Review Changes to save."));
    ui.fireEvent.click(tags.getByRole("button", { name: "Remove tag StudioTest" }));
    assert.equal(tags.queryByText("Unsaved · Review Changes to save."), null);
    ui.cleanup(); frames.clear();
  }
});

test("a snapshot missing tag metadata offers an inline editor refresh", async () => {
  const original = response;
  response = { ...response, snapshot: { ...response.snapshot, models: { dev: { ...response.snapshot.models.dev, tagging: undefined }, prod: { ...response.snapshot.models.prod, tagging: undefined } } } };
  try {
    await mount(true, "lambda:graphql-api");
    ui.fireEvent.click(document.querySelector(".declaration-tags summary")!);
    assert.ok(ui.screen.getByRole("button", { name: "Refresh editor" }));
  } finally { response = original; }
});

test("an older source index shows tag inputs and refresh instead of a read-only definition list", async () => {
  const original = response, target = "lambda:graphql-api";
  const { tags: _tags, ...fields } = response.snapshot.source.editability[target]!;
  response = { ...response, snapshot: { ...response.snapshot, source: { ...response.snapshot.source, editability: { ...response.snapshot.source.editability, [target]: fields } } } };
  try {
    await mount(true, target);
    ui.fireEvent.click(document.querySelector(".declaration-tags summary")!);
    assert.equal((ui.screen.getByRole("textbox", { name: "Tag 1 value" }) as HTMLInputElement).disabled, true);
    assert.ok(ui.screen.getByRole("button", { name: "Refresh editor" }));
    assert.equal(document.querySelector(".tag-readonly"), null);
    assert.ok(ui.screen.getByRole("link", { name: "Open tag declaration in VS Code" }));
  } finally { response = original; }
});

test("discarding invalid tag edits restores source rows and clears the local validation message", async () => {
  await mount(true, "lambda:graphql-api");
  const section = document.querySelector<HTMLElement>(".declaration-tags")!, tags = ui.within(section);
  ui.fireEvent.click(section.querySelector("summary")!);
  const first = tags.getByRole("textbox", { name: "Tag 1 key" });
  ui.fireEvent.change(first, { target: { value: "aws:reserved" } });
  assert.ok(tags.getByText(/reserved for AWS or framework ownership/));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  assert.equal(tags.queryByText(/reserved for AWS or framework ownership/), null);
  assert.equal((tags.getByRole("textbox", { name: "Tag 1 key" }) as HTMLInputElement).value, "area");
});
