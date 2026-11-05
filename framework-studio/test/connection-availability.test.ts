import assert from "./support/assert";
import test from "node:test";
import type { Mode, ModelEdge, Snapshot } from "../shared/model";
import { graphFixture } from "../scripts/support/graph-fixture";
import { edgeAvailability } from "../src/connections";
import { indexModel } from "../src/lookup";

function models(): Snapshot["models"] {
  const model = (mode: Mode) => {
    const fixture = graphFixture(12, mode);
    return {
      ...fixture,
      targets: fixture.targets.map((target, index) => ({
        ...target,
        lanes: { ...target.lanes, local: index !== 1, dev: false, prod: index !== 2 },
      })),
      resources: [
        ...fixture.resources.map((resource, index) => ({ ...resource, absent: mode === "prod" && index === 0 })),
        { id: "resource:fixture0.bucket", kind: "member" as const, path: ["fixture0", "bucket"], parent: "resource:fixture0", absent: false },
      ],
      edges: [
        ...fixture.edges,
        { id: "member", from: "lambda:fixture-0", to: "resource:fixture0.bucket", relation: "grant" as const, provenance: "source" as const, label: "grantRead" },
      ],
    };
  };
  return { dev: model("dev"), prod: model("prod") };
}

test("prebuilt availability indexes preserve every edge's mode-specific result", () => {
  const pair = models();
  const indexes = { dev: indexModel(pair.dev), prod: indexModel(pair.prod) };
  for (const edge of pair.dev.edges) {
    assert.deepEqual(edgeAvailability(edge, pair, indexes), edgeAvailability(edge, pair), edge.id);
  }
  assert.deepEqual(edgeAvailability(pair.dev.edges.find(edge => edge.id === "member")!, pair, indexes), { dev: true, prod: false }, "a stack member follows its absent owner in production");
  assert.deepEqual(edgeAvailability(pair.dev.edges.find(edge => edge.relation === "routes" && edge.to === "lambda:fixture-1")!, pair, indexes), { dev: false, prod: true });
  assert.deepEqual(edgeAvailability(pair.dev.edges.find(edge => edge.relation === "routes" && edge.to === "lambda:fixture-2")!, pair, indexes), { dev: true, prod: false });
});

test("availability keeps first matching edge and missing-edge behavior with prebuilt indexes", () => {
  const pair = models();
  const edge: ModelEdge = { id: "duplicate", from: "lambda:fixture-0", to: "resource:fixture1", relation: "grant", provenance: "declared", label: "grantRead" };
  const missingEndpoint = { ...edge, to: "resource:missing" };
  const duplicatePair = { ...pair, dev: { ...pair.dev, edges: [...pair.dev.edges, missingEndpoint, edge] }, prod: { ...pair.prod, edges: [...pair.prod.edges, edge, missingEndpoint] } };
  const indexes = { dev: indexModel(duplicatePair.dev), prod: indexModel(duplicatePair.prod) };
  assert.deepEqual(edgeAvailability(edge, duplicatePair, indexes), { dev: false, prod: true });
  assert.deepEqual(edgeAvailability(edge, duplicatePair, indexes), edgeAvailability(edge, duplicatePair));
  assert.deepEqual(edgeAvailability({ ...edge, id: "not-present" }, duplicatePair, indexes), { dev: false, prod: false });
});

test("fresh render indexes observe later model changes without carrying availability across calls", () => {
  const pair = models();
  const edge = pair.dev.edges.find(edge => edge.id === "member")!;
  assert.deepEqual(edgeAvailability(edge, pair, { dev: indexModel(pair.dev), prod: indexModel(pair.prod) }), { dev: true, prod: false });
  Object.assign(pair.dev.resources.find(resource => resource.id === "resource:fixture0")!, { absent: true });
  Object.assign(pair.prod.resources.find(resource => resource.id === "resource:fixture0")!, { absent: false });
  assert.deepEqual(edgeAvailability(edge, pair, { dev: indexModel(pair.dev), prod: indexModel(pair.prod) }), { dev: false, prod: true });
  assert.deepEqual(edgeAvailability(edge, pair), { dev: false, prod: true });
});
