import assert from "./support/assert";
import test from "node:test";
import { resourceTooltipPlacement } from "../src/views/ResourceTooltip";

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
