import assert from "./support/assert";
import test from "node:test";
import { depth, project, tileTop, unproject } from "../src/scene/iso";

test("projection matches the audited renderer's constants", () => {
  assert.deepEqual(project({ x: 0, y: 0 }), { x: 0, y: 0 });
  assert.deepEqual(project({ x: 1, y: 0 }), { x: 32, y: 16 });
  assert.deepEqual(project({ x: 0, y: 1 }), { x: -32, y: 16 });
  assert.deepEqual(project({ x: 2, y: 2, h: 1 }), { x: 0, y: 48 });
});

test("unprojecting a ground point returns the grid point it came from", () => {
  for (const point of [{ x: 3, y: 1 }, { x: 0.5, y: 7.25 }, { x: -2, y: 4 }]) {
    assert.deepEqual(unproject(project(point)), point);
  }
});

test("rows further back draw first, and height breaks a tie", () => {
  assert.ok(depth({ x: 1, y: 1 }) < depth({ x: 2, y: 1 }));
  assert.ok(depth({ x: 2, y: 0 }) < depth({ x: 2, y: 0, h: 1 }));
  assert.equal(tileTop({ x: 0, y: 0 }), "0,-16 32,0 0,16 -32,0");
});
