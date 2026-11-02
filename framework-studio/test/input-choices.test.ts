import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "./support/assert";
import { inputChoicesError, inputModeIntents, type ResourceIntent } from "../shared/resources";
import { SnapshotBuilder } from "../server/snapshot";
import { readResourceIntent, ResourceService } from "../server/resources";
import { frameworkInputChoices } from "../server/input-choices-source";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/input-choice-tests");
async function fixture() {
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "framework-config")); mkdirSync(path.join(root, "cdk-app"));
  cpSync(path.resolve(__dirname, "../../framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "framework.config.ts"), 'import { defineFrameworkConfig } from "@repo/framework/config"; import { defaults } from "./framework-config/defaults"; import { resources } from "./framework-config/resources"; export default defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], events: [], services: [] });\n');
  writeFileSync(path.join(root, "framework-config/resources.ts"), 'import { defineResources, resource } from "@repo/framework/config"; export const resources = defineResources({ setting: resource.fromEnv("SETTING").default("initial") });\n');
  const file = path.join(root, "cdk-app/deployment-inputs.ts");
  writeFileSync(file, `import { defineResources, resource, type CloudMode } from "@repo/framework/config";
export const deploymentInputs = (mode: CloudMode) => defineResources({
  // Keep this declaration and its reader stable.
  skipEmailVerification: resource.fromEnv(/* input name */ "SKIP_EMAIL_VERIFICATION")
    .enum("true", "false").default("false").note("Reader policy stays managed."),
}, { mode });\n`);
  for (const mode of ["dev", "prod"]) writeFileSync(path.join(root, `cdk-app/.env.${mode}`), "SKIP_EMAIL_VERIFICATION=false\nUNUSED_SECRET=private-not-for-source\n");
  const builder = new SnapshotBuilder(root); await builder.refresh();
  for (const model of Object.values(builder.current!.snapshot.models)) if (model.status !== "ok") {
    await builder.dispose(); rmSync(root, { recursive: true });
    throw new Error(JSON.stringify(model.diagnostics));
  }
  const service = new ResourceService(root, builder);
  const resource = () => builder.current!.snapshot.models.dev.resources.find(item => item.id === "framework:deployment.skipEmailVerification")!;
  const intent = (choices: readonly string[]): ResourceIntent => ({ resource: resource().id, kind: "input", fromEnv: resource().fromEnv, group: "Deployment settings", modes: inputModeIntents(resource()), requirements: {}, choices });
  const plan = (choices: readonly string[]) => service.plan(intent(choices), builder.current!.snapshot.revision, "dev");
  const dispose = async () => { await builder.dispose(); assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); };
  return { root, file, builder, service, resource, intent, plan, dispose };
}

test("framework enum edits review source, preserve values and comments, and refresh without module reload", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.resource().values, ["true", "false"]);
    assert.deepEqual(f.resource().inputChoices?.defaults, ["false"]);
    for (const choices of [["true", "false", "preview"], [], ["true", "false"]]) {
      const before = readFileSync(f.file, "utf8");
      const plan = await f.plan(choices);
      assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
      assert.equal(readFileSync(f.file, "utf8"), before, "review never writes");
      assert.equal(plan.changes.length, 1);
      assert.equal(plan.changes[0]!.file, "cdk-app/deployment-inputs.ts");
      assert.ok(!JSON.stringify(plan).includes("private-not-for-source"));
      assert.equal((await f.service.apply(plan.planId)).status, "applied");
      assert.deepEqual(f.resource().values ?? [], choices);
      const after = readFileSync(f.file, "utf8");
      assert.ok(after.includes('/* input name */ "SKIP_EMAIL_VERIFICATION"'));
      assert.ok(after.includes('.default("false").note("Reader policy stays managed.")'));
      for (const mode of ["dev", "prod"]) assert.equal(readFileSync(path.join(f.root, `cdk-app/.env.${mode}`), "utf8"), "SKIP_EMAIL_VERIFICATION=false\nUNUSED_SECRET=private-not-for-source\n");
    }
  } finally { await f.dispose(); }
});

test("framework enum editing rejects invalid choices, changed defaults, policy changes, and stale source", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.plan(["true"]), /default must remain|default.*allowed values/);
    assert.match(inputChoicesError(["false", "FALSE"])!, /unique/);
    assert.match(inputChoicesError([""])!, /non-blank/);
    assert.throws(() => readResourceIntent({ intent: f.intent(["false", "FALSE"]) }), /unique/);
    await assert.rejects(f.service.plan({ ...f.intent(["true", "false", "extra"]), fromEnv: "OTHER" }, f.builder.current!.snapshot.revision, "dev"), /Only allowed values/);
    const plan = await f.plan(["true", "false", "extra"]);
    writeFileSync(f.file, readFileSync(f.file, "utf8") + "// intervening edit\n");
    await assert.rejects(f.service.apply(plan.planId), /changed/);
    assert.ok(readFileSync(f.file, "utf8").endsWith("// intervening edit\n"));
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace('.enum("true", "false")', '.enum(...["true", "false"])'));
    assert.equal(frameworkInputChoices(f.root, "deployment", "skipEmailVerification", "SKIP_EMAIL_VERIFICATION"), undefined, "computed enums are never rewritten");
    assert.equal(frameworkInputChoices(f.root, "database", "multiAz", "DATABASE_MULTI_AZ"), undefined, "inferred database types have no enum authority");
  } finally { await f.dispose(); }
});
