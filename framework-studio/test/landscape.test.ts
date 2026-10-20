import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { offLens, restingAlpha } from "../src/scene/connections";
import { buildScene, chamfered, chamferSize, titleRoom, type Island, type Scene } from "../src/scene/build";
import { fitBounds, pan, resizeCamera, screenToWorld, wheelFactor, worldToScreen, zoomAt, MAX_ZOOM, MIN_ZOOM, type Camera } from "../src/scene/camera";
import { project, unprojectAt } from "../src/scene/iso";
import { acceptCards, distanceToPolyline, insidePolygon, pickEntity, pickIsland, surfaceOutline } from "../src/scene/picking";
import { buildIconShape, ICON_BADGE } from "../src/scene/shapes";
import { backgroundGrid } from "../src/scene/grid";
import { islandFrame } from "../src/scene/frame";
import { API_EDGE_COLOR, BAND_TRIM, COMPUTE_EDGE_COLOR, DECK, EDGE_COLORS, GRAPHITE, GUARD_EDGE_COLOR, ICON_TINT, ISLAND_TRIM, READ_EDGE_COLOR, ROLE_BADGE, STEP_EDGE_COLOR, TOOL_EDGE_COLOR, TRIGGER_EDGE_COLOR, trimColor } from "../src/scene/look";
import { behind, islandDrawOrder, islandSlabs, polygonArea, type IslandSlab } from "../src/scene/slabs";
import { carriesOwnTile, ICONS } from "../src/icons";
import { catalogAvailability, connectionDisabledEndpoints } from "../src/deployment";
import { indexModel } from "../src/lookup";
import { existsSync, readFileSync } from "node:fs";
import { landscapeFocus, searchOpacity, searchScene, SEARCH_FADE } from "../src/scene/focus";
import { layoutIslands, type IslandFootprint } from "../src/scene/layout";
import { aggregateConnections, connectionLabel } from "../src/connections";

/**
 * The landscape is a view, and these hold it to that: every entity of the real
 * repository stands in it under its own id (stack fields use their parent), it stands still when
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
  const resourceAvailability = catalogAvailability(snapshot.models);
  dev = buildScene(snapshot.models.dev, { webSocketApi: snapshot.webSocketApi, resourceAvailability, layoutModels: Object.values(snapshot.models) });
  prod = buildScene(snapshot.models.prod, { webSocketApi: snapshot.webSocketApi, resourceAvailability, layoutModels: Object.values(snapshot.models) });
});
after(() => builder.dispose());

test("connection labels reflect relationships and both endpoints in each graph", () => {
  for (const scene of [dev, prod]) for (const group of scene.edges) {
    for (const mode of ["dev", "prod"] as const) {
      const index = indexModel(snapshot.models[mode]);
      const enabled = group.members.some((member) => member.models[mode] && connectionDisabledEndpoints(index, mode, member.models[mode]!).length === 0);
      assert.equal(group.availability[mode], enabled, `${group.id}: ${mode}`);
    }
    assert.equal(group.badge, group.availability.dev && group.availability.prod ? undefined : group.availability.dev ? "dev" : group.availability.prod ? "prod" : "off");
  }
  assert.equal(dev.edges.find((group) => group.from === "client-envfile" && group.to === "envfile:dev")?.members.length, 4);
  assert.equal(connectionLabel(dev.edges.find((group) => group.from === "client-envfile" && group.to === "envfile:dev")!), "4 · Dev");
});

test("aggregation keeps per-mode evidence, direction and stable identities", () => {
  const read = snapshot.models.dev.edges.find((edge) => edge.relation === "env" && edge.to.startsWith("resource:cognito."))!;
  assert.ok(read);
  const second = { ...read, id: "fixture:second", label: "second field", to: "resource:cognito" };
  const reverse = { ...second, id: "fixture:reverse", from: second.to, to: second.from };
  const devModel = { ...snapshot.models.dev, edges: [read, second, reverse] };
  const prodModel = { ...snapshot.models.prod, edges: [{ ...read, detail: "Production evidence" }] };
  const groups = aggregateConnections(devModel, [devModel, prodModel]);
  const group = groups.find((item) => item.from === read.from)!;
  assert.equal(group.members.length, 2);
  assert.equal(groups.length, 2, "opposite directions remain distinct");
  assert.equal(group.members.find((member) => member.edge.id === read.id)?.models.prod?.detail, "Production evidence");
  assert.equal(group.members.find((member) => member.edge.id === second.id)?.availability.prod, false);
  assert.deepEqual(groups.map((item) => item.id), aggregateConnections(prodModel, [prodModel, devModel]).map((item) => item.id));
  assert.deepEqual(groups.map((item) => item.id), aggregateConnections({ ...devModel, edges: [...devModel.edges].reverse() }, [prodModel]).map((item) => item.id));
});

test("replay-enabled event connections reach the displayed replay stack through the shared router", () => {
  for (const scene of [dev, prod]) {
    const replay = scene.nodes.find((node) => node.id === "framework-stack:DevLambdaReplayStack")!;
    assert.ok(replay);
    const edges = scene.edges.filter((edge) => edge.edge.relation === "localReplay");
    assert.ok(edges.length);
    for (const edge of edges) {
      assert.equal(edge.to, replay.id);
      assert.ok(scene.nodes.some((node) => node.id === edge.from));
      assert.ok(scene.routes[edge.id]);
    }
  }
});

test("map search matches names and multiple case-insensitive terms without changing scene geometry", () => {
  assert.equal(searchScene(dev, snapshot.models.dev, "  "), undefined);
  const before = JSON.stringify(dev);
  const result = searchScene(dev, snapshot.models.dev, "  GRAPHQL  ")!;
  assert.ok(result.nodes.has("lambda:graphql-api"));
  assert.ok(result.nodes.has("route:http:/graphql"));
  assert.ok(!result.nodes.has("lambda:sign-in"));
  assert.ok(searchScene(dev, snapshot.models.dev, "HTTP graphql")!.nodes.has("lambda:graphql-api"));
  assert.equal(searchScene(dev, snapshot.models.dev, "graphql nonexistentword")!.nodes.size, 0);
  assert.equal(JSON.stringify(dev), before);
});

test("map search includes input environment names, stack fields and workload source identities", () => {
  const model = snapshot.models.dev;
  assert.ok(searchScene(dev, model, "LANGGRAPH_OPENAI_MODEL_ID")!.nodes.has("resource:langgraph.openaiModelId"));
  const member = model.resources.find((resource) => resource.kind === "member" && /UserPool$/.test(resource.typeText ?? ""))!;
  assert.ok(member.parent);
  assert.ok(searchScene(dev, model, member.typeText!)!.nodes.has(member.parent));
  assert.ok(searchScene(dev, model, "/lambda_functions/http_functions/graphql-api")!.nodes.has("lambda:graphql-api"));
});

test("island and subnet searches highlight their members, while endpoint searches include service badges", () => {
  const matches = searchScene(dev, snapshot.models.dev, "Serverless compute")!;
  assert.ok(matches.islands.has("island:lambda"));
  assert.ok(dev.nodes.filter((node) => node.island === "island:lambda").every((node) => matches.nodes.has(node.id)));
  assert.ok(!matches.islands.has("island:apis"));
  const model = snapshot.models.prod;
  const withEndpoints = { ...model, network: { ...model.network!, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["lambda"] } };
  const scene = buildScene(withEndpoints);
  const endpoint = searchScene(scene, withEndpoints, "dynamodb")!;
  assert.ok(endpoint.props.has("prop:endpoint:dynamodb"));
  const subnet = searchScene(scene, withEndpoints, "Private subnet")!;
  assert.ok(scene.nodes.filter((node) => node.band === "band:private").every((node) => subnet.nodes.has(node.id)));
});

test("selection overrides search and clearing it restores the original matching view", () => {
  const matches = searchScene(dev, snapshot.models.dev, "graphql")!;
  const filtered = landscapeFocus(dev, undefined, matches);
  assert.equal(filtered.kind, "search");
  assert.equal(searchOpacity(filtered, "nodes", "lambda:graphql-api"), 1);
  assert.equal(searchOpacity(filtered, "nodes", "lambda:sign-in"), SEARCH_FADE);
  const selected = landscapeFocus(dev, "lambda:sign-in", matches);
  assert.equal(selected.kind, "selection");
  assert.ok(selected.nodes.has("lambda:sign-in"));
  assert.equal(searchOpacity(selected, "nodes", "lambda:sign-in"), 1);
  const restored = landscapeFocus(dev, undefined, matches);
  assert.equal(restored.kind, "search");
  assert.equal(restored.nodes, matches.nodes);
  assert.equal(searchOpacity(restored, "nodes", "lambda:sign-in"), SEARCH_FADE);
  assert.equal(landscapeFocus(dev).kind, "all");
});

test("a zero-result search fades all layers and an island selection still overrides it", () => {
  const matches = searchScene(dev, snapshot.models.dev, "no-such-entity-987654")!;
  const focus = landscapeFocus(dev, undefined, matches);
  for (const node of dev.nodes) assert.equal(searchOpacity(focus, "nodes", node.id), SEARCH_FADE);
  for (const prop of dev.props) assert.equal(searchOpacity(focus, "props", prop.id), SEARCH_FADE);
  for (const island of dev.islands) assert.equal(searchOpacity(focus, "islands", island.id), SEARCH_FADE);
  const selected = landscapeFocus(dev, "island:lambda", matches);
  assert.equal(selected.kind, "selection");
  assert.ok(dev.nodes.filter((node) => node.island === "island:lambda").every((node) => selected.nodes.has(node.id)));
});

test("island highlights omit shared tile and wall edges", () => {
  const faces = [[0, 0, 1, 0, 1, 1, 0, 1], [1, 0, 2, 0, 2, 1, 1, 1], [0, 1, 1, 1, 1, 2, 0, 2], [1, 1, 2, 1, 2, 2, 1, 2]];
  const segments = surfaceOutline(faces);
  assert.equal(segments.length / 4, 8, "only the outer perimeter remains");
  for (let at = 0; at < segments.length; at += 4) {
    const [x0, y0, x1, y1] = segments.slice(at, at + 4);
    assert.ok((x0 === x1 && (x0 === 0 || x0 === 2)) || (y0 === y1 && (y0 === 0 || y0 === 2)));
  }
});

// ---------------------------------------------------------------------------
// The scene, from the real repository
// ---------------------------------------------------------------------------

test("every route, target, catalog entry and managed database stands exactly once", () => {
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const expected = [...model.routes.map((route) => route.id), ...model.targets.map((target) => target.ref), ...model.resources.filter((resource) => resource.kind !== "member" || (resource.frameworkManaged && resource.networkPlacement)).map((resource) => resource.id), ...(model.localServices ?? []).map((service) => service.id)].sort();
    assert.deepEqual(scene.nodes.map((node) => node.id).sort(), expected);
    const cells = new Set(scene.nodes.map((node) => `${node.gx},${node.gy}`));
    assert.equal(cells.size, scene.nodes.length, "two buildings share a cell");
  }
});

test("aggregated connections retain every original edge and its environment evidence", () => {
  const visible = (model: typeof snapshot.models.dev, scene: Scene) => model.edges.filter((edge) => (scene.representatives[edge.from] ?? edge.from) !== (scene.representatives[edge.to] ?? edge.to)).map((edge) => edge.id).sort();
  assert.deepEqual(dev.edges.flatMap((edge) => edge.members.flatMap((member) => member.models.dev ? [member.models.dev.id] : [])).sort(), visible(snapshot.models.dev, dev));
  assert.deepEqual(prod.edges.flatMap((edge) => edge.members.flatMap((member) => member.models.prod ? [member.models.prod.id] : [])).sort(), visible(snapshot.models.prod, prod));
  for (const [scene, other] of [[dev, snapshot.models.prod], [prod, snapshot.models.dev]] as const) {
    const held = new Map(other.edges.map((edge) => [edge.id, edge]));
    const own = new Map(snapshot.models[scene.mode].edges.map((edge) => [edge.id, edge]));
    const pairs = new Set<string>();
    for (const edge of scene.edges) {
      const pair = JSON.stringify([edge.from, edge.to]);
      assert.ok(!pairs.has(pair), `one arc per directed pair: ${pair}`);
      pairs.add(pair);
      for (const member of edge.members) assert.deepEqual(member.edge, own.get(member.edge.id) ?? held.get(member.edge.id));
    }
  }
});

test("every scene entity and network fixture has a local SVG and a pickable plaque", () => {
  for (const item of [...dev.nodes, ...dev.props]) {
    assert.ok(existsSync(path.join(repositoryRoot, "framework-studio/public/icons", `${ICONS[item.icon][0]}.svg`)));
    assert.ok(insidePolygon(item.geometry.top.x, item.geometry.top.y + 12, item.geometry.hull));
  }
});

test("network plaques stand on their terraces with room between adjacent fixtures", () => {
  const source = snapshot.models.prod;
  assert.ok(source.network);
  const scene = buildScene({ ...source, network: { ...source.network, natGateway: true, egressOnlyInternetGateway: true, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["ecs", "logs"] } });
  for (const prop of scene.props) {
    const tile = scene.tiles.find((tile) => tile.gx === prop.gx && tile.gy === prop.gy);
    assert.ok(tile, `${prop.id} must stand on terrain`);
    assert.equal(tile.h, prop.h);
    for (const other of scene.props) {
      if (prop === other || prop.h !== other.h) continue;
      assert.ok(Math.abs(prop.gx - other.gx) + Math.abs(prop.gy - other.gy) >= 3, `${prop.id} overlaps ${other.id}`);
    }
  }
});

test("every VPC endpoint has a service badge included in its hover silhouette", () => {
  const source = snapshot.models.prod;
  const network = { ...source.network!, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["ecs", "lambda", "secretsmanager", "states", "logs"] };
  const scene = buildScene({ ...source, network });
  const endpoints = scene.props.filter((prop) => prop.id.startsWith("prop:endpoint:"));
  assert.equal(endpoints.length, 7, "endpoints beyond the fourth remain visible");
  assert.equal(endpoints.find((prop) => prop.id === "prop:endpoint:s3")!.roleIcon, "bucket");
  assert.equal(endpoints.find((prop) => prop.id === "prop:endpoint:dynamodb")!.roleIcon, "table");
  assert.equal(endpoints.find((prop) => prop.id === "prop:endpoint:ecs")!.roleIcon, "service");
  assert.equal(endpoints.find((prop) => prop.id === "prop:endpoint:logs")!.roleIcon, "construct", "unmapped services keep a generic badge");
  for (const prop of endpoints) {
    assert.equal(prop.icon, "endpoint");
    assert.ok(prop.roleIcon);
    assert.ok(existsSync(path.join(repositoryRoot, "framework-studio/public/icons", `${ICONS[prop.roleIcon][0]}.svg`)));
    const anchor = project({ x: prop.gx, y: prop.gy, h: prop.h });
    // This point lies in the badge beyond the main plaque's right edge.
    assert.ok(insidePolygon(anchor.x + ICON_BADGE.x + ICON_BADGE.size - ICON_BADGE.padding, anchor.y + ICON_BADGE.y + ICON_BADGE.size / 2, prop.geometry.hull));
  }
  const development = buildScene({ ...source, network, mode: "dev" });
  for (const prop of endpoints) {
    const ghost = development.props.find((item) => item.id === prop.id)!;
    assert.equal(ghost.presence, "other");
    assert.equal(ghost.roleIcon, prop.roleIcon);
    assert.deepEqual(ghost.geometry, prop.geometry);
  }
  assert.ok(scene.props.filter((prop) => !prop.id.startsWith("prop:endpoint:")).every((prop) => prop.roleIcon === undefined), "gateway fixtures keep their plain plaques");
});

test("background lattice follows the terrain projection and stays bounded at distant zooms", () => {
  const viewport = { width: 1600, height: 900 };
  for (const zoom of [0.18, 0.5, 1, 2.5]) {
    const camera = { x: -317, y: 143, zoom };
    const lines = backgroundGrid(camera, viewport);
    assert.ok(lines.length > 0 && lines.length < 300);
    for (const line of lines) {
      assert.equal(Math.abs((line.b.y - line.a.y) / (line.b.x - line.a.x)), 0.5);
      for (const point of [line.a, line.b]) {
        const grid = unprojectAt(point, 0);
        assert.ok(Number.isInteger(grid.x) && Number.isInteger(grid.y));
      }
    }
  }
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

test("islands pack into rows: small ones share a row when it fits, leave room for a title, and never overlap", () => {
  // An island's box in the screen-aligned frame: sx = gx - gy across, sy = gx + gy down.
  const box = (island: Island) => ({ left: island.gx0 - island.gy1 - 1, right: island.gx1 - island.gy0 + 1, top: island.gx0 + island.gy0 - 1, bottom: island.gx1 + island.gy1 + 1 });
  for (const scene of [dev, prod]) {
    for (const [a, b] of scene.islands.flatMap((one, at) => scene.islands.slice(at + 1).map((two) => [one, two] as const))) {
      const one = box(a);
      const two = box(b);
      assert.ok(one.right <= two.left || two.right <= one.left || one.bottom <= two.top || two.bottom <= one.top, `${a.id} overlaps ${b.id}`);
    }
    const island = (id: string) => scene.islands.find((candidate) => candidate.id === id);
    const compute = scene.islands.filter((candidate) => ["compute", "network", "agents", "orchestration"].includes(candidate.region));
    const width = Math.max(...compute.map((candidate) => box(candidate).right - box(candidate).left));
    const agents = island("island:agentcore");
    const flows = island("island:orchestration");
    if (!agents || !flows) continue;
    const size = (candidate: Island) => box(candidate).right - box(candidate).left;
    if (size(agents) + titleRoom(flows.title) + size(flows) > width) continue;
    // They fit one row, so they share it: level with each other, the second leaving room for its title.
    if (Math.abs(box(agents).top + box(agents).bottom - box(flows).top - box(flows).bottom) <= 2) assert.ok(Math.abs(box(flows).left - box(agents).right) >= titleRoom(flows.title) - 1, "neighbours leave title room");
  }
});

test("switching the graph changes what is shown, never where it stands", () => {
  const place = (scene: Scene) => new Map(scene.nodes.map((node) => [node.id, `${node.gx},${node.gy},${node.h}`]));
  assert.deepEqual(place(prod), place(dev));
  assert.deepEqual(prod.bounds, dev.bounds);
  // Deterministic: the same model lays out the same way twice.
  assert.deepEqual(buildScene(snapshot.models.dev, { webSocketApi: snapshot.webSocketApi, layoutModels: Object.values(snapshot.models) }).nodes.map((node) => [node.id, node.gx, node.gy]), dev.nodes.map((node) => [node.id, node.gx, node.gy]));
});

test("the desktop overview fills a 1080p monitor, with Workflows before Stacks", () => {
  const viewport = { width: 1920, height: 1080 - 52 };
  for (const scene of [dev, prod]) {
    const lower = ["island:agentcore", "island:orchestration", "island:stacks"].map((id) => scene.islands.find((island) => island.id === id)!);
    const centre = (island: Island) => ({
      x: (island.gx0 + island.gx1 - island.gy0 - island.gy1) / 2,
      y: (island.gx0 + island.gx1 + island.gy0 + island.gy1) / 2,
    });
    // Only Workflows-before-Stacks is constrained; other islands follow their dependencies.
    assert.ok(centre(lower[1]!).x < centre(lower[2]!).x, "Workflows stay before Stacks");
    const core = scene.islands.filter((island) => !lower.includes(island) && island.id !== "island:environment");
    const fitted = fitBounds(scene.bounds, viewport, 48);
    // The islands retain a useful overview on a 16:9 monitor as the topology changes.
    assert.ok((scene.bounds.maxX - scene.bounds.minX) * fitted.zoom > viewport.width * 0.75, "uses the monitor's width");
    assert.ok((scene.bounds.maxY - scene.bounds.minY) * fitted.zoom > viewport.height * 0.8, "uses the monitor's height");
  }
});

test("environment files stay beside and left of catalog inputs as either island grows and shrinks", () => {
  const source = snapshot.models.dev;
  const environment = source.resources.find((resource) => resource.id === "envfile:dev")!;
  const input = source.resources.find((resource) => resource.kind === "input" && resource.fromEnv)!;
  for (const count of [1, 4, 16, 49, 100, 4]) {
    const extra = Array.from({ length: count }, (_, at) => ({ ...input, id: `resource:layout-input-${at}`, path: [`layoutInput${at}`], fromEnv: `LAYOUT_INPUT_${at}` }));
    const files = Array.from({ length: Math.max(1, Math.floor(count / 3)) }, (_, at) => ({ ...environment, id: `envfile:layout-${at}`, path: [`.env.layout${at}`] }));
    const scene = buildScene({ ...source, resources: [...source.resources.filter((resource) => resource.kind !== "input" && resource.kind !== "secret" && !resource.deploymentFile), ...extra, ...files] });
    const parameters = scene.islands.find((island) => island.id === "island:inputs")!;
    const env = scene.islands.find((island) => island.id === "island:environment")!;
    const rightEdge = (island: Island) => island.gx1 - island.gy0;
    const leftEdge = (island: Island) => island.gx0 - island.gy1;
    assert.ok(rightEdge(env) + titleRoom(parameters.title) - 1 <= leftEdge(parameters), "measured boundaries leave room for the input title");
    assert.ok(Math.abs(env.gx0 + env.gx1 + env.gy0 + env.gy1 - parameters.gx0 - parameters.gx1 - parameters.gy0 - parameters.gy1) <= 2, "the pair stays vertically aligned");
    const vpc = scene.islands.find((island) => island.region === "network")!;
    assert.ok(leftEdge(vpc) > rightEdge(parameters), "the network remains right of the input cluster");
  }
});

test("multiple differently sized VPC footprints form one compact, non-overlapping group on the right", () => {
  const main: IslandFootprint[] = [
    { id: "island:apis", title: "APIs", region: "entry", size: 26 },
    { id: "island:inputs", title: "Input parameters and secrets", region: "catalog", size: 20 },
    { id: "island:environment", title: "CDK environment files", region: "catalog", size: 11 },
    { id: "island:lambda", title: "Serverless compute", region: "compute", size: 29 },
    { id: "island:agentcore", title: "Agents", region: "agents", size: 8 },
    { id: "island:orchestration", title: "Workflows", region: "orchestration", size: 8 },
    { id: "island:stacks", title: "Stacks", region: "catalog", size: 14 },
  ];
  for (const count of [1, 2, 3, 5, 9, 16]) {
    const networks: IslandFootprint[] = Array.from({ length: count }, (_, at) => ({ id: `network:dynamic-${at}`, title: `VPC ${at}`, region: "network", size: 18 + at % 4 * 7 }));
    const footprints = [...main, ...networks];
    const positions = layoutIslands(footprints);
    assert.equal(positions.length, footprints.length);
    assert.equal(new Set(positions.map((item) => item.id)).size, footprints.length);
    const box = (id: string) => { const position = positions.find((item) => item.id === id)!; const size = footprints.find((item) => item.id === id)!.size; return { ...position, right: position.left + size, bottom: position.top + size }; };
    const leftBoundary = Math.max(...["island:apis", "island:inputs", "island:environment"].map((id) => box(id).right));
    for (const network of networks) assert.ok(box(network.id).left > leftBoundary, "all network identities use the right-hand zone");
    for (const [at, a] of footprints.entries()) for (const b of footprints.slice(at + 1)) {
      const aa = box(a.id), bb = box(b.id);
      assert.ok(aa.right <= bb.left || bb.right <= aa.left || aa.bottom <= bb.top || bb.bottom <= aa.top, `${a.id} clears ${b.id} at ${count} VPCs`);
    }
    const networkWidth = Math.max(...networks.map((item) => box(item.id).right)) - Math.min(...networks.map((item) => box(item.id).left));
    const networkHeight = Math.max(...networks.map((item) => box(item.id).bottom)) - Math.min(...networks.map((item) => box(item.id).top));
    const area = networks.reduce((sum, item) => sum + item.size ** 2, 0);
    assert.ok(networkWidth * networkHeight < area * 3, "VPCs stay clustered rather than occupying unrelated slots");
    if (count >= 5) { assert.ok(new Set(networks.map((item) => box(item.id).left)).size > 1); assert.ok(new Set(networks.map((item) => box(item.id).top)).size > 1, "larger groups wrap into rows"); }
    assert.deepEqual(layoutIslands([...main, ...[...networks].reverse()]), positions, "network input order does not reshuffle the cluster");
  }
});

test("mixed service groups share a regular lattice as islands grow and shrink", () => {
  const model = snapshot.models.dev;
  const template = model.targets.find((target) => target.kind === "lambda" && target.placement.kind === "outside")!;
  assert.ok(template);
  let previousExtent = 0;
  for (const count of [1, 2, 3, 5, 9, 16, 25, 40, 64]) {
    const targets = Array.from({ length: count }, (_, at) => ({ ...template, ref: `lambda:packing-${at}`, id: `packing-${at}`, role: (["http", "webSocket", "event", "tool"] as const)[at % 4]! }));
    const input = { ...model, targets: [...model.targets.filter((target) => target.kind !== "lambda" || target.placement.kind !== "outside"), ...targets], routes: [], edges: [] };
    const scene = buildScene(input);
    const island = scene.islands.find((island) => island.id === "island:lambda")!;
    const nodes = scene.nodes.filter((node) => node.island === island.id);
    const columns = [...new Set(nodes.map((node) => node.gx))].sort((a, b) => a - b);
    const rows = [...new Set(nodes.map((node) => node.gy))].sort((a, b) => a - b);
    for (const line of [columns, rows]) for (let at = 1; at < line.length; at += 1) assert.equal(line[at]! - line[at - 1]!, 3, "no extra gap at a service-group boundary");
    assert.equal(columns.length, Math.ceil(count / rows.length), "no reserved role columns");
    for (const node of nodes) {
      assert.ok(node.gx >= island.gx0 + 2 && node.gx <= island.gx1 - 2);
      assert.ok(node.gy >= island.gy0 + 2 && node.gy <= island.gy1 - 2);
      assert.ok(scene.tiles.some((tile) => tile.gx === node.gx && tile.gy === node.gy && tile.island === island.id));
    }
    const extent = island.gx1 - island.gx0 + island.gy1 - island.gy0;
    assert.ok(extent >= previousExtent, "growth does not shrink the footprint");
    previousExtent = extent;
    assert.equal(new Set(scene.nodes.map((node) => `${node.gx},${node.gy}`)).size, scene.nodes.length);
    for (const a of scene.islands) for (const b of scene.islands) {
      if (a.id >= b.id) continue;
      const box = (island: Island) => ({ left: island.gx0 - island.gy1, right: island.gx1 - island.gy0, top: island.gx0 + island.gy0, bottom: island.gx1 + island.gy1 });
      const aa = box(a), bb = box(b);
      assert.ok(aa.right < bb.left || bb.right < aa.left || aa.bottom < bb.top || bb.bottom < aa.top, `${a.id} clears ${b.id} at ${count} nodes`);
    }
    assert.deepEqual(buildScene(input).nodes.map(({ id, gx, gy }) => [id, gx, gy]), scene.nodes.map(({ id, gx, gy }) => [id, gx, gy]));
  }
  for (const scene of [dev, prod]) for (const prop of scene.props) for (const node of scene.nodes.filter((node) => prop.serves.includes(node.band))) {
    assert.ok(Math.max(Math.abs(prop.gx - node.gx), Math.abs(prop.gy - node.gy)) >= 3, "network fixtures reserve their own lattice row");
  }
});

test("what a building shows of an entity follows the model's lanes and absence", () => {
  const node = (scene: Scene, id: string) => scene.nodes.find((candidate) => candidate.id === id)!;
  // graphql-api runs under Compose in development and is built by production.
  assert.equal(node(dev, "lambda:graphql-api").presence, "built");
  assert.equal(node(prod, "lambda:graphql-api").presence, "built");
  // AWS invokes the Cognito triggers, so a development deployment builds them too.
  assert.equal(node(dev, "lambda:cognito-pre-signup-trigger").presence, "built");
  // db-migrate is cloud-only: absent from the local lane and from a development deployment.
  assert.equal(node(dev, "task:db-migrate").presence, "other");
  assert.equal(node(prod, "service:example-service").presence, "other", "local-only execution belongs to Development");
  assert.equal(node(dev, "lambda:graphql-api").badge, undefined, "local development plus production needs no exception badge");
  assert.equal(node(dev, "lambda:ws-disconnect-route").badge, snapshot.webSocketApi ? undefined : "dev", "WebSocket availability accounts for whether its AWS API is enabled");
  assert.equal(node(dev, "service:example-service").badge, "dev");
  assert.equal(node(dev, "task:db-migrate").badge, "prod");
  assert.equal(node(dev, "resource:rds").badge, "prod");
  assert.equal(node(dev, "resource:referenceExamples").badge, undefined);
  // The catalog says what each graph holds.
  assert.equal(node(dev, "resource:rds").presence, "absent");
  assert.equal(node(prod, "resource:rds").presence, "present");
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
  // The subnets stand level, side by side: public, private, isolated.
  assert.deepEqual(vpc(dev).bands.map((band) => band.id), ["band:public", "band:private", "band:isolated"]);
  assert.equal(new Set(vpc(dev).bands.map((band) => band.h)).size, 1);
  assert.equal(dev.islands.find((island) => island.id === "island:stacks")!.ghost, undefined, "present stacks keep their shared island solid");
});

test("each VPC foundation encloses every terrace and stays fixed across environments", () => {
  const island = prod.islands.find((island) => island.region === "network")!;
  const frame = islandFrame(island);
  assert.deepEqual(frame, islandFrame(dev.islands.find((candidate) => candidate.id === island.id)!));
  for (const tile of prod.tiles.filter((tile) => tile.island === island.id)) {
    for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) {
      const point = project({ x: tile.gx + dx, y: tile.gy + dy, h: island.base });
      assert.ok(insidePolygon(point.x, point.y, frame.top), "the foundation must enclose every subnet's base");
    }
  }
  assert.ok(frame.bounds.minX >= prod.bounds.minX && frame.bounds.maxX <= prod.bounds.maxX);
  assert.ok(frame.bounds.minY >= prod.bounds.minY && frame.bounds.maxY <= prod.bounds.maxY);
  const second = islandFrame({ ...island, id: "island:another-vpc", gx0: island.gx0 + 50, gx1: island.gx1 + 50 });
  assert.ok(second.bounds.minX > frame.bounds.maxX, "another network island gets its own boundary");
});

test("the shared API layer stays solid with active HTTP routes when its WebSocket routes are disabled", () => {
  const source = snapshot.models.prod;
  const routeTargets = new Set(source.routes.filter((route) => route.kind === "webSocket").map((route) => route.target));
  const targets = source.targets.map((target) => routeTargets.has(target.ref)
    ? { ...target, lanes: { ...target.lanes, local: false, dev: false, prod: false } } : target);
  const scene = buildScene({ ...source, targets });
  assert.equal(scene.islands.find((island) => island.id === "island:apis")!.ghost, undefined);
  assert.ok(scene.nodes.filter((node) => source.routes.some((route) => route.kind === "webSocket" && route.id === node.id)).every((node) => node.presence === "nowhere"));
});

test("ghosting applies to every island with only disabled nodes", () => {
  const source = snapshot.models.prod;
  const targets = source.targets.map((target) => ({ ...target, lanes: { ...target.lanes, local: false, dev: false, prod: false } }));
  const scene = buildScene({ ...source, targets });
  for (const island of scene.islands) {
    const nodes = scene.nodes.filter((node) => node.island === island.id);
    if (island.region === "catalog" || island.region === "network" || nodes.length === 0) continue;
    assert.equal(island.ghost, "disabled", island.id);
  }
  assert.equal(scene.islands.find((island) => island.id === "island:stacks")!.ghost, undefined, "present resources keep their terrain");
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

test("inspector and window resizes preserve screen positions without cumulative camera drift", () => {
  const wide = { width: 1600, height: 950 };
  const points = [{ x: -317, y: 143 }, { x: 900, y: 600 }];
  for (const zoom of [MIN_ZOOM, 0.43, 1, MAX_ZOOM]) {
    const initial = { x: 1350, y: 937, zoom };
    let camera = initial;
    let viewport = wide;
    const positions = points.map((point) => worldToScreen(initial, wide, point));
    for (let repetition = 0; repetition < 100; repetition += 1) {
      for (const next of [{ width: 1200, height: 950 }, { width: 760, height: 520 }, wide]) {
        camera = resizeCamera(camera, viewport, next);
        viewport = next;
        points.forEach((point, index) => {
          const at = worldToScreen(camera, viewport, point);
          assert.ok(Math.abs(at.x - positions[index]!.x) < 1e-7);
          assert.ok(Math.abs(at.y - positions[index]!.y) < 1e-7);
        });
      }
    }
    assert.equal(camera.zoom, zoom);
    assert.ok(Math.abs(camera.x - initial.x) < 1e-7 && Math.abs(camera.y - initial.y) < 1e-7);
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
  const back = buildIconShape( project({ x: 4, y: 4, h: 2 }).x, project({ x: 4, y: 4, h: 2 }).y);
  const frontAnchor = project({ x: 5, y: 4, h: 4 });
  const front = buildIconShape( frontAnchor.x, frontAnchor.y);
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

test("terrain picking uses the raised island's projected top and wall ahead of the island behind it", () => {
  const owner = dev.islands[0]!;
  const behind: Island = { ...owner, id: "behind", gx0: 0, gy0: 0, gx1: 4, gy1: 4, base: -2, top: 0,
    bands: [{ ...owner.bands[0]!, gx0: 0, gx1: 4, h: 0 }] };
  const raised: Island = { ...owner, id: "raised", gx0: 4, gy0: 4, gx1: 8, gy1: 8, base: 0, top: 3,
    bands: [{ ...owner.bands[0]!, gx0: 4, gx1: 8, h: 3 }] };
  const slabs = islandDrawOrder(islandSlabs({ islands: [behind, raised], nodes: [], props: [] }));
  const onTop = project({ x: 5, y: 5, h: 3 });
  assert.ok(unprojectAt(onTop, 0).x < 4);
  assert.equal(pickIsland(onTop, slabs)?.id, "raised");
  const wall = slabs.find((slab) => slab.island.id === "raised")!.bands[0]!.walls[0]!.quad;
  const onWall = { x: (wall[0]! + wall[2]! + wall[4]! + wall[6]!) / 4, y: (wall[1]! + wall[3]! + wall[5]! + wall[7]!) / 4 };
  assert.equal(pickIsland(onWall, slabs)?.id, "raised");
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

test("every building's silhouette contains everything it paints, and rises from its tile", () => {
  for (const badge of [false, true]) {
    const shape = buildIconShape(100, 200, badge);
    assert.ok(shape.top.y < 200);
    for (const face of shape.faces) {
      for (let index = 0; index < face.points.length; index += 2) {
        const point = { x: face.points[index]!, y: face.points[index + 1]! };
        // Inside, or on the silhouette's edge.
        const outline = [...shape.hull, shape.hull[0]!, shape.hull[1]!];
        const edge = distanceToPolyline(point, Array.from({ length: outline.length / 2 }, (_, at) => ({ x: outline[at * 2]!, y: outline[at * 2 + 1]! })));
        assert.ok(insidePolygon(point.x, point.y, shape.hull) || edge < 1e-6, `plinth paints outside its silhouette (badge: ${badge})`);
      }
    }
  }
});

test("stack fields stay in the model and use their stack as the visible edge endpoint", () => {
  const member = "resource:cognito.userPool";
  const stack = "resource:cognito";
  assert.ok(snapshot.models.dev.resources.some((resource) => resource.id === member));
  assert.ok(!dev.nodes.some((node) => node.id === member));
  assert.equal(dev.representatives[member], stack);
  assert.equal(dev.nodes.find((node) => node.id === stack)?.label, "CognitoStack");
  assert.equal(dev.islands.find((island) => island.id === "island:stacks")?.title, "Stacks");
  const bindings = dev.edges.filter((edge) => edge.edge.to === member);
  assert.ok(bindings.length > 0);
  for (const edge of bindings) assert.equal(edge.to, stack);
  const ids = new Set(dev.nodes.map((node) => node.id));
  for (const edge of dev.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to));
    assert.notEqual(edge.from, edge.to);
  }
});

test("stack constructor evidence produces an unattached badge, while the managed database sits in isolated subnets", () => {
  const node = (scene: Scene, id: string) => scene.nodes.find((item) => item.id === id)!;
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const example = model.resources.find((resource) => resource.id === "resource:referenceExamples")!;
    assert.equal(example.stackUsage?.status, "unreferenced");
    assert.equal(node(scene, example.id).roleIcon, "unattached");
    assert.equal(model.resources.find((resource) => resource.id === "resource:cognito")?.stackUsage?.status, "referenced");
    const database = node(scene, "resource:rds.database");
    assert.equal(database.island, "island:vpc");
    assert.equal(database.band, "band:isolated");
    assert.equal(database.icon, "database");
    assert.equal(database.roleIcon, "managed");
    assert.equal(database.presence, model.mode === "dev" ? "absent" : "present");
    assert.equal(node(scene, "resource:rds").roleIcon, "managed");
    assert.equal(scene.representatives[database.id], undefined);
    const ownership = scene.edges.find((edge) => edge.edge.relation === "contains" && edge.edge.to === database.id);
    assert.ok(ownership);
    assert.equal(ownership.from, "resource:rds");
    assert.equal(ownership.to, database.id);
    assert.ok(scene.routes[ownership.edge.id]?.points.length);
    const bindings = scene.edges.filter((edge) => edge.edge.relation === "database" && edge.edge.to === database.id);
    if (model.mode === "prod") assert.ok(bindings.length > 0);
    for (const edge of bindings) assert.equal(edge.to, database.id);
  }
});

test("the local database stands in the isolated subnet right beside RDS, solid in development and ghosted in production", () => {
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    assert.ok(!scene.islands.some((island) => island.id === "island:local" || island.title === "Local development"), "it has no island of its own");
    const local = scene.nodes.find((item) => item.id === "local:postgres")!;
    const rds = scene.nodes.find((item) => item.id === "resource:rds.database")!;
    assert.equal(local.island, "island:vpc");
    assert.equal(local.band, "band:isolated");
    assert.equal(local.entity, "local");
    assert.equal(local.presence, model.mode === "dev" ? "built" : "other");
    assert.equal(local.h, rds.h, "on the same terrace");
    assert.equal(Math.abs(local.gx - rds.gx) + Math.abs(local.gy - rds.gy), 3, "one lattice step from RDS");
    const isolated = scene.islands.find((island) => island.id === "island:vpc")!.bands.find((band) => band.id === "band:isolated")!;
    assert.ok(isolated.caption.some((line) => line.includes("Local PostgreSQL")), "the subnet says it is not an AWS resource");
  }
});

test("a connection is drawn by what it references and where it starts, solid only where named", () => {
  const colours = [API_EDGE_COLOR, COMPUTE_EDGE_COLOR, GUARD_EDGE_COLOR, TOOL_EDGE_COLOR, STEP_EDGE_COLOR, TRIGGER_EDGE_COLOR, ...Object.values(EDGE_COLORS)];
  assert.equal(new Set(colours).size, colours.length, "each rule has a colour of its own");
  assert.equal(READ_EDGE_COLOR, EDGE_COLORS.inputs, "a value being read looks like an environment file supplying an input");
  const startsAt = (edge: { from: string }, ...prefixes: string[]) => prefixes.some((prefix) => edge.from.startsWith(prefix));
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const kindOf = new Map(model.resources.map((resource) => [resource.id, resource.kind]));
    const seen = { stack: 0, input: 0, secret: 0, authorizer: 0, secretFile: 0, tool: 0, step: 0, api: 0, compute: 0, other: 0 };
    for (const { edge, from, category, style } of scene.edges) {
      const referenced = kindOf.get(edge.to);
      const reads = (edge.relation === "env" || edge.relation === "secret") && referenced !== undefined;
      const expect = (color: string, dashed: boolean) => assert.deepEqual(style, { color, dashed }, `${edge.id} (${edge.relation})`);
      if (edge.relation === "trigger") expect(TRIGGER_EDGE_COLOR, false);
      else if (edge.relation === "authorizes") { seen.authorizer += 1; expect(GUARD_EDGE_COLOR, false); }
      else if (edge.relation === "grant") expect(GUARD_EDGE_COLOR, true);
      else if (reads && (edge.relation === "secret" || referenced === "secret")) { seen.secret += 1; expect(GUARD_EDGE_COLOR, true); }
      else if (reads) { seen[referenced === "input" || referenced === "group" ? "input" : "stack"] += 1; expect(READ_EDGE_COLOR, true); }
      else if (edge.relation === "supplies" && referenced === "secret") { seen.secretFile += 1; expect(GUARD_EDGE_COLOR, true); }
      else if (edge.relation === "usesTool") { seen.tool += 1; expect(TOOL_EDGE_COLOR, false); }
      else if (edge.relation === "step") { seen.step += 1; expect(STEP_EDGE_COLOR, false); }
      else if (startsAt({ from }, "route:")) { seen.api += 1; expect(API_EDGE_COLOR, false); }
      else if (startsAt({ from }, "lambda:", "service:", "task:")) { seen.compute += 1; expect(COMPUTE_EDGE_COLOR, false); }
      else { seen.other += 1; expect(EDGE_COLORS[category], true); }
      // A reference points the way the model records it: from the workload to what it references.
      if (reads || edge.relation === "grant") assert.ok(startsAt({ from }, "lambda:", "service:", "task:", "agent:"), `${edge.id} starts at the workload`);
    }
    for (const [name, count] of Object.entries(seen)) assert.ok(count > 0, `${model.mode}: no ${name} connection to judge (${JSON.stringify(seen)})`);
    // Reads of an input parameter and an environment file feeding a plain input share one look.
    const plainSupplies = scene.edges.filter((edge) => edge.edge.relation === "supplies" && kindOf.get(edge.edge.to) !== "secret");
    assert.ok(plainSupplies.length > 0);
    for (const edge of plainSupplies) assert.deepEqual(edge.style, { color: READ_EDGE_COLOR, dashed: true }, edge.edge.id);
  }
});

test("the WebSocket authorizer's link to the API is red and solid", () => {
  for (const scene of [dev, prod]) {
    const link = scene.edges.find((edge) => edge.edge.relation === "authorizes" && edge.edge.from === "lambda:ws-authorizer" && edge.edge.to === "route:ws:$connect");
    assert.ok(link, "the authorizer guards $connect");
    assert.deepEqual(link.style, { color: GUARD_EDGE_COLOR, dashed: false });
    assert.deepEqual([link.from, link.to], ["lambda:ws-authorizer", "route:ws:$connect"], "it runs authorizer to route");
  }
});

test("a permission grant keeps a mixed aggregate red and dashed", () => {
  const read = snapshot.models.prod.edges.find((edge) => edge.relation === "env" && edge.to.startsWith("resource:cognito"))!;
  assert.ok(read, "a workload reads a Cognito field");
  const grant = { ...read, id: "edge:test-grant", relation: "grant" as const, label: "grantRead()" };
  const scene = buildScene({ ...snapshot.models.prod, edges: [...snapshot.models.prod.edges, grant] }, { webSocketApi: snapshot.webSocketApi });
  const drawn = (id: string) => scene.edges.find((edge) => edge.members.some((member) => member.edge.id === id))!.style;
  assert.deepEqual(drawn(grant.id), { color: GUARD_EDGE_COLOR, dashed: true });
  assert.deepEqual(drawn(read.id), drawn(grant.id), "the read and grant share one guarded connection");
});

test("a connection outside the viewed environment rests at a quarter of the strength it has inside it", () => {
  assert.equal(restingAlpha("declared", false), 0.3);
  assert.equal(restingAlpha("source", false), 0.3);
  assert.equal(restingAlpha("derived", false), 0.18);
  assert.equal(restingAlpha("declared", true), 0.075);
  assert.equal(restingAlpha("derived", true), 0.045);
  for (const provenance of ["declared", "derived", "source"] as const) assert.equal(restingAlpha(provenance, true) * 4, restingAlpha(provenance, false), `${provenance}: the same ratio for every connection`);
  assert.ok(restingAlpha("declared", false) > 0.24, "easier to see than the old resting strength");
  // Either end enabled only elsewhere, in neither environment, or absent here puts it outside the lens.
  for (const presence of ["other", "nowhere", "absent"] as const) {
    assert.equal(offLens({}, { presence }, { presence: "built" }), true, `${presence} at the start`);
    assert.equal(offLens({}, { presence: "present" }, { presence }), true, `${presence} at the end`);
  }
  assert.equal(offLens({}, { presence: "built" }, { presence: "present" }), false);
  assert.equal(offLens({ otherLens: "prod" }, { presence: "built" }, { presence: "built" }), true, "a connection only the other environment holds");
});

test("connection inspector deployment reasons agree with every drawn connection in both modes", () => {
  for (const scene of [dev, prod]) {
    const index = indexModel(snapshot.models[scene.mode]);
    const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
    for (const edge of scene.edges) {
      const disabled = edge.otherLens !== undefined || connectionDisabledEndpoints(index, scene.mode, edge.edge).length > 0;
      assert.equal(disabled, offLens(edge, nodes.get(edge.from), nodes.get(edge.to)), `${scene.mode}: ${edge.edge.id}`);
    }
  }
});

test("switching Development and Production moves which connections recede", () => {
  const nodesOf = (scene: Scene) => new Map(scene.nodes.map((node) => [node.id, node]));
  const outside = (scene: Scene) => {
    const nodeOf = nodesOf(scene);
    return new Set(scene.edges.filter((edge) => offLens(edge, nodeOf.get(edge.from), nodeOf.get(edge.to))).map((edge) => edge.edge.id));
  };
  const touching = (scene: Scene, id: string) => scene.edges.filter((edge) => edge.from === id || edge.to === id);
  const devOut = outside(dev), prodOut = outside(prod);
  assert.ok(devOut.size > 0 && prodOut.size > 0, "each lens leaves some connections out");
  assert.notDeepEqual([...devOut].sort(), [...prodOut].sort(), "what recedes moves with the lens");
  // Production-only workload, seen from Development: its own connections recede; from Production they read clearly.
  const migrate = touching(dev, "task:db-migrate");
  assert.ok(migrate.length > 0);
  for (const edge of migrate) { assert.ok(devOut.has(edge.edge.id), `dev: ${edge.edge.id}`); assert.ok(!prodOut.has(edge.edge.id), `prod: ${edge.edge.id}`); }
  // Development-only workload, seen from Production: the other way round.
  const authorizer = touching(prod, "lambda:ws-authorizer");
  assert.ok(authorizer.length > 0);
  for (const edge of authorizer) { assert.ok(prodOut.has(edge.edge.id), `prod: ${edge.edge.id}`); assert.ok(!devOut.has(edge.edge.id), `dev: ${edge.edge.id}`); }
  // A resource the viewed graph declares undefined is outside the lens too: RDS in Development.
  const rds = touching(dev, "resource:rds.database");
  assert.ok(rds.length > 0);
  for (const edge of rds) assert.ok(devOut.has(edge.edge.id), `dev: ${edge.edge.id}`);
  // Two connections between solid nodes are never dimmed.
  const nodeOf = nodesOf(dev);
  assert.ok(dev.edges.filter((edge) => !devOut.has(edge.edge.id)).every((edge) => ["built", "present"].includes(nodeOf.get(edge.from)!.presence) && ["built", "present"].includes(nodeOf.get(edge.to)!.presence)));
});

test("whatever a graph does not hold is absent in that view and its connections recede, whatever kind of resource it is", () => {
  const modes = ["dev", "prod"] as const;
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const nodeOf = new Map(scene.nodes.map((node) => [node.id, node]));
    for (const resource of model.resources) {
      const node = nodeOf.get(resource.id);
      if (node) assert.equal(node.presence, resource.absent ? "absent" : "present", `${model.mode}: ${resource.id}`);
    }
    for (const edge of scene.edges) {
      if ([edge.from, edge.to].some((id) => nodeOf.get(id)?.presence === "absent")) assert.ok(offLens(edge, nodeOf.get(edge.from), nodeOf.get(edge.to)), `${model.mode}: ${edge.edge.id}`);
    }
  }
  // A resource that belongs to one environment is how every producer says so: absent in the other graph.
  for (const mode of modes) for (const file of snapshot.models[mode].resources.filter((resource) => resource.deploymentFile)) {
    assert.equal(file.absent, file.deploymentFile!.mode !== mode, `${file.id} in the ${mode} graph`);
  }
});

test("an environment file's connections read clearly in its own view and recede in the other", () => {
  const supplies = (file: "dev" | "prod") => ({ id: `lens-fixture:${file}`, from: `envfile:${file}`, to: "resource:langgraph.modelProvider", relation: "supplies" as const, provenance: "source" as const, label: "LANGGRAPH_MODEL_PROVIDER" });
  for (const viewed of ["dev", "prod"] as const) {
    const other = viewed === "dev" ? "prod" : "dev";
    const model = snapshot.models[viewed];
    const scene = buildScene({ ...model, edges: [...model.edges, supplies("dev"), supplies("prod")] }, { webSocketApi: snapshot.webSocketApi });
    const nodeOf = new Map(scene.nodes.map((node) => [node.id, node]));
    assert.equal(nodeOf.get(`envfile:${viewed}`)!.presence, "present", `${viewed} file in the ${viewed} view`);
    assert.equal(nodeOf.get(`envfile:${other}`)!.presence, "absent", `${other} file in the ${viewed} view`);
    const strength = (file: "dev" | "prod") => {
      const edge = scene.edges.find((candidate) => candidate.members.some((member) => member.edge.id === `lens-fixture:${file}`))!;
      return restingAlpha(edge.edge.provenance, offLens(edge, nodeOf.get(edge.from), nodeOf.get(edge.to)));
    };
    assert.equal(strength(viewed), 0.3, `${viewed} file's connection in the ${viewed} view`);
    assert.equal(strength(other), 0.075, `${other} file's connection in the ${viewed} view`);
  }
});

test("an environment file that has not been generated wears a missing-file badge on its node", () => {
  const model = snapshot.models.dev;
  const withExists = (exists: boolean) => buildScene({ ...model, resources: model.resources.map((resource) => resource.deploymentFile ? { ...resource, deploymentFile: { ...resource.deploymentFile, exists } } : resource) }, { webSocketApi: snapshot.webSocketApi });
  const badges = (scene: Scene) => scene.nodes.filter((node) => node.id.startsWith("envfile:")).map((node) => node.roleIcon);
  assert.deepEqual(badges(withExists(false)), ["missingFile", "missingFile"]);
  assert.deepEqual(badges(withExists(true)), [undefined, undefined]);
});

test("an enabled connection reads clearly in its own view and recedes where it is disabled", () => {
  const strength = (scene: Scene) => {
    const nodeOf = new Map(scene.nodes.map((node) => [node.id, node]));
    const edge = scene.edges.find((candidate) => candidate.edge.from === "route:service:/example-service/*" && candidate.edge.to === "service:example-service")!;
    assert.ok(edge, "the example service's route reaches its service");
    return restingAlpha(edge.edge.provenance, offLens(edge, nodeOf.get(edge.from), nodeOf.get(edge.to)));
  };
  assert.equal(strength(dev), 0.3, "enabled in Development");
  assert.equal(strength(prod), 0.075, "disabled in Production");
});

test("both views draw the same connections; the other environment's own are marked and dimmed", () => {
  const ids = (scene: Scene) => scene.edges.map((edge) => edge.id).sort();
  assert.deepEqual(ids(dev), ids(prod), "switching the view never makes a connection appear or vanish");
  const marked = (scene: Scene) => scene.edges.filter((edge) => edge.otherLens).map((edge) => `${edge.otherLens}: ${edge.edge.from} -> ${edge.edge.to}`).sort();
  assert.deepEqual(marked(dev), ["prod: client-envfile -> envfile:prod", "prod: client-envfile -> framework-stack:FrontendWebsiteS3Stack", "prod: lambda:graphql-api -> resource:rds.database", "prod: lambda:oauth-callback -> resource:rds.database"]);
  assert.deepEqual(marked(prod), ["dev: client-envfile -> envfile:dev", "dev: lambda:cognito-post-confirmation-trigger -> local:postgres", "dev: lambda:graphql-api -> local:postgres", "dev: lambda:oauth-callback -> local:postgres"]);
  // A connection a lens does not hold itself is one the lens dims, and the model's own edges are never marked.
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const own = new Set(model.edges.map((edge) => edge.id));
    for (const edge of scene.edges) assert.equal(edge.otherLens !== undefined, !edge.members.some((member) => own.has(member.edge.id)), edge.id);
  }
  // Without the other environment's model there is nothing to add: the viewed model alone is drawn as it always was.
  const alone = buildScene(snapshot.models.dev, { webSocketApi: snapshot.webSocketApi });
  assert.ok(alone.edges.every((edge) => edge.otherLens === undefined));
});

test("without a local database the isolated subnet says nothing about one", () => {
  const scene = buildScene({ ...snapshot.models.dev, localServices: [] });
  assert.ok(!scene.nodes.some((node) => node.entity === "local"));
  assert.ok(!scene.islands.find((island) => island.id === "island:vpc")!.bands.some((band) => band.caption.some((line) => line.includes("Local PostgreSQL"))));
});

test("catalog and selected output stacks share one island while keeping their availability and inspector identities", () => {
  for (const [scene, model] of [[dev, snapshot.models.dev], [prod, snapshot.models.prod]] as const) {
    const stacks = model.resources.filter((resource) => resource.kind === "stack");
    assert.ok(stacks.length > 1);
    const island = scene.islands.find((island) => island.id === "island:stacks")!;
    assert.equal(island.title, "Stacks");
    assert.deepEqual(scene.nodes.filter((node) => node.island === island.id).map((node) => node.id).sort(), stacks.map((stack) => stack.id).sort());
    assert.ok(!scene.islands.some((island) => island.id.startsWith("island:resource:")));
    for (const stack of stacks) {
      const node = scene.nodes.find((node) => node.id === stack.id)!;
      assert.equal(node.presence, stack.absent ? "absent" : "present");
      assert.equal(node.label, stack.stackClass ?? stack.path.join("."));
      if (stack.frameworkManaged) assert.equal(node.roleIcon, "managed");
    }
  }
});

test("all VPC gateways and endpoints ghost with the unbuilt network and stay in the same positions", () => {
  const network = snapshot.models.prod.network!;
  assert.ok(network);
  for (const builtInProd of [true, false]) {
    const source = { ...snapshot.models.prod, network: { ...network, builtInProd, natGateway: true, egressOnlyInternetGateway: true, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["ecs", "logs"] } };
    const development = buildScene({ ...source, mode: "dev" });
    const production = buildScene({ ...source, mode: "prod" });
    assert.equal(development.props.length, 7, "internet, egress-only, NAT and four endpoint plaques");
    assert.ok(development.props.every((prop) => prop.presence === "other"));
    assert.ok(production.props.every((prop) => prop.presence === (builtInProd ? "built" : "other")));
    const positions = (scene: Scene) => scene.props.map((prop) => [prop.id, prop.gx, prop.gy, prop.h]);
    assert.deepEqual(positions(development), positions(production));
  }
});

test("every building knows its band, and each gateway or endpoint names the subnets whose traffic it carries", () => {
  for (const scene of [dev, prod]) {
    for (const node of scene.nodes) {
      assert.equal(node.band, scene.tiles.find((tile) => tile.gx === node.gx && tile.gy === node.gy)!.band, node.id);
    }
  }
  const network = snapshot.models.prod.network!;
  const scene = buildScene({ ...snapshot.models.prod, network: { ...network, natGateway: true, egressOnlyInternetGateway: true, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["ecs", "logs"] } });
  const serves = Object.fromEntries(scene.props.map((prop) => [prop.id, [...prop.serves].sort()]));
  assert.deepEqual(serves["prop:internet-gateway"], ["band:public"]);
  assert.deepEqual(serves["prop:egress-only-gateway"], ["band:private"]);
  assert.deepEqual(serves["prop:nat-gateway"], ["band:private"]);
  for (const id of Object.keys(serves).filter((id) => id.startsWith("prop:endpoint:"))) {
    assert.deepEqual(serves[id], ["band:isolated", "band:private", "band:public"], id);
  }
});

test("HTTP, WebSocket, event and tool Lambdas share one layer, while HTTP, WebSocket and agent APIs share another", () => {
  const lambdas = snapshot.models.dev.targets.filter((target) => target.kind === "lambda");
  assert.ok(lambdas.some((target) => target.role === "tool"), "the repository declares a tool Lambda");
  for (const target of lambdas) {
    const node = dev.nodes.find((node) => node.id === target.ref)!;
    assert.equal(node.island, target.placement.kind === "vpc" ? "island:vpc" : "island:lambda", target.ref);
  }
  const apis = dev.nodes.filter((node) => node.entity === "route");
  assert.equal(apis.length, snapshot.models.dev.routes.length);
  assert.ok(apis.every((node) => node.island === "island:apis"));
  assert.equal(dev.islands.find((island) => island.id === "island:lambda")?.title, "Serverless compute");
  for (const id of ["island:lambda", "island:apis"]) assert.equal(dev.islands.find((island) => island.id === id)?.bands.length, 1);
});

test("only the VPC has a boundary; API and Lambda panels have no group frame", () => {
  for (const scene of [dev, prod]) {
    assert.deepEqual(scene.frames.map((frame) => frame.kind), ["network"]);
    assert.deepEqual(scene.frames[0]!.members, ["island:vpc"]);
  }
});

// ---------------------------------------------------------------------------
// Graphite slabs
// ---------------------------------------------------------------------------

/** The real scene plus a production network with every fixture, so terraces carry furniture. */
function furnished(): Scene {
  const source = snapshot.models.prod;
  return buildScene({ ...source, network: { ...source.network!, builtInProd: true, natGateway: true, egressOnlyInternetGateway: true, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: ["ecs", "logs"] } });
}

const onEdge = (x: number, y: number, polygon: readonly number[]) => {
  const closed = [...polygon, polygon[0]!, polygon[1]!];
  return distanceToPolyline({ x, y }, Array.from({ length: closed.length / 2 }, (_, at) => ({ x: closed[at * 2]!, y: closed[at * 2 + 1]! }))) < 1e-9;
};

test("chamfers cut only rim cells: every building, fixture and terrace name keeps its ground, and tiles agree with the outline", () => {
  for (const scene of [dev, prod, furnished()]) {
    const tiles = new Set(scene.tiles.map((tile) => `${tile.gx},${tile.gy}`));
    for (const slab of islandSlabs(scene)) {
      const { island, outline } = slab;
      const width = island.gx1 - island.gx0 + 1;
      const length = island.gy1 - island.gy0 + 1;
      for (let gx = island.gx0; gx <= island.gx1; gx += 1) {
        for (let gy = island.gy0; gy <= island.gy1; gy += 1) {
          const inside = insidePolygon(gx, gy, outline) || onEdge(gx, gy, outline);
          assert.equal(tiles.has(`${gx},${gy}`), inside, `${island.id} cell ${gx},${gy}`);
          assert.equal(chamfered(gx - island.gx0, gy - island.gy0, width, length), !inside);
        }
      }
      for (const band of island.bands) assert.ok(tiles.has(`${band.gx},${band.gy}`), `${band.id}'s name stands on its rim`);
    }
    // A plinth's base stays on its terrace's drawn top.
    const slabs = islandSlabs(scene);
    for (const item of [...scene.nodes, ...scene.props]) {
      const band = slabs.flatMap((slab) => slab.bands.map((band) => ({ band, island: slab.island }))).find(({ band, island }) => {
        const meta = island.bands[band.index]!;
        return item.gx >= meta.gx0 && item.gx <= meta.gx1 && item.gy >= island.gy0 && item.gy <= island.gy1;
      });
      assert.ok(band, `${item.id} stands on no band`);
      const tile = project({ x: item.gx, y: item.gy, h: item.h });
      for (const [x, y] of [[tile.x, tile.y - 9], [tile.x + 25, tile.y + 3], [tile.x, tile.y + 15], [tile.x - 25, tile.y + 3]] as const) {
        assert.ok(insidePolygon(x, y, band.band.top), `${item.id}'s plinth overhangs its terrace`);
      }
    }
  }
});

test("each island's slabs tile its outline but for a narrow seam between terraces, and its bands cover its columns", () => {
  for (const slab of islandSlabs(furnished())) {
    const { island } = slab;
    const total = slab.bands.reduce((sum, band) => sum + polygonArea(band.region), 0);
    // Each seam is a full-length column strip, clear of the chamfered corners.
    const cut = chamferSize(island.gx1 - island.gx0 + 1, island.gy1 - island.gy0 + 1);
    const seams = island.bands.slice(0, -1).map((band) => band.gx1 + 0.5);
    for (const at of seams) assert.ok(at - GRAPHITE.terraceGap / 2 >= island.gx0 - 0.5 + cut && at + GRAPHITE.terraceGap / 2 <= island.gx1 + 0.5 - cut);
    const gaps = seams.length * GRAPHITE.terraceGap * (island.gy1 - island.gy0 + 1);
    assert.ok(Math.abs(total + gaps - polygonArea(slab.outline)) < 1e-9, island.id);
    // Neighbouring slabs never touch.
    const columns = slab.bands.map((band) => band.region.filter((_, at) => at % 2 === 0));
    for (let index = 1; index < columns.length; index += 1) {
      assert.ok(Math.min(...columns[index]!) - Math.max(...columns[index - 1]!) > GRAPHITE.terraceGap - 1e-9);
    }
    slab.island.bands.forEach((band, index) => {
      assert.ok(band.gx0 <= band.gx1);
      if (index === 0) assert.equal(band.gx0, slab.island.gx0);
      else assert.equal(band.gx0, slab.island.bands[index - 1]!.gx1 + 1);
      if (index === slab.island.bands.length - 1) assert.equal(band.gx1, slab.island.gx1);
    });
  }
});

test("walls face the viewer: rims fall to the floor from the front edges, and terraces step down to the next", () => {
  for (const slab of islandSlabs(furnished())) {
    const { island } = slab;
    slab.bands.forEach((band, index) => {
      const next = island.bands[index + 1];
      const seamed = island.bands.length > 1 && GRAPHITE.terraceGap > 0;
      const steps = band.walls.filter((wall) => !wall.rim);
      if (next && next.h < band.h && !seamed) {
        assert.equal(steps.length, 1, `${band.id} steps down once`);
        assert.equal(steps[0]!.side, "right");
        assert.equal(steps[0]!.depth, (band.h - next.h) * 16);
      } else assert.equal(steps.length, 0, `${band.id} has no step`);
      for (const wall of band.walls.filter((wall) => wall.rim)) {
        assert.equal(wall.depth, (band.h - island.base) * 16);
        // Its top edge lies on the island's front-left or front-right edge, or the front facet between them.
        const [x0, y0, x1, y1] = wall.lip;
        const a = unprojectAt({ x: x0, y: y0 }, band.h);
        const b = unprojectAt({ x: x1, y: y1 }, band.h);
        const onFrontLeft = Math.abs(a.y - (island.gy1 + 0.5)) < 1e-9 && Math.abs(b.y - (island.gy1 + 0.5)) < 1e-9;
        // A band's right edge is the island's, or the near side of the seam to the next band.
        const right = index === slab.bands.length - 1 ? island.gx1 + 0.5 : island.bands[index]!.gx1 + 0.5 - GRAPHITE.terraceGap / 2;
        const onFrontRight = Math.abs(a.x - right) < 1e-9 && Math.abs(b.x - right) < 1e-9;
        const onFacet = Math.abs(a.x + a.y - (b.x + b.y)) < 1e-9 && a.x + a.y > (island.gx0 + island.gy0 + island.gx1 + island.gy1) / 2;
        assert.ok(onFrontLeft || onFrontRight || onFacet, `${band.id} has a rim wall off the front`);
        assert.equal(wall.side, onFrontLeft ? "left" : onFrontRight ? "right" : "front");
      }
    });
    // Exactly one front-left run per band; a right wall on the last band, and beside every seam.
    slab.bands.forEach((band, index) => {
      assert.equal(band.walls.filter((wall) => wall.rim && wall.side === "left").length, 1);
      assert.equal(band.walls.filter((wall) => wall.rim && wall.side === "right").length, index === slab.bands.length - 1 || slab.bands.length > 1 ? 1 : 0);
    });
  }
});

test("a wall's gradient is constant along its top edge and reaches its foot", () => {
  for (const slab of islandSlabs(furnished())) {
    for (const band of slab.bands) {
      for (const wall of band.walls) {
        const [gx0, gy0, gx1, gy1] = wall.gradient;
        const [lx0, ly0, lx1, ly1] = wall.lip;
        const g = { x: gx1 - gx0, y: gy1 - gy0 };
        const t = (x: number, y: number) => ((x - gx0) * g.x + (y - gy0) * g.y) / (g.x * g.x + g.y * g.y);
        assert.ok(Math.abs(t(lx1, ly1)) < 1e-9, "the far end of the top edge is at 0");
        assert.ok(Math.abs(t(lx0, ly0 + wall.depth) - 1) < 1e-9, "the foot is at 1");
        assert.ok(Math.abs(t(lx1, ly1 + wall.depth) - 1) < 1e-9);
      }
    }
  }
});

test("islands draw back to front: of two that overlap on screen, the one behind comes first", () => {
  const overlaps = (a: IslandSlab, b: IslandSlab) =>
    a.bounds.minX < b.bounds.maxX && b.bounds.minX < a.bounds.maxX && a.bounds.minY < b.bounds.maxY && b.bounds.minY < a.bounds.maxY;
  for (const scene of [dev, prod, furnished()]) {
    const ordered = islandDrawOrder(islandSlabs(scene));
    assert.equal(ordered.length, scene.islands.length);
    for (let a = 0; a < ordered.length; a += 1) {
      for (let b = a + 1; b < ordered.length; b += 1) {
        if (!overlaps(ordered[a]!, ordered[b]!)) continue;
        assert.ok(behind(ordered[a]!.island, ordered[b]!.island), `${ordered[a]!.island.id} drew before ${ordered[b]!.island.id}, which it stands in front of`);
      }
    }
    // Terraces keep their order: high ground behind, falling toward the viewer.
    for (const slab of ordered) assert.deepEqual(slab.bands.map((band) => band.index), slab.bands.map((_, index) => index));
  }
});

test("switching the graph changes how slabs are lit, never an island's outline, rim, shadow or place", () => {
  // Only how the VPC is cut differs: one deck while it is unbuilt, terraces once built (tested below), so its bands compare by identity.
  const shape = (scene: Scene) => islandSlabs(scene).map(({ island, outline, rim, shadow, bands }) => ({ id: island.id, outline, rim, shadow, bands: island.region === "network" ? bands.map((band) => band.id) : bands }));
  assert.deepEqual(shape(prod), shape(dev));
});

test("an unbuilt VPC is one continuous deck, and a built one keeps its terraces apart", () => {
  const vpc = (scene: Scene) => islandSlabs(scene).find((slab) => slab.island.id === "island:vpc")!;
  const deck = vpc(dev), terraces = vpc(furnished());
  assert.equal(deck.island.ghost, "blueprint");
  assert.equal(terraces.island.ghost, undefined);
  assert.equal(deck.deck, true);
  assert.equal(terraces.deck, false, "a built network is never merged");
  for (const slab of [...islandSlabs(dev), ...islandSlabs(prod), ...islandSlabs(furnished())].filter((candidate) => candidate.island.id !== "island:vpc" || candidate.island.ghost !== "blueprint")) assert.equal(slab.deck, false, `${slab.island.id} stays as it was`);
  const covered = (slab: typeof deck) => slab.bands.reduce((sum, band) => sum + polygonArea(band.region), 0);
  // The deck: the subnets tile the whole outline, flush, with no seam.
  assert.ok(Math.abs(covered(deck) - polygonArea(deck.outline)) < 1e-9, "no seam");
  const columns = deck.bands.map((band) => band.region.filter((_, at) => at % 2 === 0));
  for (let index = 1; index < columns.length; index += 1) assert.ok(Math.abs(Math.min(...columns[index]!) - Math.max(...columns[index - 1]!)) < 1e-9, "flush");
  // No wall between subnets: a right-hand wall only on the last, one front-left run per subnet along the one long wall, and nothing steps down.
  deck.bands.forEach((band, index) => {
    assert.equal(band.walls.filter((wall) => wall.rim && wall.side === "right").length, index === deck.bands.length - 1 ? 1 : 0, band.id);
    assert.equal(band.walls.filter((wall) => wall.rim && wall.side === "left").length, 1, band.id);
    assert.ok(band.walls.every((wall) => wall.rim), `${band.id}: nothing steps down`);
  });
  // The rim is the whole outline raised to the deck's height, and the same subnets stand either way.
  assert.equal(deck.rim.length, deck.outline.length);
  assert.deepEqual(deck.bands.map((band) => band.id), terraces.bands.map((band) => band.id));
  // The built network is exactly as it was: a seam between terraces, and a right-hand wall beside each.
  assert.ok(covered(terraces) < polygonArea(terraces.outline) - 1e-9, "a seam between terraces");
  for (const band of terraces.bands) assert.equal(band.walls.filter((wall) => wall.rim && wall.side === "right").length, 1, band.id);
});

test("the unbuilt deck keeps its subnets quiet and its rim the strongest line", () => {
  assert.ok(DECK.zone <= 0.12, "a subnet is a whisper of its colour");
  assert.ok(DECK.zone < DECK.pad.stroke && DECK.pad.stroke < DECK.rim, "pads anchor what stands on it, and the rim outranks them");
  assert.ok(DECK.glass.top >= 0.5 && DECK.glass.top < 0.8, "dark glass with body, still glass");
  assert.ok(DECK.label >= 0.85, "a subnet's name stays legible");
  assert.ok(DECK.shadow > 0 && DECK.shadow < 1, "a lighter shadow than a built island's");
});

test("every island has a trim in its icons' colour family, and every icon a tint", () => {
  for (const scene of [dev, prod, furnished()]) {
    for (const island of scene.islands) {
      assert.ok(island.id in ISLAND_TRIM, `${island.id} falls back to its region's trim`);
      assert.match(trimColor(island), /^#[0-9a-f]{6}$/i);
    }
  }
  for (const key of Object.keys(ICONS) as (keyof typeof ICONS)[]) assert.match(ICON_TINT[key], /^#[0-9a-f]{6}$/i);
  // Subnets read by colour: public green, private blue, isolated purple, each unlike the VPC's own edge.
  const vpc = dev.islands.find((island) => island.id === "island:vpc")!;
  for (const band of vpc.bands) assert.ok(band.id in BAND_TRIM, band.id);
  const colours = [...vpc.bands.map((band) => BAND_TRIM[band.id]), trimColor(vpc)];
  assert.equal(new Set(colours).size, colours.length);
});

test("an event badge is a black bolt on yellow, and every other role badge keeps the dark plate", () => {
  const luminance = (hexColor: string) => { const [r, g, b] = [1, 3, 5].map((at) => parseInt(hexColor.slice(at, at + 2), 16)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const event = ROLE_BADGE.event!;
  assert.ok(luminance(event.fill) > 160 && /^#f/i.test(event.fill), "an event badge is yellow");
  assert.equal(event.artwork, "eventBadge");
  const bolt = readFileSync(path.join(repositoryRoot, "framework-studio/public/icons", `${ICONS.eventBadge[0]}.svg`), "utf8");
  assert.ok(!/#d9e6f2/i.test(bolt) && /stroke="#0b0f14"/.test(bolt), "the bolt on yellow is dark ink");
  assert.deepEqual(Object.keys(ROLE_BADGE), ["event"], "the WebSocket plug and the agent badge keep the plate");
  for (const [key, badge] of Object.entries(ROLE_BADGE)) {
    assert.ok(badge.artwork === undefined || badge.artwork in ICONS, key);
    assert.ok(existsSync(path.join(repositoryRoot, "framework-studio/public/icons", `${ICONS[(badge.artwork ?? key) as keyof typeof ICONS][0]}.svg`)), key);
  }
  // Lambdas of those roles still stand with those role icons, so the badges reach the map.
  const roleIcons = new Set(dev.nodes.map((node) => node.roleIcon));
  assert.ok(roleIcons.has("event") && roleIcons.has("webSocket") && roleIcons.has("agent"));
  assert.equal(ICONS.webSocket[0], "generic/cable");
});

test("a badge lets an AWS service tile fill it, so no plate shows round it as a border", () => {
  for (const key of ["agent", "bucket", "table", "lambda", "service", "queue", "topic", "bus", "workflow", "secret", "database", "userpool"] as const) {
    assert.equal(carriesOwnTile(key), true, key);
    const svg = readFileSync(path.join(repositoryRoot, "framework-studio/public/icons", `${ICONS[key][0]}.svg`), "utf8");
    assert.match(svg, /<rect[^>]*width="80"[^>]*height="80"|<rect[^>]*height="80"[^>]*width="80"/, `${key} paints its own 80 by 80 tile`);
  }
  // Generic glyphs are bare strokes and still need the plate behind them.
  for (const key of ["event", "eventBadge", "webSocket", "unattached", "managed", "construct"] as const) assert.equal(carriesOwnTile(key), false, key);
});
