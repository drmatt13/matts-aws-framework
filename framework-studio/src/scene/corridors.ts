import type { Bounds, Point } from "./camera";
import { intersects, pathBounds, pathHits, pathsCross, type Obstacle } from "./layout-geometry";
import { arcPoints } from "./picking";

/**
 * Independent connections closer than this, within 20° of parallel, are competing for one corridor.
 * World units, so a change elsewhere on the map never respaces a corridor: about 8 CSS px at a
 * typical overview zoom and 20 px close up.
 */
export const CORRIDOR_CLEARANCE = 24;
const PARALLEL = Math.cos(20 * Math.PI / 180);
/** Wires that share a node meet there. Within this radius a 7° fan is already distinct. */
const FAN_RADIUS = CORRIDOR_CLEARANCE / Math.tan(7 * Math.PI / 180);
const MIN_RUN = 3 * CORRIDOR_CLEARANCE;
/** A wire's control point moves at most this fraction of its span, so a bow stays subtle. */
const SHIFT = 0.14, MAX_SHIFT = 300;
/** Arcs may lose a little of their lift to make room, never most of it. */
const DROP = 0.2;
/** Below this offset two wires have no measurable side. */
const SEPARATE = 2;
/**
 * Above this many connections the corridor pass is skipped and every wire keeps its own arc. Dense
 * fans make the pass grow with the square of their size; at this scale it stays near half a second
 * even for a map that is mostly fans, and well under that for typical ones.
 */
export const CORRIDOR_LIMIT = 300;

export interface CorridorPath {
  readonly id: string;
  /** Endpoint node ids. Wires converging on one node form a fan there, not a corridor. */
  readonly ends: readonly [string, string];
  readonly points: readonly Point[];
}
export interface CorridorWire extends CorridorPath {
  /** The quadratic's control point; `points` samples it uniformly in t. */
  readonly control: Point;
  /** Wires of one group move together: a fan between the same two nodes keeps its spacing. */
  readonly group: string;
  /** Obstacle ids the wire may touch: its endpoints and their islands. */
  readonly exempt: readonly string[];
}
interface Sample { readonly ti: number; readonly tj: number; readonly s: number }
export interface CorridorConflict {
  /** `a` is the sampled (shorter) wire; separations are measured along its normal. */
  readonly a: string; readonly b: string;
  readonly length: number; readonly separation: number;
  readonly samples: readonly Sample[];
}

/** Unit normal of the chord, oriented the same way for both directions of travel. */
function chordNormal(a: Point, b: Point): Point {
  let dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length; dy /= length;
  if (dy < 0 || dy === 0 && dx < 0) { dx = -dx; dy = -dy; }
  return { x: -dy, y: dx };
}
function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let at = 1; at < points.length; at++) total += Math.hypot(points[at]!.x - points[at - 1]!.x, points[at]!.y - points[at - 1]!.y);
  return total;
}

/** A path with its segment envelopes, prepared once per detection pass. */
interface Prepared { readonly path: CorridorPath; readonly boxes: Float64Array; readonly box: Bounds; readonly length: number }
function prepare(path: CorridorPath): Prepared {
  const { points } = path, boxes = new Float64Array((points.length - 1) * 4);
  for (let at = 1; at < points.length; at++) {
    const a = points[at - 1]!, b = points[at]!, k = (at - 1) * 4;
    boxes[k] = Math.min(a.x, b.x); boxes[k + 1] = Math.max(a.x, b.x); boxes[k + 2] = Math.min(a.y, b.y); boxes[k + 3] = Math.max(a.y, b.y);
  }
  return { path, boxes, box: pathBounds(points), length: polylineLength(points) };
}

/** The nearest point found by `nearest`; reused because detection asks for it hundreds of thousands of times. */
const near = { d: 0, px: 0, py: 0, t: 0, tx: 0, ty: 0 };
/** Whether a polyline sampled uniformly in t passes within `reach`; if so `near` holds its nearest point. */
function nearest(x: number, y: number, other: Prepared, reach: number): boolean {
  const { points } = other.path, boxes = other.boxes;
  let best = reach * reach, found = false;
  for (let at = 1; at < points.length; at++) {
    const k = (at - 1) * 4;
    if (x < boxes[k]! - reach || x > boxes[k + 1]! + reach || y < boxes[k + 2]! - reach || y > boxes[k + 3]! + reach) continue;
    const a = points[at - 1]!, b = points[at]!, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const u = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
    const px = a.x + u * dx, py = a.y + u * dy, d = (x - px) * (x - px) + (y - py) * (y - py);
    if (d >= best) continue;
    const norm = Math.sqrt(length) || 1;
    best = d; found = true;
    near.px = px; near.py = py; near.t = (at - 1 + u) / (points.length - 1); near.tx = dx / norm; near.ty = dy / norm;
  }
  near.d = Math.sqrt(best);
  return found;
}

/** Sustained near-parallel proximity of `a` to `b` within `reach`, sampled along `a`, outside any shared node's fan. */
function conflict(prepared: Prepared, other: Prepared, clearance: number, reach: number): CorridorConflict | undefined {
  const a = prepared.path, b = other.path, box = other.box, last = a.points.length - 1;
  // Up to two shared nodes, each with a fan radius where convergence is expected.
  const fan = FAN_RADIUS * FAN_RADIUS, start = b.ends.includes(a.ends[0]) ? a.points[0]! : undefined, end = b.ends.includes(a.ends[1]) ? a.points[last]! : undefined;
  const normal = chordNormal(a.points[0]!, a.points[last]!);
  const step = clearance / 2, samples: Sample[] = [];
  // Runs within `reach` supply the samples; runs within `clearance` are what actually competes.
  let length = 0, separation = Infinity, run: Sample[] = [], runLength = 0, closeLength = 0, carry = 0;
  for (let at = 1; at <= last + 1; at++) {
    const p = a.points[at - 1]!, q = a.points[Math.min(at, last)]!, segment = at > last ? 0 : Math.hypot(q.x - p.x, q.y - p.y);
    const k = (at - 1) * 4;
    let along = carry;
    const skip = !segment || prepared.boxes[k + 1]! < box.minX - reach || prepared.boxes[k]! > box.maxX + reach || prepared.boxes[k + 3]! < box.minY - reach || prepared.boxes[k + 2]! > box.maxY + reach;
    const tx = segment ? (q.x - p.x) / segment : 0, ty = segment ? (q.y - p.y) / segment : 0;
    // One pass past the last segment flushes the final run.
    for (; skip || along < segment; along += step) {
      const x = p.x + tx * along, y = p.y + ty * along;
      const hub = !skip && (start && (x - start.x) ** 2 + (y - start.y) ** 2 < fan || end && (x - end.x) ** 2 + (y - end.y) ** 2 < fan);
      if (!skip && !hub && nearest(x, y, other, reach) && Math.abs(tx * near.tx + ty * near.ty) > PARALLEL) {
        run.push({ ti: (at - 1 + along / segment) / last, tj: near.t, s: (near.px - x) * normal.x + (near.py - y) * normal.y });
        runLength += step;
        if (near.d < clearance) { closeLength += step; separation = Math.min(separation, near.d); continue; }
      } else {
        if (runLength >= MIN_RUN) samples.push(...run);
        if (run.length) { run = []; runLength = 0; }
      }
      if (closeLength >= MIN_RUN) length += closeLength;
      closeLength = 0;
      if (skip) break;
    }
    if (skip) { if (segment) carry = along + Math.ceil((segment - along) / step) * step - segment; continue; }
    carry = along - segment;
  }
  return samples.length ? { a: a.id, b: b.id, length, separation, samples } : undefined;
}

/**
 * Pairs of connections competing for a corridor. A spatial grid of segments proposes only pairs
 * that pass near one another in nearly the same direction; crossings at an angle never compete.
 * Wires between the same two nodes are an intentional fan and never compete with each other.
 * A wider `reach` also returns near-parallel neighbours that are not yet too close; `focus` limits
 * the search to pairs that include one of those paths.
 */
export function corridorConflicts(paths: readonly CorridorPath[], clearance = CORRIDOR_CLEARANCE, reach = clearance, focus?: ReadonlySet<number>): readonly CorridorConflict[] {
  const cell = reach * 2, cells = new Map<number, { index: number; tx: number; ty: number }[]>(), candidates = new Set<number>(), count = paths.length;
  const loose = Math.cos(25 * Math.PI / 180);
  for (let index = 0; index < count; index++) {
    const { points } = paths[index]!;
    for (let at = 1; at < points.length; at++) {
      const p = points[at - 1]!, q = points[at]!, length = Math.hypot(q.x - p.x, q.y - p.y);
      if (!length) continue;
      const segment = { index, tx: (q.x - p.x) / length, ty: (q.y - p.y) / length };
      const x1 = Math.floor((Math.max(p.x, q.x) + reach) / cell), y0 = Math.floor((Math.min(p.y, q.y) - reach) / cell), y1 = Math.floor((Math.max(p.y, q.y) + reach) / cell);
      for (let x = Math.floor((Math.min(p.x, q.x) - reach) / cell); x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = x * 1_000_003 + y, bucket = cells.get(key);
        if (!bucket) { cells.set(key, [segment]); continue; }
        for (const other of bucket) if (other.index !== index && (!focus || focus.has(index) || focus.has(other.index)) && Math.abs(other.tx * segment.tx + other.ty * segment.ty) > loose) candidates.add(other.index * count + index);
        bucket.push(segment);
      }
    }
  }
  const prepared = paths.map(prepare);
  const conflicts: CorridorConflict[] = [];
  for (const key of [...candidates].sort((a, b) => a - b)) {
    const i = Math.floor(key / count), j = key % count, a = paths[i]!, b = paths[j]!;
    if (a.ends.every(end => b.ends.includes(end)) && b.ends.every(end => a.ends.includes(end))) continue;
    const found = prepared[j]!.length < prepared[i]!.length ? conflict(prepared[j]!, prepared[i]!, clearance, reach) : conflict(prepared[i]!, prepared[j]!, clearance, reach);
    if (found) conflicts.push(found);
  }
  return conflicts;
}

/** Groups `i` and `j` must be at least the clearance apart: `s + wi·shiftᵢ + wj·shiftⱼ ≥ clearance`. */
interface Constraint { readonly i: number; readonly j: number; readonly wi: number; readonly wj: number; readonly s: number }
/** How much of a control-point move reaches the curve at parameter t. */
const reachAt = (t: number) => 2 * t * (1 - t);

/**
 * Spread connections that compete for a corridor just far enough apart to read as separate wires.
 *
 * Each wire stays one quadratic between its exact endpoints; only its control point moves, along the
 * chord normal. The bow is largest mid-span and vanishes at the ends, and wires converging on a shared
 * node arrive at distinct angles, so a sheaf opens into a fan. Every competing pair keeps its current
 * side, so spacing never crosses the pair, and each corridor is solved together, sharing the room by
 * span: long wires bow more, short ones less. Wires that do not compete keep their exact route, and a
 * move that would cut more obstacles or cross more than one more wire is scaled back.
 */
export function separateCorridors(input: readonly CorridorWire[], obstacles: readonly Obstacle[]): ReadonlyMap<string, readonly Point[]> {
  if (input.length > CORRIDOR_LIMIT) return new Map();
  const wires = [...input].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Neighbours that are near-parallel but not yet too close join the solve, so making room in one
  // corridor never pushes a wire into another.
  const conflicts = corridorConflicts(wires, CORRIDOR_CLEARANCE, 2 * CORRIDOR_CLEARANCE);
  if (!conflicts.some(found => found.length)) return new Map();
  const groupIndex = new Map<string, number>(), group = wires.map(wire => { if (!groupIndex.has(wire.group)) groupIndex.set(wire.group, groupIndex.size); return groupIndex.get(wire.group)!; });
  const normals = wires.map(wire => chordNormal(wire.points[0]!, wire.points.at(-1)!));
  const groups = groupIndex.size, low = new Float64Array(groups).fill(-Infinity), high = new Float64Array(groups).fill(Infinity), reach = new Float64Array(groups).fill(Infinity);
  wires.forEach((wire, at) => {
    const a = wire.points[0]!, b = wire.points.at(-1)!, n = normals[at]!, g = group[at]!;
    const cap = Math.min(MAX_SHIFT, SHIFT * Math.hypot(b.x - a.x, b.y - a.y)), lift = Math.max(0, (a.y + b.y) / 2 - wire.control.y);
    let lo = -cap, hi = cap;
    if (n.y > 1e-9) hi = Math.min(hi, DROP * lift / n.y);
    if (n.y < -1e-9) lo = Math.max(lo, DROP * lift / n.y);
    low[g] = Math.max(low[g]!, lo); high[g] = Math.min(high[g]!, hi); reach[g] = Math.min(reach[g]!, cap);
  });
  const byId = new Map(wires.map((wire, at) => [wire.id, at]));

  // Wires lying on top of one another have no side of their own. They take the order of their endpoints
  // across the corridor, one order for the whole corridor, so the pairs agree and the far ends stay uncrossed.
  const root = Array.from({ length: groups }, (_, g) => g);
  const find = (g: number): number => root[g] === g ? g : (root[g] = find(root[g]!));
  for (const found of conflicts) { const i = find(group[byId.get(found.a)!]!), j = find(group[byId.get(found.b)!]!); if (i !== j) root[Math.max(i, j)] = Math.min(i, j); }
  const axis = new Map<number, Point>(), key = new Float64Array(groups);
  wires.forEach((wire, at) => {
    const corridor = find(group[at]!), reference = axis.get(corridor) ?? normals[at]!, a = wire.points[0]!, b = wire.points.at(-1)!;
    axis.set(corridor, reference);
    key[group[at]!] = ((a.x + b.x) * reference.x + (a.y + b.y) * reference.y) / 2;
  });
  const corridors = new Map<number, Constraint[]>();
  for (const found of conflicts) {
    const ai = byId.get(found.a)!, bi = byId.get(found.b)!, i = group[ai]!, j = group[bi]!;
    const usable = found.samples.filter(sample => reachAt(sample.ti) + reachAt(sample.tj) > 0.12);
    if (i === j || !usable.length) continue;
    const sigma = Math.sign(normals[ai]!.x * normals[bi]!.x + normals[ai]!.y * normals[bi]!.y) || 1;
    // A pair that visibly swaps sides is a shallow crossing: move it toward the cheaper end. A pair with
    // a measurable side keeps it. Only wires lying on top of each other take the corridor's order.
    const need = (side: number) => Math.max(...usable.map(sample => (CORRIDOR_CLEARANCE - side * sample.s) / ((reachAt(sample.ti) + reachAt(sample.tj)) / 2)));
    const mean = usable.reduce((sum, sample) => sum + sample.s * (reachAt(sample.ti) + reachAt(sample.tj)), 0) / usable.reduce((sum, sample) => sum + reachAt(sample.ti) + reachAt(sample.tj), 0);
    const crossed = usable.some(sample => sample.s > SEPARATE) && usable.some(sample => sample.s < -SEPARATE);
    const reference = axis.get(find(i))!, along = normals[ai]!.x * reference.x + normals[ai]!.y * reference.y < 0 ? -1 : 1;
    const side = crossed ? (need(1) < need(-1) ? 1 : -1) : Math.abs(mean) > SEPARATE ? Math.sign(mean) : (key[j]! - key[i]! || bi - ai) * along < 0 ? -1 : 1;
    const stride = Math.max(1, Math.ceil(usable.length / 10)), list = corridors.get(find(i)) ?? [];
    for (let at = 0; at < usable.length; at += stride) {
      const sample = usable[at]!;
      list.push({ i, j, wi: -side * reachAt(sample.ti), wj: side * sigma * reachAt(sample.tj), s: side * sample.s });
    }
    corridors.set(find(i), list);
  }
  // Projected Kaczmarz from rest: only a violated spacing moves anything, shared by each group's reach.
  const shift = new Float64Array(groups);
  const solve = (constraints: readonly Constraint[]) => {
    for (let sweep = 0, moved = true; sweep < 60 && moved; sweep++) {
      moved = false;
      for (const c of constraints) {
        const violation = CORRIDOR_CLEARANCE - (c.s + c.wi * shift[c.i]! + c.wj * shift[c.j]!);
        if (violation <= 1e-3) continue;
        const mi = reach[c.i]!, mj = reach[c.j]!, denominator = c.wi * c.wi * mi + c.wj * c.wj * mj;
        if (!denominator) continue;
        const i = Math.max(low[c.i]!, Math.min(high[c.i]!, shift[c.i]! + violation * c.wi * mi / denominator));
        const j = Math.max(low[c.j]!, Math.min(high[c.j]!, shift[c.j]! + violation * c.wj * mj / denominator));
        if (Math.abs(i - shift[c.i]!) + Math.abs(j - shift[c.j]!) > 1e-3) moved = true;
        shift[c.i] = i; shift[c.j] = j;
      }
    }
  };
  for (const [, constraints] of [...corridors].sort((a, b) => a[0] - b[0])) solve(constraints);

  // A separation is not worth a new collision: scale back moves that cut more obstacles or cross more wires.
  const route = (at: number) => {
    const wire = wires[at]!, n = normals[at]!, amount = shift[group[at]!]!;
    return amount ? arcPoints(wire.points[0]!, { x: wire.control.x + n.x * amount, y: wire.control.y + n.y * amount }, wire.points.at(-1)!, wire.points.length - 1) : wire.points;
  };
  // Crossings are counted on every other sample, the same way before and after a move.
  const coarse = (points: readonly Point[]) => points.filter((_, at) => at % 2 === 0 || at === points.length - 1);
  const base = wires.map(wire => coarse(wire.points)), baseBounds = base.map(pathBounds);
  const current = wires.map((_, at) => route(at)), currentBounds = current.map(pathBounds), currentCoarse = current.map(coarse);
  const hits = (at: number, points: readonly Point[]) => {
    const bounds = pathBounds(points);
    return obstacles.reduce((total, obstacle) => total + Number(!wires[at]!.exempt.includes(obstacle.id) && intersects(bounds, obstacle.bounds) && pathHits(points, obstacle.bounds)), 0);
  };
  const crossings = (at: number, points: readonly Point[], others: readonly (readonly Point[])[], bounds: readonly Bounds[]) => {
    const own = pathBounds(points);
    let total = 0;
    for (let other = 0; other < others.length; other++) if (other !== at && intersects(own, bounds[other]!) && pathsCross(points, others[other]!)) total++;
    return total;
  };
  const moving = wires.flatMap((_, at) => shift[group[at]!] ? [at] : []), membersOf = new Map<number, number[]>();
  for (const at of moving) { const list = membersOf.get(group[at]!); if (list) list.push(at); else membersOf.set(group[at]!, [at]); }
  const baseHits = new Map(moving.map(at => [at, hits(at, wires[at]!.points)]));
  const baseCrossings = new Map(moving.map(at => [at, crossings(at, base[at]!, base, baseBounds)]));
  for (let pass = 0; pass < 2; pass++) for (const [g, members] of membersOf) {
    for (let attempt = 0; attempt < 5 && shift[g]; attempt++) {
      const bad = members.some(at => hits(at, current[at]!) > baseHits.get(at)! || crossings(at, currentCoarse[at]!, currentCoarse, currentBounds) > baseCrossings.get(at)! + 1);
      if (!bad) break;
      shift[g] = attempt === 4 ? 0 : shift[g]! / 2;
      for (const at of members) { current[at] = route(at); currentBounds[at] = pathBounds(current[at]!); currentCoarse[at] = coarse(current[at]!); }
    }
  }
  // The solve is linear and a bow moves a wire far beyond the neighbours it was checked against. A wire
  // that ends up competing for more length than it started with is scaled back, then left where it was.
  const count = wires.length, pairs = new Map<number, number>();
  const record = (found: readonly CorridorConflict[]) => {
    for (const item of found) if (item.length) { const a = byId.get(item.a)!, b = byId.get(item.b)!; pairs.set(Math.min(a, b) * count + Math.max(a, b), item.length); }
  };
  const total = () => {
    const sum = new Float64Array(count);
    for (const [key, length] of pairs) { sum[Math.floor(key / count)] += length; sum[key % count] += length; }
    return sum;
  };
  record(conflicts);
  const started = total();
  // Only pairs that include a wire changed since the last look can have changed.
  for (let pass = 0, changed = new Set(moving); pass < 3; pass++) {
    for (const key of [...pairs.keys()]) if (changed.has(Math.floor(key / count)) || changed.has(key % count)) pairs.delete(key);
    record(corridorConflicts(wires.map((wire, at) => ({ id: wire.id, ends: wire.ends, points: current[at]! })), CORRIDOR_CLEARANCE, CORRIDOR_CLEARANCE, changed));
    const now = total();
    const worse = new Set(wires.flatMap((_, at) => shift[group[at]!] && now[at]! > started[at]! + CORRIDOR_CLEARANCE ? [group[at]!] : []));
    if (!worse.size) break;
    for (const g of worse) shift[g] = pass === 2 ? 0 : shift[g]! / 2;
    changed = new Set(wires.flatMap((_, at) => worse.has(group[at]!) ? [at] : []));
    for (const at of changed) current[at] = route(at);
  }
  // Validate the geometry actually returned. Overlap rollback can put an intermediate bow through
  // an obstacle that the full move cleared; dropping tiny moves can also change other wires' crossings.
  // Drop unsafe groups together, preserving their fan. Each pass removes at least one group, so even
  // when restoring one wire changes another's crossing count this finishes within the group count.
  for (const g of membersOf.keys()) if (Math.abs(shift[g]!) < 3) shift[g] = 0;
  for (const at of moving) { current[at] = route(at); currentBounds[at] = pathBounds(current[at]!); currentCoarse[at] = coarse(current[at]!); }
  for (let pass = 0; pass < membersOf.size; pass++) {
    const unsafe = [...membersOf].filter(([g, members]) => shift[g] && members.some(at => hits(at, current[at]!) > baseHits.get(at)! || crossings(at, currentCoarse[at]!, currentCoarse, currentBounds) > baseCrossings.get(at)! + 1));
    if (!unsafe.length) break;
    for (const [g, members] of unsafe) {
      shift[g] = 0;
      for (const at of members) { current[at] = route(at); currentBounds[at] = pathBounds(current[at]!); currentCoarse[at] = coarse(current[at]!); }
    }
  }
  const result = new Map<string, readonly Point[]>();
  wires.forEach((wire, at) => { if (shift[group[at]!]!) result.set(wire.id, current[at]!); });
  return result;
}

