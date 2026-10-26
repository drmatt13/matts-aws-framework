import { readDraftEdits } from "../server/server";
import assert from "./support/assert";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { consumesResource } from "../server/resources-source";
import { drawnAs } from "../src/drawn-as";
import { buildScene } from "../src/scene/build";
import { searchScene } from "../src/scene/focus";
import { aggregateConnections } from "../src/connections";

const repository = path.resolve(__dirname, "../..");
function fixture() {
  const root = mkdtempSync(path.join(repository, ".cache", "deploy-condition-"));
  for (const directory of ["framework-config", "cdk-app/lambda_functions/http_functions/conditional"]) mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(path.join(root, "framework-config/resources.ts"), `import { defineResources, resource } from "@repo/framework/config";
export const resources = defineResources({ flag: resource.fromEnv("FLAG").enum("enabled", "disabled"), privateValue: resource.secret("PRIVATE") });
`);
  writeFileSync(path.join(root, "framework.config.ts"), `import { defineFrameworkConfig } from "@repo/framework/config";
import { resources as inputs } from "./framework-config/resources";
export default defineFrameworkConfig({ resources, defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: [{ "/conditional": { directory: "/lambda_functions/http_functions/conditional", methods: ["GET"], deploy: "none" } }], webSocket: [], services: [], events: [] });
`.replace("{ resources, defaults", "{ resources: inputs, defaults"));
  writeFileSync(path.join(root, "cdk-app/lambda_functions/http_functions/conditional/index.ts"), "export const lambdaHandler = async () => ({ statusCode: 200 });\n");
  writeFileSync(path.join(root, "cdk-app/.env.dev"), "FLAG=enabled\nPRIVATE=never-in-browser-dev\n");
  writeFileSync(path.join(root, "cdk-app/.env.prod"), "FLAG=disabled\nPRIVATE=never-in-browser-prod\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "conditional-fixture", private: true, workspaces: [] }));
  return root;
}

test("Deploy HTTP parser accepts bounded conditions and rejects expressions or extra fields", () => {
  const edit = { kind: "deploy", target: "lambda:conditional", value: { when: { resource: "resource:flag", equals: "enabled" } } };
  assert.deepEqual(readDraftEdits([edit]), [edit]);
  for (const value of [null, "invalid", { when: { resource: "resource:flag", equals: "" } }, { when: { resource: "resource:flag", equals: "enabled", expression: "unsafe" } }]) assert.throws(() => readDraftEdits([{ ...edit, value }]), /Deploy/);
});

test("conditional Deploy source edits resolve both environments, preserve aliases, apply", async () => {
  const root = fixture(), builder = new SnapshotBuilder(root), edits = new EditService(root, builder);
  try {
    const state = await builder.refresh();
    assert.equal(state.snapshot.models.dev.status, "ok", JSON.stringify(state.snapshot.models.dev.diagnostics));
    const before = readFileSync(path.join(root, "framework.config.ts"), "utf8");
    const plan = await edits.planBatch([{ kind: "deploy", target: "lambda:conditional", value: { when: { resource: "resource:flag", equals: "enabled" } } }], state.snapshot.revision);
    assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
    assert.ok(plan.changes[0]!.diff.unified.includes('inputs["flag"]'));
    assert.ok(plan.impact.some(message => message.includes("Development condition matches; enabled")));
    assert.ok(plan.impact.some(message => message.includes("Production condition does not match; disabled")));
    const applied = await edits.applyBatch(plan.planId);
    assert.equal(applied.status, "applied", applied.message);
    const snapshot = (await builder.refresh()).snapshot;
    const target = snapshot.models.dev.targets[0]!;
    assert.deepEqual([target.lanes.local, target.lanes.dev, target.lanes.prod], [true, false, false]);
    assert.equal(target.lanes.when?.dev, "holds"); assert.equal(target.lanes.when?.prod, "fails");
    assert.equal(consumesResource(target, "resource:flag"), true);
    assert.equal(snapshot.source.editability[target.ref]?.deploy?.kind, "condition");
    assert.ok(snapshot.models.dev.edges.some(edge => edge.relation === "deployWhen" && edge.to === "resource:flag"));
    assert.ok(!JSON.stringify({ plan, snapshot }).includes("never-in-browser"));
    const current = (await builder.refresh()).snapshot;
    await assert.rejects(edits.planBatch([{ kind: "deploy", target: "lambda:conditional", value: { when: { resource: "resource:privateValue", equals: "anything" } } }], current.revision), /non-secret input/);
  } finally { await builder.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("gateway representatives agree across layout, connections, search and selection", async () => {
  const root = fixture(), builder = new SnapshotBuilder(root);
  try {
    const snapshot = (await builder.refresh()).snapshot, model = snapshot.models.dev;
    const scene = buildScene(model), map = drawnAs(model);
    assert.deepEqual(scene.representatives, map);
    assert.equal(map["route:http:/conditional"], "gateway:http");
    assert.equal(map["framework-stack:HttpApiGatewayStack"], "gateway:http");
    assert.deepEqual(scene.nodes.filter(node => node.island === "island:apis").map(node => node.id), ["gateway:http"]);
    assert.ok(searchScene(scene, model, "/conditional")!.nodes.has("gateway:http"));
    assert.ok(aggregateConnections(model).some(edge => edge.from === "gateway:http" && edge.to === "lambda:conditional"));
  } finally { await builder.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("event Deploy conditions review both modes, apply without changing native identity", async () => {
  const root = fixture();
  const file = path.join(root, "framework.config.ts");
  const handler = path.join(root, "cdk-app/lambda_functions/event_functions/event");
  mkdirSync(handler, { recursive: true });
  writeFileSync(path.join(handler, "index.ts"), "export const lambdaHandler = async (event: unknown) => event;\n");
  writeFileSync(file, readFileSync(file, "utf8").replace("events: []", 'events: [{ event: { deploy: "none", cloud: { constructId: "StableEvent" } } }]'));
  const builder = new SnapshotBuilder(root), edits = new EditService(root, builder);
  try {
    const state = await builder.refresh();
    assert.equal(state.snapshot.models.dev.status, "ok", JSON.stringify(state.snapshot.models.dev.diagnostics));
    const before = readFileSync(file, "utf8");
    assert.ok(state.snapshot.models.dev.fields["lambda:event"]?.some(fact => fact.field === "deploy"));
    const plan = await edits.planBatch([{ kind: "deploy", target: "lambda:event", value: { when: { resource: "resource:flag", equals: "enabled" } } }], state.snapshot.revision);
    assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
    const applied = await edits.applyBatch(plan.planId);
    assert.equal(applied.status, "applied", applied.message);
    const snapshot = (await builder.refresh()).snapshot;
    const event = snapshot.models.dev.targets.find(target => target.ref === "lambda:event")!;
    assert.deepEqual([event.lanes.local, event.lanes.dev, event.lanes.prod], [true, true, false]);
    assert.equal(event.constructId, "StableEvent");
  } finally { await builder.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("representatives cover protocols, gateway stacks and hidden members consistently", () => {
  const model = { mode: "prod", status: "ok", routes: [
    { id: "route:http:/a", kind: "http", target: "lambda:a" },
    { id: "route:service:/s", kind: "service", target: "service:s" },
    { id: "route:ws:$default", kind: "webSocket", target: "lambda:ws" },
    { id: "route:agent:/chat", kind: "agent", target: "agent:chat" },
  ], targets: [], resources: [
    { id: "resource:gateway", stackClass: "HttpApiGatewayStack", kind: "stack" },
    { id: "resource:gateway.api", kind: "member", parent: "resource:gateway" },
    { id: "resource:other.member", kind: "member", parent: "resource:other" },
    { id: "resource:database", kind: "member", parent: "resource:other", networkId: "application", networkPlacement: "isolated" },
  ] } as unknown as import("../shared/model").ModeModel;
  const mapping = drawnAs(model);
  assert.equal(mapping["route:http:/a"], "gateway:http");
  assert.equal(mapping["route:service:/s"], "gateway:http");
  assert.equal(mapping["route:ws:$default"], "gateway:websocket");
  assert.equal(mapping["route:agent:/chat"], "agent:chat");
  assert.equal(mapping["resource:gateway.api"], "gateway:http");
  assert.equal(mapping["resource:other.member"], "resource:other");
  assert.equal(mapping["resource:database"], undefined);
});
