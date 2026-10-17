import assert from "node:assert/strict";
import { test } from "node:test";
import type { Island } from "../src/scene/build";
import { pan, worldToScreen, type Camera } from "../src/scene/camera";
import { islandFrame } from "../src/scene/frame";
import { placeIslandTitle, tilePolygons } from "../src/scene/picking";
import { islandSlabs } from "../src/scene/slabs";

const rectangle = (x: number, y: number, width: number, height: number) => [x, y, x + width, y, x + width, y + height, x, y + height];
const viewport = { width: 1600, height: 900 };
function screen(polygon: readonly number[], camera: Camera): number[] {
  const points: number[] = [];
  for (let at = 0; at < polygon.length; at += 2) {
    const point = worldToScreen(camera, viewport, { x: polygon[at]!, y: polygon[at + 1]! });
    points.push(point.x, point.y);
  }
  return points;
}

function island(width: number, depth: number): Island {
  return {
    id: "fixture", title: "Small or large island", region: "compute", caption: [],
    gx0: 2, gy0: 3, gx1: width + 1, gy1: depth + 2, base: 0, top: 3,
    bands: [{ id: "band", title: "Compute", caption: [], h: 3, gx0: 2, gx1: width + 1, gx: 2, gy: 3 }],
  };
}

test("titles keep a 10 CSS pixel gap from actual small and large outlines through zoom and pan", () => {
  const outlines: (readonly number[])[][] = [];
  for (const [width, depth] of [[3, 3], [5, 8], [23, 17]] as const) {
    const owner = island(width, depth);
    const [slab] = islandSlabs({ islands: [owner], nodes: [], props: [] });
    const surfaces = slab!.bands.flatMap((band) => [band.top, ...band.walls.map((wall) => wall.quad)]);
    outlines.push(surfaces);
    const frame = islandFrame(owner);
    outlines.push([...surfaces, frame.top, frame.left, frame.right]);
  }
  outlines.push(tilePolygons({ gx: 4, gy: 3, h: 1, wallLeft: -2, wallRight: -2 }));
  for (const outline of outlines) {
    for (const zoom of [0.18, 0.45, 1, 2.5]) {
      const camera = { x: -317, y: 143, zoom };
      const projected = outline.map((polygon) => screen(polygon, camera));
      const placed = placeIslandTitle(projected, { width: 108, height: 12 }, projected);
      assert.ok(placed, `zoom ${zoom}`);
      const left = Math.min(...projected.flatMap((polygon) => polygon.filter((_, at) => at % 2 === 0)));
      assert.ok(Math.abs(left - (placed.x + placed.width) - 10) < 1e-8);
      const moved = placeIslandTitle(outline.map((polygon) => screen(polygon, pan(camera, 91, -43))), { width: 108, height: 12 }, []);
      assert.ok(moved);
      assert.ok(Math.abs(moved.x - placed.x - 91) < 1e-8);
      assert.ok(Math.abs(moved.y - placed.y + 43) < 1e-8, JSON.stringify({ zoom, placed, moved }));
    }
  }
});

test("perspective changes anchor to projected geometry instead of a grid corner or a padded culling box", () => {
  const shape = [-20, 30, 80, -20, 180, 30, 80, 80];
  for (const angle of [0, Math.PI / 6, -Math.PI / 4]) {
    const projected = shape.map((value, at) => {
      const x = shape[at - at % 2]!;
      const y = shape[at - at % 2 + 1]!;
      return at % 2 === 0 ? x * Math.cos(angle) - y * Math.sin(angle) : x * Math.sin(angle) + y * Math.cos(angle);
    });
    const placed = placeIslandTitle([projected], { width: 90, height: 12 }, [projected]);
    assert.ok(placed);
    const left = Math.min(...projected.filter((_, at) => at % 2 === 0));
    assert.ok(Math.abs(placed.x + placed.width - (left - 10)) < 1e-8);
  }
});

test("obstacles slide titles along the flank while retaining the gap, including already placed labels", () => {
  const outline = [rectangle(0, 0, 100, 80)];
  const size = { width: 60, height: 12 };
  const first = placeIslandTitle(outline, size, []);
  assert.ok(first);
  for (const blocker of [rectangle(-80, 30, 75, 20), rectangle(first.x, first.y, first.width, first.height)]) {
    const placed = placeIslandTitle(outline, size, [blocker]);
    assert.ok(placed);
    assert.equal(placed.x + placed.width, -10);
    const top = Math.min(...blocker.filter((_, at) => at % 2 === 1));
    const bottom = Math.max(...blocker.filter((_, at) => at % 2 === 1));
    assert.ok(placed.y + placed.height <= top - 2 || placed.y >= bottom + 2);
  }
  // This triangle's bounding box crosses the title; its actual outline does not.
  assert.deepEqual(placeIslandTitle(outline, size, [[-100, 0, 20, 0, 20, 40]]), first);
  assert.equal(placeIslandTitle(outline, size, [rectangle(-1000, -1000, 2000, 2000)]), undefined);
});
