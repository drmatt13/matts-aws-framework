import assert from "./support/assert";
import test from "node:test";
import type { Bounds, Point } from "../src/scene/camera";
import { intersects, pathBounds, pathHits, pathsCross, segmentsCross } from "../src/scene/layout-geometry";

const orientation = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const strictCrossing = (a: Point, b: Point, c: Point, d: Point) => orientation(a, b, c) * orientation(a, b, d) < -0.0001 && orientation(c, d, a) * orientation(c, d, b) < -0.0001;
function exhaustiveCrossing(a: readonly Point[], b: readonly Point[]) {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) if (strictCrossing(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) return true;
  return false;
}
function exhaustiveHit(points: readonly Point[], box: Bounds) {
  const corners = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
  return points.some((point, at) => point.x > box.minX && point.x < box.maxX && point.y > box.minY && point.y < box.maxY
    || at > 0 && corners.some((corner, side) => strictCrossing(points[at - 1]!, point, corner, corners[(side + 1) % corners.length]!)));
}

test("path envelopes include interior extrema, reversed paths and zero-width segments", () => {
  const points = [{ x: 5, y: 8 }, { x: -4, y: 20 }, { x: 11, y: -3 }, { x: 3, y: 9 }];
  assert.deepEqual(pathBounds(points), { minX: -4, maxX: 11, minY: -3, maxY: 20 });
  assert.deepEqual(pathBounds([...points].reverse()), pathBounds(points));
  const vertical = [{ x: 5, y: -10 }, { x: 5, y: 10 }];
  const horizontal = [{ x: -10, y: 0 }, { x: 10, y: 0 }];
  assert.ok(intersects(pathBounds(vertical), pathBounds(horizontal)));
  assert.ok(pathsCross(vertical, horizontal));
  const box = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  assert.ok(pathHits(vertical, box));
  assert.ok(intersects(pathBounds(vertical), box));
  assert.equal(intersects(pathBounds([{ x: 10, y: -1 }, { x: 10, y: 11 }]), box), false, "touching the box boundary is not an interior hit");
});

test("envelope rejection preserves exhaustive sampled-path intersections", () => {
  let seed = 732451;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 * 800 - 400; };
  const paths = Array.from({ length: 100 }, (_, at): Point[] => Array.from({ length: 2 + at % 8 }, () => ({ x: next(), y: next() })));
  let crossingPairs = 0, rejectedPairs = 0, hits = 0;
  for (const [at, path] of paths.entries()) {
    const bounds = pathBounds(path);
    for (const other of paths.slice(at + 1)) {
      const actual = exhaustiveCrossing(path, other), possible = intersects(bounds, pathBounds(other));
      assert.equal(pathsCross(path, other), actual, "segment pruning preserves exact crossings");
      assert.equal(possible && actual, actual, "an envelope must never reject an exact crossing");
      crossingPairs += Number(actual); rejectedPairs += Number(!possible);
    }
    for (let n = 0; n < 10; n++) {
      const x = next(), y = next(), box = { minX: x, maxX: x + 40, minY: y, maxY: y + 40 };
      const actual = exhaustiveHit(path, box);
      assert.equal(pathHits(path, box), actual, "segment pruning preserves exact obstacle hits");
      assert.equal(intersects(bounds, box) && actual, actual, "an envelope must never reject an exact obstacle hit");
      hits += Number(actual);
    }
  }
  assert.ok(crossingPairs > 100 && hits > 10 && rejectedPairs > 10, "the fixture exercises hits and rejected candidates");
});

test("path pruning agrees with the strict orientation definition across degenerate and arbitrary segments", () => {
  const segments = Array.from({ length: 120 }, (_, at): [Point, Point] => [
    { x: at % 11 * 13 - 60, y: at % 7 * 17 - 50 },
    { x: at % 5 * 23 - 40, y: at % 13 * 11 - 60 },
  ]);
  let crossings = 0;
  for (const [a, b] of segments) for (const [c, d] of segments) {
    const actual = strictCrossing(a, b, c, d);
    assert.equal(segmentsCross(a, b, c, d), actual);
    assert.equal(pathsCross([a, b], [c, d]), actual);
    crossings += Number(actual);
  }
  assert.ok(crossings > 100, "the fixture covers strict crossings as well as boundary and degenerate cases");
});
