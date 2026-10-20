import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { after, before, test } from "node:test";
import { withClientEnvironment } from "../server/client-environment";
import { SnapshotBuilder } from "../server/snapshot";
import { CLIENT_ENVIRONMENT_ID, CLIENT_ENVIRONMENT_ISLAND } from "../shared/client-environment";
import type { ModeModel, Snapshot } from "../shared/model";
import { buildScene } from "../src/scene/build";
import { searchScene } from "../src/scene/focus";

const root = path.resolve(__dirname, "../..");
let builder: SnapshotBuilder;
let snapshot: Snapshot;
before(async () => { builder = new SnapshotBuilder(root); snapshot = (await builder.refresh()).snapshot; });
after(() => builder.dispose());
const clientFile = (model: ModeModel) => model.resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)!.clientEnvironment!;

test("every documented client variable maps to the selected graph's inputs or public stack outputs", () => {
  const expected = Object.keys(parseEnv(readFileSync(path.join(root, "client-app/.env.example"), "utf8"))).sort();
  for (const model of Object.values(snapshot.models)) {
    const file = clientFile(model);
    assert.deepEqual(file.entries.map((entry) => entry.name).sort(), expected);
    assert.equal(file.inputs, `cdk-app/.env.${model.mode}`);
    const entries = new Map(file.entries.map((entry) => [entry.name, entry]));
    const cognito = model.resources.find((resource) => resource.stackClass === "CognitoStack")!;
    for (const name of ["VITE_USER_POOL_ID", "VITE_USER_POOL_CLIENT_ID", "VITE_COGNITO_DOMAIN", "VITE_AWS_REGION"]) {
      assert.equal(entries.get(name)!.sources[0]!.entity, cognito.id);
      assert.equal(entries.get(name)!.status, "mapped");
    }
    assert.equal(entries.get("VITE_AWS_REGION")!.expression, "CognitoStack.region");
    for (const entry of file.entries) for (const source of entry.sources) if (source.entity) assert.ok(model.resources.some((resource) => resource.id === source.entity));
    for (const edge of model.edges.filter((edge) => edge.from === CLIENT_ENVIRONMENT_ID)) {
      assert.equal(edge.relation, "maps");
      assert.ok(!model.resources.find((resource) => resource.id === edge.to)?.deploymentFile || edge.to === `envfile:${model.mode}`);
    }
  }
});

test("local endpoint recipes, production front door and intentionally empty local tools follow each mode", () => {
  const entries = (model: ModeModel) => new Map(clientFile(model).entries.map((entry) => [entry.name, entry]));
  const dev = entries(snapshot.models.dev), prod = entries(snapshot.models.prod);
  assert.match(dev.get("VITE_API_GATEWAY_URL")!.expression, /LOCAL_API_DEV_SERVER_HOST_PORT/);
  assert.match(dev.get("VITE_LOCAL_WS_URL")!.expression, /^ws:\/\/localhost:.*LOCAL_WS_DEV_SERVER_HOST_PORT/);
  assert.match(dev.get("VITE_WS_TESTER_URL")!.expression, /WS_TESTER_HOST_PORT/);
  assert.match(prod.get("VITE_API_GATEWAY_URL")!.expression, /FrontendWebsiteS3Stack.CloudFrontUrl/);
  for (const name of ["VITE_LOCAL_WS_URL", "VITE_WS_TESTER_URL"]) {
    assert.equal(prod.get(name)!.status, "empty");
    assert.equal(prod.get(name)!.required, false);
    assert.deepEqual(prod.get(name)!.sources, []);
  }
});

test("a WebSocket mapping is empty only when its stack is absent; a missing enabled output is reported", () => {
  const base = snapshot.models.dev;
  const project = (absent: boolean, outputs: boolean) => withClientEnvironment({ ...base, resources: base.resources.map((resource) => resource.stackClass === "WebSocketApiStack" ? { ...resource, absent, stackOutputs: outputs ? resource.stackOutputs : [] } : resource) });
  const entry = (model: ModeModel) => clientFile(model).entries.find((entry) => entry.name === "VITE_API_GATEWAY_WS_URL")!;
  assert.equal(entry(project(true, true)).status, "empty");
  assert.equal(entry(project(false, true)).status, "mapped");
  assert.equal(entry(project(false, true)).required, true);
  assert.equal(entry(project(false, false)).status, "unavailable");
});

test("mappings reuse renamed catalog identities and never expose authored input values", () => {
  const sentinel = "private-client-mapping-sentinel";
  const base = snapshot.models.dev;
  const renamed = withClientEnvironment({ ...base, resources: base.resources.map((resource) => {
    if (resource.stackClass === "CognitoStack") return { ...resource, id: "resource:identity" };
    if (resource.deploymentFile?.mode === "dev") return { ...resource, deploymentFile: { ...resource.deploymentFile, entries: [...resource.deploymentFile.entries.filter((entry) => entry.name !== "VITE_API_GATEWAY_URL"), { name: "VITE_API_GATEWAY_URL", status: "configured" as const, sensitive: false, defaulted: false, targets: [], value: sentinel }] } };
    return resource;
  }) });
  const file = clientFile(renamed);
  assert.ok(file.entries.find((entry) => entry.name === "VITE_USER_POOL_ID")!.sources.every((source) => source.entity === "resource:identity"));
  assert.match(file.entries.find((entry) => entry.name === "VITE_API_GATEWAY_URL")!.sources[0]!.label, /VITE_API_GATEWAY_URL/);
  assert.ok(!JSON.stringify(file).includes(sentinel));
  const twice = withClientEnvironment(renamed);
  assert.equal(twice.resources.filter((resource) => resource.id === CLIENT_ENVIRONMENT_ID).length, 1);
  assert.equal(twice.edges.length, renamed.edges.length);
});

test("the client island, its source connections and variable search exist in both scenes without moving between modes", () => {
  const options = { layoutModels: Object.values(snapshot.models) };
  const scenes = Object.values(snapshot.models).map((model) => buildScene(model, options));
  for (const [at, model] of Object.values(snapshot.models).entries()) {
    const scene = scenes[at]!;
    assert.equal(scene.islands.find((island) => island.id === CLIENT_ENVIRONMENT_ISLAND)?.title, "Client-app environment file");
    assert.equal(scene.nodes.find((node) => node.id === CLIENT_ENVIRONMENT_ID)?.island, CLIENT_ENVIRONMENT_ISLAND);
    assert.ok(scene.edges.some((edge) => edge.from === CLIENT_ENVIRONMENT_ID && edge.to === "resource:cognito"));
    assert.ok(searchScene(scene, model, "VITE_USER_POOL_CLIENT_ID")!.nodes.has(CLIENT_ENVIRONMENT_ID));
  }
  assert.deepEqual(scenes[0]!.nodes.map((node) => [node.id, node.gx, node.gy]), scenes[1]!.nodes.map((node) => [node.id, node.gx, node.gy]));
});
