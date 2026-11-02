import type { IslandFootprint, IslandPosition } from "./layout";
import { FLOW_RELATIONS, type IslandLink, type LayoutGraph, type LayoutLink } from "./layout-graph";
import { pathLength, pathsCross, type Obstacle } from "./layout-geometry";
import { depth, dopBoxes, dopPolygon, ISLAND_CLEARANCE, islandShape, pathHitsDop, separation, shiftDop, titleDop, UNIT_X, UNIT_Y, type Dop, type IslandShape } from "./layout-shape";
import type { ConnectionRoutes } from "./routing";
import { arcControl, arcPoints } from "./picking";
import type { Bounds } from "./camera";
import type { Scene } from "./types";

export interface LayoutQuality {
  readonly crossings: number; readonly weightedCrossings: number; readonly length: number;
  readonly islandOverlaps: number; readonly labelOverlaps: number; readonly edgeObstacles: number;
  /** Bundles from different neighbours that leave an island along nearly the same direction. */
  readonly congestion: number;
  /** Request-path relationships that run back toward the upper left, in weighted world px. */
  readonly flow: number;
  /** Empty space between islands of one architectural group beyond their clearance, in world px. */
  readonly cohesion: number;
  readonly aspect: number; readonly utilization: number;
  /** Painted island and title area over the world rectangle a fitted overview shows. */
  readonly fill: number;
  readonly movement: number; readonly cost: number;
}
/** Islands' painted envelopes and overview titles at one arrangement, in world px. */
export interface LayoutFrame {
  readonly bodies: readonly Dop[];
  readonly titles: readonly Dop[];
  readonly bounds: Bounds;
  readonly zoom: number;
}
/** The workspace a fitted overview is judged against; smaller is conservative for titles. */
const REFERENCE_WIDTH = 1500;
/** The zoom a fitted overview of these bodies reaches; titles are screen-sized, so it sizes them. */
export function overviewZoom(bodies: readonly Dop[], aspect: number): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const d of bodies) { x0 = Math.min(x0, d.x0); x1 = Math.max(x1, d.x1); y0 = Math.min(y0, d.y0); y1 = Math.max(y1, d.y1); }
  return Math.min(1, REFERENCE_WIDTH / Math.max(1, x1 - x0), REFERENCE_WIDTH / aspect / Math.max(1, y1 - y0));
}
export function layoutFrame(islands: readonly IslandFootprint[], shapes: readonly IslandShape[], positions: readonly IslandPosition[], aspect: number, zoom?: number): LayoutFrame {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const bodies = islands.map((island, at) => { const p = byId.get(island.id)!; return shiftDop(shapes[at]!.body, p.left * UNIT_X, p.top * UNIT_Y); });
  const scale = zoom ?? overviewZoom(bodies, aspect);
  const titles = islands.map((island, at) => { const p = byId.get(island.id)!; return shiftDop(titleDop(island.title, shapes[at]!, scale), p.left * UNIT_X, p.top * UNIT_Y); });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of [...bodies, ...titles]) { minX = Math.min(minX, d.x0); maxX = Math.max(maxX, d.x1); minY = Math.min(minY, d.y0); maxY = Math.max(maxY, d.y1); }
  return { bodies, titles, bounds: { minX, maxX, minY, maxY }, zoom: scale };
}
/** Routing obstacles: boxes that hug each island's painted envelope. */
export function layoutObstacles(islands: readonly IslandFootprint[], positions: readonly IslandPosition[]): readonly Obstacle[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return islands.flatMap((island) => {
    const p = byId.get(island.id)!;
    return dopBoxes(shiftDop(islandShape(island).body, p.left * UNIT_X, p.top * UNIT_Y)).map((bounds) => ({ id: island.id, bounds }));
  });
}
export function positionedLinks(graph: LayoutGraph, positions: readonly IslandPosition[]): readonly LayoutLink[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return graph.links.map((link) => {
    const a = byId.get(link.from.island)!, b = byId.get(link.to.island)!;
    return { ...link, from: { ...link.from, x: link.from.x + a.left * UNIT_X, y: link.from.y + a.top * UNIT_Y }, to: { ...link.to, x: link.to.x + b.left * UNIT_X, y: link.to.y + b.top * UNIT_Y } };
  });
}
/** Overview title envelopes in the same projected plane as the routing obstacles. */
export function layoutLabels(islands: readonly IslandFootprint[], positions: readonly IslandPosition[], aspect = 16 / 9): readonly Obstacle[] {
  const frame = layoutFrame(islands, islands.map(islandShape), positions, aspect);
  return frame.titles.map((title, at) => ({ id: `title:${islands[at]!.id}`, bounds: { minX: title.x0, maxX: title.x1, minY: title.y0, maxY: title.y1 } }));
}
const polygonArea = (points: readonly { readonly x: number; readonly y: number }[]) => Math.abs(points.reduce((sum, p, at) => { const q = points[(at + 1) % points.length]!; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
/** A well-composed overview: islands and titles cover about this much of the fitted view. */
const TYPICAL_FILL = 0.4;
/** Bundles closer than this angle share a corridor where they leave an island. */
const CONGESTION_ANGLE = Math.PI / 6;

/**
 * A reusable evaluator: shapes, areas and link lists are prepared once, so the optimizer's
 * repeated measurements pay only for the arrangement-dependent work.
 */
export function prepareMeasure(islands: readonly IslandFootprint[], graph: LayoutGraph, aspect = 16 / 9, previous?: readonly IslandPosition[], samples = 4) {
  const shapes = islands.map(islandShape);
  const index = new Map(islands.map((island, at) => [island.id, at]));
  const areas = shapes.map((shape) => polygonArea(dopPolygon(shape.body)));
  const old = new Map(previous?.map((p) => [p.id, p]) ?? []);
  // Undirected island bundles for angular congestion.
  const bundles = new Map<string, { a: number; b: number; weight: number }>();
  for (const link of graph.islands) {
    const a = index.get(link.from), b = index.get(link.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const bundle = bundles.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), weight: 0 };
    bundle.weight += link.weight; bundles.set(key, bundle);
  }
  const incident = islands.map((_, at) => [...bundles.values()].filter((bundle) => bundle.a === at || bundle.b === at).map((bundle) => ({ other: bundle.a === at ? bundle.b : bundle.a, weight: bundle.weight })));
  const grouped: [number, number][] = [];
  for (let a = 0; a < islands.length; a++) for (let b = a + 1; b < islands.length; b++) if (islands[a]!.group && islands[a]!.group === islands[b]!.group) grouped.push([a, b]);
  const flows = (graph.flows ?? []).flatMap((flow) => { const a = index.get(flow.from), b = index.get(flow.to); return a === undefined || b === undefined || a === b ? [] : [{ a, b, weight: flow.weight }]; });
  return (positions: readonly IslandPosition[], routes?: ConnectionRoutes, zoom?: number): LayoutQuality & { readonly frame: LayoutFrame } => {
    const frame = layoutFrame(islands, shapes, positions, aspect, zoom);
    const { bodies, titles } = frame;
    let islandOverlaps = 0, labelOverlaps = 0, crossings = 0, weightedCrossings = 0, edgeObstacles = 0, length = 0, congestion = 0, flow = 0, cohesion = 0;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      islandOverlaps += Number(depth(bodies[i]!, 0, 0, bodies[j]!, 0, 0, ISLAND_CLEARANCE) > 0);
      labelOverlaps += Number(depth(titles[i]!, 0, 0, titles[j]!, 0, 0, 0) > 0 || depth(titles[i]!, 0, 0, bodies[j]!, 0, 0, 0) > 0 || depth(bodies[i]!, 0, 0, titles[j]!, 0, 0, 0) > 0);
    }
    const links = positionedLinks(graph, positions);
    const paths = links.map((link) => routes?.[link.id]?.points ?? arcPoints(link.from, arcControl(link.from, link.to), link.to, samples));
    for (let i = 0; i < links.length; i++) {
      const a = links[i]!, points = paths[i]!;
      length += pathLength(points) * a.weight;
      for (const [at, body] of bodies.entries()) {
        const id = islands[at]!.id;
        if (id !== a.from.island && id !== a.to.island && pathHitsDop(points, body)) edgeObstacles += a.weight;
      }
      for (let j = i + 1; j < links.length; j++) {
        const b = links[j]!;
        if (a.from.id === b.from.id || a.to.id === b.to.id || a.from.id === b.to.id || a.to.id === b.from.id) continue;
        if (pathsCross(points, paths[j]!)) { crossings++; weightedCrossings += Math.sqrt(a.weight * b.weight); }
      }
    }
    const centres = bodies.map((d) => ({ x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 }));
    for (const [at, around] of incident.entries()) {
      const c = centres[at]!;
      const directions = around.map(({ other, weight }) => ({ angle: Math.atan2(centres[other]!.y - c.y, centres[other]!.x - c.x), weight }));
      for (let i = 0; i < directions.length; i++) for (let j = i + 1; j < directions.length; j++) {
        let difference = Math.abs(directions[i]!.angle - directions[j]!.angle);
        if (difference > Math.PI) difference = 2 * Math.PI - difference;
        if (difference < CONGESTION_ANGLE) congestion += Math.sqrt(directions[i]!.weight * directions[j]!.weight) * (1 - difference / CONGESTION_ANGLE) ** 2;
      }
    }
    // Requests read from the upper left: a callee right of or below its caller reads forward.
    for (const { a, b, weight } of flows) flow += weight * Math.max(0, centres[a]!.x - centres[b]!.x + centres[a]!.y - centres[b]!.y);
    for (const [a, b] of grouped) cohesion += Math.max(0, separation(bodies[a]!, bodies[b]!) - ISLAND_CLEARANCE);
    const movement = positions.reduce((sum, p) => { const before = old.get(p.id); return sum + (before ? Math.hypot((p.left - before.left) * UNIT_X, (p.top - before.top) * UNIT_Y) : 0); }, 0) / Math.max(1, old.size);
    // The fitted overview frames wires as well: arcs lift above the top row of islands.
    let { minX, maxX, minY, maxY } = frame.bounds;
    for (const points of paths) for (const point of points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
    const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);
    const actualAspect = width / height;
    const utilization = Math.min(actualAspect / aspect, aspect / actualAspect);
    // The overview shows a viewport-shaped rectangle around everything. Empty space in it,
    // whether from a sprawling arrangement or the wrong shape, makes every island smaller on
    // screen; an outlying island cannot buy a better aspect without paying for that space.
    const content = areas.reduce((sum, value) => sum + value, 0) + titles.reduce((sum, d) => sum + (d.x1 - d.x0) * (d.y1 - d.y0), 0);
    const fill = content / (Math.max(width, height * aspect) * Math.max(height, width / aspect));
    const cost = islandOverlaps * 1e8 + labelOverlaps * 200000 + weightedCrossings * 2500 + edgeObstacles * 5000 + length * (TYPICAL_FILL / Math.min(TYPICAL_FILL, fill))
      + Math.abs(Math.log(actualAspect / aspect)) * 1200 + movement * 3 + congestion * 4000 + flow * 6 + cohesion * 20;
    return { crossings, weightedCrossings, length, islandOverlaps, labelOverlaps, edgeObstacles, congestion, flow, cohesion, aspect: actualAspect, utilization, fill, movement, cost, frame };
  };
}
export function measureLayout(islands: readonly IslandFootprint[], graph: LayoutGraph, positions: readonly IslandPosition[], aspect = 16 / 9, previous?: readonly IslandPosition[], routes?: ConnectionRoutes, samples = 4): LayoutQuality {
  const { frame: _, ...quality } = prepareMeasure(islands, graph, aspect, previous, samples)(positions, routes);
  return quality;
}

/** Full-resolution validation uses the routes and anchors actually painted, not
 * the bounded aggregated proxy used during search. */
export function measureSceneLayout(scene: Scene, aspect = 16 / 9): LayoutQuality {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const positions = new Map(scene.layout.positions.map((p) => [p.id, p]));
  const anchor = (id: string) => { const node = byId.get(id)!, p = positions.get(node.island)!; return { id, island: node.island, x: node.geometry.top.x - p.left * UNIT_X, y: node.geometry.top.y - p.top * UNIT_Y }; };
  const between = scene.edges.filter((edge) => byId.get(edge.from)!.island !== byId.get(edge.to)!.island);
  const links = between.map((edge) => ({ id: edge.id, from: anchor(edge.from), to: anchor(edge.to), weight: edge.edge.provenance === "source" ? 1 : 2, category: edge.category }));
  const islands: IslandLink[] = links.map((link) => ({ from: link.from.island, to: link.to.island, weight: link.weight }));
  const flows = links.filter((_, at) => FLOW_RELATIONS.has(between[at]!.edge.relation)).map((link) => ({ from: link.from.island, to: link.to.island, weight: link.weight }));
  return measureLayout(scene.layout.footprints, { links, islands, flows, signature: "actual routes" }, scene.layout.positions, aspect, undefined, scene.routes, 24);
}
