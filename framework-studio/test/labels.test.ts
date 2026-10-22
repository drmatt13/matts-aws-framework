import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_CAPTION, SUBNET_LABEL, nodeCaptionPresentation, subnetLabelPresentation, subnetLabelRect, visibleNodeCaptions } from "../src/scene/labels";

test("subnet headings retain mid-range contrast and fade continuously into a compact overview", () => {
  assert.equal(subnetLabelPresentation(0.5).alpha, 1);
  assert.equal(subnetLabelPresentation(0.08).alpha, 0.5);
  const nodeAlpha = NODE_CAPTION.minOpacity + (1 - NODE_CAPTION.minOpacity) * nodeCaptionPresentation(0.45).detail;
  assert.ok(subnetLabelPresentation(0.45).alpha > nodeAlpha, "subnet names stay visible longer as the map zooms out");
  let previous = subnetLabelPresentation(0.05);
  for (let zoom = 0.06; zoom <= 1; zoom += 0.01) {
    const current = subnetLabelPresentation(zoom);
    assert.ok(current.alpha >= previous.alpha && current.alpha - previous.alpha < 0.025);
    assert.ok(current.scale >= previous.scale && current.plateAlpha <= current.alpha);
    previous = current;
  }
});

test("subnet cards anchor their bottom-left corner near the middle of the top-right rim", () => {
  const anchor = { x: 200, y: 150 };
  for (const zoom of [0.05, 0.18, 0.45, 1, 2.5]) {
    const { scale } = subnetLabelPresentation(zoom);
    const rect = subnetLabelRect(anchor, 120 * scale, 28 * scale, scale);
    assert.ok(Math.abs(rect.x - anchor.x - SUBNET_LABEL.gap * scale) < 0.0001);
    assert.ok(Math.abs(rect.y + rect.height - anchor.y + SUBNET_LABEL.gap * scale / 2) < 0.0001, "the lower-left corner stays by the zone midpoint at every zoom");
    const longer = subnetLabelRect(anchor, 200 * scale, 28 * scale, scale);
    assert.equal(longer.x, rect.x, "longer names grow to the right without detaching their corner anchor");
    const panned = subnetLabelRect({ x: anchor.x - 400, y: anchor.y + 300 }, rect.width, rect.height, scale);
    assert.ok(Math.abs(panned.x - rect.x + 400) < 0.0001 && Math.abs(panned.y - rect.y - 300) < 0.0001);
  }
});

test("the trailing heading balances its midpoint and the painted VPC end cap along the rim", () => {
  const anchor = { x: 350, y: 200 }, width = 120, height = 28;
  const free = subnetLabelRect(anchor, width, height, 1);
  const capped = subnetLabelRect(anchor, width, height, 1, 400);
  const fullyCappedX = 400 + SUBNET_LABEL.gap - width;
  assert.equal(capped.x, (free.x + fullyCappedX) / 2, "the trailing name sits halfway between the two placements");
  assert.equal(capped.y - free.y, (capped.x - free.x) / 2, "the heading stays beside the same rim rather than drifting horizontally");
  const publicAnchor = { x: 100, y: 75 };
  assert.deepEqual(subnetLabelRect(publicAnchor, width, height, 1, 400), subnetLabelRect(publicAnchor, width, height, 1), "earlier headings keep their corner alignment");
  const panned = subnetLabelRect({ x: anchor.x - 800, y: anchor.y + 300 }, width, height, 1, 400 - 800);
  assert.equal(panned.x, capped.x - 800);
  assert.equal(panned.y, capped.y + 300, "the end cap belongs to terrain, so viewport edges never relocate it");
});

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
