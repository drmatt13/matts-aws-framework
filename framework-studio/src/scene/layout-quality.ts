import type { IslandFootprint, IslandPosition } from "./layout";
import type { LayoutGraph, LayoutLink } from "./layout-graph";
import { boundsOf, intersects, pathHits, pathLength, pathsCross, translated, type Obstacle } from "./layout-geometry";
import { legacyRoute, type ConnectionRoutes } from "./routing";
import type { Scene } from "./build";

export interface LayoutQuality {
  readonly crossings: number; readonly weightedCrossings: number; readonly length: number;
  readonly islandOverlaps: number; readonly labelOverlaps: number; readonly edgeObstacles: number;
  readonly aspect: number; readonly utilization: number; readonly movement: number; readonly cost: number;
}
export function layoutObstacles(islands: readonly IslandFootprint[], positions: readonly IslandPosition[]): readonly Obstacle[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return islands.map((island) => { const p = byId.get(island.id)!; return { id: island.id, bounds: translated(island.bounds ?? { minX: 0, maxX: island.size * 32, minY: -70, maxY: island.size * 16 + 16 }, p.left * 32, p.top * 16) }; });
}
export function positionedLinks(graph: LayoutGraph, positions: readonly IslandPosition[]): readonly LayoutLink[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return graph.links.map((link) => {
    const a = byId.get(link.from.island)!, b = byId.get(link.to.island)!;
    return { ...link, from: { ...link.from, x: link.from.x + a.left * 32, y: link.from.y + a.top * 16 }, to: { ...link.to, x: link.to.x + b.left * 32, y: link.to.y + b.top * 16 } };
  });
}
/** Overview title envelopes in the same projected plane as the routing obstacles. */
export function layoutLabels(islands: readonly IslandFootprint[], positions: readonly IslandPosition[], aspect = 16 / 9): readonly Obstacle[] {
  const obstacles = layoutObstacles(islands, positions);
  const bounds = boundsOf(obstacles.map((item) => item.bounds));
  const zoom = Math.min(1, 1824 / Math.max(1, bounds.maxX - bounds.minX), (1824 / aspect) / Math.max(1, bounds.maxY - bounds.minY));
  return obstacles.map((item, at) => ({ id: `title:${item.id}`, bounds: { minX: item.bounds.minX - (14 + islands[at]!.title.length * 6.5 + 10) / zoom, maxX: item.bounds.minX - 10 / zoom, minY: (item.bounds.minY + item.bounds.maxY) / 2 - 9 / zoom, maxY: (item.bounds.minY + item.bounds.maxY) / 2 + 9 / zoom } }));
}
export function measureLayout(islands: readonly IslandFootprint[], graph: LayoutGraph, positions: readonly IslandPosition[], aspect = 16 / 9, previous?: readonly IslandPosition[], routes?: ConnectionRoutes, samples = 4): LayoutQuality {
  const obstacles = layoutObstacles(islands, positions);
  const bounds = boundsOf(obstacles.map((item) => item.bounds));
  const width = Math.max(1, bounds.maxX - bounds.minX), height = Math.max(1, bounds.maxY - bounds.minY);
  const labels = layoutLabels(islands, positions, aspect).map((label) => label.bounds);
  let islandOverlaps = 0, labelOverlaps = 0, crossings = 0, weightedCrossings = 0, edgeObstacles = 0, length = 0;
  for (let i = 0; i < obstacles.length; i++) for (let j = i + 1; j < obstacles.length; j++) {
    islandOverlaps += Number(intersects(obstacles[i]!.bounds, obstacles[j]!.bounds, 12));
    labelOverlaps += Number(intersects(labels[i]!, labels[j]!) || intersects(labels[i]!, obstacles[j]!.bounds) || intersects(labels[j]!, obstacles[i]!.bounds));
  }
  const links = positionedLinks(graph, positions);
  const paths = links.map((link) => routes?.[link.id]?.points ?? legacyRoute(link.from, link.to, samples).points);
  for (let i = 0; i < links.length; i++) {
    const a = links[i]!, points = paths[i]!;
    length += pathLength(points) * a.weight;
    for (const obstacle of obstacles) if (obstacle.id !== a.from.island && obstacle.id !== a.to.island && pathHits(points, obstacle.bounds)) edgeObstacles += a.weight;
    for (let j = i + 1; j < links.length; j++) {
      const b = links[j]!;
      if (a.from.id === b.from.id || a.to.id === b.to.id || a.from.id === b.to.id || a.to.id === b.from.id) continue;
      if (pathsCross(points, paths[j]!)) { crossings++; weightedCrossings += Math.sqrt(a.weight * b.weight); }
    }
  }
  const old = new Map(previous?.map((p) => [p.id, p]) ?? []);
  const movement = positions.reduce((sum, p) => { const before = old.get(p.id); return sum + (before ? Math.hypot((p.left - before.left) * 32, (p.top - before.top) * 16) : 0); }, 0) / Math.max(1, old.size);
  const actualAspect = width / height;
  const utilization = Math.min(actualAspect / aspect, aspect / actualAspect);
  const area = obstacles.reduce((sum, item) => sum + (item.bounds.maxX - item.bounds.minX) * (item.bounds.maxY - item.bounds.minY), 0);
  const cost = islandOverlaps * 1e8 + labelOverlaps * 200000 + weightedCrossings * 2500 + edgeObstacles * 5000 + length * 0.025 + Math.abs(Math.log(actualAspect / aspect)) * 1200 + Math.max(0, 1 - area / (width * height)) * 300 + movement * 3;
  return { crossings, weightedCrossings, length, islandOverlaps, labelOverlaps, edgeObstacles, aspect: actualAspect, utilization, movement, cost };
}

/** Full-resolution validation uses the routes and anchors actually painted, not
 * the bounded aggregated proxy used during search. */
export function measureSceneLayout(scene: Scene, aspect = 16 / 9): LayoutQuality {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const positions = new Map(scene.layout.positions.map((p) => [p.id, p]));
  const anchor = (id: string) => { const node = byId.get(id)!, p = positions.get(node.island)!; return { id, island: node.island, x: node.geometry.top.x - p.left * 32, y: node.geometry.top.y - p.top * 16 }; };
  const links = scene.edges.filter((edge) => byId.get(edge.from)!.island !== byId.get(edge.to)!.island).map((edge) => ({ id: edge.id, from: anchor(edge.from), to: anchor(edge.to), weight: edge.edge.provenance === "source" ? 1 : 2, category: edge.category }));
  return measureLayout(scene.layout.footprints, { links, islands: [], signature: "actual routes" }, scene.layout.positions, aspect, undefined, scene.routes, 24);
}
