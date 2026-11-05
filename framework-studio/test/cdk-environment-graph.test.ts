import assert from "./support/assert";
import { test } from "node:test";
import { CDK_ENVIRONMENT_ID, type InputRequirement } from "../shared/deployment-inputs";
import type { Mode, ModeModel, ModelEdge, ModelResource } from "../shared/model";
import { aggregateConnections, connectionHasSource, missingConnectionInput } from "../src/connections";
import { connectionIssues, presentConnectionHover } from "../src/connection-presentation";
import { indexModel } from "../src/lookup";
import { buildScene } from "../src/scene/build";
import { searchScene } from "../src/scene/focus";
import { nodeHoverFacts } from "../src/scene/hover";
import { connectionVisible } from "../src/scene/connections";

const MODES = ["dev", "prod"] as const;
const GROUP = "resource:settings";
function fixture() {
  const inputs = ["shared", "devOnly", "prodOnly"];
  const requirement = (mode: Mode, input: string): InputRequirement => ({
    resource: `${GROUP}.${input}`, name: input.toUpperCase(), file: `cdk-app/.env.${mode}`, mode,
    required: true, status: input === "shared" && mode === "prod" ? "missing" : "configured", reasons: [],
  });
  const edges = MODES.flatMap(mode => inputs.filter(input => input !== `${mode === "dev" ? "prod" : "dev"}Only`).map((input): ModelEdge => ({
    id: `input-source:${mode}:${input.toUpperCase()}:${GROUP}.${input}`, from: `envfile:${mode}`, to: `${GROUP}.${input}`,
    relation: "supplies", label: input.toUpperCase(), provenance: "source", inputRequirement: requirement(mode, input),
    source: { file: `cdk-app/.env.${mode}`, line: 3, column: 1, start: 0, end: 0 },
  })));
  const model = (mode: Mode): ModeModel => {
    const resources: ModelResource[] = [
      { id: CDK_ENVIRONMENT_ID, path: ["CDK environment"], kind: "envFile", absent: false, deploymentFiles: { dev: "envfile:dev", prod: "envfile:prod" } },
      ...MODES.map((fileMode): ModelResource => ({ id: `envfile:${fileMode}`, path: [`cdk-app/.env.${fileMode}`], kind: "envFile", absent: fileMode !== mode,
        deploymentFile: { mode: fileMode, path: `cdk-app/.env.${fileMode}`, template: `cdk-app/.env.${fileMode}.template`, exists: true,
          entries: edges.filter(edge => edge.from === `envfile:${fileMode}`).map(edge => ({ name: edge.label, status: edge.inputRequirement!.status === "missing" ? "missing" : "configured", counterpart: "configured", sensitive: false, defaulted: false, targets: [edge.to] })) } })),
      { id: GROUP, path: ["settings"], kind: "group", absent: false },
      ...inputs.map((input): ModelResource => ({ id: `${GROUP}.${input}`, path: ["settings", input], parent: GROUP, kind: "input", fromEnv: input.toUpperCase(), absent: input === `${mode === "dev" ? "prod" : "dev"}Only` })),
      { id: "client-envfile", path: ["Client environment"], kind: "envFile", absent: false,
        clientEnvironment: { mode, path: mode === "dev" ? "client-app/.env.development.local" : "client-app/.env.production.local", inputs: `cdk-app/.env.${mode}`, entries: [], mappings: {}, options: [] } },
    ];
    return { mode, status: "ok", resources, edges, targets: [], routes: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 };
  };
  return { dev: model("dev"), prod: model("prod") };
}

test("CDK supplies join each variable's physical modes without duplicate rows or lost source identity", () => {
  const models = fixture();
  const connection = aggregateConnections(models.dev, Object.values(models))[0]!;
  assert.equal(connection.from, CDK_ENVIRONMENT_ID);
  assert.equal(connection.to, GROUP);
  assert.equal(connection.members.length, 3);
  assert.deepEqual(connection.availability, { dev: true, prod: true });
  const shared = connection.members.find(member => member.edge.label === "SHARED")!;
  assert.deepEqual(shared.availability, { dev: true, prod: true });
  assert.deepEqual(shared.sourceIds, MODES.map(mode => `input-source:${mode}:SHARED:${GROUP}.shared`));
  for (const mode of MODES) {
    assert.equal(shared.models[mode]!.from, `envfile:${mode}`);
    assert.equal(shared.models[mode]!.source!.file, `cdk-app/.env.${mode}`);
    assert.ok(connectionHasSource(connection, shared.models[mode]!.id));
    assert.deepEqual(connection.members.find(member => member.edge.label === `${mode.toUpperCase()}ONLY`)!.availability, { dev: mode === "dev", prod: mode === "prod" });
  }
  const other = aggregateConnections(models.prod, Object.values(models))[0]!;
  assert.equal(other.id, connection.id);
  assert.deepEqual(other.members.map(member => member.sourceIds), connection.members.map(member => member.sourceIds));
});

test("missing production values do not mark development wires; hovers retain the qualified production problem", () => {
  const models = fixture(), indexes = { dev: indexModel(models.dev), prod: indexModel(models.prod) };
  const dev = aggregateConnections(models.dev, Object.values(models))[0]!;
  const prod = aggregateConnections(models.prod, Object.values(models))[0]!;
  assert.equal(missingConnectionInput(dev), false);
  assert.equal(missingConnectionInput(prod), true);
  assert.equal(connectionVisible(dev, new Set(), undefined, true), false);
  assert.equal(connectionVisible(prod, new Set(), undefined, true), true);
  assert.deepEqual(connectionIssues(dev, "dev", indexes.dev), []);
  assert.equal(connectionIssues(prod, "prod", indexes.prod).length, 1);
  const hover = presentConnectionHover(dev, indexes);
  assert.equal(hover.title, "Supplies: 3 inputs");
  assert.equal(hover.environmentFile, undefined, "the unified resource uses per-input pills");
  const row = hover.rows.find(row => row.label === "shared")!;
  assert.deepEqual(row.availability, { dev: true, prod: true });
  assert.ok(row.details.some(detail => detail.tone === "error" && detail.modes?.join() === "prod"));
});

test("one semantic supply retains a stable group id and distinct input destinations stay distinct", () => {
  const pair = fixture();
  const models = MODES.map(mode => ({ ...pair[mode], edges: pair[mode].edges.filter(edge => edge.label === "SHARED") }));
  const single = aggregateConnections(models[0]!, models)[0]!;
  assert.equal(single.members.length, 1);
  assert.ok(single.id.startsWith("connection:envfile%3Acdk:"));
  assert.equal(single.id, aggregateConnections(models[1]!, models)[0]!.id);
  const duplicated = models.map(model => ({ ...model, edges: [...model.edges, ...model.edges.map(edge => ({ ...edge, id: `${edge.id}:second`, to: `${GROUP}.devOnly` }))] }));
  assert.equal(aggregateConnections(duplicated[0]!, duplicated)[0]!.members.length, 2);
});

test("a single-graph projection preserves source evidence without inventing availability for the other graph", () => {
  const models = fixture();
  for (const mode of MODES) {
    const connection = aggregateConnections(models[mode])[0]!;
    assert.equal(connection.members.length, 3);
    assert.deepEqual(connection.availability, { dev: mode === "dev", prod: mode === "prod" });
    const shared = connection.members.find(member => member.edge.label === "SHARED")!;
    for (const fileMode of MODES) assert.equal(shared.models[fileMode]!.inputRequirement!.mode, fileMode);
    assert.equal(missingConnectionInput(connection), mode === "prod");
  }
});

test("map, searches and hover locations share one CDK environment while retaining both physical files", () => {
  const models = fixture();
  for (const mode of MODES) {
    const scene = buildScene(models[mode], { layoutModels: Object.values(models) });
    const environment = scene.nodes.filter(node => node.island === "island:environment");
    assert.deepEqual(environment.map(node => node.id), [CDK_ENVIRONMENT_ID]);
    assert.equal(scene.nodes.find(node => node.id === CDK_ENVIRONMENT_ID)!.presence, "present");
    for (const fileMode of MODES) {
      assert.equal(scene.representatives[`envfile:${fileMode}`], CDK_ENVIRONMENT_ID);
      assert.ok(searchScene(scene, models[mode], `cdk-app/.env.${fileMode}`)!.nodes.has(CDK_ENVIRONMENT_ID));
    }
    const facts = nodeHoverFacts(environment.find(node => node.id === CDK_ENVIRONMENT_ID)!, { dev: indexModel(models.dev), prod: indexModel(models.prod) });
    assert.deepEqual(facts.places, MODES.map(env => ({ env, where: `Local file · cdk-app/.env.${env}` })));
  }
});
