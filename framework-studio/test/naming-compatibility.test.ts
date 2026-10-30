import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { BatchEditor } from "../server/edits/batch";
import { SnapshotBuilder } from "../server/snapshot";
import { sourceFixtureCheckpoint } from "./support/source-fixture";

const repository = path.resolve(__dirname, "../..");
const root = path.join(repository, ".cache/framework-studio", `naming-compatibility-${randomUUID()}`);
const file = (name: string) => path.join(root, name);
const save = (name: string, text: string) => { mkdirSync(path.dirname(file(name)), { recursive: true }); writeFileSync(file(name), text); };
let builder: SnapshotBuilder;
let editor: BatchEditor;
let restore: () => Promise<void>;

before(async () => {
  save("framework-config/resources.ts", 'import { defineResources, resource } from "@repo/framework/config";\nexport const resources = defineResources({ flag: resource.value("true"), mixed: { native: resource.cdk<{ readonly tableName: string }>(), setting: resource.value("true") } });\n');
  save("framework.config.ts", 'import { defineFrameworkConfig } from "@repo/framework/config";\nimport { defaults } from "./framework-config/defaults";\nimport { resources } from "./framework-config/resources";\nexport default defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], events: [], services: [], tasks: [], workflows: [] });\n');
  cpSync(path.join(repository, "framework-config/defaults.ts"), file("framework-config/defaults.ts"));
  save("cdk-app/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true, allowJs: true }, include: ["../framework-config/**/*.ts", "../framework.config.ts", "lambda_functions/**/*"] }));
  builder = new SnapshotBuilder(root); editor = new BatchEditor(root, builder, new Map());
  const state = await builder.refresh();
  assert.equal(state.snapshot.models.dev.status, "ok", JSON.stringify(state.snapshot.models.dev.diagnostics));
});
beforeEach(() => { restore = sourceFixtureCheckpoint(root, builder); });
afterEach(async () => { await restore(); editor.expirePlans(); });
after(async () => { await builder?.dispose(); rmSync(root, { recursive: true, force: true }); });

test("a direct rename request cannot bypass the native-group compatibility gate", async () => {
  const before = readFileSync(file("framework-config/resources.ts"), "utf8");
  assert.equal(builder.current!.snapshot.namingCapabilities?.["resource:mixed"]?.code, false);
  await assert.rejects(editor.plan([{ kind: "rename", entity: "resource:mixed", name: "renamedGroup" }], builder.current!.snapshot.revision), /identity|compatibility|input|secret/i);
  assert.equal(readFileSync(file("framework-config/resources.ts"), "utf8"), before);
});

for (const extension of ["js", "mts"]) test(`a configured ${extension} consumer is either blocked during review or fully supported by apply`, async () => {
  const consumer = `cdk-app/lambda_functions/worker/consumer.${extension}`;
  save(consumer, 'import { resources } from "../../../framework-config/resources";\nexport const selected = resources.flag;\n');
  await builder.refresh();
  const plan = await editor.plan([{ kind: "rename", entity: "resource:flag", name: "featureFlag" }], builder.current!.snapshot.revision);
  if (!plan.ok) {
    assert.ok(plan.renameIssues?.some(issue => issue.source.file === consumer), JSON.stringify(plan));
    return;
  }
  const applied = await editor.apply(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.match(readFileSync(file(consumer), "utf8"), /resources\.featureFlag/);
});

for (const [name, body] of [
  ["reflective access", 'export const selected = Reflect.get(resources, "flag");'],
  ["an erased catalog shape", 'const catalog: Record<string, unknown> = resources; export const selected = catalog.flag;'],
] as const) test(`${name} blocks a rename whose references cannot be proven`, async () => {
  const consumer = "cdk-app/lambda_functions/worker/consumer.ts";
  save(consumer, `import { resources } from "../../../framework-config/resources";\n${body}\n`);
  await builder.refresh();
  const plan = await editor.plan([{ kind: "rename", entity: "resource:flag", name: "featureFlag" }], builder.current!.snapshot.revision);
  assert.equal(plan.ok, false);
  assert.ok(plan.renameIssues?.some(issue => issue.source.file === consumer), JSON.stringify(plan));
  await assert.rejects(editor.apply(plan.planId), /rejected settings/);
});
