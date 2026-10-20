import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createElement as h } from "react";
import type { SnapshotResponse } from "../shared/api";
import { SnapshotBuilder } from "../server/snapshot";
import { landscapeFocus, SEARCH_FADE } from "../src/scene/focus";
import { SceneRenderer, type RenderState } from "../src/scene/render";
import { fitScene } from "../src/scene/fit";
import { iconUrl } from "../src/icons";
import { buildScene } from "../src/scene/build";
import { connectionMidpoint } from "../src/scene/routing";
import { screenToWorld, worldToScreen, type Camera, type Viewport } from "../src/scene/camera";
import { catalogAvailability } from "../src/deployment";
import { DECK, hexRgb, ISLAND_TRIM } from "../src/scene/look";
import { NODE_CAPTION, NODE_DEPLOYMENT_TAG, rectanglesOverlap } from "../src/scene/labels";
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
const labelPaints: { text: string; alpha: number; y: number }[] = [];
const iconStrokes: { icon: string; color: string; width: number }[] = [];
const pathStrokes: { color: string; width: number }[] = [];
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
  const alphaStack: number[] = [];
  let paintedIcon = "";
  const context = new Proxy({
    globalAlpha: 1,
    strokeStyle: "",
    lineWidth: 1,
    stroke(path?: Path2D) {
      strokes.push(this.strokeStyle);
      if (path) pathStrokes.push({ color: this.strokeStyle, width: this.lineWidth });
      if (paintedIcon) iconStrokes.push({ icon: paintedIcon, color: this.strokeStyle, width: this.lineWidth });
      paintedIcon = "";
    },
    fillText(text: string, _x: number, y: number) { labels.push(text); labelPaints.push({ text, alpha: this.globalAlpha, y }); },
    save() { alphaStack.push(this.globalAlpha); },
    restore() { this.globalAlpha = alphaStack.pop() ?? 1; },
    createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: (text: string) => { measurements++; return { width: text.length * glyphWidth, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * glyphWidth, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }; },
    drawImage(image: { src: string }) { images.push({ src: image.src, alpha: this.globalAlpha }); paintedIcon = image.src; },
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
afterEach(() => { ui.cleanup(); frames.clear(); images.length = 0; strokes.length = 0; labels.length = 0; labelPaints.length = 0; iconStrokes.length = 0; pathStrokes.length = 0; glyphWidth = 6; });

interface Debug { search(): { active: boolean; nodes: string[]; opacityOf(id: string): number }; stats(): { focus: string } }
const debug = () => (dom.window as unknown as { __studioLandscape: Debug }).__studioLandscape;
const search = () => ui.screen.getByRole("searchbox", { name: "Search isometric map" });
const draw = async () => ui.act(async () => {
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback(performance.now() + 500);
});

async function mount(withInspector = false) {
  function Workbench() {
    const context = studio.useStudio();
    return h("div", null, h("output", { "aria-label": "Selection" }, context.selected ?? "none"), h(map.Isometric),
      withInspector ? h("button", { onClick: () => context.setMode(context.mode === "dev" ? "prod" : "dev") }, "Switch environment") : null,
      withInspector ? h(inspector.Inspector) : null);
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
  renderer.setScene(scene);
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
