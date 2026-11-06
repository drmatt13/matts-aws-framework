import assert from "./support/assert";
import { test } from "node:test";
import type { ModelEdge } from "../shared/model";
import type { IslandFootprint, IslandPosition } from "../src/scene/layout";
import { extractLayoutGraph } from "../src/scene/layout-graph";
import { optimizeLayout } from "../src/scene/layout-optimize";
import { layoutFrame, measureLayout } from "../src/scene/layout-quality";
import { ISLAND_CLEARANCE, islandShape, separation, UNIT_X, UNIT_Y } from "../src/scene/layout-shape";

/** Small names keep these comparisons about spatial composition rather than label overlap. */
function fixture(count = 4, dense = false, varied = false) {
  const islands: IslandFootprint[] = Array.from({ length: count }, (_, at) => {
    const width = varied ? 4 + at % 3 * 4 : 6, length = varied ? 4 + at % 2 * 6 : 6;
    return { id: `service:${at}`, title: String.fromCharCode(65 + at), region: "compute", size: width + length,
      ground: { width, length, inset: 0, top: 2, base: -1 } };
  });
  const anchors = islands.map((island) => ({ id: `${island.id}/node`, island: island.id, ...islandShape(island).centre }));
  const edges: ModelEdge[] = [];
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
    if (!dense && b !== a + 1) continue;
    edges.push({ id: `edge:${a}:${b}`, from: anchors[a]!.id, to: anchors[b]!.id, relation: "supplies", label: "fixture", provenance: "declared" });
  }
  return { islands, graph: extractLayoutGraph(anchors, edges) };
}

/** Four identical islands, two per row; only their origins change between comparisons. */
function rectangle(islands: readonly IslandFootprint[], width: number, height: number): IslandPosition[] {
  return islands.map((island, at) => ({ id: island.id, left: at % 2 * width / UNIT_X, top: Math.floor(at / 2) * height / UNIT_Y }));
}

function geometry(islands: readonly IslandFootprint[], positions: readonly IslandPosition[], aspect = 16 / 9) {
  const frame = layoutFrame(islands, islands.map(islandShape), positions, aspect);
  const nearest = frame.bodies.map((body, at) => Math.min(...frame.bodies.flatMap((other, index) => index === at ? [] : [separation(body, other)])));
  return { frame, nearest };
}

test("the composition objective compacts legal islands while rejecting collisions and sprawl", () => {
  const { islands, graph } = fixture();
  const compact = measureLayout(islands, graph, rectangle(islands, 464, 336));
  const spacious = measureLayout(islands, graph, rectangle(islands, 640, 480));
  const sprawling = measureLayout(islands, graph, rectangle(islands, 3200, 2400));
  assert.equal(compact.islandOverlaps + compact.labelOverlaps, 0, "the compact comparison is legal");
  assert.equal(spacious.islandOverlaps + spacious.labelOverlaps, 0);
  assert.ok(compact.length < spacious.length, "compact routes are shorter");
  assert.ok(compact.fill > spacious.fill, "compact islands occupy more of the fitted overview");
  assert.ok(compact.cost < spacious.cost, "unused space does not buy a better connected composition");
  const colliding = measureLayout(islands, graph, rectangle(islands, 100, 100));
  assert.ok(colliding.islandOverlaps > 0);
  assert.ok(colliding.cost > sprawling.cost, "clearance takes priority over short routes and high fill");
  assert.ok(sprawling.cost > spacious.cost, "long routes and excessive empty canvas still have a cost");
});

test("the composition objective uses horizontal room according to the viewport rather than demanding the same shape everywhere", () => {
  const { islands, graph } = fixture();
  const narrow = rectangle(islands, 500, 800);
  const wide = rectangle(islands, 1000, 800);
  // Isolate viewport preference from the longer routes introduced by expansion.
  const unconnected = { ...graph, links: [], islands: [], flows: [] };
  const desktop = { narrow: measureLayout(islands, unconnected, narrow, 16 / 9), wide: measureLayout(islands, unconnected, wide, 16 / 9) };
  const portrait = { narrow: measureLayout(islands, unconnected, narrow, 0.9), wide: measureLayout(islands, unconnected, wide, 0.9) };
  assert.ok(desktop.wide.utilization > desktop.narrow.utilization);
  assert.ok(desktop.wide.cost < desktop.narrow.cost, "a desktop composition can spend spare horizontal space");
  assert.ok(portrait.narrow.cost < portrait.wide.cost, "the same expansion is unnecessary in a tall viewport");
  const connected = { narrow: measureLayout(islands, graph, narrow, 16 / 9), wide: measureLayout(islands, graph, wide, 16 / 9) };
  assert.ok(connected.wide.utilization > connected.narrow.utilization);
  assert.ok(connected.wide.length > connected.narrow.length);
  assert.ok(connected.wide.cost > connected.narrow.cost, "aspect alone cannot erase the cost of longer wires");
});

test("title envelopes and angular congestion account for names and dense connection corridors", () => {
  const { islands, graph } = fixture();
  const positions = rectangle(islands, 800, 336);
  const shortNames = measureLayout(islands, graph, positions);
  const longNames = measureLayout(islands.map((island) => ({ ...island, title: `${island.title} configuration services` })), graph, positions);
  const busy = measureLayout(islands, fixture(4, true).graph, positions);
  assert.equal(shortNames.islandOverlaps + shortNames.labelOverlaps + longNames.labelOverlaps, 0, "all comparisons are drawable");
  const shortFrame = geometry(islands, positions).frame;
  const longFrame = geometry(islands.map(island => ({ ...island, title: `${island.title} configuration services` })), positions).frame;
  assert.deepEqual(longFrame.bodies, shortFrame.bodies, "labels never resize the terrain");
  for (const [at, title] of longFrame.titles.entries()) {
    assert.equal(title.x1, shortFrame.titles[at]!.x1, "both titles anchor to the same island flank");
    assert.ok(title.x0 < shortFrame.titles[at]!.x0, "longer names reserve more room to the left");
  }
  assert.ok(busy.congestion > shortNames.congestion, "more bundles sharing narrow departure angles cost more");
});

test("fresh compositions retain visible separation across sparse and dense topology and desktop aspects", () => {
  for (const dense of [false, true]) for (const aspect of [4 / 3, 16 / 9, 2.5]) {
    const { islands, graph } = fixture(7, dense, true);
    const result = optimizeLayout(islands, graph, { aspect });
    const { nearest } = geometry(islands, result.positions, aspect);
    assert.equal(result.after.islandOverlaps + result.after.labelOverlaps, 0);
    assert.ok(nearest.every((gap) => gap >= ISLAND_CLEARANCE - 1e-6), "all painted islands retain their hard clearance");
    assert.ok(result.after.cost <= result.before.cost, "the solve does not worsen its legalized semantic seed");
    assert.deepEqual(result.positions.map(position => position.id).sort(), islands.map(island => island.id).sort(), "every island is placed exactly once");
    for (const position of result.positions) {
      const island = islands.find(item => item.id === position.id)!;
      assert.ok(Number.isInteger(position.left) && Number.isInteger(position.top), "origins lie on the ground lattice");
      assert.equal(Math.abs((position.left + position.top + island.ground!.length) % 2), 0, "the renderer preserves the evaluated terrain footprint");
    }
    assert.ok(result.evaluations <= 720);
  }
});

test("spacious compositions remain deterministic, reuse exact positions and honor manual constraints during edits", () => {
  const { islands, graph } = fixture(7);
  const first = optimizeLayout(islands, graph);
  const repeat = optimizeLayout([...islands].reverse(), graph, { pins: {} });
  assert.deepEqual(repeat.positions, first.positions, "a fresh uncached solve is independent of declaration order");
  const unchanged = optimizeLayout(islands, graph, { previous: first.positions, previousKey: first.topologyKey, previousFingerprints: first.fingerprints });
  assert.deepEqual(unchanged.positions, first.positions);
  assert.equal(unchanged.evaluations, 0);

  const pin = first.positions[0]!;
  const fixed = optimizeLayout(islands, graph, { pins: { [pin.id]: pin } });
  const added: IslandFootprint = { ...islands[0]!, id: "new-service", title: "New" };
  const edited = optimizeLayout([...islands, added], graph, {
    previous: fixed.positions, previousKey: fixed.topologyKey, previousFingerprints: fixed.fingerprints, pins: { [pin.id]: pin },
  });
  assert.equal(edited.strategy, "incremental");
  assert.deepEqual(edited.positions.find((p) => p.id === pin.id), pin, "a manually constrained island never yields to spacing preferences");
  for (const position of fixed.positions) {
    assert.deepEqual(edited.positions.find((p) => p.id === position.id), position, "adding an unrelated island preserves the settled composition");
  }
  assert.equal(edited.after.islandOverlaps + edited.after.labelOverlaps, 0);
});
