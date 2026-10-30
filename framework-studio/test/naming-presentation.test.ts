import assert from "./support/assert";
import path from "node:path";
import { after, before, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import type { ModeModel, Snapshot } from "../shared/model";
import { NamingHistory, displayName, presentedSnapshot } from "../src/naming";
import { indexModel, titleOf } from "../src/lookup";
import { buildScene } from "../src/scene/build";
import { searchScene } from "../src/scene/focus";
import { configuredAccessOptions } from "../src/access-options";

let builder: SnapshotBuilder;
let snapshot: Snapshot;
before(async () => { builder = new SnapshotBuilder(path.resolve(__dirname, "../..")); snapshot = (await builder.refresh()).snapshot; });
after(() => builder.dispose());

test("accepted rename remaps historical URLs and descendants without hijacking fresh IDs or rename cycles", () => {
  const history = new NamingHistory();
  assert.equal(history.selection("first", "resource:settings.enabled"), "resource:settings.enabled");
  assert.equal(history.selection("second", "resource:settings"), "resource:settings");
  history.accept({ "resource:settings": "resource:features" });
  assert.equal(history.selection("first", "resource:settings.enabled"), "resource:features.enabled");
  assert.equal(history.selection("second", "resource:settings"), "resource:features");
  assert.equal(history.selection("fresh", "resource:settings"), "resource:settings", "a newly created resource may reuse the old id");
  history.accept({ "resource:features": "resource:settings" });
  assert.equal(history.selection("first", "resource:settings.enabled"), "resource:settings.enabled");
  assert.equal(history.selection("second", "resource:settings"), "resource:settings");
  assert.equal(history.selection("fresh", "resource:settings"), "resource:settings");
  assert.equal(history.selection("second", "lambda:other"), "lambda:other", "a replacement with another raw selection starts a new identity");
});

test("display names share map, lookup, search and access captions while source identities remain canonical", () => {
  const id = "resource:enableWebSocketApi";
  const sourceModel = snapshot.models.dev;
  const sourceResource = sourceModel.resources.find(item => item.id === id)!;
  const next = presentedSnapshot({ ...snapshot, displayNames: { values: { [id]: "WebSocket feature" } } });
  const model = next.models.dev;
  const scene = buildScene(model);
  assert.equal(scene.nodes.find(node => node.id === id)?.label, "WebSocket feature");
  assert.equal(titleOf(indexModel(model), id), "WebSocket feature");
  assert.ok(searchScene(scene, model, "WebSocket feature")?.nodes.has(id));
  assert.ok(searchScene(scene, model, "enableWebSocketApi")?.nodes.has(id));
  const target = model.targets.find(item => item.role === "http")!;
  const option = configuredAccessOptions(target, next).find(item => item.id === id)!;
  assert.equal(option.title, "WebSocket feature");
  assert.match(option.searchTerms!, /enableWebSocketApi/);
  assert.deepEqual(model.resources.find(item => item.id === id)?.path, sourceResource.path);
  assert.equal(sourceModel, snapshot.models.dev);
  assert.equal(displayName(sourceModel, id, "enableWebSocketApi"), "enableWebSocketApi");
});

test("VPCs keep network.name as their only display authority and retain CIDR context", () => {
  const network = snapshot.models.dev.networks![0]!;
  const id = `island:vpc:${network.id}`;
  const named = presentedSnapshot({ ...snapshot, displayNames: { values: { [id]: "Conflicting metadata" } } });
  const model = named.models.dev;
  const title = `${network.name ?? network.id} · ${network.cidr}`;
  assert.equal(displayName(model, id, title), title);
  assert.equal(buildScene(model).islands.find(island => island.id === id)?.title, title);
});

test("a confirmed code rename retains every node slot and island position", () => {
  const from = "resource:enableWebSocketApi", to = "resource:allowWebSockets";
  const initial = buildScene(snapshot.models.dev);
  const model: ModeModel = { ...snapshot.models.dev,
    resources: snapshot.models.dev.resources.map(resource => resource.id === from ? { ...resource, id: to, path: ["allowWebSockets"] } : resource),
    edges: snapshot.models.dev.edges.map(edge => ({ ...edge, from: edge.from === from ? to : edge.from, to: edge.to === from ? to : edge.to })),
  };
  const renamed = buildScene(model, { layoutSettings: { previous: initial.layout.positions, previousKey: initial.layout.topologyKey, preservePositions: true } });
  assert.deepEqual(renamed.layout.positions, initial.layout.positions);
  for (const previous of initial.nodes) {
    const current = renamed.nodes.find(node => node.id === (previous.id === from ? to : previous.id))!;
    assert.deepEqual([current.gx, current.gy, current.h, current.geometry], [previous.gx, previous.gy, previous.h, previous.geometry], previous.id);
  }
});
