import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SnapshotBuilder } from "../server/snapshot";
import type { ModelEdge, Snapshot } from "../shared/model";
import { buildScene } from "../src/scene/build";
import { extractLayoutGraph, topologyEdges, type LayoutAnchor } from "../src/scene/layout-graph";
import { layoutAspect, optimizeLayout } from "../src/scene/layout-optimize";
import { layoutIslands, type IslandFootprint } from "../src/scene/layout";
import { measureLayout, measureSceneLayout, positionedLinks, layoutObstacles } from "../src/scene/layout-quality";
import { routeConnections } from "../src/scene/routing";
import { distanceToPolyline, placeIslandTitle } from "../src/scene/picking";
import { pathHits } from "../src/scene/layout-geometry";
import { fitScene } from "../src/scene/fit";
import { islandSlabs } from "../src/scene/slabs";
import { worldToScreen } from "../src/scene/camera";
import { ELEVATION_STEP, project } from "../src/scene/iso";

const edge = (from: string, to: string, at: number): ModelEdge => ({ id: `edge:${at}`, from, to, relation: "routes", label: "fixture", provenance: "declared" });
function fixture(count = 4, dense = false) {
  const islands: IslandFootprint[] = Array.from({ length: count }, (_, at) => ({ id: `island:fixture-${at}`, title: `Service ${at}`, region: at < count / 2 ? "entry" : "compute", size: 12 + at % 3 * 3 }));
  const anchors: LayoutAnchor[] = islands.map((island, at) => ({ id: `node:${at}`, island: island.id, x: island.size * 16, y: island.size * 8 - 54 }));
  const edges: ModelEdge[] = [];
  for (let a = 0; a < count / 2; a++) for (let b = Math.ceil(count / 2); b < count; b++) if (dense || b === count - 1 - a) edges.push(edge(`node:${a}`, `node:${b}`, edges.length));
  return { islands, anchors, edges, graph: extractLayoutGraph(anchors, edges) };
}

test("graph extraction aggregates genuine connections and member representatives; self/missing links do not affect island placement", () => {
  const { anchors, edges } = fixture();
  const graph = extractLayoutGraph(anchors, [...edges, { ...edges[0]!, id: "duplicate" }, edge("member", "node:2", 90), edge("node:0", "node:0", 91), edge("absent", "node:0", 92)], { member: "node:0" });
  assert.equal(graph.links.length, 3);
  assert.equal(graph.links.find((link) => link.from.id === "node:0" && link.to.id === "node:3")!.weight, 6);
  assert.deepEqual(extractLayoutGraph(anchors, [...edges].reverse()), extractLayoutGraph(anchors, edges));
});

test("dependency-aware placement reduces a deliberately crossed bipartite graph and remains deterministic", () => {
  const { islands, graph } = fixture(8);
  const result = optimizeLayout(islands, graph);
  const before = measureLayout(islands, graph, layoutIslands(islands));
  const after = measureLayout(islands, graph, result.positions);
  assert.ok(after.weightedCrossings < before.weightedCrossings, JSON.stringify({ before, after }));
  assert.equal(after.islandOverlaps, 0);
  assert.equal(after.labelOverlaps, 0);
  assert.deepEqual(optimizeLayout([...islands].reverse(), graph).positions, result.positions);
  assert.ok(result.evaluations <= 360);
});

test("dense many-to-many graphs have bounded computation and preserve every individual routed relationship", () => {
  const { islands, graph } = fixture(20, true);
  const result = optimizeLayout(islands, graph);
  assert.ok(result.after.cost <= result.before.cost);
  assert.equal(result.after.islandOverlaps, 0);
  assert.ok(result.evaluations <= 360);
  const routes = routeConnections(positionedLinks(graph, result.positions), layoutObstacles(islands, result.positions));
  assert.equal(Object.keys(routes).length, graph.links.length);
  for (const link of positionedLinks(graph, result.positions)) {
    const route = routes[link.id]!;
    assert.deepEqual(route.points[0], { x: link.from.x, y: link.from.y });
    assert.deepEqual(route.points.at(-1), { x: link.to.x, y: link.to.y });
    assert.ok(route.length > 0);
    assert.equal(distanceToPolyline(route.points[12]!, route.points), 0, "picking consumes the painted route");
  }
  const large = fixture(80, true);
  const started = performance.now();
  const bounded = optimizeLayout(large.islands, large.graph);
  assert.ok(bounded.evaluations <= 90);
  assert.equal(bounded.after.islandOverlaps, 0);
  assert.ok(performance.now() - started < 5000, "bounded work completes even on slow CI");
});

test("unchanged topology reuses exact positions without optimization; small edits favour local movement", () => {
  const { islands, graph, anchors, edges } = fixture(8, true);
  const initial = optimizeLayout(islands, graph);
  const unchanged = optimizeLayout(islands, graph, { previous: initial.positions, previousKey: initial.topologyKey });
  assert.equal(unchanged.evaluations, 0);
  assert.deepEqual(unchanged.positions, initial.positions);
  const edited = optimizeLayout(islands, extractLayoutGraph(anchors, edges.slice(1)), { previous: initial.positions, previousKey: initial.topologyKey });
  assert.ok(edited.after.movement < 150, `mean projected movement ${edited.after.movement}`);
  const grown = islands.map((island, at) => at ? island : { ...island, size: island.size + 3 });
  assert.equal(optimizeLayout(grown, graph, { previous: initial.positions }).after.islandOverlaps, 0);
  const muchLarger = islands.map((island, at) => at ? island : { ...island, size: 90 });
  const repaired = optimizeLayout(muchLarger, graph, { previous: initial.positions, budget: 2 });
  assert.equal(repaired.after.islandOverlaps, 0, "growth must repair overlap even when refinement exhausts its budget");
  assert.ok(repaired.evaluations <= 2);
  const removed = islands.slice(1);
  const filtered = extractLayoutGraph(anchors.slice(1), edges);
  assert.equal(optimizeLayout(removed, filtered, { previous: initial.positions }).positions.length, removed.length);
});

test("pinned positions remain constraints during refinement", () => {
  const { islands, graph } = fixture(8, true);
  const first = optimizeLayout(islands, graph);
  const pin = first.positions[0]!;
  const pinned = optimizeLayout(islands, graph, { pins: { [pin.id]: pin } });
  assert.deepEqual(pinned.positions.find((p) => p.id === pin.id), pin);
  assert.equal(pinned.after.islandOverlaps, 0);
});

test("routing avoids an unrelated island and retains separate paths for parallel relationships", () => {
  const from = { id: "a", island: "left", x: 0, y: 0 }, to = { id: "b", island: "right", x: 800, y: 0 };
  const obstacle = { id: "middle", bounds: { minX: 300, maxX: 500, minY: -80, maxY: 80 } };
  const links = ["one", "two"].map((id) => ({ id, from, to, weight: 2, category: "routes" }));
  const routes = routeConnections(links, [obstacle]);
  assert.deepEqual(Object.keys(routes).sort(), ["one", "two"]);
  for (const route of Object.values(routes)) assert.equal(pathHits(route.points, obstacle.bounds), false);
  assert.notDeepEqual(routes.one!.points, routes.two!.points);
});

test("connections lift along world Z with a minimum crest even when viewed along their depth, in either direction", () => {
  const from = { id: "a", island: "left", x: 0, y: 0 };
  for (const [x, y] of [[30, 0], [800, 0], [400, 400], [-400, 400], [1, 800], [-1, 800], [0, 800], [0, -800]]) {
    const to = { id: "b", island: "right", x: x!, y: y! };
    const link = { id: "wire", from, to, weight: 2, category: "routes" };
    const points = routeConnections([link], []).wire!.points;
    const reverse = routeConnections([{ ...link, from: to, to: from }], []).wire!.points;
    assert.ok(Math.min(from.y, to.y) - Math.min(...points.map((p) => p.y)) >= 23,
      `the crest clears the higher projected endpoint for (${to.x}, ${to.y})`);
    assert.deepEqual(points[0], { x: 0, y: 0 });
    assert.deepEqual(points.at(-1), { x: to.x, y: to.y });
    for (let at = 0; at < points.length; at++) {
      const t = at / (points.length - 1);
      assert.ok(Math.abs(points[at]!.x - (from.x + (to.x - from.x) * t)) < 1e-8,
        "elevation projects vertically without bending sideways");
      if (at > 0 && at < points.length - 1) assert.ok(points[at]!.y < from.y + (to.y - from.y) * t,
        "every interior point is above its straight 3D chord");
      const other = reverse[points.length - 1 - at]!;
      assert.ok(Math.hypot(points[at]!.x - other.x, points[at]!.y - other.y) < 1e-8, "reversing the arrow retains the curve");
    }
  }
});

test("physical arc height accounts for attachment elevations and foreshortened ground spans", () => {
  for (const end of [{ x: 20, y: -20, h: 3 }, { x: 20, y: 20, h: 3 }, { x: -15, y: 8, h: 9 }, { x: 0, y: 0, h: 12 }, { x: 0, y: 0, h: 3 }]) {
    const start = { x: 0, y: 0, h: 3 };
    const from = { id: "a", island: "left", ...project(start), h: start.h };
    const to = { id: "b", island: "right", ...project(end), h: end.h };
    const points = routeConnections([{ id: "wire", from, to, weight: 2, category: "routes" }], []).wire!.points;
    const heights = points.map((p, at) => {
      const t = at / (points.length - 1);
      const ground = project({ x: end.x * t, y: end.y * t });
      return (ground.y - p.y) / ELEVATION_STEP;
    });
    const physicalRise = (Math.max(...heights) - Math.max(start.h, end.h)) * ELEVATION_STEP;
    const groundSpan = Math.hypot(end.x, end.y) * 32 * Math.SQRT2;
    assert.ok(physicalRise >= 27 + groundSpan * 0.08, `physical crest clears the attachments: ${physicalRise}`);
    assert.ok(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), "coincident attachments stay finite");
  }
});

test("nearby connections retain compact arcs even when crossings or obstacles favor a larger detour", () => {
  for (const [x, y] of [[30, 0], [200, 0], [250, 200], [0, 320]]) {
    const from = { id: "a", island: "left", x: 0, y: 0 }, to = { id: "b", island: "right", x: x!, y: y! };
    const groundSpan = Math.hypot(to.x, to.y * 2);
    const obstacle = { id: "middle", bounds: { minX: -400, maxX: 400, minY: -300, maxY: 300 } };
    const links = Array.from({ length: 7 }, (_, at) => ({ id: `wire-${at}`, from, to, weight: 2, category: "permissions" }));
    const routes = Object.values(routeConnections(links, [obstacle]));
    assert.equal(new Set(routes.map((route) => JSON.stringify(route.points))).size, links.length, "lanes stay distinct even for depth-aligned wires");
    for (const route of routes) {
      const lift = Math.max(...route.points.map((p, at) => to.y * at / (route.points.length - 1) - p.y));
      assert.ok(lift >= 28, "the minimum elevation is preserved");
      assert.ok(lift <= Math.max(52, groundSpan * 0.3), `short connection stays compact: ${lift} for ${groundSpan}`);
      assert.deepEqual(route.points[0], { x: from.x, y: from.y });
      assert.deepEqual(route.points.at(-1), { x: to.x, y: to.y });
    }
  }
});

let builder: SnapshotBuilder, snapshot: Snapshot;
before(async () => { builder = new SnapshotBuilder(path.resolve(__dirname, "../..")); snapshot = (await builder.refresh()).snapshot; });
after(() => builder.dispose());
test("the real migration-to-RDS connection stays proportional to its nearby endpoints", () => {
  for (const model of Object.values(snapshot.models)) {
    const scene = buildScene(model, { layoutModels: Object.values(snapshot.models) });
    const edge = scene.edges.find((item) => item.edge.from === "task:db-migrate" && item.edge.to === "resource:rds.database");
    assert.ok(edge);
    const points = scene.routes[edge.edge.id]!.points, a = points[0]!, b = points.at(-1)!;
    const dx = b.x - a.x, dy = b.y - a.y, chord = Math.hypot(dx, dy);
    const bow = Math.max(...points.map((point) => Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x)) / chord));
    assert.ok(bow <= chord * 0.25, `migration-to-RDS arc is too tall: ${bow} across ${chord}`);
  }
});
test("real development and production graphs improve actual full-resolution wires against the previous layout", () => {
  for (const model of Object.values(snapshot.models)) {
    const options = { layoutModels: Object.values(snapshot.models) };
    const baseline = buildScene(model, { ...options, semanticLayout: true });
    const scene = buildScene(model, options);
    const before = measureSceneLayout(baseline), after = measureSceneLayout(scene);
    assert.ok(after.crossings < before.crossings * 0.9, JSON.stringify({ mode: model.mode, before, after }));
    assert.ok(after.length < before.length);
    assert.ok(after.edgeObstacles < before.edgeObstacles);
    assert.equal(after.islandOverlaps, 0); assert.equal(after.labelOverlaps, 0);
    assert.deepEqual(scene.edges.map((e) => e.edge.id).sort(), baseline.edges.map((e) => e.edge.id).sort());
  }
});
test("significant aspect changes reflow while small resizes and presentation-only mode changes do not", () => {
  assert.equal(layoutAspect(1920, 1028), layoutAspect(1860, 1028));
  const model = snapshot.models.dev, layoutModels = Object.values(snapshot.models);
  const wide = buildScene(model, { layoutModels });
  const portrait = buildScene(model, { layoutModels, layoutSettings: { aspect: layoutAspect(900, 1028) } });
  assert.notDeepEqual(wide.layout.positions, portrait.layout.positions);
  assert.ok(measureSceneLayout(portrait, 0.9).utilization > 0.7);
  const other = buildScene(snapshot.models.prod, { layoutModels, layoutSettings: { previous: wide.layout.positions, previousKey: wide.layout.topologyKey } });
  assert.deepEqual(other.layout.positions, wide.layout.positions);
  assert.equal(other.layout.evaluations, 0);
  assert.deepEqual(topologyEdges(layoutModels), topologyEdges([...layoutModels].reverse()));
});

test("fit keeps screen-sized island titles inside desktop and portrait viewports", () => {
  for (const viewport of [{ width: 1920, height: 900 }, { width: 900, height: 900 }]) {
    const scene = buildScene(snapshot.models.dev, { layoutModels: Object.values(snapshot.models), layoutSettings: { aspect: layoutAspect(viewport.width, viewport.height) } });
    const camera = fitScene(scene, viewport);
    const screenPolygon = (polygon: readonly number[]) => polygon.flatMap((_, at) => at % 2 ? [] : Object.values(worldToScreen(camera, viewport, { x: polygon[at]!, y: polygon[at + 1]! })));
    const surfaces = islandSlabs(scene).map((slab) => ({
      title: slab.island.title,
      polygons: [...slab.bands.flatMap((band) => [band.top, ...band.walls.map((wall) => wall.quad)]),
        ...scene.frames.filter((frame) => frame.members.includes(slab.island.id)).flatMap((frame) => [frame.geometry.top, frame.geometry.left, frame.geometry.right])].map(screenPolygon),
    }));
    const obstacles = [...surfaces.flatMap((surface) => surface.polygons), ...scene.nodes.map((node) => screenPolygon(node.geometry.hull))];
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    for (const surface of surfaces) {
      const title = placeIslandTitle(surface.polygons, { width: surface.title.length * 7 * scale, height: 15 * scale }, obstacles);
      assert.ok(title, `${surface.title} has a clear label flank`);
      assert.ok(title.x >= 30 && title.x + title.width <= viewport.width - 30, `${surface.title} fits horizontally`);
      assert.ok(title.y >= 30 && title.y + title.height <= viewport.height - 30, `${surface.title} fits vertically`);
      obstacles.push([title.x, title.y, title.x + title.width, title.y, title.x + title.width, title.y + title.height, title.x, title.y + title.height]);
    }
  }
});
