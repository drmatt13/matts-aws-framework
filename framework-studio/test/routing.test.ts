import assert from "./support/assert";
import { test } from "node:test";
import { pathHits } from "../src/scene/layout-geometry";
import type { LayoutLink } from "../src/scene/layout-graph";
import { routeConnections } from "../src/scene/routing";

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
