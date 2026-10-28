import assert from "./support/assert";
import test from "node:test";
import { canvasTooltipViewport, pointerTooltipPlacement, resourceTooltipPlacement, tooltipContentSize } from "../src/views/ResourceTooltip";

test("resource previews sit beside desktop rows and stay within the visible window", () => {
  const viewport = { left: 0, top: 0, width: 1440, height: 900 };
  const row = { left: 1100, right: 1424, top: 840, bottom: 884 };
  const card = { width: 320, height: 240 };
  const placement = resourceTooltipPlacement(row, card, viewport);
  assert.ok(placement.left + card.width < row.left, "the preview leaves its row visible");
  assert.ok(placement.top >= 8 && placement.top + card.height <= 892);
});

test("narrow windows put previews above or below the row without horizontal overflow", () => {
  for (const top of [80, 350, 590]) {
    const row = { left: 8, right: 312, top, bottom: top + 44 };
    const placement = resourceTooltipPlacement(row, { width: 320, height: 240 }, { left: 0, top: 0, width: 320, height: 680 });
    assert.equal(placement.left, 8);
    assert.ok(placement.top >= 8);
    const height = Math.min(240, placement.maxHeight);
    assert.ok(placement.top + height <= 672);
    assert.ok(placement.top + height < row.top || placement.top > row.bottom, "the row remains reachable");
  }
});

test("previews respect the visual viewport when zooming or scrolling the window", () => {
  const viewport = { left: 100, top: 80, width: 220, height: 400 };
  for (const top of [0, 240, 600]) {
    const placement = resourceTooltipPlacement({ left: 100, right: 320, top, bottom: top + 44 }, { width: 320, height: 240 }, viewport);
    assert.equal(placement.maxWidth, 204);
    assert.ok(placement.left >= 108 && placement.left + placement.maxWidth <= 312);
    assert.ok(placement.top >= 88 && placement.top + Math.min(240, placement.maxHeight) <= 472);
  }
});

test("map tooltips use their measured size at every corner rather than a fixed-height estimate", () => {
  const viewport = { left: 40, top: 80, width: 800, height: 600 };
  for (const card of [{ width: 320, height: 120 }, { width: 440, height: 480 }, { width: 600, height: 1200 }]) {
    for (const point of [{ x: 44, y: 84 }, { x: 836, y: 84 }, { x: 44, y: 676 }, { x: 836, y: 676 }, { x: 440, y: 380 }]) {
      const position = pointerTooltipPlacement(point, card, viewport);
      assert.ok(position.left >= 48 && position.top >= 88);
      assert.ok(position.left + Math.min(card.width, position.maxWidth) <= 832);
      assert.ok(position.top + Math.min(card.height, position.maxHeight) <= 672);
    }
  }
  const short = pointerTooltipPlacement({ x: 400, y: 200 }, { width: 320, height: 100 }, viewport);
  assert.equal(short.left, 412);
  assert.equal(short.top, 212);
  const tall = pointerTooltipPlacement({ x: 400, y: 600 }, { width: 320, height: 400 }, viewport);
  assert.equal(tall.top, 188, "a tall card fits above its pointer rather than clipping below the canvas");
});

test("tiny and partially hidden canvases never produce negative tooltip constraints", () => {
  for (const viewport of [{ left: 120, top: 200, width: 12, height: 10 }, { left: 20, top: 40, width: 0, height: 0 }]) {
    const pointer = pointerTooltipPlacement({ x: -100, y: 2000 }, { width: 440, height: 900 }, viewport);
    const row = resourceTooltipPlacement({ left: -100, right: 1000, top: -500, bottom: 1500 }, { width: 440, height: 900 }, viewport);
    for (const position of [pointer, row]) {
      assert.ok(position.maxHeight >= 0 && position.maxWidth >= 0);
      assert.ok(position.left >= viewport.left && position.left <= viewport.left + viewport.width);
      assert.ok(position.top >= viewport.top && position.top <= viewport.top + viewport.height);
    }
  }
});

test("overflowed cards retain their natural height for subsequent placement and resizing", () => {
  const element = { getBoundingClientRect: () => ({ width: 320, height: 242 }) as DOMRect, scrollHeight: 720, clientHeight: 240 };
  assert.deepEqual(tooltipContentSize(element), { width: 320, height: 722 });
  const viewport = { left: 0, top: 0, width: 390, height: 680 };
  const anchor = { left: 8, right: 382, top: 260, bottom: 304 };
  const first = resourceTooltipPlacement(anchor, { width: 320, height: 722 }, viewport);
  const next = resourceTooltipPlacement(anchor, tooltipContentSize(element), viewport);
  assert.deepEqual(next, first, "a scrollbar does not make the preview switch sides after its first measurement");
});

test("map bounds intersect the visual viewport in local coordinates, including zoom and scrolling", () => {
  const host = { left: 100, top: 200, width: 800, height: 600 };
  assert.deepEqual(canvasTooltipViewport(host, { left: 0, top: 0, width: 1440, height: 900 }), { left: 0, top: 0, width: 800, height: 600 });
  assert.deepEqual(canvasTooltipViewport(host, { left: 240, top: 320, width: 400, height: 360 }), { left: 140, top: 120, width: 400, height: 360 });
  assert.deepEqual(canvasTooltipViewport(host, { left: 0, top: 0, width: 40, height: 80 }), { left: 0, top: 0, width: 0, height: 0 });
  assert.deepEqual(canvasTooltipViewport(host, { left: 1000, top: 900, width: 400, height: 360 }), { left: 800, top: 600, width: 0, height: 0 });
});
