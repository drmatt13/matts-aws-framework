import assert from "./support/assert";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import type { ModelEdge, ModeModel, NetworkModel } from "../shared/model";
import { buildScene } from "../src/scene/build";
import { extractLayoutGraph, type LayoutAnchor } from "../src/scene/layout-graph";
import { optimizeLayout, type LayoutSettings } from "../src/scene/layout-optimize";
import type { IslandFootprint, IslandPosition } from "../src/scene/layout";
import { layoutFrame, measureLayout } from "../src/scene/layout-quality";
import { depth, dopOf, ISLAND_CLEARANCE, islandShape, penetration, segmentHitsDop, separation, shiftDop, UNIT_X, UNIT_Y } from "../src/scene/layout-shape";
import { classicalScaling, majorize, stress, stressGraph } from "../src/scene/layout-stress";
import { islandSlabs } from "../src/scene/slabs";
import { graphFixture } from "../scripts/support/graph-fixture";

/** Reproducible pseudo-random numbers: every architecture below is the same on every run. */
function random(seed: number) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
}
const RELATIONS = ["routes", "grant", "env", "database", "step", "usesTool"] as const;
/** A synthetic architecture: measured islands with real terrain, attachments where buildings stand, and links. */
function architecture(seed: number, count: number, density = 1.6) {
  const next = random(seed);
  const regions = ["entry", "compute", "network", "agents", "orchestration", "catalog"] as const;
  const islands: IslandFootprint[] = Array.from({ length: count }, (_, at) => {
    const width = 6 + 2 * Math.floor(next() * 8), length = 6 + 2 * Math.floor(next() * 6), top = 1 + Math.floor(next() * 4);
    const region = regions[at % regions.length]!;
    return { id: `island:${seed}-${at}`, title: `Island ${at} ${"x".repeat(Math.floor(next() * 14))}`, region, size: width + length,
      ground: { width, length, inset: 0, top, base: top - 3 }, ...(region === "network" ? { group: "network" } : {}) };
  });
  const anchors: LayoutAnchor[] = islands.flatMap((island) => Array.from({ length: 1 + Math.floor(next() * 3) }, (_, k) => {
    const { width, length, top } = island.ground!;
    const lx = 1 + Math.floor(next() * Math.max(1, width - 3)), ly = 1 + Math.floor(next() * Math.max(1, length - 3));
    return { id: `${island.id}/node-${k}`, island: island.id, h: top + 3, x: (length + lx - ly) * UNIT_X, y: (2 + lx + ly) * UNIT_Y - top * 16 - 54 };
  }));
  const edges: ModelEdge[] = [];
  for (let at = 0; at < Math.round(count * density); at++) {
    const from = anchors[Math.floor(next() * anchors.length)]!, to = anchors[Math.floor(next() * anchors.length)]!;
    if (from.island === to.island) continue;
    edges.push({ id: `edge:${seed}:${at}`, from: from.id, to: to.id, relation: RELATIONS[Math.floor(next() * RELATIONS.length)]!, label: "fixture", provenance: "declared" });
  }
  return { islands, anchors, edges, graph: extractLayoutGraph(anchors, edges) };
}
const placed = (islands: readonly IslandFootprint[], positions: readonly IslandPosition[]) => layoutFrame(islands, islands.map(islandShape), positions, 16 / 9);
const centre = (frame: ReturnType<typeof placed>, at: number) => { const d = frame.bodies[at]!; return { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 }; };
const by = (positions: readonly IslandPosition[]) => new Map(positions.map((p) => [p.id, p]));

test("an island's placement envelope covers everything the renderer paints for it, and little else", () => {
  const network: NetworkModel = { id: "edge", name: "edge", constructId: "Edge", cidr: "10.4.0.0/16", zones: 2, egressOnlyInternetGateway: true, natGateway: true,
    gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["sqs", "sns", "ecr.api"], builtInProd: true, monthlyCost: { natGateway: 32, interfaceEndpoints: 21 },
    subnets: (["public", "private", "isolated"] as const).map((name) => ({ name, egress: { ipv4: name !== "isolated", ipv6: name !== "isolated" } })) };
  const base = graphFixture(40);
  const model: ModeModel = { ...base, networks: [network], targets: base.targets.map((target, at) => at % 3 ? target : { ...target, placement: { kind: "vpc", networkId: "edge", subnet: (["public", "private", "isolated"] as const)[at % 3]!, reason: "fixture", egress: { ipv4: true, ipv6: true }, dualStack: true } }) };
  const scene = buildScene(model);
  assert.ok(scene.islands.some((island) => island.region === "network"), "the fixture exercises a VPC foundation");
  const positions = by(scene.layout.positions);
  for (const slab of islandSlabs(scene)) {
    const footprint = scene.layout.footprints.find((item) => item.id === slab.island.id)!, p = positions.get(footprint.id)!;
    const body = shiftDop(islandShape(footprint).body, p.left * UNIT_X, p.top * UNIT_Y);
    const painted = [...slab.bands.flatMap((band) => [band.top, ...band.walls.map((wall) => wall.quad)]),
      ...scene.frames.filter((frame) => frame.members.includes(footprint.id)).flatMap((frame) => [frame.geometry.top, frame.geometry.left, frame.geometry.right])].flat();
    const points = painted.flatMap((_, at) => at % 2 ? [] : [{ x: painted[at]!, y: painted[at + 1]! }]);
    const hull = dopOf(points);
    // Containment, with a pixel of tolerance for floating-point projection.
    for (const side of ["x0", "y0", "a0", "b0"] as const) assert.ok(hull[side] >= body[side] - 1, `${footprint.id} paints beyond ${side}`);
    for (const side of ["x1", "y1", "a1", "b1"] as const) assert.ok(hull[side] <= body[side] + 1, `${footprint.id} paints beyond ${side}`);
    // Tightness: only chamfers and building headroom separate the envelope from the paint.
    assert.ok(hull.x0 - body.x0 <= 2 * UNIT_X && body.x1 - hull.x1 <= 2 * UNIT_X, `${footprint.id} envelope is tight across`);
    assert.ok(body.y1 - hull.y1 <= 2 * UNIT_Y, `${footprint.id} envelope is tight below`);
    assert.equal(slab.island.gx0 - slab.island.gy0, Math.round(p.left + footprint.ground!.inset + footprint.ground!.length), `${footprint.id} lands exactly on its evaluated origin`);
  }
});

test("geometry primitives: penetration separates, depth agrees, segments and gaps are exact", () => {
  const a = dopOf([{ x: 0, y: 50 }, { x: 100, y: 0 }, { x: 200, y: 50 }, { x: 100, y: 100 }]);
  const b = shiftDop(a, 150, 10);
  const push = penetration(a, b, 10);
  assert.ok(push.depth > 0);
  assert.equal(depth(a, 0, 0, a, 150, 10, 10), push.depth);
  const moved = shiftDop(b, push.x * (push.depth + 0.01), push.y * (push.depth + 0.01));
  assert.equal(depth(a, 0, 0, moved, 0, 0, 10), 0, "the minimum translation clears the gap");
  assert.ok(Math.abs(separation(a, moved) - 10) < 0.1, "and leaves exactly the gap");
  assert.equal(separation(a, b), 0);
  assert.equal(segmentHitsDop(a, -50, 50, 250, 50), true, "a segment through the middle hits");
  assert.equal(segmentHitsDop(a, -50, -10, 250, -10), false, "a segment above misses");
  assert.equal(segmentHitsDop(a, 10, 0, 0, 10), false, "a segment across the empty corner of the box misses the diamond");
});

test("stress majorization recovers a known arrangement and only lowers stress", () => {
  // Four islands on a square: links along its sides and one diagonal.
  const radius = [2, 2, 2, 2];
  const graph = stressGraph(radius, [{ a: 0, b: 1, strength: 1 }, { a: 1, b: 2, strength: 1 }, { a: 2, b: 3, strength: 1 }, { a: 3, b: 0, strength: 1 }], 1);
  const start = classicalScaling(graph);
  const solved = majorize(graph, start, { iterations: 80 });
  assert.ok(stress(graph, solved) <= stress(graph, start) + 1e-9);
  const side = graph.distance[1]!;
  const length = (i: number, j: number) => Math.hypot(solved[i]!.x - solved[j]!.x, solved[i]!.y - solved[j]!.y);
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0]] as const) assert.ok(Math.abs(length(i, j) - side) < side * 0.15, "linked islands sit near their ideal distance");
  const fixed = majorize(graph, start, { iterations: 40, fixed: [true, false, false, false] });
  assert.deepEqual(fixed[0], start[0], "fixed islands never move");
});

test("placement keeps every pair of islands a full clearance apart, on the exact lattice, with every title clear", () => {
  for (let seed = 1; seed <= 24; seed++) {
    const { islands, graph } = architecture(seed, 3 + seed % 12);
    const result = optimizeLayout(islands, graph, { aspect: [16 / 9, 0.9, 2.5][seed % 3] });
    const frame = placed(islands, result.positions);
    for (let i = 0; i < islands.length; i++) for (let j = i + 1; j < islands.length; j++) {
      assert.ok(separation(frame.bodies[i]!, frame.bodies[j]!) >= ISLAND_CLEARANCE - 1e-6, `seed ${seed}: ${islands[i]!.id} keeps its clearance from ${islands[j]!.id}`);
    }
    assert.equal(result.after.islandOverlaps, 0);
    assert.equal(result.after.labelOverlaps, 0, `seed ${seed}: titles clear`);
    for (const p of result.positions) {
      const length = islands.find((island) => island.id === p.id)!.ground!.length;
      assert.ok(Number.isInteger(p.left) && Number.isInteger(p.top) && (p.left + p.top + length) % 2 === 0, "origins need no rounding when terrain is placed");
    }
    assert.deepEqual(result.positions.map((p) => p.id).sort(), islands.map((island) => island.id).sort(), "every island placed exactly once");
  }
});

test("placement is deterministic and independent of declaration order", () => {
  const { islands, graph } = architecture(99, 10);
  const first = optimizeLayout(islands, graph);
  // A distinct (but equivalent) settings key bypasses the result cache, forcing a fresh solve.
  const again = optimizeLayout([...islands].reverse(), graph, { pins: {} });
  assert.deepEqual(again.positions, first.positions);
  assert.equal(again.evaluations, first.evaluations);
});

test("layout quality improves on the semantic seed across reproducible random architectures", () => {
  let before = 0, after = 0, lengthBefore = 0, lengthAfter = 0;
  for (let seed = 200; seed < 230; seed++) {
    const { islands, graph } = architecture(seed, 4 + seed % 10, 2.5);
    const result = optimizeLayout(islands, graph);
    assert.ok(result.after.cost <= result.before.cost, `seed ${seed} never ends worse than its seed`);
    const seedQuality = measureLayout(islands, graph, optimizeLayout(islands, graph, { budget: 1 }).positions);
    const finalQuality = measureLayout(islands, graph, result.positions);
    before += seedQuality.weightedCrossings; after += finalQuality.weightedCrossings;
    lengthBefore += seedQuality.length; lengthAfter += finalQuality.length;
  }
  assert.ok(after < before * 0.6, `weighted crossings ${before} -> ${after}`);
  assert.ok(lengthAfter < lengthBefore * 0.8, `weighted length ${lengthBefore} -> ${lengthAfter}`);
});

test("islands of one architectural group settle near one another", () => {
  let grouped = 0, groupedPairs = 0, other = 0, otherPairs = 0;
  for (let seed = 300; seed < 310; seed++) {
    const { islands, graph } = architecture(seed, 12, 1);
    const frame = placed(islands, optimizeLayout(islands, graph).positions);
    const linked = new Set(graph.islands.flatMap((link) => [`${link.from}|${link.to}`, `${link.to}|${link.from}`]));
    for (let i = 0; i < islands.length; i++) for (let j = i + 1; j < islands.length; j++) {
      const gap = separation(frame.bodies[i]!, frame.bodies[j]!);
      if (islands[i]!.group && islands[i]!.group === islands[j]!.group) { grouped += gap; groupedPairs++; }
      else if (!linked.has(`${islands[i]!.id}|${islands[j]!.id}`)) { other += gap; otherPairs++; }
    }
  }
  assert.ok(grouped / groupedPairs < other / otherPairs, `group members sit closer (${Math.round(grouped / groupedPairs)} px) than unrelated islands (${Math.round(other / otherPairs)} px)`);
});

/** What a view passes on its next layout: the previous result's memory. */
const remembered = (result: ReturnType<typeof optimizeLayout>): LayoutSettings => ({ previous: result.positions, previousKey: result.topologyKey, previousFingerprints: result.fingerprints });

test("a new island slots into a clear spot beside its neighbours without moving any other island", () => {
  const { islands, anchors, edges } = architecture(41, 9);
  const initial = optimizeLayout(islands, extractLayoutGraph(anchors, edges));
  const added: IslandFootprint = { id: "island:added", title: "Added", region: "compute", size: 16, ground: { width: 10, length: 6, inset: 0, top: 3, base: 0 } };
  const anchor: LayoutAnchor = { id: "added/node", island: added.id, x: 200, y: 40 };
  const links: ModelEdge[] = [anchors[0]!, anchors.at(-1)!].map((other, at) => ({ id: `edge:added:${at}`, from: anchor.id, to: other.id, relation: "grant", label: "fixture", provenance: "declared" }));
  const next = optimizeLayout([...islands, added], extractLayoutGraph([...anchors, anchor], [...edges, ...links]), remembered(initial));
  assert.equal(next.strategy, "incremental");
  const old = by(initial.positions), now = by(next.positions);
  for (const island of islands) {
    const moved = Math.hypot((now.get(island.id)!.left - old.get(island.id)!.left) * UNIT_X, (now.get(island.id)!.top - old.get(island.id)!.top) * UNIT_Y);
    // Only the new island's own neighbours may make a small, local adjustment.
    const neighbour = links.some((link) => anchors.find((item) => item.id === link.to)!.island === island.id);
    assert.ok(neighbour ? moved <= 192 : moved === 0, `${island.id} moved ${moved} px`);
  }
  assert.equal(next.after.islandOverlaps, 0);
  assert.equal(next.after.labelOverlaps, 0);
});

test("a grown island keeps its centre while islands it now touches make room", () => {
  for (const seed of [57, 58, 59, 60, 61, 62, 63, 64]) {
    const { islands, anchors, edges } = architecture(seed, 10);
    const graph = extractLayoutGraph(anchors, edges);
    const initial = optimizeLayout(islands, graph);
    // One more lattice column of services.
    const grown = islands.map((island, at) => at ? island : { ...island, size: island.size + 4, ground: { ...island.ground!, width: island.ground!.width + 4 } });
    const next = optimizeLayout(grown, graph, remembered(initial));
    assert.equal(next.strategy, "incremental", `seed ${seed}: a small growth never reshuffles the map`);
    assert.equal(next.after.islandOverlaps, 0);
    assert.equal(next.after.labelOverlaps, 0);
    const before = placed(islands, initial.positions), after = placed(grown, next.positions);
    const shift = Math.hypot(centre(after, 0).x - centre(before, 0).x, centre(after, 0).y - centre(before, 0).y);
    assert.ok(shift <= 192 + UNIT_X, `seed ${seed}: the grown island stays where it was (${Math.round(shift)} px)`);
    const old = by(initial.positions), now = by(next.positions);
    const moves = islands.slice(1).map((island) => Math.hypot((now.get(island.id)!.left - old.get(island.id)!.left) * UNIT_X, (now.get(island.id)!.top - old.get(island.id)!.top) * UNIT_Y));
    assert.ok(moves.filter((moved) => moved === 0).length >= 2, `seed ${seed}: islands clear of the growth hold still (${moves.map(Math.round).join(" ")})`);
    assert.ok(Math.max(...moves) <= 320, `seed ${seed}: others move only to make room nearby (${Math.round(Math.max(...moves))} px)`);
  }
  // Doubling a hub is a broad change: whichever strategy wins, the result stays drawable.
  const { islands, anchors, edges } = architecture(57, 10);
  const graph = extractLayoutGraph(anchors, edges);
  const initial = optimizeLayout(islands, graph);
  const doubled = islands.map((island, at) => at ? island : { ...island, size: island.size + 16, ground: { ...island.ground!, width: island.ground!.width + 10, length: island.ground!.length + 6 } });
  const next = optimizeLayout(doubled, graph, remembered(initial));
  assert.equal(next.after.islandOverlaps, 0);
  assert.equal(next.after.labelOverlaps, 0);
  assert.equal(optimizeLayout(islands, graph, remembered(next)).after.islandOverlaps, 0, "shrinking back stays clear");
});

test("editing one relationship leaves unrelated islands exactly where they were", () => {
  const { islands, anchors, edges } = architecture(73, 10, 2);
  const initial = optimizeLayout(islands, extractLayoutGraph(anchors, edges));
  const removed = edges[0]!;
  const ends = new Set([removed.from, removed.to].map((id) => anchors.find((anchor) => anchor.id === id)!.island));
  const next = optimizeLayout(islands, extractLayoutGraph(anchors, edges.slice(1)), remembered(initial));
  assert.equal(next.strategy, "incremental");
  const old = by(initial.positions), now = by(next.positions);
  for (const island of islands) {
    const moved = Math.hypot((now.get(island.id)!.left - old.get(island.id)!.left) * UNIT_X, (now.get(island.id)!.top - old.get(island.id)!.top) * UNIT_Y);
    assert.ok(ends.has(island.id) ? moved <= 96 : moved === 0, `${island.id} moved ${moved} px`);
  }
});

test("pinned islands hold through fresh and incremental placement", () => {
  const { islands, anchors, edges } = architecture(88, 8);
  const graph = extractLayoutGraph(anchors, edges);
  const free = optimizeLayout(islands, graph);
  const pin = { ...free.positions[2]!, left: free.positions[2]!.left + 40, top: free.positions[2]!.top + 40 };
  const pinned = optimizeLayout(islands, graph, { pins: { [pin.id]: pin } });
  assert.deepEqual(by(pinned.positions).get(pin.id), pin);
  assert.equal(pinned.after.islandOverlaps, 0);
  const edited = optimizeLayout(islands, extractLayoutGraph(anchors, edges.slice(2)), { ...remembered(pinned), pins: { [pin.id]: pin } });
  assert.deepEqual(by(edited.positions).get(pin.id), pin);
  assert.equal(edited.after.islandOverlaps, 0);
});

test("layout work stays bounded as architectures grow", () => {
  for (const [count, limit] of [[12, 1500], [24, 3000]] as const) {
    const { islands, graph } = architecture(500 + count, count, 3);
    const started = performance.now();
    const result = optimizeLayout(islands, graph);
    const elapsed = performance.now() - started;
    assert.ok(result.evaluations <= 720, `${count} islands: ${result.evaluations} evaluations`);
    assert.ok(elapsed < limit, `${count} islands lay out in ${Math.round(elapsed)} ms, even on slow CI`);
    assert.equal(result.after.islandOverlaps, 0);
  }
});
