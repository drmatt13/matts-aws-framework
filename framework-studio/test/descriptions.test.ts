import assert from "./support/assert";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseDescriptions, renameRouteDescriptions, rewriteDescription } from "../server/descriptions";
import { SnapshotBuilder } from "../server/snapshot";
import { connectionDescriptionId, descriptionEntityIds } from "../shared/descriptions";
import type { Snapshot } from "../shared/model";
import { buildScene } from "../src/scene/build";

let builder: SnapshotBuilder;
let snapshot: Snapshot;
before(async () => { builder = new SnapshotBuilder(path.resolve(__dirname, "../..")); snapshot = (await builder.refresh()).snapshot; });
after(() => builder.dispose());

test("managed map identities have authored descriptions or contextual network fixture guidance", () => {
  assert.equal(snapshot.descriptions.problem, undefined);
  const ids = descriptionEntityIds(Object.values(snapshot.models));
  const fixtureGuidance = new Map<string, string>();
  for (const model of Object.values(snapshot.models)) {
    const scene = buildScene(model);
    for (const prop of scene.props) fixtureGuidance.set(prop.id, prop.caption.join(" ").trim());
    for (const item of [...scene.nodes, ...scene.islands, ...scene.props]) {
      assert.ok(ids.has(item.id), `editable: ${item.id}`);
      assert.ok(snapshot.descriptions.values[item.id]?.trim() || fixtureGuidance.get(item.id), `description: ${item.id}`);
    }
    for (const edge of model.edges) assert.ok(ids.has(connectionDescriptionId(edge)), `editable connection: ${edge.id}`);
  }
  for (const id of ids) if (!id.startsWith("connection-description:")) assert.ok(snapshot.descriptions.values[id]?.trim() || fixtureGuidance.get(id), `description: ${id}`);
});

test("connection notes follow named relationships across graph ordering and environment detail changes", () => {
  const edge = snapshot.models.dev.edges.find((edge) => edge.relation === "env")!;
  assert.equal(connectionDescriptionId(edge), connectionDescriptionId({ ...edge, id: "different-ordinal#3", detail: "Production reference", provenance: "derived" }));
  assert.notEqual(connectionDescriptionId(edge), connectionDescriptionId({ ...edge, label: "ANOTHER_MAPPING" }));
  assert.notEqual(connectionDescriptionId(edge), connectionDescriptionId({ ...edge, from: edge.to, to: edge.from }));
});

test("conditional deployment keeps its existing description key when its direction changes", () => {
  const condition = snapshot.models.dev.edges.find(edge => edge.relation === "deployWhen")!;
  assert.ok(condition);
  assert.ok(condition.from.startsWith("resource:"));
  const historical = `connection-description:${JSON.stringify([condition.relation, condition.to, condition.from, condition.label, condition.attachment ?? null])}`;
  assert.equal(connectionDescriptionId(condition), historical);
});

test("literal edits preserve comments and safely round trip text that resembles code", () => {
  const original = '// preserve header\nexport const descriptions = {\n  // keep comment\n  "lambda:one": "before", // keep inline\n} satisfies Record<string, string>;\n';
  const value = 'Quotes " and \' with \\ paths\r\nNew line\t${process.exit()} `ticks` 😺';
  const after = rewriteDescription(original, "lambda:one", value);
  assert.equal(parseDescriptions(after).values["lambda:one"], value);
  assert.equal(after, original.replace('"before"', JSON.stringify(value)));
  const inserted = rewriteDescription(after, "lambda:two", value);
  assert.equal(parseDescriptions(inserted).values["lambda:two"], value);
  assert.ok(inserted.includes('// keep inline'));
  const empty = rewriteDescription('export const descriptions = {\n // keep this\n};', "lambda:new", value);
  assert.ok(empty.includes('// keep this'));
  assert.equal(parseDescriptions(empty).values["lambda:new"], value);
});

test("computed, duplicate and invalid descriptions are refused without executing source", () => {
  for (const text of ['export const descriptions = { ...other };', 'export const descriptions = { x: run() };', 'export const descriptions = { x: "a", x: "b" };', 'export const descriptions = { x: `a${run()}` };', 'export const descriptions = {']) assert.throws(() => parseDescriptions(text));
  assert.throws(() => rewriteDescription('export const descriptions = {};', "lambda:new", "x".repeat(8001)), /at most/);
  assert.throws(() => rewriteDescription('export const descriptions = {};', "lambda:new", "\0"), /null/);
});

test("route description renames support swaps, preserve prose and reject unrelated collisions", () => {
  const source = 'export const descriptions = { "route:http:/a": "A", "route:http:/b": "B" };';
  const swap = renameRouteDescriptions(source, [{ before: "/a", after: "/b" }, { before: "/b", after: "/a" }]);
  assert.equal(parseDescriptions(swap).values["route:http:/b"], "A");
  assert.equal(parseDescriptions(swap).values["route:http:/a"], "B");
  assert.throws(() => renameRouteDescriptions(source, [{ before: "/a", after: "/b" }]), /already exists/);
});
