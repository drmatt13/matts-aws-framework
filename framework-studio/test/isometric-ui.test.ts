import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createElement as h } from "react";
import type { SnapshotResponse } from "../shared/api";
import { SnapshotBuilder } from "../server/snapshot";
import { SEARCH_FADE } from "../src/scene/focus";
import { iconUrl } from "../src/icons";
import { buildScene } from "../src/scene/build";
import { connectionMidpoint } from "../src/scene/routing";
import { worldToScreen, type Camera, type Viewport } from "../src/scene/camera";
import { catalogAvailability } from "../src/deployment";

let builder: SnapshotBuilder;
let response: SnapshotResponse;
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let map: typeof import("../src/views/Isometric");
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const images: { src: string; alpha: number }[] = [];
const strokes: string[] = [];

before(async () => {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLCanvasElement", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => frames.delete(id) });
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  Object.defineProperty(globalThis, "Path2D", { configurable: true, value: class { moveTo() {} lineTo() {} closePath() {} } });
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class { src = ""; complete = true; naturalWidth = 48; onload = null; } });
  const gradient = () => ({ addColorStop() {} });
  const alphaStack: number[] = [];
  const context = new Proxy({
    globalAlpha: 1,
    strokeStyle: "",
    stroke() { strokes.push(this.strokeStyle); },
    save() { alphaStack.push(this.globalAlpha); },
    restore() { this.globalAlpha = alphaStack.pop() ?? 1; },
    createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: (text: string) => ({ width: text.length * 6, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    drawImage(image: { src: string }) { images.push({ src: image.src, alpha: this.globalAlpha }); },
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1920, height: 1000, top: 0, left: 0, right: 1920, bottom: 1000, toJSON() {} });
  dom.window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  class Pointer extends dom.window.MouseEvent {
    readonly pointerId: number;
    constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  }
  Object.defineProperty(dom.window, "PointerEvent", { configurable: true, value: Pointer });
  Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: Pointer });
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  studio = await import("../src/studio"); map = await import("../src/views/Isometric");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, history: {}, busy: null };
});
after(async () => { await builder.dispose(); dom.window.close(); });
afterEach(() => { ui.cleanup(); frames.clear(); images.length = 0; strokes.length = 0; });

interface Debug { search(): { active: boolean; nodes: string[]; opacityOf(id: string): number }; stats(): { focus: string } }
const debug = () => (dom.window as unknown as { __studioLandscape: Debug }).__studioLandscape;
const search = () => ui.screen.getByRole("searchbox", { name: "Search isometric map" });
const draw = async () => ui.act(async () => {
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(performance.now() + 500);
});

async function mount() {
  function Workbench() {
    const context = studio.useStudio();
    return h("div", null, h("output", { "aria-label": "Selection" }, context.selected ?? "none"), h(map.Isometric));
  }
  function Root() {
    const search = router.useSearch({ strict: false }) as { select?: string };
    const navigate = router.useNavigate();
    return h(studio.StudioProvider, { response, selected: search.select, select: (id: string | undefined) => void navigate({ to: ".", search: { select: id } } as never), children: h(Workbench) });
  }
  const root = router.createRootRoute({ component: Root, validateSearch: (search) => ({ select: typeof search.select === "string" ? search.select : undefined }) });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.screen.findByRole("searchbox", { name: "Search isometric map" }); await draw();
}

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
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "s3 endpoint" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "prop:endpoint:s3"));
  await draw();
  assert.equal(debug().stats().focus, "selection");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Internet gateway" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "prop:internet-gateway"));
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
    assert.ok(strokes.includes("#ff5f6d"), "the actual renderer strokes the error marker in red");
    const scene = buildScene(model, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
      resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
    const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { kind: string; id: string } } }).__studioLandscape;
    const at = worldToScreen(state.camera(), state.viewport(), connectionMidpoint(scene.routes[edge.id]!.points));
    assert.deepEqual(state.pickAt(at.x, at.y)?.id, edge.id, "the painted marker and hit area agree");
    const canvas = document.querySelector("canvas")!;
    ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
    ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 });
    await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, edge.id));
    assert.equal(debug().stats().focus, "selection");
  } finally { response = original; }
});

test("the real renderer strokes connections leaving the APIs island in purple and those leaving a Lambda or container in orange", async () => {
  await mount();
  await draw();
  assert.ok(strokes.some((style) => style.startsWith("rgba(255, 154, 61,")), "orange connections out of compute");
  const purple = strokes.filter((style) => style.startsWith("rgba(163, 116, 255,"));
  const leaving = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(response.snapshot.models) }).edges.filter((edge) => edge.from.startsWith("route:")).length;
  assert.ok(purple.length >= leaving, `${purple.length} purple strokes for ${leaving} route connections`);
  strokes.length = 0;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^\/api\/graphql, HTTP route/ }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "route:http:/graphql")); await draw();
  assert.ok(strokes.includes("rgba(163, 116, 255, 0.95)"), "a selected API connection lights in the same purple");
});

interface Pointing {
  screenOf(id: string): { building: { x: number; y: number }; card?: { x: number; y: number } } | undefined;
  hullOf(id: string): { x: number; y: number }[] | undefined;
  pickAt(x: number, y: number): { kind: string; id: string } | undefined;
}
const pointing = () => (dom.window as unknown as { __studioLandscape: Pointing }).__studioLandscape;

/** Moves the pointer onto an entity's label card, or the middle of its silhouette when no card is drawn, where the real picker finds it. */
async function hoverOver(id: string) {
  await draw();
  const at = pointing().screenOf(id);
  assert.ok(at, `${id} stands in the landscape`);
  const hull = pointing().hullOf(id) ?? [];
  const middle = hull.length ? { x: hull.reduce((sum, p) => sum + p.x, 0) / hull.length, y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length } : undefined;
  const point = at.card ?? middle ?? at.building;
  assert.equal(pointing().pickAt(point.x, point.y)?.id, id, "the pointer is over the entity");
  ui.fireEvent.pointerMove(document.querySelector("canvas")!, { pointerId: 1, clientX: point.x, clientY: point.y });
  return ui.screen.findByRole("tooltip");
}

const tagsOf = (card: HTMLElement) => [...card.querySelectorAll(".hover-tag")].map((tag) => [tag.className, tag.textContent]);

/** The visible words of a pill; the hidden text after the colon says where, for assistive technology. */
const visibleTags = (card: HTMLElement) => [...card.querySelectorAll(".hover-tag")].map((tag) => [tag.className, tag.firstChild?.textContent]);

test("hovering a node shows its authored description and a Dev and a Prod pill", async () => {
  await mount();
  const card = await hoverOver("lambda:sign-out");
  const text = card.textContent ?? "";
  assert.ok(text.includes(response.snapshot.descriptions.values["lambda:sign-out"]!), "the authored description");
  assert.deepEqual(visibleTags(card), [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]]);
  assert.deepEqual(tagsOf(card), [["hover-tag dev", "Dev: Your machine"], ["hover-tag prod", "Prod: AWS Lambda · outside the VPC"]]);
  assert.ok(!text.includes("Runs in development and production."), "the generic lane line is gone");
  assert.ok(!text.includes("Enabled in development"), "the generic presence line is gone");
  assert.ok(!text.includes("Click to inspect"), "no how-to caption under the description");
});

test("an environment that does not deploy the item keeps its pill, dark", async () => {
  await mount();
  const devOnly = await hoverOver("lambda:ws-authorizer");
  assert.deepEqual(visibleTags(devOnly), [["hover-tag dev", "Dev"], ["hover-tag off", "Prod"]]);
  assert.equal(tagsOf(devOnly)[1]![1], "Prod: not deployed");
  const prodOnly = await hoverOver("task:db-migrate");
  assert.deepEqual(visibleTags(prodOnly), [["hover-tag off", "Dev"], ["hover-tag prod", "Prod"]]);
});

test("hovering a framework-managed resource labels it, and an undescribed node asks for a description", async () => {
  await mount();
  const card = await hoverOver("resource:rds");
  assert.deepEqual(visibleTags(card), [["hover-tag off", "Dev"], ["hover-tag prod", "Prod"], ["hover-tag managed", "Framework-managed"]]);
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
