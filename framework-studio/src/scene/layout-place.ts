import { depth, ISLAND_CLEARANCE, penetration, shiftDop, UNIT_X, UNIT_Y, type Dop } from "./layout-shape";

/**
 * Feasible placement on the island lattice.
 *
 * Positions are island origins in layout units. `build.ts` rounds an origin to grid cells and,
 * when `left + top + length` is odd, nudges it one unit right; restricting origins to the
 * lattice where that sum is even makes the placed terrain exactly the shape evaluated here.
 */
export interface Spot { readonly left: number; readonly top: number }
export interface PlaceContext {
  /** Painted envelopes relative to each origin. */
  readonly bodies: readonly Dop[];
  /** Overview titles relative to each origin, at the planning zoom. */
  readonly titles: readonly Dop[];
  /** `length % 2` for terrain placed by `build.ts`; undefined where any integer origin is exact. */
  readonly parity: readonly (number | undefined)[];
  /** Each island's body and title together, padded by every clearance: a cheap first test. */
  readonly reach: readonly Dop[];
}
export function placeContext(bodies: readonly Dop[], titles: readonly Dop[], parity: readonly (number | undefined)[]): PlaceContext {
  const pad = (ISLAND_CLEARANCE + TITLE_CLEARANCE) / 2;
  const reach = bodies.map((b, i) => { const t = titles[i]!; return { x0: Math.min(b.x0, t.x0) - pad, x1: Math.max(b.x1, t.x1) + pad, y0: Math.min(b.y0, t.y0) - pad, y1: Math.max(b.y1, t.y1) + pad, a0: 0, a1: 0, b0: 0, b1: 0 }; });
  return { bodies, titles, parity, reach };
}
/** Clearance between a title and anything it is not attached to. */
const TITLE_CLEARANCE = 8;

const body = (ctx: PlaceContext, i: number, p: Spot) => shiftDop(ctx.bodies[i]!, p.left * UNIT_X, p.top * UNIT_Y);
const title = (ctx: PlaceContext, i: number, p: Spot) => shiftDop(ctx.titles[i]!, p.left * UNIT_X, p.top * UNIT_Y);

/**
 * How deeply two placed islands' bodies and titles intrude on each other's clearance; 0 when
 * clear. `slack` asks for that much more room on every side.
 */
export function intrusion(ctx: PlaceContext, i: number, p: Spot, j: number, q: Spot, slack = 0): number {
  const ax = p.left * UNIT_X, ay = p.top * UNIT_Y, bx = q.left * UNIT_X, by = q.top * UNIT_Y;
  const ri = ctx.reach[i]!, rj = ctx.reach[j]!;
  if (ri.x0 + ax >= rj.x1 + bx + slack || rj.x0 + bx >= ri.x1 + ax + slack || ri.y0 + ay >= rj.y1 + by + slack || rj.y0 + by >= ri.y1 + ay + slack) return 0;
  const bi = ctx.bodies[i]!, bj = ctx.bodies[j]!, ti = ctx.titles[i]!, tj = ctx.titles[j]!;
  return Math.max(depth(bi, ax, ay, bj, bx, by, ISLAND_CLEARANCE + slack), depth(ti, ax, ay, bj, bx, by, TITLE_CLEARANCE + slack),
    depth(bi, ax, ay, tj, bx, by, TITLE_CLEARANCE + slack), depth(ti, ax, ay, tj, bx, by, TITLE_CLEARANCE + slack));
}
const CLEAR = { depth: 0, x: 0, y: 0 } as const;
/** The deepest of the four body/title intersections between two placed islands, as a push on `j`. */
export function conflict(ctx: PlaceContext, i: number, p: Spot, j: number, q: Spot, slack = 0): { readonly depth: number; readonly x: number; readonly y: number } {
  if (intrusion(ctx, i, p, j, q, slack) <= 0) return CLEAR;
  const bi = body(ctx, i, p), bj = body(ctx, j, q), ti = title(ctx, i, p), tj = title(ctx, j, q);
  let best = penetration(bi, bj, ISLAND_CLEARANCE + slack);
  for (const candidate of [penetration(ti, bj, TITLE_CLEARANCE + slack), penetration(bi, tj, TITLE_CLEARANCE + slack), penetration(ti, tj, TITLE_CLEARANCE + slack)]) if (candidate.depth > best.depth) best = candidate;
  return best;
}
/** Rounding an origin to the lattice moves it at most a unit across and down: room to absorb that. */
export const LATTICE_SLACK = Math.hypot(UNIT_X, UNIT_Y);
export function clearOf(ctx: PlaceContext, i: number, p: Spot, others: readonly (Spot | undefined)[]): boolean {
  for (let j = 0; j < others.length; j++) {
    const q = others[j];
    if (j === i || !q) continue;
    if (intrusion(ctx, i, p, j, q) > 0) return false;
  }
  return true;
}
/** Every pair clear: the arrangement can be drawn as evaluated. */
export function feasible(ctx: PlaceContext, spots: readonly Spot[]): boolean {
  for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) if (intrusion(ctx, i, spots[i]!, j, spots[j]!) > 0) return false;
  return true;
}
export const onLattice = (ctx: PlaceContext, i: number, p: Spot) => Number.isInteger(p.left) && Number.isInteger(p.top) && (ctx.parity[i] === undefined || ((p.left + p.top + ctx.parity[i]!) % 2 + 2) % 2 === 0);
/** The nearest lattice origin in projected distance. */
export function snap(ctx: PlaceContext, i: number, p: Spot): Spot {
  const left = Math.round(p.left), top = Math.round(p.top);
  if (onLattice(ctx, i, { left, top })) return { left, top };
  const options = [{ left: left + 1, top }, { left: left - 1, top }, { left, top: top + 1 }, { left, top: top - 1 }];
  const distance = (q: Spot) => Math.hypot((q.left - p.left) * UNIT_X, (q.top - p.top) * UNIT_Y);
  return options.sort((a, b) => distance(a) - distance(b) || a.left - b.left || a.top - b.top)[0]!;
}

/** Parity-preserving lattice offsets within a radius, nearest first in projected distance. */
const SEARCH_RADIUS = 48;
const OFFSETS: readonly Spot[] = (() => {
  const offsets: Spot[] = [];
  for (let left = -SEARCH_RADIUS; left <= SEARCH_RADIUS; left++) for (let top = -SEARCH_RADIUS; top <= SEARCH_RADIUS; top++) if ((left + top) % 2 === 0) offsets.push({ left, top });
  const distance = (q: Spot) => Math.hypot(q.left * UNIT_X, q.top * UNIT_Y);
  return offsets.sort((a, b) => distance(a) - distance(b) || a.top - b.top || a.left - b.left);
})();

/** The nearest clear lattice origin to `target`, given islands already settled; never fails. */
export function nearestClear(ctx: PlaceContext, i: number, target: Spot, settled: readonly (Spot | undefined)[]): Spot {
  const start = snap(ctx, i, target);
  // Only islands that reach into the search window can block a candidate.
  const own = ctx.reach[i]!, wx = SEARCH_RADIUS * UNIT_X, wy = SEARCH_RADIUS * UNIT_Y;
  const x0 = own.x0 + start.left * UNIT_X - wx, x1 = own.x1 + start.left * UNIT_X + wx, y0 = own.y0 + start.top * UNIT_Y - wy, y1 = own.y1 + start.top * UNIT_Y + wy;
  const nearby = settled.map((q, j) => {
    if (!q || j === i) return undefined;
    const r = ctx.reach[j]!, left = q.left * UNIT_X, top = q.top * UNIT_Y;
    return r.x0 + left < x1 && r.x1 + left > x0 && r.y0 + top < y1 && r.y1 + top > y0 ? q : undefined;
  });
  for (const offset of OFFSETS) {
    const candidate = { left: start.left + offset.left, top: start.top + offset.top };
    if (clearOf(ctx, i, candidate, nearby)) return candidate;
  }
  // Beyond the search radius: below everything settled, where nothing can intersect.
  let floor = -Infinity;
  for (const [j, q] of settled.entries()) if (q && j !== i) floor = Math.max(floor, body(ctx, j, q).y1, title(ctx, j, q).y1);
  const top = Math.ceil((floor + ISLAND_CLEARANCE + TITLE_CLEARANCE - Math.min(ctx.bodies[i]!.y0, ctx.titles[i]!.y0)) / UNIT_Y) + 1;
  return snap(ctx, i, { left: start.left, top: Math.max(top, start.top) });
}

/**
 * Make an arrangement drawable with as little movement as possible. Fixed islands stay; the
 * rest settle in `order`, each at the clear lattice origin nearest its wish. Islands that
 * already fit keep their exact origin.
 */
export function legalize(ctx: PlaceContext, wishes: readonly Spot[], order: readonly number[], fixed: readonly boolean[] = []): Spot[] {
  const settled: (Spot | undefined)[] = wishes.map((p, i) => fixed[i] ? p : undefined);
  for (const i of order) {
    if (fixed[i]) continue;
    settled[i] = nearestClear(ctx, i, wishes[i]!, settled);
  }
  return settled as Spot[];
}

/**
 * Overlap removal by projection: each intersecting pair moves apart along its minimum
 * translation, shared in inverse proportion to mass. Infinite mass never moves; `absent`
 * islands take no part. Pairs part by `slack` beyond their clearance, so rounding the result
 * to the lattice cannot bring them back into conflict.
 */
export function separate(ctx: PlaceContext, spots: { left: number; top: number }[], mass: readonly number[], sweeps: number, absent: readonly boolean[] = [], slack = LATTICE_SLACK): void {
  // Only pairs that genuinely collide take the extra slack: islands already resting at their
  // clearance stay exactly where they are.
  const colliding = new Set<number>();
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let moved = false;
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      if (absent[i] || absent[j]) continue;
      const push = conflict(ctx, i, spots[i]!, j, spots[j]!, slack);
      if (push.depth <= 0) continue;
      const pair = i * spots.length + j;
      if (!colliding.has(pair)) {
        if (intrusion(ctx, i, spots[i]!, j, spots[j]!) <= 0) continue;
        colliding.add(pair);
      }
      const mi = mass[i]!, mj = mass[j]!;
      if (mi === Infinity && mj === Infinity) continue;
      const share = mi === Infinity ? 1 : mj === Infinity ? 0 : mi / (mi + mj);
      const depth = push.depth + 1;
      spots[j] = { left: spots[j]!.left + push.x * depth * share / UNIT_X, top: spots[j]!.top + push.y * depth * share / UNIT_Y };
      spots[i] = { left: spots[i]!.left - push.x * depth * (1 - share) / UNIT_X, top: spots[i]!.top - push.y * depth * (1 - share) / UNIT_Y };
      moved = true;
    }
    if (!moved) return;
  }
}

/**
 * Close up empty space: each movable island in turn slides straight toward `centre` as far as
 * it stays clear. Islands nearest the centre go first, so outer ones close the gaps they leave.
 */
export function compact(ctx: PlaceContext, spots: Spot[], centre: Spot, movable: readonly boolean[]): void {
  const order = spots.map((_, i) => i).filter((i) => movable[i])
    .sort((a, b) => Math.hypot((spots[a]!.left - centre.left) * UNIT_X, (spots[a]!.top - centre.top) * UNIT_Y) - Math.hypot((spots[b]!.left - centre.left) * UNIT_X, (spots[b]!.top - centre.top) * UNIT_Y) || a - b);
  for (const i of order) {
    const from = spots[i]!;
    const dx = centre.left - from.left, dy = centre.top - from.top;
    // Binary search on the fraction of the way to the centre, then the nearest clear lattice origin.
    let low = 0, high = 1;
    for (let step = 0; step < 10; step++) {
      const middle = (low + high) / 2;
      const candidate = snap(ctx, i, { left: from.left + dx * middle, top: from.top + dy * middle });
      if (clearOf(ctx, i, candidate, spots)) low = middle; else high = middle;
    }
    const candidate = snap(ctx, i, { left: from.left + dx * low, top: from.top + dy * low });
    if (clearOf(ctx, i, candidate, spots)) spots[i] = candidate;
  }
}
