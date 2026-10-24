import { layoutIslands, titleRoom, type IslandFootprint, type IslandPosition } from "./layout";
import type { LayoutGraph, LayoutLink } from "./layout-graph";
import { layoutObstacles, measureLayout, type LayoutQuality } from "./layout-quality";
import { intersects, type Obstacle } from "./layout-geometry";

export interface LayoutSettings { readonly aspect?: number; readonly previous?: readonly IslandPosition[]; readonly previousKey?: string; readonly pins?: Readonly<Record<string, IslandPosition>>; readonly budget?: number }
export interface LayoutResult { readonly positions: readonly IslandPosition[]; readonly before: LayoutQuality; readonly after: LayoutQuality; readonly evaluations: number; readonly key: string; readonly topologyKey: string }
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
/** Dependency layers with cycles kept together: reachability gives SCCs without
 * mutating or reversing the application's actual relationships. Island graphs are small. */
function layerOrder(islands: readonly IslandFootprint[], graph: LayoutGraph): readonly string[] {
  const ids = islands.map((item) => item.id).sort();
  const outgoing = new Map(ids.map((id) => [id, graph.islands.filter((edge) => edge.from === id)]));
  const incoming = new Map(ids.map((id) => [id, graph.islands.filter((edge) => edge.to === id)]));
  const reach = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const id of ids) {
    const todo = [id];
    while (todo.length) { const from = todo.pop()!; for (const edge of outgoing.get(from) ?? []) if (!reach.get(id)!.has(edge.to)) { reach.get(id)!.add(edge.to); todo.push(edge.to); } }
  }
  const component = new Map(ids.map((id) => [id, ids.find((other) => other === id || reach.get(id)!.has(other) && reach.get(other)!.has(id))!]));
  const ranks = new Map(ids.map((id) => [component.get(id)!, 0]));
  for (let pass = 0; pass < ids.length; pass++) for (const edge of graph.islands) {
    const a = component.get(edge.from)!, b = component.get(edge.to)!;
    if (a !== b) ranks.set(b, Math.max(ranks.get(b)!, ranks.get(a)! + 1));
  }
  let order = [...ids].sort((a, b) => ranks.get(component.get(a)!)! - ranks.get(component.get(b)!)! || (a < b ? -1 : 1));
  for (let pass = 0; pass < 4; pass++) {
    const index = new Map(order.map((id, at) => [id, at]));
    const bary = (id: string) => { const edges = (pass % 2 ? outgoing : incoming).get(id)!; const weight = edges.reduce((sum, e) => sum + e.weight, 0); return weight ? edges.reduce((sum, e) => sum + index.get(pass % 2 ? e.to : e.from)! * e.weight, 0) / weight : index.get(id)!; };
    order = [...order].sort((a, b) => ranks.get(component.get(a)!)! - ranks.get(component.get(b)!)! || bary(a) - bary(b) || index.get(a)! - index.get(b)!);
  }
  return order;
}
function preferences(islands: readonly IslandFootprint[], positions: readonly IslandPosition[]): boolean {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const sizes = new Map(islands.map((item) => [item.id, item.size]));
  const env = byId.get("island:environment"), input = byId.get("island:inputs");
  if (env && input && env.left + sizes.get(env.id)! + titleRoom(islands.find((item) => item.id === input.id)!.title) - 1 > input.left) return false;
  if (env && input && Math.abs(env.top + sizes.get(env.id)! / 2 - input.top - sizes.get(input.id)! / 2) > 1) return false;
  const left = islands.filter((item) => item.id === "island:inputs" || item.region === "entry" || item.id === "island:environment");
  for (const network of islands.filter((item) => item.region === "network")) for (const item of left) if (byId.get(network.id)!.left < byId.get(item.id)!.left + item.size) return false;
  const workflow = byId.get("island:orchestration"), stacks = byId.get("island:stacks");
  if (workflow && stacks && !(workflow.left < stacks.left)) return false;
  return true;
}
const cache = new Map<string, LayoutResult>();
/** The semantic packer measures terrain size. Repair its seed against actual
 * projected headroom/foundations before refinement, including very large islands.
 * Keep the environment/input pair together and reserve pinned groups first. */
function clearanceSeed(islands: readonly IslandFootprint[], positions: readonly IslandPosition[], pins: LayoutSettings["pins"]): IslandPosition[] {
  const groups = new Map<string, IslandPosition[]>();
  for (const position of positions) {
    const key = ["island:environment", "island:inputs"].includes(position.id) ? "environment-inputs" : position.id;
    const group = groups.get(key) ?? []; group.push(position); groups.set(key, group);
  }
  const fixed = (group: readonly IslandPosition[]) => group.some((p) => pins?.[p.id]);
  const ordered = [...groups.values()].sort((a, b) => Number(fixed(b)) - Number(fixed(a)) || Math.min(...a.map((p) => p.top)) - Math.min(...b.map((p) => p.top)) || a[0]!.id.localeCompare(b[0]!.id));
  const placed: Obstacle[] = [], result: IslandPosition[] = [];
  for (const original of ordered) {
    let group = original;
    const members = islands.filter((island) => group.some((p) => p.id === island.id));
    for (let pass = 0; !fixed(group) && pass <= positions.length; pass++) {
      const current = layoutObstacles(members, group);
      let shift = 0;
      for (const item of current) for (const other of placed) if (intersects(item.bounds, other.bounds, 12)) shift = Math.max(shift, other.bounds.maxY + 13 - item.bounds.minY);
      if (!shift) break;
      group = group.map((p) => ({ ...p, top: p.top + Math.ceil(shift / 16) }));
    }
    placed.push(...layoutObstacles(members, group)); result.push(...group);
  }
  return positions.map((p) => result.find((item) => item.id === p.id)!);
}
export function optimizeLayout(islands: readonly IslandFootprint[], graph: LayoutGraph, settings: LayoutSettings = {}): LayoutResult {
  const aspect = settings.aspect ?? 16 / 9;
  const sorted = [...islands].sort((a, b) => a.id < b.id ? -1 : 1);
  const topologyKey = JSON.stringify([sorted, graph.signature, aspect, settings.pins, settings.budget]);
  const key = JSON.stringify([topologyKey, settings.previous, settings.previousKey]);
  const hit = cache.get(key); if (hit) return hit;
  const baseline = clearanceSeed(sorted, layoutIslands(sorted).map((p) => settings.pins?.[p.id] ?? p), settings.pins);
  const proxy = proxyGraph(graph);
  const previous = settings.previous ?? (aspect >= 1.15 ? baseline : undefined);
  const before = measureLayout(islands, proxy, baseline, aspect, previous);
  const old = new Map(settings.previous?.map((p) => [p.id, p]) ?? []);
  const evaluate = (candidate: readonly IslandPosition[]) => { const q = measureLayout(islands, proxy, candidate, aspect, previous); return settings.previous ? { ...q, cost: q.cost + q.movement * 17 } : q; };
  let best = baseline.map((p) => settings.pins?.[p.id] ?? old.get(p.id) ?? p), quality = evaluate(best), evaluations = 1;
  const localEdit = old.size === islands.length && old.size > 0 && quality.islandOverlaps === 0;
  if (settings.previousKey === topologyKey && settings.previous?.length === islands.length) {
    const after = measureLayout(islands, proxy, settings.previous, aspect, settings.previous);
    return { positions: settings.previous, before, after, evaluations: 0, key, topologyKey };
  }
  const budget = settings.budget ?? (islands.length > 24 ? 90 : 360);
  const needsFallback = quality.islandOverlaps > 0;
  const consider = (candidate: readonly IslandPosition[]) => {
    // Reserve a final evaluation to repair an infeasible incremental packing.
    if (evaluations >= budget - (needsFallback ? 1 : 0)) return;
    if (!preferences(islands, candidate)) return;
    if (localEdit && candidate.some((p) => { const before = old.get(p.id); return !settings.pins?.[p.id] && before && Math.hypot((p.left - before.left) * 32, (p.top - before.top) * 16) > 128; })) return;
    for (const p of candidate) if (settings.pins?.[p.id] && (p.left !== settings.pins[p.id]!.left || p.top !== settings.pins[p.id]!.top)) return;
    evaluations++;
    const q = evaluate(candidate);
    if (q.cost < quality.cost - 0.01) { best = [...candidate]; quality = q; }
  };
  if (old.size) consider(best.map((p) => settings.pins?.[p.id] ?? old.get(p.id) ?? p));
  const centreScale = Math.max(0.6, Math.min(3, before.aspect / aspect));
  if (!old.size && Math.abs(centreScale - 1) > 0.15) {
    // Gateway aggregation can make the API island much smaller. Repair the
    // monitor-shaped seed's clearance after scaling instead of discarding an
    // otherwise useful arrangement because fixed-size islands now overlap.
    const scaled = baseline.map((p) => { const size = islands.find((item) => item.id === p.id)!.size; return { ...p, top: Math.round((p.top + size / 2) * centreScale - size / 2) }; });
    consider(clearanceSeed(sorted, scaled, settings.pins));
  }
  const order = layerOrder(sorted, graph);
  // A dependency-ordered, multi-row seed complements the semantic seed. Aspect
  // controls columns; constraints decide whether this alternative is admissible.
  for (const columns of old.size ? [] : [Math.max(2, Math.round(Math.sqrt(islands.length * aspect / 2))), 3]) {
    let x = 0, y = 0, rowHeight = 0;
    const seed: IslandPosition[] = [];
    for (const [at, id] of order.entries()) { const item = islands.find((island) => island.id === id)!; if (at && at % columns === 0) { x = 0; y += rowHeight + 10; rowHeight = 0; } seed.push({ id, left: x, top: y }); x += item.size + 16; rowHeight = Math.max(rowHeight, item.size); }
    consider(seed);
  }
  for (const step of old.size && !quality.islandOverlaps ? [3, 1] : [12, 6, 3, 1]) {
    for (const id of order) {
      if (settings.pins?.[id] || evaluations >= budget) continue;
      const anchor = best.find((p) => p.id === id)!;
      for (const [dx, dy] of [[0, -step], [0, step], [-step, 0], [step, 0], [-step, -step], [step, step]]) consider(best.map((p) => p.id === id ? { ...p, left: Math.round(anchor.left + dx), top: Math.round(anchor.top + dy) } : dy && ["island:environment", "island:inputs"].includes(id) && ["island:environment", "island:inputs"].includes(p.id) ? { ...p, top: p.top + dy } : p));
      // Barycentric pull toward heavily connected neighbours, with collision checks.
      const incident = graph.islands.filter((e) => e.from === id || e.to === id);
      const weight = incident.reduce((sum, e) => sum + e.weight, 0);
      if (weight) {
        const target = incident.reduce((sum, e) => sum + best.find((p) => p.id === (e.from === id ? e.to : e.from))!.top * e.weight, 0) / weight;
        consider(best.map((p) => p.id === id ? { ...p, top: Math.round(target) } : p));
      }
    }
    for (let a = 0; a < best.length && evaluations < budget; a++) for (let b = a + 1; b < best.length && evaluations < budget; b++) {
      const one = best[a]!, two = best[b]!;
      consider(best.map((p) => p.id === one.id ? { ...p, left: two.left, top: two.top } : p.id === two.id ? { ...p, left: one.left, top: one.top } : p));
    }
  }
  // A large footprint edit can make the old arrangement infeasible. Prefer a
  // valid fresh packing over preserving an overlap that local moves cannot repair.
  if (quality.islandOverlaps) {
    const fallback = baseline.map((p) => settings.pins?.[p.id] ?? p);
    const q = evaluate(fallback);
    evaluations++;
    if (q.cost < quality.cost) { best = fallback; quality = q; }
  }
  const result = { positions: best, before, after: quality, evaluations, key, topologyKey };
  if (cache.size >= 24) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
