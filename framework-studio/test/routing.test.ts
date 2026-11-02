import assert from "./support/assert";
import { test } from "node:test";
import { pathHits, pathsCross, type Obstacle } from "../src/scene/layout-geometry";
import type { LayoutLink } from "../src/scene/layout-graph";
import { routeArcs, routeConnections } from "../src/scene/routing";
import { corridorConflicts, separateCorridors } from "../src/scene/corridors";
import { arcPoints } from "../src/scene/picking";

const a = { id: "a", island: "left", x: 0, y: 0 };
const b = { id: "b", island: "right", x: 800, y: 0 };
const pair: readonly LayoutLink[] = [
  { id: "first", from: a, to: b, weight: 3, category: "routes" },
  { id: "second", from: b, to: a, weight: 1, category: "interactions" },
];

test("a shared parallel curve avoids obstacles on every member, including the opposite direction", () => {
  const obstacle = { id: "outer-sibling", bounds: { minX: 370, maxX: 430, minY: -100, maxY: -84 } };
  const clear = routeConnections(pair, []);
  assert.equal(pathHits(clear.first!.points, obstacle.bounds), false, "the first member alone sees no obstruction");
  assert.equal(pathHits(clear.second!.points, obstacle.bounds), true, "the obstacle obstructs only the other fan member");

  const routes = routeConnections(pair, [obstacle]);
  for (const link of pair) {
    const points = routes[link.id]!.points;
    assert.equal(pathHits(points, obstacle.bounds), false, `${link.id} must clear the obstacle`);
    assert.deepEqual(points[0], { x: link.from.x, y: link.from.y });
    assert.deepEqual(points.at(-1), { x: link.to.x, y: link.to.y });
  }
  const gap = (routes: ReturnType<typeof routeConnections>) => routes.second!.points[12]!.y - routes.first!.points[12]!.y;
  assert.equal(gap(routes), gap(clear), "obstacle avoidance retains the fan's separation");
  assert.deepEqual(routeConnections([...pair].reverse(), [obstacle]), routes, "declaration order cannot choose another shared curve");
});

test("an unobstructed parallel fan retains its exact geometry when unrelated obstacles are added", () => {
  const routes = routeConnections(pair, []);
  assert.deepEqual(routeConnections(pair, [{ id: "distant", bounds: { minX: 3000, maxX: 3100, minY: 500, maxY: 600 } }]), routes);
});

// Geometry of the enableWebSocketApi -> $connect outlier, with neutral fixture ids.
// One extra icon hit makes the old scorer choose its largest upward detour.
const steep: LayoutLink = {
  id: "steep", category: "inputs", weight: 2,
  from: { id: "input", island: "inputs", h: 4.375, x: 384, y: -646 },
  to: { id: "workload", island: "compute", h: 6.375, x: 448, y: 282 },
};
const nearby: readonly Obstacle[] = [
  { id: "settings", bounds: { minX: 359, maxX: 423, minY: -518, maxY: -449 } },
  { id: "settings", bounds: { minX: 304, maxX: 464, minY: -568, maxY: -528 } },
  { id: "neighbor", bounds: { minX: 423, maxX: 473, minY: 154, maxY: 223 } },
  { id: "neighbor", bounds: { minX: 368, maxX: 528, minY: 104, maxY: 144 } },
];
const crest = (points: readonly { x: number; y: number }[]) => Math.min(points[0]!.y, points.at(-1)!.y) - Math.min(...points.map(point => point.y));
const untrimmed = (links: readonly LayoutLink[], obstacles: readonly Obstacle[]) => {
  const wires = routeArcs(links, obstacles), moved = separateCorridors(wires, obstacles);
  return wires.map(wire => ({ ...wire, points: moved.get(wire.id) ?? wire.points }));
};

test("a tall narrow detour gets a compact crest without changing any other route or adding collisions", () => {
  const links = [steep, ...pair];
  const before = untrimmed(links, nearby), after = routeConnections(links, nearby);
  const original = before.find(wire => wire.id === steep.id)!;
  const points = after.steep!.points;
  assert.ok(crest(original.points) > 120, "the fixture reproduces the oversized avoidance crest");
  assert.ok(crest(points) >= 23 && crest(points) <= 25, "the usual projected clearance is retained");
  assert.deepEqual(points[0], original.points[0]);
  assert.deepEqual(points.at(-1), original.points.at(-1));
  for (const wire of before) if (wire.id !== steep.id) assert.deepEqual(after[wire.id]!.points, wire.points, `${wire.id} must not move`);
  for (const obstacle of nearby) if (!pathHits(original.points, obstacle.bounds)) assert.equal(pathHits(points, obstacle.bounds), false, "no new icon or caption collision");
  const crossings = (path: typeof points) => before.filter(wire => wire.id !== steep.id && pathsCross(path, wire.points)).length;
  assert.ok(crossings(points) <= crossings(original.points));
  const congestion = (wires: typeof before) => corridorConflicts(wires).reduce((sum, conflict) => sum + conflict.length, 0);
  assert.ok(congestion(before.map(wire => ({ ...wire, points: after[wire.id]!.points }))) <= congestion(before));
  assert.deepEqual(routeConnections([...links].reverse(), nearby), after, "declaration order does not change the safeguard");
  const reverse = routeConnections([{ ...steep, from: steep.to, to: steep.from }], nearby).steep!.points;
  const forward = routeConnections([steep], nearby).steep!.points;
  for (let at = 0; at < forward.length; at++) assert.ok(Math.hypot(forward[at]!.x - reverse[reverse.length - 1 - at]!.x, forward[at]!.y - reverse[reverse.length - 1 - at]!.y) < 1e-8);
});

test("unsafe crest corrections fall back to the exact original route", () => {
  const ordinary = routeArcs([steep], [])[0]!;
  const barriers = [0, 24, -24, 48, -48].map((shift, index) => {
    const point = arcPoints(ordinary.points[0]!, { x: ordinary.control.x + shift, y: ordinary.control.y }, ordinary.points.at(-1)!, 24)[12]!;
    return { id: `barrier-${index}`, bounds: { minX: point.x - 0.1, maxX: point.x + 0.1, minY: point.y - 0.1, maxY: point.y + 0.1 } };
  });
  const obstacles = [...nearby, ...barriers];
  const original = untrimmed([steep], obstacles)[0]!;
  assert.ok(crest(original.points) > 120);
  for (const barrier of barriers) assert.equal(pathHits(original.points, barrier.bounds), false);
  assert.deepEqual(routeConnections([steep], obstacles).steep!.points, original.points);
});

test("ordinary steep crests, wide arcs, short spans and parallel fans keep their exact geometry", () => {
  const cases = [
    { links: [steep], obstacles: [] },
    { links: [{ ...steep, to: { ...steep.to, x: 800 } }], obstacles: nearby },
    { links: [{ ...steep, to: { ...steep.to, x: 390, y: -400 } }], obstacles: nearby },
    { links: [steep, { ...steep, id: "parallel", category: "interactions" }], obstacles: nearby },
  ];
  for (const { links, obstacles } of cases) {
    const before = untrimmed(links, obstacles), after = routeConnections(links, obstacles);
    for (const wire of before) assert.deepEqual(after[wire.id]!.points, wire.points);
  }
});
