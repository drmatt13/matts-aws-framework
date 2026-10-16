import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { atlasPixels, CELL, SPRITE, spriteOrigin, spritePixels } from "../src/scene/atlas";
import { buildScene, MATERIALS, type Scene } from "../src/scene/build";
import { fitBounds, pan, screenToWorld, wheelFactor, worldToScreen, zoomAt, MAX_ZOOM, MIN_ZOOM, type Camera } from "../src/scene/camera";
import { project, unprojectAt } from "../src/scene/iso";
import { acceptCards, distanceToPolyline, insidePolygon, pickEntity, pickTile, tilePolygons } from "../src/scene/picking";
import { buildShape, type ShapeKind } from "../src/scene/shapes";

/**
 * The landscape is a view, and these hold it to that: every entity of the real
 * repository stands in it exactly once under its own id, it stands still when
 * the graph changes mode, what it shows of each entity is what the model says,
 * and the camera and picker put the pointer where the eye does.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");
let builder: SnapshotBuilder;
let snapshot: Snapshot;
let dev: Scene;
let prod: Scene;

before(async () => {
  builder = new SnapshotBuilder(repositoryRoot);
  snapshot = (await builder.refresh()).snapshot;
  dev = buildScene(snapshot.models.dev, { webSocketApi: snapshot.webSocketApi });
  prod = buildScene(snapshot.models.prod, { webSocketApi: snapshot.webSocketApi });
});
after(() => builder.dispose());

// ---------------------------------------------------------------------------
// The scene, from the real repository
// ---------------------------------------------------------------------------

test("every route, target and catalog entry stands exactly once, under its own id", () => {
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const expected = [...model.routes.map((route) => route.id), ...model.targets.map((target) => target.ref), ...model.resources.map((resource) => resource.id)].sort();
    assert.deepEqual(scene.nodes.map((node) => node.id).sort(), expected);
    const cells = new Set(scene.nodes.map((node) => `${node.gx},${node.gy}`));
    assert.equal(cells.size, scene.nodes.length, "two buildings share a cell");
  }
});

test("every edge is the model's own, with its relation", () => {
  assert.deepEqual(
    dev.edges.map((edge) => edge.edge.id).sort(),
    snapshot.models.dev.edges.filter((edge) => edge.from !== edge.to).map((edge) => edge.id).sort(),
  );
});

test("buildings stand on their island's ground, at its height", () => {
  const tiles = new Map(dev.tiles.map((tile) => [`${tile.gx},${tile.gy}`, tile]));
  for (const node of dev.nodes) {
    const tile = tiles.get(`${node.gx},${node.gy}`);
    assert.ok(tile, `${node.id} stands on no tile`);
    assert.equal(tile.island, node.island);
    assert.equal(tile.h, node.h);
  }
  const islands = new Set<string>();
  for (const tile of dev.tiles) {
    const key = `${tile.gx},${tile.gy}`;
    assert.ok(!islands.has(key), `${key} belongs to two islands`);
    islands.add(key);
  }
});

test("switching the graph changes what is shown, never where it stands", () => {
  const place = (scene: Scene) => new Map(scene.nodes.map((node) => [node.id, `${node.gx},${node.gy},${node.h}`]));
  assert.deepEqual(place(prod), place(dev));
  assert.deepEqual(prod.bounds, dev.bounds);
  // Deterministic: the same model lays out the same way twice.
  assert.deepEqual(buildScene(snapshot.models.dev, { webSocketApi: snapshot.webSocketApi }).nodes.map((node) => [node.id, node.gx, node.gy]), dev.nodes.map((node) => [node.id, node.gx, node.gy]));
});

test("what a building shows of an entity follows the model's lanes and absence", () => {
  const node = (scene: Scene, id: string) => scene.nodes.find((candidate) => candidate.id === id)!;
  // graphql-api runs under Compose in development and is built by production.
  assert.equal(node(dev, "lambda:graphql-api").presence, "local");
  assert.equal(node(prod, "lambda:graphql-api").presence, "built");
  // AWS invokes the Cognito triggers, so a development deployment builds them too.
  assert.equal(node(dev, "lambda:cognito-pre-signup-trigger").presence, "built");
  // db-migrate is cloud-only: absent from the local lane and from a development deployment.
  assert.equal(node(dev, "task:db-migrate").presence, "other");
  // The catalog says what each graph holds.
  assert.equal(node(dev, "resource:rds.database").presence, "absent");
  assert.equal(node(prod, "resource:rds.database").presence, "present");
  assert.equal(node(prod, "resource:workflowFixtures.fixtureTable").presence, "absent");
  // The route follows its target.
  assert.equal(node(dev, "route:http:/graphql").presence, node(dev, "lambda:graphql-api").presence);
});

test("compute stands where it runs, and the VPC is a blueprint where it is not built", () => {
  const islandOf = (id: string) => dev.nodes.find((node) => node.id === id)!.island;
  const bandOf = (id: string) => {
    const node = dev.nodes.find((candidate) => candidate.id === id)!;
    return dev.tiles.find((tile) => tile.gx === node.gx && tile.gy === node.gy)!.band;
  };
  for (const target of snapshot.models.dev.targets) {
    if (target.placement.kind === "vpc") {
      assert.equal(islandOf(target.ref), "island:vpc", target.ref);
      assert.equal(bandOf(target.ref), `band:${target.placement.subnet}`, target.ref);
    } else {
      assert.notEqual(islandOf(target.ref), "island:vpc", target.ref);
    }
  }
  const vpc = (scene: Scene) => scene.islands.find((island) => island.id === "island:vpc")!;
  assert.equal(vpc(dev).ghost, "blueprint");
  assert.equal(vpc(prod).ghost, snapshot.models.prod.network?.builtInProd ? undefined : "blueprint");
  // The terraces step down from public to isolated, so each step's wall faces the viewer.
  const heights = vpc(dev).bands.map((band) => band.h);
  assert.deepEqual([...heights].sort((a, b) => b - a), heights);
  assert.equal(dev.islands.find((island) => island.id === "island:resource:rds")!.ghost, "absent");
});

test("walls show only where the ground falls away", () => {
  const tiles = new Map(dev.tiles.map((tile) => [`${tile.gx},${tile.gy}`, tile]));
  for (const tile of dev.tiles) {
    const left = tiles.get(`${tile.gx},${tile.gy + 1}`);
    if (left && left.island === tile.island && left.h === tile.h) assert.equal(tile.wallLeft, undefined, "an internal wall between level tiles");
    if (left && left.island === tile.island && left.h < tile.h) assert.equal(tile.wallLeft, left.h);
    if (!left || left.island !== tile.island) assert.ok(tile.rimLeft && tile.wallLeft !== undefined && tile.wallLeft < tile.h);
  }
});

test("painter's order: tiles and buildings by diagonal row, back to front", () => {
  for (const list of [dev.tiles, dev.nodes]) {
    for (let index = 1; index < list.length; index += 1) {
      assert.ok(list[index - 1]!.gx + list[index - 1]!.gy <= list[index]!.gx + list[index]!.gy);
    }
  }
});

// ---------------------------------------------------------------------------
// Projection and camera
// ---------------------------------------------------------------------------

test("unprojecting at a tile's height returns the tile", () => {
  for (const point of [{ x: 3, y: 1, h: 4 }, { x: -2.5, y: 7, h: 1 }, { x: 0, y: 0, h: 0 }]) {
    assert.deepEqual(unprojectAt(project(point), point.h), point);
  }
});

test("zooming keeps the world point under the pointer within a pixel", () => {
  const viewports = [{ width: 1600, height: 948 }, { width: 390, height: 700 }, { width: 2560, height: 1300 }];
  for (const viewport of viewports) {
    let camera: Camera = { x: 812, y: 455, zoom: 0.62 };
    for (const anchor of [{ x: 10, y: 20 }, { x: viewport.width / 2, y: viewport.height / 2 }, { x: viewport.width - 3, y: viewport.height - 7 }]) {
      for (const delta of [-120, -3, 53, 360, -900]) {
        const world = screenToWorld(camera, viewport, anchor);
        camera = zoomAt(camera, viewport, anchor, wheelFactor(delta, 0, viewport.height));
        const after = worldToScreen(camera, viewport, world);
        assert.ok(Math.hypot(after.x - anchor.x, after.y - anchor.y) < 1, `drifted at zoom ${camera.zoom}`);
        assert.ok(camera.zoom >= MIN_ZOOM && camera.zoom <= MAX_ZOOM);
      }
    }
  }
});

test("wheel deltas in lines, pages and pixels zoom alike, and scrolling down zooms out", () => {
  assert.ok(wheelFactor(100, 0, 800) < 1);
  assert.ok(wheelFactor(-100, 0, 800) > 1);
  assert.equal(wheelFactor(3, 1, 800), wheelFactor(48, 0, 800));
});

test("a drag moves the world with the pointer, and fitting shows the whole scene", () => {
  const viewport = { width: 1200, height: 800 };
  const camera: Camera = { x: 100, y: 50, zoom: 1.5 };
  const grabbed = screenToWorld(camera, viewport, { x: 300, y: 300 });
  const moved = pan(camera, 40, -25);
  const now = worldToScreen(moved, viewport, grabbed);
  assert.ok(Math.abs(now.x - 340) < 1e-9 && Math.abs(now.y - 275) < 1e-9);

  const fitted = fitBounds(dev.bounds, viewport, 40);
  for (const corner of [
    { x: dev.bounds.minX, y: dev.bounds.minY },
    { x: dev.bounds.maxX, y: dev.bounds.maxY },
  ]) {
    const screen = worldToScreen(fitted, viewport, corner);
    if (fitted.zoom > MIN_ZOOM) {
      assert.ok(screen.x >= 39 && screen.x <= viewport.width - 39 && screen.y >= 39 && screen.y <= viewport.height - 39);
    }
  }
});

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

test("overlapping cards pick the one painted last, and a card wins over a building", () => {
  const cards = [
    { id: "back", x: 100, y: 100, width: 120, height: 22 },
    { id: "front", x: 150, y: 110, width: 120, height: 22 },
  ];
  const buildings = [{ id: "building", hull: [0, 0, 1000, 0, 1000, 1000, 0, 1000] }];
  assert.equal(pickEntity({ x: 160, y: 115 }, { x: 160, y: 115 }, cards, buildings), "front");
  assert.equal(pickEntity({ x: 110, y: 105 }, { x: 110, y: 105 }, cards, buildings), "back");
  assert.equal(pickEntity({ x: 500, y: 500 }, { x: 500, y: 500 }, cards, buildings), "building");
  assert.equal(pickEntity({ x: 500, y: 500 }, { x: 2000, y: 2000 }, cards, buildings), undefined);
});

test("label cards never overlap, and the selection always keeps its card", () => {
  // A crowd of cards around one point, as a zoomed-out spotlight produces.
  const candidates = Array.from({ length: 12 }, (_, order) => ({
    id: `card-${order}`,
    order,
    priority: order === 3 ? 3 : order % 4 === 0 ? 1 : 0,
    x: 100 + (order % 4) * 40,
    y: 100 + Math.floor(order / 4) * 12,
    width: 110,
    height: 20,
  }));
  const kept = acceptCards(candidates);
  assert.ok(kept.some((card) => card.id === "card-3"), "the selection's card was dropped");
  for (let a = 0; a < kept.length; a += 1) {
    for (let b = a + 1; b < kept.length; b += 1) {
      const one = kept[a]!;
      const two = kept[b]!;
      assert.ok(!(one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height), `${one.id} overlaps ${two.id}`);
    }
  }
  assert.deepEqual(kept.map((card) => card.order), [...kept.map((card) => card.order)].sort((x, y) => x - y), "kept cards stay in painter's order");
});

test("buildings overlapping on screen pick the one in front, by silhouette", () => {
  // Two buildings a diagonal row apart: the front one's roof covers the back one's base.
  const back = buildShape("service", project({ x: 4, y: 4, h: 2 }).x, project({ x: 4, y: 4, h: 2 }).y);
  const frontAnchor = project({ x: 5, y: 4, h: 4 });
  const front = buildShape("service", frontAnchor.x, frontAnchor.y);
  const both = [
    { id: "back", hull: back.hull },
    { id: "front", hull: front.hull },
  ];
  let overlap: { x: number; y: number } | undefined;
  for (let x = frontAnchor.x - 40; x <= frontAnchor.x + 40 && !overlap; x += 1) {
    for (let y = frontAnchor.y - 80; y <= frontAnchor.y + 20; y += 1) {
      if (insidePolygon(x, y, back.hull) && insidePolygon(x, y, front.hull)) {
        overlap = { x, y };
        break;
      }
    }
  }
  assert.ok(overlap, "the fixture's silhouettes should overlap");
  assert.equal(pickEntity(overlap, overlap, [], both), "front");
});

test("terrain is picked at its own height: a raised tile in front hides the ground behind it", () => {
  const behind = { gx: 3, gy: 3, h: 0 };
  const raised = { gx: 4, gy: 4, h: 3, wallLeft: 0, wallRight: 0 };
  // A point on the raised tile's top face, which a ground-plane inverse would place behind it.
  const onTop = project({ x: 4, y: 4, h: 3 });
  const ground = unprojectAt(onTop, 0);
  assert.ok(ground.x < 4 && ground.y < 4, "the ground-plane inverse lands behind the raised tile");
  assert.equal(pickTile(onTop, [behind, raised]), raised);
  // And on its wall.
  const wall = tilePolygons(raised)[1]!;
  const onWall = { x: (wall[0]! + wall[2]! + wall[4]! + wall[6]!) / 4, y: (wall[1]! + wall[3]! + wall[5]! + wall[7]!) / 4 };
  assert.equal(pickTile(onWall, [behind, raised]), raised);
});

test("picking a real building through the camera finds the entity at the pointer", () => {
  const viewport = { width: 1400, height: 900 };
  const silhouettes = dev.nodes.map((node) => ({ id: node.id, hull: node.geometry.hull }));
  for (const zoom of [0.5, 1, 2.2]) {
    let checked = 0;
    dev.nodes.forEach((node, position) => {
      const hull = node.geometry.hull;
      let x = 0;
      let y = 0;
      for (let index = 0; index < hull.length; index += 2) {
        x += hull[index]!;
        y += hull[index + 1]!;
      }
      const centroid = { x: x / (hull.length / 2), y: y / (hull.length / 2) };
      // Skip a building whose middle another, painted later, stands in front of.
      if (dev.nodes.slice(position + 1).some((other) => insidePolygon(centroid.x, centroid.y, other.geometry.hull))) return;
      const camera: Camera = { x: centroid.x + 37, y: centroid.y - 21, zoom };
      const screen = worldToScreen(camera, viewport, centroid);
      assert.equal(pickEntity(screen, screenToWorld(camera, viewport, screen), [], silhouettes), node.id, `zoom ${zoom}`);
      checked += 1;
    });
    assert.ok(checked >= dev.nodes.length * 0.9, `only ${checked} of ${dev.nodes.length} buildings were unobstructed`);
  }
});

// ---------------------------------------------------------------------------
// Sprites and shapes
// ---------------------------------------------------------------------------

test("a block sprite is a diamond top over a one-step skirt, scaled, never squashed", () => {
  const sprite = spritePixels("granite", 0, 3);
  const alpha = (x: number, y: number) => sprite[(y * SPRITE + x) * 4 + 3];
  assert.equal(alpha(16, 16), 255, "the top's centre");
  assert.equal(alpha(15, 8), 255, "the north corner, row 8");
  assert.equal(alpha(0, 0), 0, "outside the block");
  assert.equal(alpha(16, 6), 0, "above the north corner");
  assert.equal(alpha(15, 30), 255, "the skirt, below the south corner");
  assert.equal(alpha(31, 31), 0, "below the east corner's skirt");
});

test("the atlas extrudes each sprite's edge into its cell, so sampling never bleeds", () => {
  const { width, pixels } = atlasPixels();
  for (const material of [MATERIALS[0]!, MATERIALS[MATERIALS.length - 1]!]) {
    const origin = spriteOrigin(material, 2, 5);
    const at = (x: number, y: number) => pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4).join(",");
    // The pixel left of the sprite repeats the sprite's own first column.
    assert.equal(at(origin.x - 1, origin.y + 16), at(origin.x, origin.y + 16));
    assert.equal(at(origin.x + SPRITE, origin.y + 16), at(origin.x + SPRITE - 1, origin.y + 16));
    assert.equal((origin.x - 1) % CELL, 0);
  }
});

test("every building's silhouette contains everything it paints, and rises from its tile", () => {
  const kinds: ShapeKind[] = ["gate", "mount", "pylon", "portal", "lambda", "service", "task", "workflow", "agent", "stack", "group", "table", "bucket", "queue", "topic", "bus", "userpool", "database", "value", "secret", "input", "construct"];
  for (const kind of kinds) {
    const shape = buildShape(kind, 100, 200, "lambda");
    assert.ok(shape.top.y < 200, kind);
    for (const face of shape.faces) {
      for (let index = 0; index < face.points.length; index += 2) {
        const point = { x: face.points[index]!, y: face.points[index + 1]! };
        // Inside, or on the silhouette's edge.
        const outline = [...shape.hull, shape.hull[0]!, shape.hull[1]!];
        const edge = distanceToPolyline(point, Array.from({ length: outline.length / 2 }, (_, at) => ({ x: outline[at * 2]!, y: outline[at * 2 + 1]! })));
        assert.ok(insidePolygon(point.x, point.y, shape.hull) || edge < 1e-6, `${kind} paints outside its silhouette`);
      }
    }
  }
});
