import { layoutIslands, type IslandFootprint, type IslandPosition } from "./layout";
import type { LayoutGraph, LayoutLink } from "./layout-graph";
import { overviewZoom, prepareMeasure, type LayoutQuality } from "./layout-quality";
import { ISLAND_CLEARANCE, islandShape, shiftDop, titleDop, UNIT_X, UNIT_Y } from "./layout-shape";
import { classicalScaling, majorize, stressGraph, type StressLink } from "./layout-stress";
import { clearOf, compact, feasible, intrusion, legalize, nearestClear, placeContext, separate, snap, type PlaceContext, type Spot } from "./layout-place";
import type { Point } from "./camera";

/**
 * Connectivity-aware island placement.
 *
 * 1. Global structure: weighted stress majorization over the island graph, started from
 *    classical scaling and from the semantic row packer, so strongly connected islands sit
 *    together and hubs settle centrally. Non-overlap of the exact projected envelopes (titles
 *    included) is enforced by projection while the stress solve runs.
 * 2. Orientation: stress is indifferent to rotation and reflection, so the arrangement is
 *    turned to read requests left to right, keep heavy bundles off the vertical (wires lift
 *    straight up the page) and match the workspace's aspect.
 * 3. Legal and compact: every origin lands on the lattice `build.ts` places exactly, at the
 *    nearest clear spot, then slides inward while it stays clear.
 * 4. Refinement: bounded discrete moves (relocate to neighbours, dock against a partner, swap,
 *    translate) against the full objective in `layout-quality.ts`: crossings, obstacles,
 *    length scaled by how well the overview is filled, titles, corridor congestion, reading
 *    flow, group cohesion and movement.
 *
 * Edits are incremental: unchanged islands keep their exact origin (a resized island keeps its
 * centre), new ones take the nearest clear spot beside their neighbours, and only the changed
 * neighbourhood is refined. After a broad edit, a fresh solve replaces that only when it is
 * substantially better.
 */
export interface IslandFingerprint { readonly size: number; readonly links: string }
export interface LayoutSettings {
  readonly preservePositions?: boolean;
  readonly aspect?: number;
  readonly previous?: readonly IslandPosition[];
  readonly previousKey?: string;
  /** What each island was when `previous` was laid out, so an edit knows what changed. */
  readonly previousFingerprints?: Readonly<Record<string, IslandFingerprint>>;
  readonly pins?: Readonly<Record<string, IslandPosition>>;
  readonly budget?: number;
}
export interface LayoutResult {
  readonly positions: readonly IslandPosition[];
  readonly before: LayoutQuality;
  readonly after: LayoutQuality;
  readonly evaluations: number;
  readonly key: string;
  readonly topologyKey: string;
  readonly fingerprints: Readonly<Record<string, IslandFingerprint>>;
  /** How the positions were reached: reused exactly, edited locally, or solved afresh. */
  readonly strategy: "reused" | "incremental" | "global";
}
/** Aspect buckets avoid reacting to small resizes or inspector toggles. */
export function layoutAspect(width: number, height: number): number {
  const ratio = width / Math.max(1, height);
  return ratio < 1.15 ? 0.9 : ratio < 1.55 ? 4 / 3 : ratio > 2.35 ? 2.5 : 16 / 9;
}
function proxyGraph(graph: LayoutGraph): LayoutGraph {
  const groups = new Map<string, LayoutLink[]>();
  for (const link of graph.links) { const key = `${link.from.island}>${link.to.island}:${link.category}`; const bucket = groups.get(key); if (bucket) bucket.push(link); else groups.set(key, [link]); }
  const weight = (group: readonly LayoutLink[]) => group.reduce((sum, link) => sum + link.weight, 0);
  const buckets = [...groups.values()].sort((a, b) => weight(b) - weight(a) || a[0]!.id.localeCompare(b[0]!.id)).slice(0, 36);
  // Spend the remaining proxy budget on geometric spread. A whole fan of
  // different inputs/handlers at one mean attachment hides its wire crossings.
  while (buckets.length < 36) {
    const splits = buckets.flatMap((group, at) => group.length < 2 ? [] : (["from", "to"] as const).flatMap(end => (["x", "y"] as const).map(axis => {
      let min = Infinity, max = -Infinity;
      for (const link of group) { min = Math.min(min, link[end][axis]); max = Math.max(max, link[end][axis]); }
      return { at, end, axis, score: group.length * (max - min) ** 2 };
    }))).sort((a, b) => b.score - a.score);
    const split = splits[0];
    if (!split || !split.score) break;
    const group = [...buckets[split.at]!].sort((a, b) => a[split.end][split.axis] - b[split.end][split.axis] || a.id.localeCompare(b.id));
    const middle = Math.ceil(group.length / 2);
    buckets.splice(split.at, 1, group.slice(0, middle), group.slice(middle));
  }
  const links = buckets.map((group): LayoutLink => {
    const first = group[0]!, weight = group.reduce((sum, link) => sum + link.weight, 0);
    const mean = (end: "from" | "to", axis: "x" | "y") => group.reduce((sum, link) => sum + link[end][axis] * link.weight, 0) / weight;
    const endpoint = (end: "from" | "to") => group.every(link => link[end].id === first[end].id) ? first[end].id : `${first.id}:${end}:mean`;
    return { ...first, from: { ...first.from, id: endpoint("from"), x: mean("from", "x"), y: mean("from", "y") }, to: { ...first.to, id: endpoint("to"), x: mean("to", "x"), y: mean("to", "y") }, weight };
  }).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
  // Retain a deterministic bounded proxy; full relationships are routed/measured separately.
  return { ...graph, links: links.slice(0, 36) };
}
/** Undirected island bundles: total relationship weight between each pair. */
function bundlesOf(islands: readonly IslandFootprint[], graph: LayoutGraph): StressLink[] {
  const index = new Map(islands.map((island, at) => [island.id, at]));
  const pairs = new Map<string, StressLink>();
  for (const link of graph.islands) {
    const a = index.get(link.from), b = index.get(link.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    pairs.set(key, { a: Math.min(a, b), b: Math.max(a, b), strength: (pairs.get(key)?.strength ?? 0) + link.weight });
  }
  return [...pairs.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}
/** An island's size and its bundles: what an edit must change for the island to need moving. */
function fingerprintsOf(islands: readonly IslandFootprint[], bundles: readonly StressLink[]): Record<string, IslandFingerprint> {
  return Object.fromEntries(islands.map((island, at) => [island.id, {
    size: island.size,
    links: bundles.filter((link) => link.a === at || link.b === at).map((link) => `${islands[link.a === at ? link.b : link.a]!.id}:${link.strength}`).join(","),
  }]));
}

const cache = new Map<string, LayoutResult>();
export function optimizeLayout(islands: readonly IslandFootprint[], graph: LayoutGraph, settings: LayoutSettings = {}): LayoutResult {
  const aspect = settings.aspect ?? 16 / 9;
  const sorted = [...islands].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const n = sorted.length;
  const topologyKey = JSON.stringify([sorted, graph.signature, aspect, settings.pins, settings.budget]);
  const key = JSON.stringify([topologyKey, settings.previous, settings.previousKey, settings.preservePositions, settings.previousFingerprints]);
  const hit = cache.get(key); if (hit) return hit;

  const bundles = bundlesOf(sorted, graph);
  const fingerprints = fingerprintsOf(sorted, bundles);
  const shapes = sorted.map(islandShape);
  const proxy = proxyGraph(graph);
  const pins = sorted.map((island) => settings.pins?.[island.id]);
  const pinned = pins.map(Boolean);
  const packed = layoutIslands(sorted);
  const outputOrder = packed.map((p) => p.id);
  const packedById = new Map(packed.map((p) => [p.id, p]));
  const packedWish: Spot[] = sorted.map((island, i) => pins[i] ?? packedById.get(island.id)!);
  // Titles are screen-sized: plan them at the zoom the (roomier) semantic arrangement would get.
  const zoom = overviewZoom(sorted.map((_, i) => shiftDop(shapes[i]!.body, packedWish[i]!.left * UNIT_X, packedWish[i]!.top * UNIT_Y)), aspect);
  const contextAt = (scale: number): PlaceContext => placeContext(shapes.map((shape) => shape.body), sorted.map((island, i) => titleDop(island.title, shapes[i]!, scale)), sorted.map((island) => island.ground ? island.ground.length % 2 : undefined));
  let ctx = contextAt(zoom);
  const mass = sorted.map((island, i) => pinned[i] ? Infinity : island.size ** 2);
  const degree = sorted.map((_, i) => bundles.reduce((sum, link) => sum + (link.a === i || link.b === i ? link.strength : 0), 0));
  const heavyFirst = sorted.map((_, i) => i).sort((a, b) => Number(pinned[b]) - Number(pinned[a]) || mass[b]! - mass[a]! || a - b);
  const toPositions = (spots: readonly Spot[]): IslandPosition[] => {
    const byId = new Map(sorted.map((island, i) => [island.id, { id: island.id, left: spots[i]!.left, top: spots[i]!.top }]));
    return outputOrder.map((id) => byId.get(id)!);
  };
  const measure = prepareMeasure(sorted, proxy, aspect, settings.previous);
  const old = new Map(settings.previous?.map((p) => [p.id, p]) ?? []);
  const scored = (spots: readonly Spot[]) => { const { frame: _, ...q } = measure(toPositions(spots)); return settings.previous ? { ...q, cost: q.cost + q.movement * 17 } : q; };
  const budget = settings.budget ?? (n > 24 ? 150 : 720);
  let evaluations = 0, limit = budget;
  const evaluate = (spots: readonly Spot[]): LayoutQuality | undefined => {
    if (evaluations >= limit) return undefined;
    evaluations++;
    return scored(spots);
  };
  const seedOrder = sorted.map((_, i) => i).sort((a, b) => Number(pinned[b]) - Number(pinned[a]) || packedWish[a]!.top - packedWish[b]!.top || a - b);
  const seed = legalize(ctx, packedWish, seedOrder, pinned);
  const before = scored(seed);
  const finish = (spots: readonly Spot[], quality: LayoutQuality, strategy: LayoutResult["strategy"], exact?: readonly IslandPosition[]): LayoutResult => {
    let final = spots, planned = zoom;
    // A compact result has a closer overview, so its titles are smaller than planned; a roomier
    // one has larger titles, which must still clear their neighbours. Making room can widen the
    // overview again, so settle until the titles fit at the zoom they will be seen at, leaving a
    // little extra room on each further pass so the settling converges.
    for (let pass = 0; !exact && pass < 4; pass++) {
      const actual = overviewZoom(final.map((p, i) => shiftDop(shapes[i]!.body, p.left * UNIT_X, p.top * UNIT_Y)), aspect);
      if (actual < planned) { planned = pass ? actual * 0.9 : actual; ctx = contextAt(planned); }
      if (feasible(ctx, final)) break;
      final = legalize(ctx, final, heavyFirst, pinned);
    }
    const result: LayoutResult = { positions: exact ?? toPositions(final), before, after: final === spots ? quality : scored(final), evaluations, key, topologyKey, fingerprints, strategy };
    if (cache.size >= 24) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  };

  const complete = settings.previous?.length === n && sorted.every((island) => old.has(island.id));
  if (complete && (settings.previousKey === topologyKey || settings.preservePositions && feasible(ctx, sorted.map((island) => old.get(island.id)!)))) {
    const kept = sorted.map((island) => old.get(island.id)!);
    return finish(kept, scored(kept), "reused", settings.previous);
  }

  // -------------------------------------------------------------------------
  // Shared search machinery
  // -------------------------------------------------------------------------
  const centreOf = (i: number, p: Spot): Point => ({ x: p.left * UNIT_X + shapes[i]!.centre.x, y: p.top * UNIT_Y + shapes[i]!.centre.y });
  const originAt = (i: number, centre: Point): Spot => ({ left: (centre.x - shapes[i]!.centre.x) / UNIT_X, top: (centre.y - shapes[i]!.centre.y) / UNIT_Y });
  const neighbours = sorted.map((_, i) => bundles.filter((link) => link.a === i || link.b === i).map((link) => ({ other: link.a === i ? link.b : link.a, strength: link.strength })).sort((x, y) => y.strength - x.strength || x.other - y.other));
  const massCentre = (spots: readonly Spot[]): Spot => {
    let x = 0, y = 0, total = 0;
    for (const [i, p] of spots.entries()) { const c = centreOf(i, p), m = sorted[i]!.size ** 2; x += c.x * m; y += c.y * m; total += m; }
    return { left: x / total / UNIT_X, top: y / total / UNIT_Y };
  };

  /** Bounded discrete refinement of `start` against the full objective. */
  const refine = (start: readonly Spot[], startQuality: LayoutQuality, movable: readonly boolean[], steps: readonly number[], reach?: (i: number, p: Spot) => boolean, quick = false) => {
    let spots = [...start], quality = startQuality;
    const allowed = (i: number, p: Spot) => !reach || reach(i, p);
    const tryCandidate = (candidate: readonly Spot[]) => {
      const q = evaluate(candidate);
      if (q && q.cost < quality.cost - 0.01) { spots = [...candidate]; quality = q; return true; }
      return false;
    };
    const moveTo = (i: number, p: Spot) => {
      if (!allowed(i, p) || p.left === spots[i]!.left && p.top === spots[i]!.top || !clearOf(ctx, i, p, spots)) return false;
      const candidate = [...spots]; candidate[i] = p;
      return tryCandidate(candidate);
    };
    const order = sorted.map((_, i) => i).filter((i) => movable[i]).sort((a, b) => degree[b]! - degree[a]! || a - b);
    /** Where `i` would stand touching `j` in direction `angle`: a binary search along the ray. */
    const contact = (i: number, j: number, angle: number): Spot | undefined => {
      const cj = centreOf(j, spots[j]!), ux = Math.cos(angle), uy = Math.sin(angle);
      const at = (t: number) => originAt(i, { x: cj.x + ux * t, y: cj.y + uy * t });
      let low = 0, high = 4000;
      if (intrusion(ctx, i, at(high), j, spots[j]!) > 0) return undefined;
      for (let step = 0; step < 14; step++) { const middle = (low + high) / 2; if (intrusion(ctx, i, at(middle), j, spots[j]!) > 0) low = middle; else high = middle; }
      for (let nudge = 0; nudge < 4; nudge++) {
        const candidate = snap(ctx, i, at(high + nudge * 16));
        if (intrusion(ctx, i, candidate, j, spots[j]!) <= 0) return candidate;
      }
      return undefined;
    };
    for (let pass = 0; pass < 3 && evaluations < limit; pass++) {
      const startCost = quality.cost;
      // Relocate beside the weighted neighbourhood: the barycentre's nearest clear spot.
      for (const i of order) {
        const around = neighbours[i]!;
        if (!around.length) continue;
        let x = 0, y = 0, total = 0;
        for (const { other, strength } of around) { const c = centreOf(other, spots[other]!); x += c.x * strength; y += c.y * strength; total += strength; }
        const others = spots.map((p, j) => j === i ? undefined : p);
        moveTo(i, nearestClear(ctx, i, originAt(i, { x: x / total, y: y / total }), others));
      }
      if (quick) break;
      // Dock against the strongest partner from eight directions, smallest islands first.
      for (const i of [...order].reverse()) for (const { other } of neighbours[i]!.slice(0, 1)) {
        for (let k = 0; k < 8; k++) { const p = contact(i, other, k * Math.PI / 4); if (p) moveTo(i, p); }
      }
      // Exchange two islands' places.
      for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
        if (evaluations >= limit) break;
        const i = order[a]!, j = order[b]!;
        const settled = spots.map((p, k) => k === i || k === j ? undefined : p);
        const [first, second] = mass[i]! >= mass[j]! ? [i, j] : [j, i];
        settled[first] = nearestClear(ctx, first, originAt(first, centreOf(second, spots[second]!)), settled);
        settled[second] = nearestClear(ctx, second, originAt(second, centreOf(first, spots[first]!)), settled);
        if (allowed(i, settled[i]!) && allowed(j, settled[j]!)) tryCandidate(settled as Spot[]);
      }
      // Translate along the lattice: diagonals follow the ground grid.
      for (const step of steps) for (const i of order) for (const [dl, dt] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
        moveTo(i, { left: spots[i]!.left + dl * step, top: spots[i]!.top + dt * step });
      }
      if (quality.cost >= startCost - 0.01) break;
    }
    return { spots, quality };
  };

  /** Fresh arrangements from structure alone, best first after refinement. */
  const solveGlobally = () => {
    const titleUnits = ctx.titles.map((t) => (t.x1 - t.x0) / UNIT_X);
    const radius = shapes.map((shape, i) => ((shape.body.x1 - shape.body.x0) / UNIT_X + (shape.body.y1 - shape.body.y0) / UNIT_Y) / 4 + titleUnits[i]! / 4);
    // Islands of one kind keep a light mutual attraction, so they read as a group.
    const strongest = Math.max(1, ...bundles.map((link) => link.strength));
    const cohesion: StressLink[] = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (sorted[a]!.group && sorted[a]!.group === sorted[b]!.group) cohesion.push({ a, b, strength: strongest * 0.15 });
    const graphOf = stressGraph(radius, [...bundles, ...cohesion], ISLAND_CLEARANCE / UNIT_Y);
    const flows = (graph.flows ?? []).flatMap((flow) => {
      const a = sorted.findIndex((island) => island.id === flow.from), b = sorted.findIndex((island) => island.id === flow.to);
      return a < 0 || b < 0 || a === b ? [] : [{ a, b, weight: flow.weight }];
    });
    const centreUnits = shapes.map((shape) => ({ x: shape.centre.x / UNIT_X, y: shape.centre.y / UNIT_Y }));
    /** Stress in a stretched frame, overlap projection in the real one. */
    const solve = (free: readonly Point[], sx: number, sy: number): Spot[] => {
      // Pinned islands start, and stay, at their pins; the rest keep their shape around them.
      const pinCentre = (i: number) => ({ x: pins[i]!.left + centreUnits[i]!.x, y: pins[i]!.top + centreUnits[i]!.y });
      const held = free.flatMap((p, i) => pinned[i] ? [{ p, pin: pinCentre(i) }] : []);
      const dx = held.length ? held.reduce((sum, { p, pin }) => sum + pin.x - p.x, 0) / held.length : 0;
      const dy = held.length ? held.reduce((sum, { p, pin }) => sum + pin.y - p.y, 0) / held.length : 0;
      const start = free.map((p, i) => pinned[i] ? pinCentre(i) : { x: p.x + dx, y: p.y + dy });
      const origins = (points: readonly Point[]) => points.map((c, i) => pinned[i] ? pins[i]! : { left: c.x * sx - centreUnits[i]!.x, top: c.y * sy - centreUnits[i]!.y });
      const project = (points: Point[], iteration: number) => {
        if (iteration < 20) return;
        const spots = origins(points);
        separate(ctx, spots, mass, 2);
        for (const [i, p] of spots.entries()) points[i] = { x: (p.left + centreUnits[i]!.x) / sx, y: (p.top + centreUnits[i]!.y) / sy };
      };
      const solved = majorize(graphOf, start.map((p) => ({ x: p.x / sx, y: p.y / sy })), { iterations: 60, fixed: pinned, project });
      const spots = origins(solved);
      separate(ctx, spots, mass, 200);
      return legalize(ctx, spots, heavyFirst, pinned);
    };
    const candidates: Spot[][] = [seed];
    const withCompaction = (spots: Spot[]) => {
      const compacted = [...spots];
      compact(ctx, compacted, massCentre(compacted), pinned.map((fixed) => !fixed));
      candidates.push(spots, compacted);
    };
    // Classical scaling, oriented for reading direction, horizontal bundles and the workspace.
    const mds = classicalScaling(graphOf);
    const orientations: { points: Point[]; score: number; sx: number; sy: number }[] = [];
    for (let k = 0; k < 12; k++) for (const mirror of [false, true]) {
      const angle = k * Math.PI / 6, cos = Math.cos(angle), sin = Math.sin(angle);
      const points = mds.map((p) => { const y = mirror ? -p.y : p.y; return { x: p.x * cos - y * sin, y: p.x * sin + y * cos }; });
      let along = 0, span = 0, vertical = 0, heavy = 0;
      for (const { a, b, weight } of flows) { const dx = (points[b]!.x - points[a]!.x) * UNIT_X, dy = (points[b]!.y - points[a]!.y) * UNIT_Y; along += weight * dx; span += weight * Math.hypot(dx, dy); }
      for (const { a, b, strength } of bundles) { const dx = (points[b]!.x - points[a]!.x) * UNIT_X, dy = (points[b]!.y - points[a]!.y) * UNIT_Y; vertical += strength * dy * dy / Math.max(1e-9, dx * dx + dy * dy); heavy += strength; }
      const xs = points.map((p, i) => [p.x - radius[i]!, p.x + radius[i]!]).flat(), ys = points.map((p, i) => [p.y - radius[i]!, p.y + radius[i]!]).flat();
      const ratio = (Math.max(...xs) - Math.min(...xs)) * UNIT_X / Math.max(1, (Math.max(...ys) - Math.min(...ys)) * UNIT_Y);
      const stretch = Math.max(0.7, Math.min(1.45, Math.sqrt(aspect / ratio)));
      const score = (span ? 1 - along / span : 1) + (heavy ? 0.6 * vertical / heavy : 0) + 0.3 * Math.abs(Math.log(ratio / aspect));
      orientations.push({ points, score, sx: stretch, sy: 1 / stretch });
    }
    orientations.sort((a, b) => a.score - b.score);
    // Very large maps keep only the best orientation: each solve is quadratic in islands.
    for (const orientation of orientations.slice(0, n > 24 ? 1 : 3)) withCompaction(solve(orientation.points, orientation.sx, orientation.sy));
    // The semantic packer's arrangement, relaxed by the same stress.
    withCompaction(solve(seed.map((p, i) => ({ x: p.left + centreUnits[i]!.x, y: p.top + centreUnits[i]!.y })), 1, 1));
    // Every candidate first takes its cheapest, most effective improvement (each island beside
    // its neighbours), so the choice between them compares settled arrangements.
    const movable = pinned.map((fixed) => !fixed);
    const seedQuality = evaluate(seed) ?? before;
    const polished: { spots: Spot[]; quality: LayoutQuality }[] = [{ spots: seed, quality: seedQuality }];
    for (const candidate of candidates.slice(1)) {
      const q = evaluate(candidate);
      if (!q) break;
      polished.push(refine(candidate, q, movable, [], undefined, true));
    }
    polished.sort((a, b) => a.quality.cost - b.quality.cost);
    // Refining a second start measured no better across varied architectures: the moves converge.
    return refine(polished[0]!.spots, polished[0]!.quality, movable, [8, 4, 2, 1]);
  };

  if (!old.size || !sorted.some((island) => old.has(island.id))) {
    const { spots, quality } = solveGlobally();
    return finish(spots, quality, "global");
  }

  // -------------------------------------------------------------------------
  // Incremental: keep what did not change, make room for what grew, slot in what is new
  // -------------------------------------------------------------------------
  const prints = settings.previousFingerprints;
  const isNew = sorted.map((island) => !old.has(island.id));
  const resized = sorted.map((island, i) => !isNew[i] && prints?.[island.id] !== undefined && prints[island.id]!.size !== island.size);
  const relinked = sorted.map((island, i) => !isNew[i] && prints?.[island.id] !== undefined && prints[island.id]!.links !== fingerprints[island.id]!.links);
  const removed = [...old.keys()].filter((id) => !sorted.some((island) => island.id === id)).length;
  // How much the arrangement's ingredients changed: whole islands added or removed, plus each
  // resize as a fraction of the island. A column of new services is a small fraction.
  const change = isNew.filter(Boolean).length + removed + sorted.reduce((sum, island, i) => sum + (resized[i] ? Math.abs(island.size - prints![island.id]!.size) / island.size : 0), 0);
  const structural = change >= Math.max(2, n / 4);
  // Remembered islands start where they were; a resized one keeps its centre, not its corner.
  const wish: Spot[] = sorted.map((island, i) => {
    const p = pins[i] ?? old.get(island.id);
    if (!p || pins[i]) return p ?? { left: 0, top: 0 };
    const shift = (prints?.[island.id]?.size ?? island.size) - island.size;
    return { left: p.left + shift / 2, top: p.top + shift / 2 };
  });
  // Make room: where a resize or a longer title brought islands together, they part along the
  // shortest way out. A resized island holds its ground; the others give way by size.
  const roomMass = sorted.map((island, i) => pinned[i] ? Infinity : island.size ** 2 * (resized[i] ? 4 : 1));
  separate(ctx, wish, roomMass, 200, isNew);
  const existingOrder = heavyFirst.filter((i) => !isNew[i]);
  const settled: (Spot | undefined)[] = legalize(ctx, wish.map((p, i) => snap(ctx, i, p)), existingOrder, pinned).map((p, i) => isNew[i] ? undefined : p);
  // A new island takes the nearest clear spot to the weighted centre of its placed neighbours.
  for (const i of heavyFirst.filter((k) => isNew[k] && !pinned[k])) {
    const around = neighbours[i]!.filter(({ other }) => settled[other]);
    let target: Point;
    if (around.length) {
      let x = 0, y = 0, total = 0;
      for (const { other, strength } of around) { const c = centreOf(other, settled[other]!); x += c.x * strength; y += c.y * strength; total += strength; }
      target = { x: x / total, y: y / total };
    } else {
      // Unconnected: beside the arrangement, level with its middle.
      const bodies = settled.flatMap((p, j) => p ? [shiftDop(shapes[j]!.body, p.left * UNIT_X, p.top * UNIT_Y)] : []);
      target = bodies.length
        ? { x: Math.max(...bodies.map((d) => d.x1)) + ISLAND_CLEARANCE + (shapes[i]!.body.x1 - shapes[i]!.body.x0) / 2, y: (Math.min(...bodies.map((d) => d.y0)) + Math.max(...bodies.map((d) => d.y1))) / 2 }
        : { x: 0, y: 0 };
    }
    settled[i] = nearestClear(ctx, i, originAt(i, target), settled);
  }
  for (const i of heavyFirst) if (!settled[i]) settled[i] = pins[i]!;
  const placed = settled as Spot[];
  // Refine only the changed neighbourhood. New islands roam; changed ones and the neighbours of
  // anything new or resized adjust within a short reach of where they settled.
  const disturbed = sorted.map((_, i) => isNew[i] || resized[i]);
  const movable = sorted.map((_, i) => !pinned[i] && (disturbed[i] || relinked[i] || neighbours[i]!.some(({ other }) => disturbed[other])));
  const reach = (i: number, p: Spot) => isNew[i] || Math.hypot((p.left - placed[i]!.left) * UNIT_X, (p.top - placed[i]!.top) * UNIT_Y) <= (disturbed[i] ? 192 : 96);
  // A broad edit keeps budget back for comparing a fresh solve.
  limit = structural ? Math.max(1, Math.floor(budget / 3)) : budget;
  const startQuality = evaluate(placed) ?? scored(placed);
  const local = movable.some(Boolean) ? refine(placed, startQuality, movable, [4, 2, 1], reach) : { spots: placed, quality: startQuality };
  limit = budget;
  if (!structural || evaluations >= budget) return finish(local.spots, local.quality, "incremental");
  // A fresh solve replaces the edit only when it is substantially better, translated so the
  // remembered islands keep their centre and the camera's view of the map stays put.
  const global = solveGlobally();
  const anchor = (spots: readonly Spot[]) => {
    let x = 0, y = 0, count = 0;
    for (const [i, p] of spots.entries()) if (!isNew[i]) { const c = centreOf(i, p); x += c.x; y += c.y; count++; }
    return { x: x / Math.max(1, count), y: y / Math.max(1, count) };
  };
  const from = anchor(global.spots), to = anchor(placed);
  let dl = Math.round((to.x - from.x) / UNIT_X);
  const dt = Math.round((to.y - from.y) / UNIT_Y);
  if ((dl + dt) % 2) dl += 1;
  const shifted = pinned.some(Boolean) ? global.spots : global.spots.map((p) => ({ left: p.left + dl, top: p.top + dt }));
  const alignedQuality = scored(shifted);
  return alignedQuality.cost < local.quality.cost * 0.8 ? finish(shifted, alignedQuality, "global") : finish(local.spots, local.quality, "incremental");
}
