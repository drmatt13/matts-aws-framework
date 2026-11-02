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

test("the composition objective prefers breathing room to legal but tightly packed islands, while bounding sprawl", () => {
  const { islands, graph } = fixture();
  const compact = measureLayout(islands, graph, rectangle(islands, 464, 336));
  const spacious = measureLayout(islands, graph, rectangle(islands, 640, 480));
  const sprawling = measureLayout(islands, graph, rectangle(islands, 3200, 2400));
  assert.equal(compact.islandOverlaps + compact.labelOverlaps, 0, "the compact comparison is legal");
  assert.equal(spacious.islandOverlaps + spacious.labelOverlaps, 0);
  assert.ok(spacious.cost < compact.cost, `negative space improves the objective: ${compact.cost} -> ${spacious.cost}`);
  assert.ok(sprawling.cost > spacious.cost, "long routes and excessive empty canvas still have a cost");
});

test("the composition objective uses horizontal room according to the viewport rather than demanding the same shape everywhere", () => {
  const { islands, graph } = fixture();
  const narrow = rectangle(islands, 500, 800);
  const wide = rectangle(islands, 1000, 800);
  const desktop = { narrow: measureLayout(islands, graph, narrow, 16 / 9), wide: measureLayout(islands, graph, wide, 16 / 9) };
  const portrait = { narrow: measureLayout(islands, graph, narrow, 0.9), wide: measureLayout(islands, graph, wide, 0.9) };
  assert.ok(desktop.wide.utilization > desktop.narrow.utilization);
  assert.ok(desktop.wide.cost < desktop.narrow.cost, "a desktop composition can spend spare horizontal space");
  assert.ok(portrait.narrow.cost < portrait.wide.cost, "the same expansion is unnecessary in a tall viewport");
});

test("preferred spacing responds to labels and connection density even before painted elements overlap", () => {
  const { islands, graph } = fixture();
  const positions = rectangle(islands, 800, 336);
  const shortNames = measureLayout(islands, graph, positions);
  const longNames = measureLayout(islands.map((island) => ({ ...island, title: `${island.title} configuration services` })), graph, positions);
  const busy = measureLayout(islands, fixture(4, true).graph, positions);
  assert.equal(shortNames.islandOverlaps + shortNames.labelOverlaps + longNames.labelOverlaps, 0, "all comparisons are drawable");
  assert.ok(longNames.crowding > shortNames.crowding, "longer external names ask for more breathing room");
  assert.ok(busy.crowding > shortNames.crowding, "additional neighbor corridors ask for more breathing room");
});

test("fresh compositions retain visible separation across sparse and dense topology and desktop aspects", () => {
  for (const dense of [false, true]) for (const aspect of [4 / 3, 16 / 9, 2.5]) {
    const { islands, graph } = fixture(7, dense, true);
    const result = optimizeLayout(islands, graph, { aspect });
    const { nearest } = geometry(islands, result.positions, aspect);
    assert.equal(result.after.islandOverlaps + result.after.labelOverlaps, 0);
    assert.ok(nearest.every((gap) => gap >= ISLAND_CLEARANCE - 1e-6), "all painted islands retain their hard clearance");
    const median = [...nearest].sort((a, b) => a - b)[Math.floor(nearest.length / 2)]!;
    assert.ok(median > ISLAND_CLEARANCE * 1.5, `most islands have breathing room (${dense ? "dense" : "sparse"}, ${aspect}): ${median}`);
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
