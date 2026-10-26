import { sourceFixtureCheckpoint } from "./support/source-fixture";
import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { CREATION_KINDS, creationDefaults, readCreationRequest, type CreationKind } from "../shared/creation";
import { assertCreationFile, planCreation } from "../server/edits/creation";
import { EditService } from "../server/edits/transaction";
import { writeSourceChange } from "../server/edits/io";
import { SnapshotBuilder } from "../server/snapshot";
import { generateCreationArtifacts } from "../server/edits/creation-generation";
import { resourceTypeErrors } from "../server/resources-source";
import { buildScene } from "../src/scene/build";
import { landscapeFocus, searchScene } from "../src/scene/focus";
import { islandSlabs } from "../src/scene/slabs";
import { pickIsland } from "../src/scene/picking";
import { project } from "../src/scene/iso";
import { networkSettings } from "../shared/networks";
import { planNetworkRemoval } from "../server/edits/networks";
import { SourceFiles } from "../server/source";

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, ".cache/framework-studio", `creation-${randomUUID()}`);
let builder: SnapshotBuilder;
let edits: EditService;
before(async () => {
  mkdirSync(fixture, { recursive: true });
  const include = (source: string) => !/(?:^|\/)(?:node_modules|cdk\.out|dist|\.git)(?:\/|$)/.test(source) && (!/\/\.env(?:\.|$)/.test(source) || path.basename(source) === ".env.example");
  for (const relative of ["framework-config", "framework.config.ts", "package.json", "package-lock.json", "docker-compose.yml", "docker-compose.services.yml", "packages/framework/src", "packages/api-contract/src/generated", "cdk-app/lib", "cdk-app/bin", "cdk-app/deployment.ts", "cdk-app/database-settings.ts", "cdk-app/stateful-resources.ts", "cdk-app/cdk.json", "cdk-app/tsconfig.json", "cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents", "scripts"]) cpSync(path.join(root, relative), path.join(fixture, relative), { recursive: true, filter: include });
  const manifests = require("node:fs").globSync(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).workspaces.map((pattern: string) => `${pattern}/package.json`), { cwd: root }) as string[];
  for (const relative of manifests) { mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true }); cpSync(path.join(root, relative), path.join(fixture, relative)); }
  for (const mode of ["dev", "prod"]) cpSync(path.join(root, `cdk-app/.env.${mode}.template`), path.join(fixture, `cdk-app/.env.${mode}.template`));
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
});
let restoreSource: () => Promise<void>;
beforeEach(() => { restoreSource = sourceFixtureCheckpoint(fixture, builder); });
afterEach(async () => { await restoreSource(); });

after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });
// Add only fields the selected discriminant accepts: the HTTP parser rejects extras.
function valid(kind: CreationKind, extra: Record<string, unknown> = {}) {
  const defaults = creationDefaults(kind);
  return readCreationRequest({ kind, ...defaults, ...("id" in defaults ? { id: ["input", "secret", "stack"].includes(kind) ? "studioExample" : `studio-${kind}` } : {}), ...("envName" in defaults ? { envName: "STUDIO_EXAMPLE" } : {}), ...(kind === "stack" ? { className: "StudioExampleStack" } : {}), ...(kind === "route" ? { path: "/studio-example" } : {}), ...(["service", "task"].includes(kind) ? { vpc: "application" } : {}), ...(kind === "service" ? { path: "/studio-example/*" } : {}), ...(kind === "vpc" ? { cidr: "10.42.0.0/16" } : {}), ...extra });
}
const state = () => builder.current!;
const revision = () => state().snapshot.revision;

for (const kind of CREATION_KINDS) test(`${kind}: complete reviewed creation, discovery, conflict protection`, async () => {
  const intent = valid(kind, { description: `Created in Studio: ${kind}`, tags: { Feature: "Studio fixtures" } });
  const planned = planCreation(fixture, state(), intent);
  const originals = new Map([...planned.overrides].map(([file]) => [file, existsSync(file) ? readFileSync(file, "utf8") : null]));
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(plan.select, planned.expected.select);
  assert.ok(plan.changes.length >= planned.overrides.size);
  for (const change of plan.changes) if (!originals.has(path.join(fixture, change.file))) originals.set(path.join(fixture, change.file), existsSync(path.join(fixture, change.file)) ? readFileSync(path.join(fixture, change.file), "utf8") : null);
  for (const [file, before] of originals) assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, before, "review never writes source");
  const applied = await edits.applyBatch(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.equal(applied.select, planned.expected.select);
  assert.equal(state().snapshot.descriptions.values[planned.expected.select], intent.description, "the existing Inspector description reads the created description");
  for (const mode of ["dev", "prod"] as const) {
    const model = state().snapshot.models[mode];
    const ids = new Set([...model.targets.map((item) => item.ref), ...model.resources.map((item) => item.id), ...model.routes.map((item) => item.id)]);
    for (const id of [...planned.expected.targets, ...planned.expected.resources, ...planned.expected.routes]) assert.ok(ids.has(id), `${mode} discovers ${id}`);
    const scene = buildScene(model);
    assert.ok(scene.nodes.some((node) => node.id === (scene.representatives[planned.expected.select] ?? planned.expected.select)) || scene.islands.some((island) => island.id === planned.expected.select), "the canonical resource appears in the actual graph projection");
    assert.equal(model.status, "ok");
    assert.equal(model.tagging?.[planned.expected.select]?.effective.Feature, "Studio fixtures", `${mode} reads the created tags from TypeScript`);
  }
  await assert.rejects(edits.planBatch([{ kind: "create", request: intent }], revision()), /already|exists/);

});

test("identity-pool: reviewed native stack exposes its pool, preserves existing identities and writes source", async () => {
  const intent = valid("stack", { id: "campaignIdentity", className: "CampaignIdentityStack", template: "identity-pool", scope: "dev", readBucketArn: "arn:aws:s3:::campaign-private", readPrefix: "tenant/" });
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.ok(plan.changes.some(change => change.file === "cdk-app/lib/app/campaign-identity-stack.ts"));
  const result = await edits.applyBatch(plan.planId); assert.equal(result.status, "applied", result.message);
  assert.ok(state().snapshot.models.dev.resources.some(resource => resource.id === "resource:campaignIdentity.identityPool"));
  assert.match(readFileSync(path.join(fixture, "cdk-app/bin/cdk-app.ts"), "utf8"), /userPool: cognitoStack.userPool, userPoolClient: cognitoStack.userPoolClient/);
  assert.match(readFileSync(path.join(fixture, "cdk-app/lib/app/campaign-identity-stack.ts"), "utf8"), /identityPoolAccess/);
  await restoreSource();
  assert.equal(existsSync(path.join(fixture, "cdk-app/lib/app/campaign-identity-stack.ts")), false);
});

test("prod-only stack tags remain editable in the local graph and preserves source structure", async () => {
  const file = path.join(fixture, "framework-config/resources/stacks.ts");
  const before = readFileSync(file, "utf8");
  const originalTags = state().snapshot.models.prod.tagging!["resource:rds"]!.authored;
  const plan = await edits.planBatch([{ kind: "tags", entity: "resource:rds", tags: { ...originalTags, Purpose: "Database ownership" } }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const applied = await edits.applyBatch(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  for (const mode of ["dev", "prod"] as const) assert.equal(state().snapshot.models[mode].tagging?.["resource:rds"]?.effective.Purpose, "Database ownership");
  await restoreSource();
  assert.equal(readFileSync(file, "utf8"), before);
});

test("untrusted requests reject unsupported settings and never reflect secret plaintext", () => {
  for (const kind of CREATION_KINDS) {
    assert.throws(() => readCreationRequest({ ...valid(kind), [kind === "vpc" ? "zones" : "id"]: kind === "vpc" ? 1 : "../../outside" }));
    assert.throws(() => readCreationRequest({ ...valid(kind), plaintext: "do-not-echo-this" }), (error: unknown) => error instanceof Error && !error.message.includes("do-not-echo-this"));
  }
  assert.throws(() => readCreationRequest({ ...valid("secret"), defaultValue: "do-not-echo-this" }), /unsupported settings/);
});

test("creation paths reject traversal, arbitrary files and symbolic-link parents", () => {
  for (const file of ["../outside.ts", "cdk-app/.env.dev", "package.json", "framework-config/../secret.ts", "framework-config/x/../../secret.ts", "framework-config/x\\secret.ts"]) assert.throws(() => assertCreationFile(fixture, file));
  const linked = path.join(fixture, "framework-config/linked");
  symlinkSync(path.join(fixture, "framework-config/workloads"), linked);
  try { assert.throws(() => assertCreationFile(fixture, "framework-config/linked/test.ts"), /symbolic/); }
  finally { rmSync(linked); }
});

test("concurrent source changes and newly occupied handler paths prevent all writes", async () => {
  const intent = valid("function", { id: "concurrent-function" });
  const declaration = path.join(fixture, "framework-config/workloads/events.ts");
  const originalDeclaration = readFileSync(declaration, "utf8");
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const handler = path.join(fixture, "cdk-app/lambda_functions/event_functions/concurrent-function/index.ts");
  mkdirSync(path.dirname(handler), { recursive: true });
  writeFileSync(handler, "// User-owned file\n");
  await assert.rejects(edits.applyBatch(plan.planId), /changed/);
  assert.equal(readFileSync(handler, "utf8"), "// User-owned file\n");
  assert.equal(readFileSync(declaration, "utf8"), originalDeclaration);
  rmSync(path.dirname(handler), { recursive: true });
});

test("an HTTP route and authenticated handler include bindings, permission edges and generated routes in one review", async () => {
  const intent = valid("route", { id: "bound-route", path: "/bound-route", bindingResource: "resource:openaiApiKey", bindingVariable: "PROVIDER_SECRET_ARN" });
  const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  for (const file of ["cdk-app/lambda_functions/http_functions/bound-route/index.ts", "framework-config/workloads/http.ts", "packages/api-contract/src/generated/framework-routes.ts"]) assert.ok(plan.changes.some((change) => change.file === file), `review includes ${file}`);
  assert.match(plan.changes.find((change) => change.file.endsWith("bound-route/index.ts"))!.diff.unified, /authenticated/);
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  const model = state().snapshot.models.prod;
  const target = model.targets.find((item) => item.ref === "lambda:bound-route")!;
  assert.equal(target.userPool, true);
  assert.ok(model.edges.some((edge) => edge.from === target.ref && edge.to === "resource:openaiApiKey"));
  assert.ok(target.environment.some((entry) => entry.name === "PROVIDER_SECRET_ARN" && entry.value.kind === "reference"));
  await restoreSource();
});

test("route aliases preserve target identity and WebSocket creation uses canonical ws route IDs", async () => {
  const target = state().snapshot.models.dev.targets.find((target) => target.ref === "lambda:graphql-api")!;
  const alias = await edits.planBatch([{ kind: "create", request: valid("route", { id: "route-alias", existingTarget: target.ref, path: "/route-alias", method: "POST" }) }], revision());
  assert.ok(alias.ok, JSON.stringify(alias.preflight));
  assert.equal((await edits.applyBatch(alias.planId)).status, "applied");
  assert.equal(state().snapshot.models.dev.targets.find((item) => item.ref === target.ref)!.constructId, target.constructId);
  assert.equal(state().snapshot.models.dev.routes.find((item) => item.id === "route:http:/route-alias")!.target, target.ref);
  await restoreSource();
  const websocketFile = path.join(fixture, "framework-config/workloads/websocket.ts");
  const originalWebSocket = readFileSync(websocketFile, "utf8");
  const conditionSource = originalWebSocket.replace('import { resources }', 'import { resources as creationInputs }')
    .replaceAll('resource: resources.enableWebSocketApi, equals: "true"', 'resource: creationInputs.langgraph.modelProvider, equals: "bedrock-mantle"');
  writeFileSync(websocketFile, conditionSource);
  try {
    await builder.refresh();
    const request = valid("route", { id: "ws-action", category: "webSocket", path: "studioAction" });
    for (const deploy of ["local-only", "cloud-only"]) assert.throws(() => planCreation(fixture, state(), { ...request, deploy } as typeof request), /must use the \$connect condition/);
    const disabled = planCreation(fixture, state(), { ...request, deploy: "none" } as typeof request);
    assert.match(disabled.overrides.get(websocketFile)!, /deploy: "none"/);
    const proposed = planCreation(fixture, state(), request);
    assert.match(proposed.overrides.get(websocketFile)!, /resource: creationInputs\["langgraph"\]\["modelProvider"\]/, "creation reuses the existing alias and actual catalog selector path");
    assert.match(proposed.overrides.get(websocketFile)!, /equals: "bedrock-mantle"/);
    assert.ok(proposed.impact.some(message => /Copies \$connect deployment condition: LANGGRAPH_MODEL_PROVIDER/.test(message)));
    const ws = await edits.planBatch([{ kind: "create", request }], revision());
    assert.ok(ws.ok, JSON.stringify(ws.preflight));
    const result = await edits.applyBatch(ws.planId);
    assert.equal(result.status, "applied", result.message);
    assert.equal(result.select, "route:ws:studioAction");
    for (const model of Object.values(state().snapshot.models)) {
      const when = model.targets.find(target => target.ref === "lambda:ws-action")!.lanes.when!;
      assert.equal(when.resource, "resource:langgraph.modelProvider");
      assert.equal(when.equals, "bedrock-mantle");
    }
    await restoreSource();
  } finally { writeFileSync(websocketFile, originalWebSocket); await builder.refresh(); }
});

test("an unguarded conditional WebSocket handshake keeps independent creation scope", () => {
  const snapshot = state().snapshot;
  const unguarded = (model: typeof snapshot.models.dev) => ({ ...model, routes: model.routes.map(({ authorizer: _authorizer, ...route }) => route) });
  const independent = { ...state(), snapshot: { ...snapshot, models: { dev: unguarded(snapshot.models.dev), prod: unguarded(snapshot.models.prod) } } };
  const proposed = planCreation(fixture, independent, valid("route", { id: "independent-action", category: "webSocket", path: "independentAction", deploy: "cloud-only" }));
  const source = proposed.overrides.get(path.join(fixture, "framework-config/workloads/websocket.ts"))!;
  assert.match(source, /deploy: "cloud-only"/, "no authorization guard requires this independent handler to copy the handshake condition");
});

test("catalog creation preserves authored environment values and secret consumers use automatic ARN delivery", async () => {
  const authored = path.join(fixture, "cdk-app/.env.dev");
  const privateValue = "fixture-value-kept-out-of-review";
  writeFileSync(authored, `STUDIO_EXAMPLE=${privateValue}\n`);
  const input = await edits.planBatch([{ kind: "create", request: valid("input", { required: true, defaultValue: "configured", consumer: "lambda:graphql-api", consumerVariable: "STUDIO_SETTING" }) }], revision());
  assert.ok(input.ok, JSON.stringify(input.preflight));
  assert.ok(!JSON.stringify(input).includes(privateValue));
  assert.equal((await edits.applyBatch(input.planId)).status, "applied");
  assert.equal(state().snapshot.models.dev.resources.find((item) => item.id === "resource:studioExample")!.absent, false);
  assert.equal(state().snapshot.models.prod.resources.find((item) => item.id === "resource:studioExample")!.absent, false);
  await restoreSource();
  const secret = await edits.planBatch([{ kind: "create", request: valid("secret", { consumer: "lambda:graphql-api", consumerVariable: "STUDIO_SECRET_ARN" }) }], revision());
  assert.ok(secret.ok, JSON.stringify(secret.preflight));
  assert.ok(secret.changes.every((change) => !/^cdk-app\/\.env\.(dev|prod)$/.test(change.file)));
  assert.ok(secret.changes.some((change) => change.diff.unified.includes('.arn')));
  assert.equal((await edits.applyBatch(secret.planId)).status, "applied");
  assert.ok(state().snapshot.models.dev.edges.some((edge) => edge.from === "lambda:graphql-api" && edge.to === "resource:studioExample"));
  await restoreSource();
  assert.equal(readFileSync(authored, "utf8"), `STUDIO_EXAMPLE=${privateValue}\n`);
  rmSync(authored);
});

test("partial multi-file write failure restores existing files and removes newly created files", async () => {
  let writes = 0;
  const failing = new EditService(fixture, builder, (root, file, before, after) => {
    if (++writes === 2) throw new Error("Simulated second-write failure");
    writeSourceChange(root, file, before, after);
  });
  const plan = await failing.planBatch([{ kind: "create", request: valid("function", { id: "failed-function" }) }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const before = plan.changes.map(({ file }) => ({ file: path.join(fixture, file), content: existsSync(path.join(fixture, file)) ? readFileSync(path.join(fixture, file), "utf8") : null }));
  const result = await failing.applyBatch(plan.planId);
  assert.equal(result.status, "reverted", result.message);
  for (const { file, content } of before) assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, content);
  assert.ok(!existsSync(path.join(fixture, "cdk-app/lambda_functions/event_functions/failed-function")), "failed scaffolding directories are cleaned up");
});

test("post-write evaluation failure compensates the entire creation", async () => {
  const declaration = path.join(fixture, "framework-config/workloads/events.ts");
  const originalDeclaration = readFileSync(declaration, "utf8");
  const plan = await edits.planBatch([{ kind: "create", request: valid("function", { id: "verification-failure" }) }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const refresh = builder.refresh.bind(builder);
  let fail = true;
  builder.refresh = async () => { if (fail) { fail = false; throw new Error("Simulated post-write verification failure"); } return refresh(); };
  try {
    const result = await edits.applyBatch(plan.planId);
    assert.equal(result.status, "reverted", result.message);
    assert.equal(readFileSync(declaration, "utf8"), originalDeclaration);
    assert.ok(!existsSync(path.join(fixture, "cdk-app/lambda_functions/event_functions/verification-failure/index.ts")));
  } finally { builder.refresh = refresh; }
});

test("a catalog input composes its declaration module and source changes expire its approval", async () => {
  const files = ["dev", "prod"].map((mode) => path.join(fixture, `cdk-app/.env.${mode}.template`));
  const templates = files.map((file) => readFileSync(file, "utf8"));
  files.forEach((file, index) => writeFileSync(file, templates[index] + "\n# STUDIO_SINGLE=\n"));
  try {
    const intent = valid("input", { id: "singleInput", envName: "STUDIO_SINGLE" });
    const plan = await edits.planBatch([{ kind: "create", request: intent }], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    assert.deepEqual(plan.changes.map((change) => change.file).sort(), ["framework-config/resources.ts", "framework-config/resources/inputs.ts"]);
    const file = path.join(fixture, "framework-config/resources.ts");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before + "\n// Concurrent source edit\n");
    await assert.rejects(edits.applyBatch(plan.planId), /changed/);
    assert.equal(readFileSync(file, "utf8"), before + "\n// Concurrent source edit\n");
    writeFileSync(file, before);
    await builder.refresh();
    const fresh = await edits.planBatch([{ kind: "create", request: intent }], revision());
    assert.equal((await edits.applyBatch(fresh.planId)).status, "applied");
    assert.ok(buildScene(state().snapshot.models.dev).nodes.some((node) => node.id === "resource:singleInput"));
    await restoreSource();
  } finally { files.forEach((file, index) => writeFileSync(file, templates[index]!)); }
});

test("successive VPC creation supports NAT, friendly names, unused removal, and guarded removal", async () => {
  await builder.refresh();
  const initialNetworks = state().snapshot.models.prod.networks!.length;
  const ids = ["creator-test", "analytics", "reporting"];
  for (const [index, id] of ids.entries()) {
    const request = valid("vpc", { id, name: `${id} workspace`, description: `Notes for ${id}`, cidr: `10.${index + 21}.0.0/16`, nat: true });
    const plan = await edits.planBatch([{ kind: "create", request }], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
    for (const mode of ["dev", "prod"] as const) {
      const network = state().snapshot.models[mode].networks!.find(network => network.id === id)!;
      assert.equal(network.name, `${id} workspace`);
      assert.equal(network.natGateway, true);
      assert.equal(network.builtInProd, false);
      assert.equal(state().snapshot.models[mode].networks!.length, initialNetworks + index + 1);
    }
    await assert.rejects(edits.planBatch([{ kind: "create", request }], revision()), /already exists/);
  }
  const beforeOverlap = readFileSync(path.join(fixture, "framework.config.ts"), "utf8");
  await assert.rejects(edits.planBatch([{ kind: "create", request: valid("vpc", { id: "overlapping", cidr: "10.21.0.0/16" }) }], revision()), /overlaps VPC "creator-test"/);
  assert.equal(readFileSync(path.join(fixture, "framework.config.ts"), "utf8"), beforeOverlap);
  assert.equal(existsSync(path.join(fixture, "framework-config/networks/overlapping/index.ts")), false);
  const testNetwork = state().snapshot.models.prod.networks!.find(network => network.id === "creator-test")!;
  const rename = await edits.planBatch([{ kind: "network", network: "creator-test", settings: { ...networkSettings(testNetwork), name: "Customer sandbox" } }], revision());
  assert.ok(rename.ok, JSON.stringify(rename.preflight));
  assert.equal((await edits.applyBatch(rename.planId)).status, "applied");
  assert.equal(state().snapshot.models.prod.networks!.find(network => network.id === "creator-test")!.name, "Customer sandbox");
  assert.equal(state().snapshot.models.prod.networks!.find(network => network.id === "creator-test")!.constructId, testNetwork.constructId);
  await assert.rejects(edits.planBatch([{ kind: "network", network: "creator-test", settings: { ...networkSettings(testNetwork), cidr: "10.22.0.0/16" } }], revision()), /overlaps VPC "analytics"/);
  assert.throws(() => planNetworkRemoval(fixture, state(), "application", new SourceFiles()), /used by|database/);
  const nativeFile = path.join(fixture, "cdk-app/lib/app/network-consumer.ts");
  writeFileSync(nativeFile, 'import { creatorTestVpc as nativeVpc } from "../../../framework-config/networks/creator-test"; const alias = nativeVpc; export { alias };');
  try { assert.throws(() => planNetworkRemoval(fixture, state(), "creator-test", new SourceFiles()), /network-consumer\.ts/); }
  finally { rmSync(nativeFile); }
  const interruptedRemoval = await edits.planBatch([{ kind: "removeNetwork", network: "creator-test" }], revision());
  writeFileSync(nativeFile, 'import { creatorTestVpc } from "../../../framework-config/networks/creator-test"; export { creatorTestVpc };');
  try {
    await assert.rejects(edits.applyBatch(interruptedRemoval.planId), /referenced|changed/);
    assert.ok(existsSync(path.join(fixture, "framework-config/networks/creator-test/index.ts")), "a new native reference prevents removal before any write");
  } finally { rmSync(nativeFile); }
  const removal = await edits.planBatch([{ kind: "removeNetwork", network: "creator-test" }], revision());
  assert.ok(removal.ok, JSON.stringify(removal.preflight));
  assert.ok(removal.changes.some(change => change.file === "framework-config/networks/creator-test/index.ts" && change.operation === "delete"));
  assert.equal((await edits.applyBatch(removal.planId)).status, "applied");
  assert.equal(existsSync(path.join(fixture, "framework-config/networks/creator-test/index.ts")), false);
  assert.equal(existsSync(path.join(fixture, "framework-config/networks/creator-test")), false, "removal prunes only the empty VPC directory");
  assert.ok(!state().snapshot.models.prod.networks!.some(network => network.id === "creator-test"));
  assert.equal(state().snapshot.descriptions.values["island:vpc:creator-test"], undefined);

});

test("independent VPC creation, workload reassignment and network settings share reviewed transactions", async () => {
  await builder.refresh();
  const request = valid("vpc", { id: "secondary", cidr: "10.77.0.0/16" });
  const create = await edits.planBatch([{ kind: "create", request }], revision());
  assert.ok(create.ok, JSON.stringify(create.preflight));
  assert.ok(create.changes.some(change => change.file === "framework-config/networks/secondary/index.ts" && change.operation === "create"));
  assert.equal(create.select, "island:vpc:secondary");
  assert.equal((await edits.applyBatch(create.planId)).status, "applied");
  const secondary = state().snapshot.models.prod.networks!.find(network => network.id === "secondary")!;
  assert.equal(secondary.builtInProd, false);
  assert.equal(state().snapshot.source.entities["island:vpc:secondary"]?.value.file, "framework-config/networks/secondary/index.ts");
  // A native resource can build this VPC before any framework workload uses it.
  // Review evaluates declarations; apply additionally enriches them from CDK source.
  const stackFile = path.join(fixture, "cdk-app/lib/app/rds-stack.ts");
  const stackBefore = readFileSync(stackFile, "utf8");
  const stackWithNativeVpc = 'import { secondaryVpc } from "../../../framework-config/networks/secondary";\n' + stackBefore
    .replace("public readonly database:", "public readonly nativeSecurityGroup: ec2.SecurityGroup;\n  public readonly database:")
    .replace("super(scope, id, props);", 'super(scope, id, props);\n    this.nativeSecurityGroup = new ec2.SecurityGroup(this, "NativeSecurityGroup", { vpc: frameworkVpc(this, secondaryVpc) });');
  writeFileSync(stackFile, stackWithNativeVpc);
  try {
    await builder.refresh();
    assert.equal(state().snapshot.models.prod.networks!.find(network => network.id === "secondary")!.builtInProd, true);
    assert.equal(state().snapshot.models.prod.resources.find(resource => resource.id === "resource:rds.nativeSecurityGroup")?.networkId, "secondary");
    const nativeReview = await edits.planBatch([{ kind: "create", request: valid("input", { id: "nativeVpcReview", envName: "NATIVE_VPC_REVIEW" }) }], revision());
    assert.ok(nativeReview.ok, JSON.stringify(nativeReview.preflight));
    const result = await edits.applyBatch(nativeReview.planId);
    assert.equal(result.status, "applied", result.message);
  } finally {
    writeFileSync(stackFile, stackBefore);
    await builder.refresh();
  }
  const original = readFileSync(path.join(fixture, "framework-config/workloads/http.ts"), "utf8");
  const review = await edits.planBatch([
    { kind: "placement", target: "lambda:sign-out", vpc: "secondary", subnet: "private" },
    { kind: "network", network: "secondary", settings: { cidr: secondary.cidr, zones: 2, nat: true, ipv6: true, s3: true, dynamodb: true, endpoints: [] } },
  ], revision());
  assert.ok(review.ok, JSON.stringify(review.preflight));
  assert.equal(readFileSync(path.join(fixture, "framework-config/workloads/http.ts"), "utf8"), original, "review does not write");
  assert.ok(review.changes.some(change => change.file === "framework-config/workloads/http.ts" && /secondary/.test(change.diff.unified)));
  assert.equal((await edits.applyBatch(review.planId)).status, "applied");
  const model = state().snapshot.models.prod;
  assert.deepEqual(model.targets.find(target => target.ref === "lambda:sign-out")!.placement.kind === "vpc" && model.targets.find(target => target.ref === "lambda:sign-out")!.placement, {
    kind: "vpc", networkId: "secondary", subnet: "private", reason: 'Declares subnet: "private".', egress: { ipv4: true, ipv6: true }, dualStack: true,
  });
  const layoutModels = Object.values(state().snapshot.models);
  const scene = buildScene(model, { layoutModels });
  assert.equal(scene.islands.filter(island => island.region === "network").length, model.networks!.length);
  assert.equal(new Set(scene.props.map(prop => prop.id)).size, scene.props.length);
  assert.equal(new Set(scene.islands.flatMap(island => island.bands.map(band => band.id))).size, scene.islands.flatMap(island => island.bands).length);
  assert.equal(scene.nodes.find(node => node.id === "lambda:sign-out")?.island, "island:vpc:secondary");
  assert.equal(scene.nodes.find(node => node.id === "resource:rds.database")?.island, "island:vpc:application");
  const selection = landscapeFocus(scene, "island:vpc:secondary");
  assert.ok(selection.nodes.has("lambda:sign-out"));
  assert.ok(!selection.nodes.has("lambda:graphql-api"));
  assert.ok([...selection.props].every(id => id.startsWith("prop:vpc:secondary:")));
  const matches = searchScene(scene, model, "secondary")!;
  assert.ok(matches.islands.has("island:vpc:secondary"));
  assert.ok(!matches.islands.has("island:vpc:application"));
  for (const island of scene.islands.filter(island => island.region === "network")) {
    const point = project({ x: (island.gx0 + island.gx1) / 2, y: (island.gy0 + island.gy1) / 2, h: island.top });
    assert.equal(pickIsland(point, islandSlabs(scene))?.id, island.id);
  }
  const geometry = (value: ReturnType<typeof buildScene>) => value.islands.map(({ id, gx0, gy0, gx1, gy1, bands }) => ({ id, gx0, gy0, gx1, gy1, bands })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(geometry(buildScene(state().snapshot.models.dev, { layoutModels })), geometry(scene), "mode switching keeps both VPCs in place");
  assert.deepEqual(geometry(buildScene({ ...model, networks: [...model.networks!].reverse() }, { layoutModels })), geometry(scene), "registry order does not move islands");
  const move = await edits.planBatch([{ kind: "placement", target: "lambda:sign-out", vpc: "secondary", subnet: "isolated" }], revision());
  const networkFile = path.join(fixture, "framework-config/networks/secondary/index.ts");
  const text = readFileSync(networkFile, "utf8");
  writeFileSync(networkFile, text + "\n// Concurrent VPC edit\n");
  await assert.rejects(edits.applyBatch(move.planId), /changed/);
  writeFileSync(networkFile, text);
  await restoreSource();
  assert.equal(existsSync(networkFile), false);
});

test("post-apply VPC and placement mismatches roll back the complete reviewed source", async () => {
  const baseline = state().snapshot.models.dev;
  const originalPlacement = baseline.targets.find(target => target.ref === "lambda:sign-out")!.placement;
  const network = baseline.networks!.find(network => network.id === "application")!;
  for (const kind of ["placement", "network"] as const) {
    const edit = kind === "placement"
      ? { kind, target: "lambda:sign-out", vpc: "application", subnet: "private" as const }
      : { kind, network: "application", settings: { ...networkSettings(network), nat: true } };
    const plan = await edits.planBatch([edit], revision());
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    const originals = plan.changes.map(change => ({ file: path.join(fixture, change.file), text: readFileSync(path.join(fixture, change.file), "utf8") }));
    const refresh = builder.refresh.bind(builder);
    let corrupt = true;
    builder.refresh = async () => {
      const actual = await refresh();
      if (!corrupt) return actual;
      corrupt = false;
      const dev = actual.snapshot.models.dev;
      return { ...actual, snapshot: { ...actual.snapshot, models: { ...actual.snapshot.models, dev: {
        ...dev,
        targets: kind === "placement" ? dev.targets.map(target => target.ref === "lambda:sign-out" ? { ...target, placement: originalPlacement } : target) : dev.targets,
        networks: kind === "network" ? dev.networks!.map(network => network.id === "application" ? { ...network, natGateway: false } : network) : dev.networks,
      } } } };
    };
    try {
      const result = await edits.applyBatch(plan.planId);
      assert.equal(result.status, "reverted", result.message);
      assert.match(result.message!, /did not match the review/);
      for (const original of originals) assert.equal(readFileSync(original.file, "utf8"), original.text);
    } finally { builder.refresh = refresh; }
  }
});

test("managed database settings review both modes, apply exact source, and reject conflicts", async () => {
  await builder.refresh();
  const database = state().snapshot.models.prod.managedDatabase!;
  assert.equal(database.id, "application");
  const file = path.join(fixture, "framework-config/databases/application/index.ts");
  const before = readFileSync(file, "utf8");
  const settings = { ...database.authored, multiAz: true, readReplicaCount: 2 };
  const plan = await edits.planBatch([{ kind: "database", database: database.id, settings }], revision());
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.deepEqual(plan.changes.map(change => change.file), ["framework-config/databases/application/index.ts"]);
  assert.equal(readFileSync(file, "utf8"), before);
  const applied = await edits.applyBatch(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  for (const mode of ["dev", "prod"] as const) {
    const model = state().snapshot.models[mode];
    assert.equal(model.managedDatabase!.settings.multiAz, true);
    assert.equal(model.managedDatabase!.settings.readReplicaCount, 2);
    assert.equal(model.managedDatabase!.networkId, "application");
    assert.equal(state().snapshot.source.entities["database:application"]!.value.file, "framework-config/databases/application/index.ts");
  }
  await restoreSource();
  assert.equal(readFileSync(file, "utf8"), before);
  await restoreSource();
  const pending = await edits.planBatch([{ kind: "database", database: database.id, settings }], revision());
  writeFileSync(file, before + "\n// Concurrent database policy edit\n");
  await assert.rejects(edits.applyBatch(pending.planId), /changed/);
  assert.equal(readFileSync(file, "utf8"), before + "\n// Concurrent database policy edit\n");
  writeFileSync(file, before);
  await builder.refresh();
});

test("generated declarations and stack registration survive full offline development and production synthesis", async () => {
  // Transaction behavior is exercised independently for every family above.
  // Build one realistic application fixture, generate once, then synth both graphs.
  const originals = new Map<string, string | null>();
  const source = new Map<string, string>();
  const stage = (file: string, text: string) => {
    if (!originals.has(file)) originals.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    source.set(file, text);
  };
  const baseline = state();
  for (const intent of [valid("stack", { id: "synthStack", className: "StudioSynthStack", scope: "prod" }), valid("workflow", { id: "synth-workflow", steps: ["lambda:invocation-test-step", "task:invocation-test-task"] }), valid("function", { id: "synth-function" }), valid("route", { id: "synth-route", path: "/synth-route" }), valid("service", { id: "synth-service", path: "/synth-service/*", deploy: "both" }), valid("task", { id: "synth-task" }), valid("agent", { id: "synth-agent", auth: false, tools: ["add-numbers"] }), valid("input", { id: "synthInput", envName: "STUDIO_SYNTH_INPUT" }), valid("secret", { id: "synthSecret", envName: "STUDIO_SYNTH_SECRET" }), valid("vpc")]) {
    for (const [file, text] of planCreation(fixture, baseline, intent).overrides) stage(file, text);
  }
  for (const [file, text] of (await generateCreationArtifacts(fixture, source)).overrides) stage(file, text);
  assert.deepEqual(resourceTypeErrors(fixture, Object.fromEntries(source)), []);
  const configured = await builder.refresh();
  for (const model of Object.values(configured.snapshot.models)) assert.equal(model.status, "ok", JSON.stringify(model.diagnostics));
  const project = JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.json"), "utf8")).context;
  const assemblyDirectory = path.join(root, ".cache/framework-studio", `creation-assembly-${randomUUID()}`);
  const cached = existsSync(path.join(root, "cdk-app/cdk.context.json")) ? JSON.parse(readFileSync(path.join(root, "cdk-app/cdk.context.json"), "utf8")) : {};
  try {
    for (const mode of ["dev", "prod"] as const) {
      const inputs = path.join(fixture, `${mode}-synth.env`);
      writeFileSync(inputs, mode === "dev" ? "CDK_APP_NAME=my-aws-app\nLOCAL_DEV_URL=http://localhost:3000\n" : "USE_FRONTEND_CUSTOM_DOMAIN=false\nUSE_COGNITO_CUSTOM_DOMAIN=false\n");
      const outdir = path.join(assemblyDirectory, mode);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(CDK_|FRAMEWORK_|AWS_PROFILE$|PROD_DEPLOYMENT$|DEPLOY_PROD_WEBSOCKET_API$|DATABASE_)/.test(key)) delete env[key];
      const synth = spawnSync(process.execPath, ["--import", "tsx", "bin/main.ts"], { cwd: path.join(fixture, "cdk-app"), encoding: "utf8", timeout: 120_000, env: { ...env, CDK_OUTDIR: outdir, CDK_DEFAULT_ACCOUNT: "734849394764", CDK_DEFAULT_REGION: "us-east-1", AWS_EC2_METADATA_DISABLED: "true", CDK_CONTEXT_JSON: JSON.stringify({ ...project, ...cached, "aws:cdk:bundling-stacks": [], prodDeployment: String(mode === "prod") }), FRAMEWORK_INPUTS_FILE: inputs } });
      assert.equal(synth.status, 0, `${synth.stdout}\n${synth.stderr}`);
      const manifest = JSON.parse(readFileSync(path.join(outdir, "manifest.json"), "utf8"));
      const stacks = Object.keys(manifest.artifacts);
      assert.equal(stacks.some((id) => id.endsWith("StudioSynthStack")), mode === "prod", "stack registration honors its catalog scope");
      if (mode === "prod") {
        const artifact = manifest.artifacts[stacks.find((id) => id.endsWith("StudioSynthStack"))!] as { type: string; properties: { templateFile: string } };
        assert.equal(artifact.type, "aws:cloudformation:stack");
        const template = JSON.parse(readFileSync(path.join(outdir, artifact.properties.templateFile), "utf8"));
        assert.ok(Object.values(template.Resources).some((resource: any) => resource.Type === "AWS::SQS::Queue"));
      }
    }
  } finally {
    rmSync(assemblyDirectory, { recursive: true, force: true });
    for (const [file, before] of [...originals].reverse()) writeSourceChange(fixture, file, readFileSync(file, "utf8"), before);
  }
});
