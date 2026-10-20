import type { Point } from "./camera";
import { arcControl, arcPoints } from "./picking";
import { pathHits, pathLength, pathsCross, type Obstacle } from "./layout-geometry";
import type { LayoutLink } from "./layout-graph";
import { ELEVATION_STEP } from "./iso";

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
export function legacyRoute(a: Point, b: Point, samples = 24): ConnectionRoute {
  const points = arcPoints(a, arcControl(a, b), b, samples);
  return { points, length: pathLength(points) };
}
/** One cached route per real relationship, shared by paint, packets and hit testing.
 * Related edges share a direction corridor but retain distinct endpoints and lanes. */
export function routeConnections(links: readonly LayoutLink[], obstacles: readonly Obstacle[]): ConnectionRoutes {
  const result: Record<string, ConnectionRoute> = {};
  const accepted: { link: LayoutLink; points: readonly Point[] }[] = [];
  const lanes = new Map<string, number>();
  for (const link of [...links].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))) {
    const { from: a, to: b } = link;
    const group = `${a.island}>${b.island}:${link.category}`;
    const index = lanes.get(group) ?? 0; lanes.set(group, index + 1);
    const lane = (index % 7) * 5;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.max(1, Math.hypot(dx, dy));
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const lift = connectionLift(a, b, lane);
    // Nearby endpoints need a nearby detour. Retain the established candidates
    // for long connections while smoothly reducing their extra bow on short ones.
    const avoidanceScale = Math.min(1, (length / 800) ** 2);
    const controls = [0, 80, 180, 320].map((extra) => ({ x: middle.x, y: middle.y - lift - extra * avoidanceScale }));
    let best: readonly Point[] = [], score = Infinity;
    for (const control of controls) {
      const points = arcPoints(a, control, b, 8);
      const hits = obstacles.reduce((sum, obstacle) => sum + Number(obstacle.id !== a.island && obstacle.id !== b.island && obstacle.id !== a.id && obstacle.id !== b.id && pathHits(points, obstacle.bounds)), 0);
      const crossings = accepted.slice(-96).reduce((sum, other) => sum + (other.link.from.id !== a.id && other.link.to.id !== a.id && other.link.from.id !== b.id && other.link.to.id !== b.id && pathsCross(points, other.points) ? Math.sqrt(other.link.weight * link.weight) : 0), 0);
      const cost = hits * 20000 + crossings * 1200 + pathLength(points);
      if (cost < score) { best = arcPoints(a, control, b, 24); score = cost; }
    }
    result[link.id] = { points: best, length: pathLength(best) };
    accepted.push({ link, points: best.filter((_, at) => at % 3 === 0) });
  }
  return result;
}
