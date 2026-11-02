import type { Bounds, Point } from "./camera";
import { arcPoints } from "./picking";
import { intersects, pathBounds, pathHits, pathLength, pathsCross, type Obstacle } from "./layout-geometry";
import type { LayoutLink } from "./layout-graph";
import { ELEVATION_STEP } from "./iso";
import { CORRIDOR_LIMIT, corridorConflicts, separateCorridors, type CorridorWire } from "./corridors";

/** Control-point lift for a quadratic whose crest clears its higher end by `rise`.
 * Unlike a midpoint-only offset, this also arches above steep/receding endpoints. */
function crestLift(difference: number, rise: number): number {
  const half = Math.abs(difference) / 2;
  return half + rise + Math.sqrt(rise * (rise + 2 * half));
}

function connectionLift(a: LayoutLink["from"], b: LayoutLink["to"], lane: number): number {
  const heightDifference = ((b.h ?? 0) - (a.h ?? 0)) * ELEVATION_STEP;
  // Undo elevation and the ground plane's 2:1 foreshortening. Equal ground spans
  // get equal physical lift, regardless of which way they run across the map.
  const span = Math.hypot(b.x - a.x, 2 * (b.y - a.y + heightDifference));
  const rise = 28 + span * 0.08;
  // Lift in world Z only: projection changes y, never x. The physical crest
  // clears both attachments; a projected clearance keeps depth-aligned wires
  // legible even when their physical arch would otherwise project to a line.
  return Math.max(crestLift(heightDifference, rise), crestLift(b.y - a.y, 24)) + lane;
}

export interface ConnectionRoute { readonly points: readonly Point[]; readonly length: number }
export type ConnectionRoutes = Readonly<Record<string, ConnectionRoute>>;
/** Arc-length midpoint, shared by the error marker and its screen-sized hit area. */
export function connectionMidpoint(points: readonly Point[]): Point {
  let remaining = pathLength(points) / 2;
  for (let at = 1; at < points.length; at++) {
    const a = points[at - 1]!, b = points[at]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length >= remaining && length) { const t = remaining / length; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
    remaining -= length;
  }
  return points[0] ?? { x: 0, y: 0 };
}
/** One cached route per real relationship, shared by paint, packets and hit testing.
 * Independent wires that compete for one corridor are spread apart after their arcs are chosen. */
export function routeConnections(links: readonly LayoutLink[], obstacles: readonly Obstacle[]): ConnectionRoutes {
  const wires = routeArcs(links, obstacles), moved = separateCorridors(wires, obstacles);
  const paths = wires.map(wire => ({ ...wire, points: moved.get(wire.id) ?? wire.points }));
  trimNarrowCrests(paths, links, obstacles);
  return Object.fromEntries(paths.map((wire) => {
    const points = wire.points;
    return [wire.id, { points, length: pathLength(points) }];
  }));
}

/** A steep, almost depth-aligned wire can buy a tiny collision improvement with the
 * largest upward detour, producing a tall hairpin. Correct only those outliers after
 * routing/separation, so the correction cannot influence any other wire or the layout.
 * Keep the ordinary physical/projected lift and try only small sideways adjustments.
 * Unsafe candidates leave the original route intact. Parallel-type fans stay together. */
function trimNarrowCrests(paths: CorridorWire[], links: readonly LayoutLink[], obstacles: readonly Obstacle[]): void {
  if (paths.length > CORRIDOR_LIMIT) return;
  const byId = new Map(links.map(link => [link.id, link]));
  const groups = new Map<string, number>();
  for (const path of paths) groups.set(path.group, (groups.get(path.group) ?? 0) + 1);
  for (let at = 0; at < paths.length; at++) {
    const wire = paths[at]!, a = wire.points[0]!, b = wire.points.at(-1)!;
    const width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y);
    const crest = Math.min(a.y, b.y) - Math.min(...wire.points.map(point => point.y));
    // Ordinary 24-unit crests, wide arcs, short spans and intentional parallel fans
    // retain their exact samples. No resource names or relationship types are special.
    if (groups.get(wire.group)! > 1 || height < 320 || width > height * 0.1 || crest <= Math.max(48, width)) continue;
    const link = byId.get(wire.id)!;
    const controlY = (a.y + b.y) / 2 - connectionLift(link.from, link.to, 0);
    const midpoint = wire.points[(wire.points.length - 1) / 2]!;
    const controlX = 2 * midpoint.x - (a.x + b.x) / 2;
    const blocked = obstacles.filter(obstacle => !wire.exempt.includes(obstacle.id) && !pathHits(wire.points, obstacle.bounds));
    const crossings = (points: readonly Point[]) => paths.reduce((sum, other, index) => sum + Number(index !== at && pathsCross(points, other.points)), 0);
    const originalCrossings = crossings(wire.points);
    const focus = new Set([at]);
    const congestion = () => corridorConflicts(paths, undefined, undefined, focus).reduce((sum, conflict) => sum + conflict.length, 0);
    const originalCongestion = congestion();
    for (const shift of [0, 24, -24, 48, -48]) {
      const points = arcPoints(a, { x: controlX + shift, y: controlY }, b, wire.points.length - 1);
      const nextCrest = Math.min(a.y, b.y) - Math.min(...points.map(point => point.y));
      if (nextCrest >= crest || nextCrest > Math.max(48, width)
        || blocked.some(obstacle => pathHits(points, obstacle.bounds)) || crossings(points) > originalCrossings) continue;
      paths[at] = { ...wire, points };
      if (congestion() <= originalCongestion) break;
      paths[at] = wire;
    }
  }
}
/** Each relationship's own arc: the lifted quadratic that best avoids obstacles and crossings.
 * Related edges share a direction corridor but retain distinct endpoints and lanes. */
export function routeArcs(links: readonly LayoutLink[], obstacles: readonly Obstacle[]): readonly CorridorWire[] {
  const accepted: { link: LayoutLink; points: readonly Point[]; bounds: Bounds }[] = [];
  const wires: CorridorWire[] = [];
  const lanes = new Map<string, number>();
  // Opposite directions and different categories share the same endpoint pair. Give every type
  // a stable fan position within that pair so filters and mode switches cannot make wires swap.
  const pairKey = (link: LayoutLink) => JSON.stringify([link.from.id, link.to.id].sort());
  const pairs = new Map<string, string[]>();
  for (const link of links) {
    const key = pairKey(link), siblings = pairs.get(key) ?? [];
    siblings.push(link.id); pairs.set(key, siblings);
  }
  for (const siblings of pairs.values()) siblings.sort();
  const pairControls = new Map<string, Point>();
  const parallelGap = 48;
  for (const link of [...links].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))) {
    const { from: a, to: b } = link;
    const group = `${a.island}>${b.island}:${link.category}`;
    const index = lanes.get(group) ?? 0; lanes.set(group, index + 1);
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.max(1, Math.hypot(dx, dy));
    const pair = pairKey(link), siblings = pairs.get(pair)!;
    // Nearby resources need a compact fan even with many types; longer wires have room for clearer gaps.
    const parallel = siblings.length > 1;
    const parallelStep = parallel ? Math.min(parallelGap, Math.max(24, (length - 320) * 0.4) / (siblings.length - 1)) : 0;
    const rank = parallel ? siblings.indexOf(link.id) - (siblings.length - 1) / 2 : 0;
    const direction = a.id < b.id ? 1 : -1;
    const normal = { x: -dy / length * direction, y: dx / length * direction };
    const fan = { x: normal.x * rank * parallelStep, y: normal.y * rank * parallelStep };
    const clearance = Math.abs(normal.y) * (siblings.length - 1) * parallelStep / 2;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const lift = connectionLift(a, b, parallel ? 0 : (index % 7) * 5) + clearance;
    // Nearby endpoints need a nearby detour. Retain the established candidates
    // for long connections while smoothly reducing their extra bow on short ones.
    const avoidanceScale = Math.min(1, (length / 800) ** 2);
    const sharedControl = pairControls.get(pair);
    const controls = sharedControl === undefined
      ? [0, 80, 180, 320].map((extra) => ({ x: middle.x + fan.x, y: middle.y - lift - extra * avoidanceScale + fan.y }))
      : [{ x: sharedControl.x + fan.x, y: sharedControl.y + fan.y }];
    let bestControl = controls[0]!, score = Infinity;
    const recent = accepted.slice(-96);
    const obstacleHits = (points: readonly Point[]) => {
      const bounds = pathBounds(points);
      return obstacles.reduce((sum, obstacle) => sum + Number(obstacle.id !== a.island && obstacle.id !== b.island && obstacle.id !== a.id && obstacle.id !== b.id && intersects(bounds, obstacle.bounds) && pathHits(points, obstacle.bounds)), 0);
    };
    for (const control of controls) {
      const points = arcPoints(a, control, b, 8);
      // Envelopes reject impossible crossings before exact sampled-curve checks.
      const bounds = pathBounds(points);
      // The whole fan inherits this base curve. A clear first member cannot justify pushing another
      // member through an obstacle. Score every offset at the final paint/picking resolution; reversed
      // endpoints trace the same geometry and retain their canonical fan position.
      let hits = 0;
      if (parallel && sharedControl === undefined) {
        for (let sibling = 0; sibling < siblings.length; sibling++) {
          const offset = (sibling - (siblings.length - 1) / 2 - rank) * parallelStep;
          hits += obstacleHits(arcPoints(a, { x: control.x + normal.x * offset, y: control.y + normal.y * offset }, b, 24));
        }
      } else hits = obstacleHits(points);
      const crossings = recent.reduce((sum, other) => sum + (other.link.from.id !== a.id && other.link.to.id !== a.id && other.link.from.id !== b.id && other.link.to.id !== b.id && intersects(bounds, other.bounds) && pathsCross(points, other.points) ? Math.sqrt(other.link.weight * link.weight) : 0), 0);
      const cost = hits * 20000 + crossings * 1200 + pathLength(points);
      if (cost < score) { bestControl = control; score = cost; }
    }
    const best = arcPoints(a, bestControl, b, 24);
    if (parallel && sharedControl === undefined) pairControls.set(pair, { x: bestControl.x - fan.x, y: bestControl.y - fan.y });
    wires.push({ id: link.id, ends: [a.id, b.id], points: best, control: bestControl, group: pair, exempt: [a.island, b.island, a.id, b.id] });
    const points = best.filter((_, at) => at % 3 === 0);
    accepted.push({ link, points, bounds: pathBounds(points) });
  }
  return wires;
}
