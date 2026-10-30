import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { BatchEditor } from "../server/edits/batch";
import { writeSourceChange } from "../server/edits/io";
import { sourceFixtureCheckpoint } from "./support/source-fixture";
import type { DraftEdit } from "../shared/api";

const repository = path.resolve(__dirname, "../..");
const root = path.join(repository, ".cache/framework-studio", `naming-batch-${randomUUID()}`);
const file = (name: string) => path.join(root, name);
const text = (name: string) => readFileSync(file(name), "utf8");
const save = (name: string, value: string) => { mkdirSync(path.dirname(file(name)), { recursive: true }); writeFileSync(file(name), value); };
let builder: SnapshotBuilder;
let editor: BatchEditor;
let restore: () => Promise<void>;
const revision = () => builder.current!.snapshot.revision;
before(async () => {
  save("framework-config/inputs.ts", 'import { resource } from "@repo/framework/config";\nexport const flag = resource.value("true", { tags: { area: "realtime" } }).enum("true", "false");\n');
  save("framework-config/resources.ts", 'import { defineResources, resource } from "@repo/framework/config";\nimport { flag } from "./inputs";\nexport const resources = defineResources({ flag, settings: { derived: resource.fromEnv() }, key: resource.secret("FIXTURE_KEY") });\n');
  save("framework-config/websocket.ts", `import { resources } from "./resources";\nexport const webSocket = {\n${["$connect", "$disconnect", "$default", "one", "two"].map((name, index) => `${JSON.stringify(name)}: { directory: "/lambda_functions/route${index}", deploy: { when: { resource: resources.flag, equals: "true" } } }`).join(",\n")}\n} as const;\n`);
  save("framework-config/client-environment.ts", 'export const clientEnvironment = { VITE_FLAG: { kind: "input", name: "resource:flag" } } as const;\n');
  save("framework-config/descriptions.ts", 'export const descriptions = { "resource:flag": "The prose still says flag.", "resource:settings.derived": "An implicit environment key." };\n');
  save("framework.config.ts", 'import { defineFrameworkConfig } from "@repo/framework/config";\nimport { defaults } from "./framework-config/defaults";\nimport { resources } from "./framework-config/resources";\nimport { webSocket } from "./framework-config/websocket";\nexport default defineFrameworkConfig({ resources, defaults, webSocket: [webSocket], http: [], events: [], services: [] });\n');
  cpSync(path.join(repository, "framework-config/defaults.ts"), file("framework-config/defaults.ts"));
  for (let i = 0; i < 5; i++) save(`cdk-app/lambda_functions/route${i}/index.ts`, "export const handler = async () => ({});\n");
  save("cdk-app/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true }, include: ["../framework-config/**/*.ts", "../framework.config.ts", "lambda_functions/**/*.ts"] }));
  builder = new SnapshotBuilder(root); editor = new BatchEditor(root, builder, new Map());
  const state = await builder.refresh();
  assert.equal(state.snapshot.models.dev.status, "ok", JSON.stringify(state.snapshot.models.dev.diagnostics));
});
beforeEach(() => { restore = sourceFixtureCheckpoint(root, builder); });
afterEach(async () => { await restore(); editor.expirePlans(); });
after(async () => { await builder?.dispose(); rmSync(root, { recursive: true, force: true }); });

test("display-only names create a reviewed optional map without changing source identity", async () => {
  const entity = builder.current!.snapshot.models.dev.targets[0]!.ref;
  assert.equal(builder.current!.snapshot.namingCapabilities?.[entity]?.code, false);
  const before = text("framework-config/websocket.ts");
  const plan = await editor.plan([{ kind: "displayName", entity, value: "  Friendly route  " }], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.deepEqual(plan.changes.map(change => [change.file, change.operation]), [["framework-config/display-names.ts", "create"]]);
  assert.equal(existsSync(file("framework-config/display-names.ts")), false);
  assert.equal((await editor.apply(plan.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.displayNames?.values[entity], "Friendly route");
  assert.equal(text("framework-config/websocket.ts"), before);
});

test("rename composes source configuration, tags, descriptions and display names in one apply", async () => {
  const edits: DraftEdit[] = [
    { kind: "rename", entity: "resource:flag", name: "webSocketEnabled" },
    { kind: "resourceConfig", intent: { resource: "resource:flag", kind: "input", fromEnv: null, group: "", requirements: {}, modes: { dev: { present: true, required: false, default: null, value: "false" }, prod: { present: true, required: false, default: null, value: "false" } } } },
    { kind: "tags", entity: "resource:flag", tags: { area: "updated" } },
    { kind: "description", entity: "resource:flag", value: "Keep flag as human prose." },
    { kind: "displayName", entity: "resource:flag", value: "Realtime feature" },
  ];
  const before = text("framework-config/inputs.ts");
  const connection = builder.current!.snapshot.models.dev.edges.find(edge => edge.from === "resource:flag" && edge.relation === "deployWhen")!;
  const plan = await editor.plan(edits, revision());
  assert.equal(plan.ok, true, JSON.stringify({ issues: plan.renameIssues, preflight: plan.preflight }));
  assert.equal(text("framework-config/inputs.ts"), before);
  assert.equal(plan.entityRemap?.["resource:flag"], "resource:webSocketEnabled");
  const applied = await editor.apply(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.equal(applied.entityRemap?.["resource:flag"], "resource:webSocketEnabled");
  const renamedConnection = builder.current!.snapshot.models.dev.edges.find(edge => edge.from === "resource:webSocketEnabled" && edge.to === connection.to && edge.relation === connection.relation)!;
  assert.equal(applied.entityRemap?.[connection.id], renamedConnection.id, "Historical relationship selections follow confirmed application.");
  assert.match(text("framework-config/inputs.ts"), /export const webSocketEnabled/);
  assert.equal(text("framework-config/websocket.ts").match(/resources\.webSocketEnabled/g)?.length, 5);
  assert.match(text("framework-config/client-environment.ts"), /resource:webSocketEnabled/);
  assert.equal(builder.current!.snapshot.descriptions.values["resource:webSocketEnabled"], "Keep flag as human prose.");
  assert.equal(builder.current!.snapshot.displayNames?.values["resource:webSocketEnabled"], "Realtime feature");
  const resource = builder.current!.snapshot.models.dev.resources.find(resource => resource.id === "resource:webSocketEnabled")!;
  assert.equal(resource.authoredValue, "false");
  assert.equal(builder.current!.snapshot.models.dev.resources.some(resource => resource.id === "resource:flag"), false);
});

test("computed old references leave a reviewable partial diff and prevent apply", async () => {
  save("cdk-app/lambda_functions/route0/dynamic.ts", 'import { resources } from "../../../framework-config/resources";\nconst key = "flag" as const;\nexport const selected = resources[key];\n');
  await builder.refresh();
  const plan = await editor.plan([{ kind: "rename", entity: "resource:flag", name: "featureFlag" }], revision());
  assert.equal(plan.ok, false);
  assert.ok(plan.changes.length);
  assert.ok(plan.renameIssues?.some(issue => issue.source.file.endsWith("dynamic.ts") && issue.source.line > 0));
  await assert.rejects(editor.apply(plan.planId), /rejected settings/);
  assert.match(text("framework-config/inputs.ts"), /export const flag/);
});

test("new consumers and changed project configuration expire a reviewed rename", async () => {
  const edit: DraftEdit = { kind: "rename", entity: "resource:flag", name: "featureFlag" };
  const before = text("framework-config/inputs.ts");
  const plan = await editor.plan([edit], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.renameIssues));
  save("cdk-app/lambda_functions/route0/new-consumer.ts", 'import { resources } from "../../../framework-config/resources"; export const flag = resources.flag;');
  await assert.rejects(editor.apply(plan.planId), /changed/);
  assert.equal(text("framework-config/inputs.ts"), before);
  await restore();
  const second = await editor.plan([edit], revision());
  save("cdk-app/tsconfig.json", text("cdk-app/tsconfig.json") + "\n");
  await assert.rejects(editor.apply(second.planId), /changed/);
  assert.equal(text("framework-config/inputs.ts"), before);
});

test("a partial write is restored without dropping the proposed rename", async () => {
  let writes = 0;
  const failing = new BatchEditor(root, builder, new Map(), (root, file, before, after) => {
    if (++writes === 2) throw new Error("Controlled partial write failure");
    writeSourceChange(root, file, before, after);
  });
  const before = text("framework-config/inputs.ts");
  const plan = await failing.plan([{ kind: "rename", entity: "resource:flag", name: "featureFlag" }], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.renameIssues));
  const result = await failing.apply(plan.planId);
  assert.equal(result.status, "reverted", result.message);
  assert.match(result.message, /draft is preserved/);
  assert.equal(result.entityRemap, undefined);
  assert.equal(text("framework-config/inputs.ts"), before);
});

test("a post-write model mismatch restores the rename and returns no continuity remap", async () => {
  let afterWrite = false;
  const originalRefresh = builder.refresh.bind(builder);
  const wrapped = {
    get current() { return builder.current; }, evaluators: builder.evaluators,
    refresh: async () => {
      const actual = await originalRefresh();
      if (!afterWrite) return actual;
      afterWrite = false;
      return { ...actual, snapshot: { ...actual.snapshot, models: { ...actual.snapshot.models,
        dev: { ...actual.snapshot.models.dev, resources: actual.snapshot.models.dev.resources.map(resource => resource.id === "resource:featureFlag" ? { ...resource, authoredValue: "false" } : resource) },
      } } };
    },
  } as SnapshotBuilder;
  const guarded = new BatchEditor(root, wrapped, new Map(), (root, file, before, after) => { writeSourceChange(root, file, before, after); afterWrite = true; });
  const before = text("framework-config/inputs.ts");
  const plan = await guarded.plan([{ kind: "rename", entity: "resource:flag", name: "featureFlag" }], revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.renameIssues));
  const applied = await guarded.apply(plan.planId);
  assert.equal(applied.status, "reverted", applied.message);
  assert.equal(applied.entityRemap, undefined);
  assert.equal(text("framework-config/inputs.ts"), before);
});

test("source-value edits compose with renaming while preserving declaration comments", async () => {
  save("framework-config/inputs.ts", text("framework-config/inputs.ts").replace('value("true", { tags:', 'value(/* value context */ "true", { /* metadata context */ tags:'));
  await builder.refresh();
  const plan = await editor.plan([
    { kind: "rename", entity: "resource:flag", name: "featureFlag" },
    { kind: "resourceConfig", intent: { resource: "resource:flag", kind: "input", fromEnv: null, group: "", requirements: {}, modes: { dev: { present: true, required: false, default: null, value: "false" }, prod: { present: true, required: false, default: null, value: "false" } } } },
  ], revision());
  assert.equal(plan.ok, true, JSON.stringify({ issues: plan.renameIssues, preflight: plan.preflight }));
  const applied = await editor.apply(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.match(text("framework-config/inputs.ts"), /export const featureFlag = resource\.value\(\/\* value context \*\/ "false", \{ \/\* metadata context \*\//);
});
