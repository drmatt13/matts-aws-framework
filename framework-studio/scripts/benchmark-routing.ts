import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { corridorConflicts, separateCorridors } from "../src/scene/corridors";
import type { Obstacle } from "../src/scene/layout-geometry";
import type { LayoutAnchor, LayoutLink } from "../src/scene/layout-graph";
import { routeArcs, routeConnections } from "../src/scene/routing";

// Connection routing at architecture scale: base arcs, corridor separation and single-edge edits.
// Usage: node --conditions=development --import tsx framework-studio/scripts/benchmark-routing.ts [connections...] [--samples n]
const args = process.argv.slice(2), at = args.indexOf("--samples");
const samples = at >= 0 ? Number(args[at + 1]) : 5;
const sizes = args.filter((arg, index) => /^\d+$/.test(arg) && index !== at + 1).map(Number);
if (!Number.isInteger(samples) || samples < 1) throw new Error("Sample count must be a positive integer.");

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Islands on a loose grid, plaques on an isometric lattice, a few hubs most wires lead to. */
function architecture(connections: number, seed = 7): { links: LayoutLink[]; obstacles: Obstacle[] } {
  const next = random(seed), islandCount = Math.max(4, Math.round(Math.sqrt(connections) * 1.2)), columns = Math.ceil(Math.sqrt(islandCount * 1.6));
  const anchors: LayoutAnchor[] = [], obstacles: Obstacle[] = [];
  for (let island = 0; island < islandCount; island++) {
    const id = `island:${island}`, size = 2 + Math.floor(next() * 4), left = (island % columns) * 900 + next() * 200, top = Math.floor(island / columns) * 650 + next() * 150;
    obstacles.push({ id, bounds: { minX: left - size * 32, maxX: left + size * 32, minY: top - 70, maxY: top + size * 16 + 16 } });
    for (let gx = 0; gx < size; gx++) for (let gy = 0; gy < size; gy++) {
      if (next() < 0.35) continue;
      const x = left + (gx - gy) * 32, y = top + (gx + gy) * 16, anchor = { id: `${id}:${gx},${gy}`, island: id, x, y: y - 40, h: 3 };
      anchors.push(anchor);
      obstacles.push({ id: anchor.id, bounds: { minX: x - 20, maxX: x + 20, minY: y - 40, maxY: y } }, { id: anchor.id, bounds: { minX: x - 80, maxX: x + 80, minY: y - 104, maxY: y - 64 } });
    }
  }
  const hubs = anchors.filter(() => next() < 0.06), links: LayoutLink[] = [];
  for (let edge = 0; links.length < connections && edge < connections * 4; edge++) {
    const from = anchors[Math.floor(next() * anchors.length)]!, to = next() < 0.45 && hubs.length ? hubs[Math.floor(next() * hubs.length)]! : anchors[Math.floor(next() * anchors.length)]!;
    if (from.island === to.island) continue;
    links.push({ id: `edge:${edge}`, from, to, weight: 1 + Math.floor(next() * 3), category: ["inputs", "routes", "interactions"][Math.floor(next() * 3)]! });
  }
  return { links, obstacles };
}

const time = <T>(run: () => T): { ms: number; value: T } => { const start = performance.now(); const value = run(); return { ms: performance.now() - start, value }; };
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const competing = (wires: ReturnType<typeof routeArcs>, moved: ReadonlyMap<string, unknown>) =>
  corridorConflicts(wires.map((wire) => ({ ...wire, points: (moved.get(wire.id) as typeof wire.points | undefined) ?? wire.points }))).reduce((sum, found) => sum + found.length, 0);

for (const size of sizes.length ? sizes : [50, 200, 1000]) {
  const { links, obstacles } = architecture(size);
  const runs = Array.from({ length: samples }, () => {
    const arcs = time(() => routeArcs(links, obstacles));
    const separation = time(() => separateCorridors(arcs.value, obstacles));
    return { arcsMs: arcs.ms, separationMs: separation.ms, wires: arcs.value, moved: separation.value };
  });
  const { wires, moved } = runs.at(-1)!, routes = routeConnections(links, obstacles);
  // One edit at a time: the share of other connections whose geometry is exactly unchanged.
  const edits = [{ name: "insert", links: [...links, { ...links[0]!, id: "edge:inserted", to: links[1]!.to }] }, { name: "delete", links: links.slice(0, -1) }].map(({ name, links: edited }) => {
    const after = time(() => routeConnections(edited, obstacles));
    const shared = Object.keys(routes).filter((id) => id in after.value);
    return { name, ms: +after.ms.toFixed(1), unchanged: +(100 * shared.filter((id) => isDeepStrictEqual(routes[id], after.value[id])).length / shared.length).toFixed(1) };
  });
  console.log(JSON.stringify({
    connections: links.length, obstacles: obstacles.length,
    arcsMs: +median(runs.map((run) => run.arcsMs)).toFixed(1), separationMs: +median(runs.map((run) => run.separationMs)).toFixed(1), separationMaxMs: +Math.max(...runs.map((run) => run.separationMs)).toFixed(1),
    moved: moved.size, competingLength: { before: Math.round(competing(wires, new Map())), after: Math.round(competing(wires, moved)) }, edits,
  }));
}
