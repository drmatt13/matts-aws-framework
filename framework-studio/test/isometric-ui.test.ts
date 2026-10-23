import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
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
import { DECK, hexRgb, ISLAND_TRIM } from "../src/scene/look";
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
let inspector: typeof import("../src/views/Inspector");
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const images: { src: string; alpha: number }[] = [];
const strokes: string[] = [];
const labels: string[] = [];
const labelPaints: { text: string; alpha: number; x: number; y: number; font: string }[] = [];
const iconStrokes: { icon: string; color: string; width: number }[] = [];
const pathStrokes: { color: string; width: number }[] = [];
const paintOrder: ({ kind: "highlight"; clipped: boolean } | { kind: "image" })[] = [];
let measurements = 0;
let glyphWidth = 6;

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
  Object.defineProperty(globalThis, "Path2D", { configurable: true, value: class { moveTo() {} lineTo() {} closePath() {} arc() {} roundRect() {} } });
  Object.defineProperty(globalThis, "Image", { configurable: true, value: class { src = ""; complete = true; naturalWidth = 48; onload = null; } });
  const gradient = () => ({ addColorStop() {} });
  let activeClip: Path2D | undefined;
  const paintStack: { alpha: number; stroke: string; width: number; clip: Path2D | undefined }[] = [];
  let paintedIcon = "";
  const context = new Proxy({
    globalAlpha: 1,
    strokeStyle: "",
    lineWidth: 1,
    stroke(path?: Path2D) {
      strokes.push(this.strokeStyle);
      if (this.strokeStyle === "rgba(167, 215, 255, 0.85)" || this.strokeStyle === "rgba(207, 229, 248, 0.6)") paintOrder.push({ kind: "highlight", clipped: !!activeClip });
      if (path) pathStrokes.push({ color: this.strokeStyle, width: this.lineWidth });
      if (paintedIcon) iconStrokes.push({ icon: paintedIcon, color: this.strokeStyle, width: this.lineWidth });
      paintedIcon = "";
    },
    fillText(text: string, x: number, y: number) { labels.push(text); labelPaints.push({ text, alpha: this.globalAlpha, x, y, font: String((this as unknown as { font: string }).font) }); },
    clip(path?: Path2D) { activeClip = path ?? new Path2D(); },
    save() { paintStack.push({ alpha: this.globalAlpha, stroke: this.strokeStyle, width: this.lineWidth, clip: activeClip }); },
    restore() {
      const saved = paintStack.pop();
      if (!saved) return;
      this.globalAlpha = saved.alpha; this.strokeStyle = saved.stroke; this.lineWidth = saved.width; activeClip = saved.clip;
    },
    createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: (text: string) => { measurements++; return { width: text.length * glyphWidth, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * glyphWidth, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }; },
    drawImage(image: { src: string }) { images.push({ src: image.src, alpha: this.globalAlpha }); paintOrder.push({ kind: "image" }); paintedIcon = image.src; },
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
  studio = await import("../src/studio"); map = await import("../src/views/Isometric"); inspector = await import("../src/views/Inspector");
  builder = new SnapshotBuilder(path.resolve(__dirname, "../.."));
  response = { snapshot: (await builder.refresh()).snapshot, evaluating: false, commands: {}, history: {}, busy: null };
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
    return h("div", null, h("output", { "aria-label": "Selection" }, context.selected ?? "none"), h(map.Isometric),
      withInspector ? h("button", { onClick: () => context.setMode(context.mode === "dev" ? "prod" : "dev") }, "Switch environment") : null,
      withInspector ? h(inspector.Inspector) : null);
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

test("the keyboard entity navigator browses connections and returns focus to the canvas with Escape", async () => {
  await mount();
  const list = ui.screen.getByRole("list", { name: "Entities in the landscape" });
  assert.ok(list.classList.contains("landscape-entity-list"), "the list becomes visible on keyboard focus");
  assert.match(list.textContent!, /Escape to return to the map/);
  const buttons = ui.within(list).getAllByRole("button");
  buttons[0]!.focus();
  ui.fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
  assert.equal(document.activeElement, buttons[1]);
  ui.fireEvent.keyDown(buttons[1]!, { key: "End" });
  assert.equal(document.activeElement, buttons.at(-1));
  ui.fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  assert.equal(document.activeElement, document.querySelector("canvas"));
  assert.equal(ui.screen.getByLabelText("Selection").textContent, "none", "keyboard navigation does not change source selection");
});

test("the visible resource navigator searches, filters and inspects canonical entities without source changes", async () => {
  await mount();
  const navigator = ui.screen.getByRole("navigation", { name: "Map resource navigator" });
  assert.match(navigator.textContent!, /map shows declarations/);
  ui.fireEvent.change(search(), { target: { value: "graphql" } });
  const results = ui.within(navigator);
  assert.ok(results.getByRole("button", { name: /graphql-api.*HTTP Lambda/ }));
  assert.equal(results.queryByRole("button", { name: /sign-in/ }), null);
  ui.fireEvent.change(results.getByRole("combobox", { name: "Map resource type" }), { target: { value: "HTTP Lambda" } });
  ui.fireEvent.click(results.getByRole("button", { name: /graphql-api.*HTTP Lambda/ }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "lambda:graphql-api"));
  assert.equal((search() as HTMLInputElement).value, "graphql");
  ui.fireEvent.click(results.getByRole("button", { name: "Clear selection" }));
  await ui.waitFor(() => assert.equal(ui.screen.getByLabelText("Selection").textContent, "none"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Browse map resources" }));
  assert.equal(ui.screen.queryByRole("navigation", { name: "Map resource navigator" }), null);
  assert.equal((search() as HTMLInputElement).value, "graphql");
});

test("missing implementation is visible at its canonical map resource without changing topology", async () => {
  const breakImplementation = (model: typeof response.snapshot.models.dev) => ({ ...model, targets: model.targets.map(target => target.ref === "lambda:graphql-api" ? { ...target, implementation: { ready: false, problems: ["Configured handler index.ts is missing."] } } : target) });
  const failed = { ...response, snapshot: { ...response.snapshot, models: { dev: breakImplementation(response.snapshot.models.dev), prod: breakImplementation(response.snapshot.models.prod) } } };
  const healthyScene = buildScene(response.snapshot.models.dev), brokenScene = buildScene(failed.snapshot.models.dev);
  assert.deepEqual(brokenScene.nodes.map(node => [node.id, node.gx, node.gy]), healthyScene.nodes.map(node => [node.id, node.gx, node.gy]));
  assert.deepEqual(brokenScene.nodes.find(node => node.id === "lambda:graphql-api")?.sourceProblems, ["Configured handler index.ts is missing."]);
  await mount(false, undefined, failed);
  const list = ui.screen.getByRole("navigation", { name: "Map resource navigator" });
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
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
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

test("connections over terrain receive hover and clicks while clear terrain still opens its island", async () => {
  await mount(true);
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
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

test("the real renderer draws resting connections a little stronger, and those outside the viewed environment at a quarter of that", async () => {
  await mount();
  await draw();
  const alphas = new Set(strokes.flatMap((style) => { const match = /^rgba\(\d+, \d+, \d+, ([\d.]+)\)$/.exec(style); return match ? [Number(match[1])] : []; }));
  assert.ok(alphas.has(0.3), "a resting connection in this environment");
  assert.ok(alphas.has(0.075), "a resting connection the environment leaves out, at a quarter of the strength");
  assert.ok(!alphas.has(0.6), "nothing is emphasised above the resting strength");
  assert.ok(!alphas.has(0.24), "the old resting strength is gone");
});

test("connection hover and inspection distinguish identically named API routes and WebSocket handlers", async () => {
  await mount(true);
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(response.snapshot.models) });
  const edge = scene.edges.find((edge) => edge.from === "route:ws:customAction" && edge.edge.relation === "routes")!;
  assert.ok(edge);
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const at = scene.routes[edge.id]!.points.map((point) => worldToScreen(state.camera(), state.viewport(), point)).find((point) => state.pickAt(point.x, point.y)?.id === edge.id);
  assert.ok(at, "the route-to-handler connection is pickable");
  ui.fireEvent.pointerMove(document.querySelector("canvas")!, { clientX: at.x, clientY: at.y });
  await draw();
  const popup = await ui.screen.findByRole("tooltip");
  assert.ok(popup.textContent?.includes("From API: customAction"));
  assert.ok(popup.textContent?.includes("To WebSocket: customAction"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Connection: API: customAction to WebSocket: customAction,/ }));
  await ui.waitFor(() => assert.ok(document.querySelector(".connection-endpoints")?.textContent?.includes("FromAPI: customActionToWebSocket: customAction")));
});

test("clicking a disabled wire explains its endpoints in the inspector and the notice follows the mode", async () => {
  await mount(true);
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(response.snapshot.models), conditions: Object.fromEntries(Object.entries(response.snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])) });
  const edge = scene.edges.find((edge) => edge.edge.from === "envfile:prod" && edge.edge.relation === "supplies")!;
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

test("clicking a grouped connection opens every mapping and retains it across environments", async () => {
  await mount(true);
  const id = "connection:client-envfile:envfile%3Adev";
  assert.ok(!labels.includes("4 · Dev"), "connection labels stay off the canvas");
  const scene = buildScene(response.snapshot.models.dev, { layoutModels: Object.values(response.snapshot.models), webSocketApi: response.snapshot.webSocketApi,
    resourceAvailability: catalogAvailability(response.snapshot.models) });
  const state = (dom.window as unknown as { __studioLandscape: { camera(): Camera; viewport(): Viewport; pickAt(x: number, y: number): { id: string } | undefined } }).__studioLandscape;
  const at = scene.routes[id]!.points.map((point) => worldToScreen(state.camera(), state.viewport(), point)).find((point) => state.pickAt(point.x, point.y)?.id === id);
  assert.ok(at, "the grouped line is pickable");
  const canvas = document.querySelector("canvas")!;
  ui.fireEvent.pointerMove(canvas, { clientX: at.x, clientY: at.y });
  await draw();
  const popup = await ui.screen.findByRole("tooltip");
  assert.ok(popup.textContent?.includes("4 relationships"));
  assert.deepEqual(visibleTags(popup), [["hover-tag dev", "Dev"], ["hover-tag off", "Prod"]]);
  assert.deepEqual(tagsOf(popup), [["hover-tag dev", "Dev: Connection enabled"], ["hover-tag off", "Prod: not deployed"]]);
  ui.fireEvent.pointerDown(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  ui.fireEvent.pointerUp(canvas, { clientX: at.x, clientY: at.y, button: 0 });
  const map = await ui.screen.findByRole("region", { name: "Aggregated connection map" });
  assert.deepEqual(visibleTags(document.querySelector(".connection-header")!), [["hover-tag dev", "Dev"], ["hover-tag off", "Prod"]]);
  assert.equal(map.querySelectorAll(".connection-map-member").length, 4);
  assert.deepEqual(visibleTags(map.querySelector("summary")!), [["hover-tag dev", "Dev"], ["hover-tag off", "Prod"]]);
  assert.ok(!map.textContent?.includes("→"), "connection rows omit repeated arrows");
  assert.equal(ui.screen.getByLabelText("Selection").textContent, id);
  ui.fireEvent.click(map.querySelector("summary")!);
  assert.ok(map.querySelector(".connection-map-detail .connection-details"), "original details are retained without a repeated header");
  ui.fireEvent.click(map.querySelector("summary")!);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Switch environment" })); await draw();
  await ui.waitFor(() => assert.ok(map.querySelector(".connection-availability > strong")?.textContent?.includes("Disabled in Production")));
  assert.equal(ui.screen.getByLabelText("Selection").textContent, id);
  assert.equal(ui.screen.getByRole("region", { name: "Aggregated connection map" }).querySelectorAll(".connection-map-member").length, 4);
});

test("connections available in both environments retain two pills in every inspector row", async () => {
  await mount(true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Connection: Environment file: client-app\/.env to Stack: cognito, / }));
  const map = await ui.screen.findByRole("region", { name: "Aggregated connection map" });
  const expected = [["hover-tag dev", "Dev"], ["hover-tag prod", "Prod"]];
  assert.deepEqual(visibleTags(document.querySelector(".connection-header")!), expected);
  const rows = [...map.querySelectorAll<HTMLElement>(".connection-map-member > summary")];
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.deepEqual(visibleTags(row), expected);
    assert.ok(!row.textContent?.includes("client-app/.env"), "summaries show each relationship without repeating shared endpoints");
  }
});

test("in Development the real renderer strokes the unbuilt VPC as one deck with a single violet rim", async () => {
  await mount();
  await draw();
  const [r, g, b] = hexRgb(ISLAND_TRIM["island:vpc"]!);
  assert.ok(strokes.includes(`rgba(${r}, ${g}, ${b}, ${DECK.rim})`), "the dashed rim of the whole deck");
  assert.ok(strokes.includes(`rgba(${r}, ${g}, ${b}, ${DECK.wallEdge})`), "the dashed edge along its walls");
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
  await draw();
  const at = pointing().screenOf(id);
  assert.ok(at, `${id} stands in the landscape`);
  const hull = pointing().hullOf(id) ?? [];
  const middle = hull.length ? { x: hull.reduce((sum, p) => sum + p.x, 0) / hull.length, y: hull.reduce((sum, p) => sum + p.y, 0) / hull.length } : undefined;
  const point = at.card ?? middle ?? at.building;
  assert.equal(pointing().pickAt(point.x, point.y)?.id, id, "the pointer is over the entity");
  ui.fireEvent.pointerMove(document.querySelector("canvas")!, { pointerId: 1, clientX: point.x, clientY: point.y });
  await draw();
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
  const edge = source.edges.find((edge) => edge.style.color === "#ff9a3d" && !edge.otherLens &&
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
    const stroke = pathStrokes.find(({ color }) => color.startsWith(prefix))!;
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
