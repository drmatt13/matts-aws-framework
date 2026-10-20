import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleNodeCaptions } from "../src/scene/labels";

test("captions keep their exact anchor and omit obstructed slots without moving neighbours", () => {
  const captions = [
    { id: "left", x: 30, y: 100, width: 100, height: 22, order: 0, priority: 0 },
    { id: "right", x: 160, y: 100, width: 100, height: 22, order: 1, priority: 0 },
  ];
  const viewport = { width: 320, height: 240 };
  assert.deepEqual(visibleNodeCaptions(captions, [], viewport), captions);
  assert.deepEqual(visibleNodeCaptions(captions, [{ x: 150, y: 90, width: 30, height: 50 }], viewport), [captions[0]]);
  assert.deepEqual(visibleNodeCaptions([captions[0]!], [], viewport), [captions[0]], "filtering the map never relocates a remaining caption");
});

test("caption bounds respect icons, badges, controls and viewport edges", () => {
  const captions = Array.from({ length: 5 }, (_, order) => ({ id: String(order), x: order * 80, y: 80, width: 60, height: 22, priority: 0, order }));
  const visible = visibleNodeCaptions(captions, [{ x: 85, y: 70, width: 30, height: 40 }], { width: 320, height: 180 });
  assert.deepEqual(visible.map((card) => card.id), ["2", "3"]);
});
