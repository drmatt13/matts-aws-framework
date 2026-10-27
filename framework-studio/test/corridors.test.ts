import assert from "./support/assert";
import { test } from "node:test";
import type { Point } from "../src/scene/camera";
import { CORRIDOR_CLEARANCE, CORRIDOR_LIMIT, corridorConflicts, separateCorridors, type CorridorWire } from "../src/scene/corridors";
import { pathBounds, pathHits, pathsCross, intersects, type Obstacle } from "../src/scene/layout-geometry";
import type { LayoutLink } from "../src/scene/layout-graph";
import { arcPoints, distanceToPolyline } from "../src/scene/picking";
import { routeConnections } from "../src/scene/routing";

/** A wire as the router produces it: one quadratic lifted `lift` above its chord's midpoint. */
function wire(id: string, a: Point, b: Point, options: { lift?: number; from?: string; to?: string; group?: string } = {}): CorridorWire {
  const control = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - (options.lift ?? 40) };
  const from = options.from ?? `${id}:from`, to = options.to ?? `${id}:to`;
  return { id, ends: [from, to], points: arcPoints(a, control, b, 24), control, group: options.group ?? id, exempt: [from, to] };
}
const routed = (wires: readonly CorridorWire[], moved: ReadonlyMap<string, readonly Point[]>) => new Map(wires.map(item => [item.id, moved.get(item.id) ?? item.points]));
/** Smallest distance between the middle halves of two routes, away from the endpoints. */
function middleGap(a: readonly Point[], b: readonly Point[]): number {
  return Math.min(...a.slice(6, 19).map(point => distanceToPolyline(point, b)));
}
function assertWellFormed(before: CorridorWire, after: readonly Point[]): void {
  assert.equal(after.length, before.points.length);
  assert.deepEqual(after[0], before.points[0]);
  assert.deepEqual(after.at(-1), before.points.at(-1));
  for (const point of after) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${before.id} has a non-finite point`);
}
/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test("two unrelated wires on nearly the same trajectory are spread apart and nothing else moves", () => {
  const a = wire("a", { x: 0, y: 0 }, { x: 30, y: 1000 }), b = wire("b", { x: 6, y: 12 }, { x: 36, y: 1010 });
  const far = wire("far", { x: 3000, y: 0 }, { x: 3600, y: 300 });
  assert.equal(corridorConflicts([a, b, far]).length, 1);
  const moved = separateCorridors([a, b, far], []);
  assert.deepEqual([...moved.keys()].sort(), ["a", "b"], "only the competing pair moves");
  const after = routed([a, b, far], moved);
  for (const item of [a, b]) assertWellFormed(item, after.get(item.id)!);
  assert.ok(middleGap(after.get("a")!, after.get("b")!) >= CORRIDOR_CLEARANCE * 0.8, "the pair reads as two wires mid-span");
  assert.equal(corridorConflicts([a, b, far].map(item => ({ ...item, points: after.get(item.id)! }))).length, 0);
  assert.equal(pathsCross(after.get("a")!, after.get("b")!), false, "spacing keeps each wire on its side");
});

test("wires that cross at an angle, run apart, or meet only near a shared node are not a corridor", () => {
  const cross = [wire("x1", { x: 0, y: 0 }, { x: 800, y: 800 }), wire("x2", { x: 800, y: 0 }, { x: 0, y: 800 })];
  const apart = [wire("p1", { x: 0, y: 0 }, { x: 0, y: 900 }), wire("p2", { x: 120, y: 0 }, { x: 120, y: 900 })];
  // A 20° fan diverges past the clearance well inside the shared node's fan radius.
  const hub = { x: 0, y: 1000 };
  const fan = [wire("f1", { x: -180, y: 0 }, hub, { to: "hub" }), wire("f2", { x: 180, y: 0 }, hub, { to: "hub" })];
  for (const set of [cross, apart, fan]) {
    assert.equal(corridorConflicts(set).length, 0);
    assert.equal(separateCorridors(set, []).size, 0);
  }
});

test("a fan from nearly collinear sources opens at its shared node in order, without crossing", () => {
  const hub = { x: 0, y: 1200 };
  const wires = [0, 250, 500, 700].map((y, at) => wire(`w${at}`, { x: at * 6, y }, hub, { to: "hub", lift: 30 }));
  assert.ok(corridorConflicts(wires).length >= 3);
  const after = routed(wires, separateCorridors(wires, []));
  for (const item of wires) assertWellFormed(item, after.get(item.id)!);
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    assert.equal(pathsCross(after.get(wires[i]!.id)!, after.get(wires[j]!.id)!), false, `${wires[i]!.id} crosses ${wires[j]!.id}`);
  }
  // Away from the hub the wires no longer lie on one another.
  const spread = wires.map(item => after.get(item.id)!).map(points => points.filter(point => hub.y - point.y > 300));
  for (let i = 1; i < spread.length; i++) for (const point of spread[i]!) assert.ok(distanceToPolyline(point, after.get(wires[i - 1]!.id)!) > 6);
});

test("parallel relationships between the same two nodes move together and keep their fan", () => {
  const a = { x: 0, y: 0 }, b = { x: 40, y: 1000 };
  const one = wire("one", a, b, { from: "s", to: "t", group: "s|t" });
  const two = { ...wire("two", a, b, { from: "s", to: "t", group: "s|t", lift: 40 }) };
  const sibling: CorridorWire = { ...two, control: { x: two.control.x + 30, y: two.control.y }, points: arcPoints(a, { x: two.control.x + 30, y: two.control.y }, b, 24) };
  const intruder = wire("intruder", { x: 8, y: 10 }, { x: 52, y: 1010 });
  const moved = separateCorridors([one, sibling, intruder], []);
  assert.ok(moved.has("intruder"));
  const offset = (item: CorridorWire) => (moved.get(item.id) ?? item.points)[12]!.x - item.points[12]!.x;
  assert.ok(Math.abs(offset(one) - offset(sibling)) < 1e-9, "siblings shift by the same amount");
  assert.equal(corridorConflicts([one, sibling]).length, 0, "a fan between two nodes is never a corridor");
});

test("a separation never makes a wire cut more obstacles than it already did", () => {
  const a = wire("a", { x: 0, y: 0 }, { x: 0, y: 1000 }), b = wire("b", { x: 8, y: 0 }, { x: 8, y: 1000 });
  // Boxes hugging both sides of the pair: any sideways bow would enter one.
  const obstacles: Obstacle[] = [{ id: "left", bounds: { minX: -60, maxX: -14, minY: 300, maxY: 700 } }, { id: "right", bounds: { minX: 22, maxX: 70, minY: 300, maxY: 700 } }];
  const after = routed([a, b], separateCorridors([a, b], obstacles));
  for (const item of [a, b]) {
    const hits = (points: readonly Point[]) => obstacles.filter(obstacle => pathHits(points, obstacle.bounds)).length;
    assert.ok(hits(after.get(item.id)!) <= hits(item.points), `${item.id} was pushed into an obstacle`);
  }
});

test("routing is independent of declaration order and leaves distant routes untouched", () => {
  const anchor = (id: string, island: string, x: number, y: number) => ({ id, island, x, y });
  const hub = anchor("hub", "south", 0, 1200);
  const links: LayoutLink[] = [0, 1, 2, 3, 4].map(at => ({ id: `fan:${at}`, from: anchor(`s${at}`, "north", at * 9, at * 120), to: hub, weight: 2, category: "inputs" }));
  const routes = routeConnections(links, []);
  assert.deepEqual(routeConnections([...links].reverse(), []), routes);
  // Add and remove wires far away, one after another: the corridor keeps its exact geometry.
  let distant: LayoutLink[] = [];
  for (let step = 0; step < 6; step++) {
    distant = step % 3 === 2 ? distant.slice(1) : [...distant, { id: `far:${step}`, from: anchor(`f${step}`, "east", 5000 + step * 40, 0), to: anchor(`g${step}`, "west", 5600, 400 + step * 30), weight: 1, category: "routes" }];
    const next = routeConnections([...links, ...distant], []);
    for (const link of links) assert.deepEqual(next[link.id], routes[link.id], `${link.id} moved after an unrelated change`);
  }
});

test("maps beyond the corridor limit keep every wire on its own arc", () => {
  const wires = Array.from({ length: CORRIDOR_LIMIT + 1 }, (_, at) => wire(`w${at}`, { x: at % 2, y: 0 }, { x: 30 + at % 2, y: 1000 }, { from: `a${at}`, to: `b${at}` }));
  assert.ok(corridorConflicts(wires.slice(0, 2)).length > 0);
  assert.equal(separateCorridors(wires, []).size, 0);
});

test("random architectures keep every invariant", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const next = random(seed), wires: CorridorWire[] = [], obstacles: Obstacle[] = [];
    const islands = Array.from({ length: 3 + Math.floor(next() * 5) }, (_, at) => ({ id: `island:${at}`, x: next() * 3000, y: next() * 2000 }));
    for (const island of islands) obstacles.push({ id: island.id, bounds: { minX: island.x - 120, maxX: island.x + 120, minY: island.y - 60, maxY: island.y + 60 } });
    const nodes = islands.flatMap(island => Array.from({ length: 2 + Math.floor(next() * 6) }, (_, at) => ({ id: `${island.id}:n${at}`, island: island.id, x: island.x + (next() - 0.5) * 200, y: island.y + (next() - 0.5) * 100 })));
    const hubs = nodes.filter(() => next() < 0.2);
    for (let at = 0, count = 10 + Math.floor(next() * 50); at < count; at++) {
      const a = nodes[Math.floor(next() * nodes.length)]!, b = hubs.length && next() < 0.5 ? hubs[Math.floor(next() * hubs.length)]! : nodes[Math.floor(next() * nodes.length)]!;
      if (a.island === b.island) continue;
      const item = wire(`w${at}`, a, b, { from: a.id, to: b.id, lift: 20 + next() * 200, group: `${a.id}|${b.id}|${at}` });
      wires.push({ ...item, exempt: [a.id, b.id, a.island, b.island] });
    }
    const moved = separateCorridors(wires, obstacles);
    const shuffled = [...wires].sort((x, y) => (x.id.length * 7 + x.id.charCodeAt(1)) % 5 - (y.id.length * 7 + y.id.charCodeAt(1)) % 5 || (x.id < y.id ? 1 : -1));
    assert.deepEqual(separateCorridors(shuffled, obstacles), moved, `seed ${seed}: depends on input order`);
    const after = routed(wires, moved);
    const overlap = (paths: ReadonlyMap<string, readonly Point[]>) => corridorConflicts(wires.map(item => ({ ...item, points: paths.get(item.id)! }))).reduce((sum, found) => sum + found.length, 0);
    assert.ok(overlap(after) <= overlap(routed(wires, new Map())), `seed ${seed}: separation increased the competing length`);
    for (const item of wires) {
      const points = after.get(item.id)!;
      assertWellFormed(item, points);
      const hits = (route: readonly Point[]) => obstacles.filter(obstacle => !item.exempt.includes(obstacle.id) && intersects(pathBounds(route), obstacle.bounds) && pathHits(route, obstacle.bounds)).length;
      assert.ok(hits(points) <= hits(item.points), `seed ${seed}: ${item.id} cuts more obstacles`);
      if (!moved.has(item.id)) assert.equal(points, item.points, "an unmoved wire keeps its exact route");
    }
  }
});
