import assert from "./support/assert";
import { test } from "node:test";
import { fitBounds, worldToScreen } from "../src/scene/camera";
import { fitScene } from "../src/scene/fit";
import type { Scene } from "../src/scene/types";

// A centered piece of artwork with additional space reserved for its left title.
const scene = {
  bounds: { minX: -400, maxX: 200, minY: -200, maxY: 200 },
  islands: [], frames: [], props: [], routes: {},
  nodes: [{ geometry: { hull: [-200, -200, 200, -200, 200, 200, -200, 200] } }],
} as unknown as Scene;

test("Fit centers painted geometry and gives the overview a small screen-space lift without changing zoom", () => {
  const viewport = { width: 1200, height: 600 };
  const old = fitBounds(scene.bounds, viewport, 40);
  const camera = fitScene(scene, viewport);
  assert.ok(old.x < 0, "the reserved title margin previously pushed the artwork right");
  assert.equal(worldToScreen(camera, viewport, { x: 0, y: 0 }).x, viewport.width / 2);
  assert.equal(camera.zoom, old.zoom);
  assert.equal(worldToScreen(camera, viewport, { x: 0, y: 0 }).y, viewport.height / 2 - 8);
  assert.ok(worldToScreen(camera, viewport, { x: 0, y: scene.bounds.minY }).y >= 32);
  const label = worldToScreen(camera, viewport, { x: scene.bounds.minX, y: 0 });
  assert.ok(label.x >= 40, "centering retains room for the entire title");
});

test("Fit limits its horizontal correction when a narrow viewport needs the title margin", () => {
  for (const width of [390, 480, 700]) {
    const viewport = { width, height: 600 };
    const camera = fitScene(scene, viewport);
    const left = worldToScreen(camera, viewport, { x: scene.bounds.minX, y: 0 }).x;
    const right = worldToScreen(camera, viewport, { x: scene.bounds.maxX, y: 0 }).x;
    assert.ok(left >= 40 - 1e-8 && right <= width - 40 + 1e-8);
    assert.equal(camera.zoom, fitBounds(scene.bounds, viewport, 40).zoom);
    const old = fitBounds(scene.bounds, viewport, 40);
    assert.ok(Math.abs((camera.y - old.y) * camera.zoom - 8) < 1e-8, "the lift stays eight screen pixels at every zoom");
  }
});

test("Fit's vertical lift respects smaller custom padding", () => {
  const viewport = { width: 1200, height: 600 };
  for (const padding of [0, 8, 20, 40]) {
    const camera = fitScene(scene, viewport, padding);
    const old = fitBounds(scene.bounds, viewport, padding);
    const lift = (camera.y - old.y) * camera.zoom;
    assert.ok(lift <= padding / 2 + 1e-8);
    assert.equal(camera.zoom, old.zoom);
  }
});

test("Fit includes a connection protruding beyond the terrain in its visual center", () => {
  const withWire = { ...scene, routes: { wire: { points: [{ x: -300, y: 0 }, { x: 200, y: 0 }], length: 500 } } };
  assert.equal(fitScene(withWire, { width: 1200, height: 600 }).x, -50);
});
