import { sourceFixtureCheckpoint } from "./support/source-fixture";
import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { ResourceIntent } from "../shared/resources";
import { SnapshotBuilder } from "../server/snapshot";
import { readResourceIntent, ResourceService } from "../server/resources";
import { DeploymentInputService } from "../server/deployment-input-edits";
import { SourceJournal } from "../server/edits/journal";
import { parseClientMappings } from "../server/client-environment-source";

const root = path.resolve(__dirname, "../..");
const fixture = path.join(root, ".cache/framework-studio", `resources-${randomUUID()}`);
let builder: SnapshotBuilder;
let service: ResourceService;
const catalog = path.join(fixture, "framework-config/resources.ts");
const route = path.join(fixture, "framework-config/http.ts");
const original = `import { defineResources, resource } from "@repo/framework/config";
export const resources = defineResources({
  key: resource.secret("FIXTURE_KEY"),
  setting: resource.fromEnv("FIXTURE_SETTING").default("initial"),
  group: { derived: resource.fromEnv() },
});
`;
const http = `import { resources } from "./resources";
export const routes = { "/fixture": {
  directory: "/lambda_functions/fixture",
  methods: ["GET"],
  environment: { SETTING: resources.setting, SECRET_ARN: resources.key.arn },
  cloud: { requirements: [{ when: { resource: resources.setting, equals: "required" }, require: [resources.key], message: "A fixture requirement." }] },
} } as const;
`;
const revision = () => builder.current!.snapshot.revision;
/** One policy for both graphs unless `modes` states each graph's. */
const intent = ({ default: fallback = "initial", required = false, modes, ...changes }: Partial<Omit<ResourceIntent, "modes">> & { default?: string | null; required?: boolean; modes?: ResourceIntent["modes"] } = {}): ResourceIntent =>
  ({ resource: "resource:setting", kind: "input", group: "", requirements: {}, ...changes, modes: modes ?? { dev: { present: true, required, default: fallback }, prod: { present: true, required, default: fallback } } });
before(async () => {
  mkdirSync(path.join(fixture, "framework-config"), { recursive: true });
  mkdirSync(path.join(fixture, "cdk-app/lambda_functions/fixture"), { recursive: true });
  writeFileSync(path.join(fixture, "cdk-app/lambda_functions/fixture/index.ts"), "export const handler = async () => ({});\n");
  cpSync(path.join(root, "framework-config/defaults.ts"), path.join(fixture, "framework-config/defaults.ts"));
  writeFileSync(catalog, original);
  writeFileSync(route, http);
  writeFileSync(path.join(fixture, "framework.config.ts"), `import { defineFrameworkConfig } from "@repo/framework/config";
import { defaults } from "./framework-config/defaults";
import { resources } from "./framework-config/resources";
import { routes } from "./framework-config/http";
export default defineFrameworkConfig({ resources, defaults, http: [routes], webSocket: [], events: [], services: [] });
`);
  writeFileSync(path.join(fixture, "cdk-app/.env.dev"), '# fixture only\nFIXTURE_KEY="test secret with # and ="\nFIXTURE_SETTING="from local env"\nUNDECLARED_PRIVATE="do not return"\nGROUP_DERIVED="derived value"\n');
  builder = new SnapshotBuilder(fixture);
  service = new ResourceService(fixture, builder);
  await builder.refresh();
});
let restoreSource: () => Promise<void>;
beforeEach(() => { restoreSource = sourceFixtureCheckpoint(fixture, builder); });
afterEach(async () => { await restoreSource(); });

after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });

test("only defined authored resources can reveal a targeted .env value, snapshots remain value-free", () => {
  assert.equal(service.details("resource:key", "dev").value, "test secret with # and =");
  assert.equal(service.details("resource:setting", "dev").value, "from local env");
  assert.equal(service.details("resource:group.derived", "dev").value, "derived value");
  for (const id of ["UNDECLARED_PRIVATE", "resource:UNDECLARED_PRIVATE", "../../cdk-app/.env", "resource:group"]) assert.throws(() => service.details(id, "dev"));
  const snapshot = JSON.stringify(builder.current!.snapshot);
  assert.ok(!snapshot.includes("test secret with # and ="));
  assert.ok(!snapshot.includes("do not return"));
  assert.ok(!snapshot.includes("from local env"));
  assert.equal(Object.hasOwn(service.details("resource:key", "dev"), "consumers"), false, "consumers and their rules come from the model, not the value endpoint");
});

test("missing and empty values differ from a configured value", () => {
  const file = path.join(fixture, "cdk-app/.env.dev");
  const before = readFileSync(file, "utf8");
  try {
    writeFileSync(file, "FIXTURE_KEY=\n");
    assert.equal(service.details("resource:key", "dev").value, "");
    assert.equal(service.details("resource:key", "dev").configured, true);
    assert.equal(service.details("resource:setting", "dev").configured, false);
  } finally { writeFileSync(file, before); }
});

test("a selected input supplies the file revision for private review without reading other variables", () => {
  const details = service.details("resource:setting", "dev");
  assert.equal(details.inputFile?.exists, true);
  assert.equal(service.details("resource:setting", "prod").inputFile?.exists, false);
  assert.ok(!JSON.stringify(details).includes("UNDECLARED_PRIVATE"));
  assert.ok(!JSON.stringify(details).includes("test secret with # and ="));
  const inputs = new DeploymentInputService(fixture, builder);
  const plan = inputs.plan("dev", [{ name: "FIXTURE_SETTING", value: "selected-value-update" }], details.inputFile!.hash, revision());
  assert.equal(plan.ok, true);
  assert.ok(!JSON.stringify(plan).includes("selected-value-update"));
  assert.ok(readFileSync(path.join(fixture, "cdk-app/.env.dev"), "utf8").includes('FIXTURE_SETTING="from local env"'), "review does not write");
});

test("default changes are evaluated from candidate source, applied exactly", async () => {
  assert.equal(builder.current!.snapshot.models.dev.status, "ok", JSON.stringify(builder.current!.snapshot.models.dev.diagnostics));
  const plan = await service.plan(intent({ default: "changed" }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(readFileSync(catalog, "utf8"), original, "preview must not write source");
  assert.match(plan.changes[0]!.diff.unified, /default\("changed"\)/);
  assert.equal((await service.apply(plan.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.resources.find((resource) => resource.id === "resource:setting")?.default, "changed");
  await restoreSource();
  assert.equal(readFileSync(catalog, "utf8"), original);
  await restoreSource();
});

test("input source toggles review declaration values without reading or changing environment files", async () => {
  const file = path.join(fixture, "cdk-app/.env.dev");
  const environment = readFileSync(file, "utf8");
  const tagged = original.replace('resource.fromEnv("FIXTURE_SETTING").default("initial")', 'resource.fromEnv("FIXTURE_SETTING", { tags: { area: "settings" } }).enum("initial", "changed", "from local env").default("initial").note("A source-controlled setting")');
  writeFileSync(catalog, tagged);
  await builder.refresh();
  const standalone = intent({ fromEnv: null, modes: {
    dev: { present: true, required: false, default: null, value: "changed" },
    prod: { present: true, required: false, default: null, value: "changed" },
  } });
  const plan = await service.plan(standalone, revision(), "dev");
  assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
  assert.deepEqual(plan.changes.map(change => change.file), ["framework-config/resources.ts"]);
  assert.match(plan.changes[0]!.diff.unified, /resource\.value\("changed", \{ tags: \{ area: "settings" \} \}\)\.enum\("initial", "changed", "from local env"\)\.note\("A source-controlled setting"\)/);
  assert.equal(readFileSync(catalog, "utf8"), tagged, "review does not write source");
  assert.equal((await service.apply(plan.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.resources.find(item => item.id === standalone.resource)?.authoredValue, "changed");
  assert.deepEqual(service.details(standalone.resource, "dev"), { configured: true, value: "changed" });
  assert.equal(readFileSync(file, "utf8"), environment, "unlinking leaves authored environment values intact");
  const linked = await service.plan(intent({ fromEnv: "FIXTURE_SETTING", default: "changed" }), revision(), "dev");
  assert.ok(linked.ok, JSON.stringify(linked.diagnostics));
  assert.equal((await service.apply(linked.planId)).status, "applied");
  assert.match(readFileSync(catalog, "utf8"), /resource\.fromEnv\("FIXTURE_SETTING", \{ tags: \{ area: "settings" \} \}\)\.enum\("initial", "changed", "from local env"\)\.default\("changed"\)\.note\("A source-controlled setting"\)/);
  assert.equal(service.details(standalone.resource, "dev").value, "from local env", "linking reads the existing file value rather than overwriting it");
  assert.equal(readFileSync(file, "utf8"), environment);
});

test("standalone values preserve mode scope and refuse defaults, requirements and secret source values", async () => {
  writeFileSync(catalog, original.replace('from "@repo/framework/config";\n', 'from "@repo/framework/config";\nimport { FRAMEWORK_MODE } from "@repo/framework/config/source";\n').replace("});\n", "}, { mode: FRAMEWORK_MODE });\n"));
  await builder.refresh();
  const standalone = intent({ fromEnv: null, modes: {
    dev: { present: true, required: false, default: null, value: "development" },
    prod: { present: true, required: false, default: null, value: "production" },
  } });
  const plan = await service.plan(standalone, revision(), "prod");
  assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
  assert.match(plan.changes[0]!.diff.unified, /resource\.value\(\{ dev: "development", prod: "production" \}\)/);
  assert.equal((await service.apply(plan.planId)).status, "applied");
  assert.deepEqual(service.details(standalone.resource, "prod"), { configured: true, value: "production" });
  const devOnly = await service.plan({ ...standalone, modes: { ...standalone.modes, prod: { present: false, required: false, default: null, value: null } } }, revision(), "dev");
  assert.ok(devOnly.ok, JSON.stringify(devOnly.diagnostics));
  assert.match(devOnly.changes[0]!.diff.unified, /resource\.value\("development"\)\.only\("dev"\)/);
  assert.equal((await service.apply(devOnly.planId)).status, "applied");
  assert.deepEqual(service.details(standalone.resource, "prod"), { configured: false });
  await assert.rejects(service.plan({ ...standalone, modes: { ...standalone.modes, dev: { ...standalone.modes.dev, default: "fallback" } } }, revision(), "dev"), /standalone input has a value/);
  await assert.rejects(service.plan({ ...standalone, kind: "secret" }, revision(), "dev"), /Secrets must be linked/);
});

test("unlinking and moving an input migrate every parsed client recipe reference in the same review", async () => {
  const client = path.join(fixture, "framework-config/client-environment.ts");
  const source = `export const clientEnvironment = {
  // A retained client field comment.
  VITE_SETTING: { kind: "input", name: "FIXTURE_SETTING" },
  VITE_GUARDED: { kind: "region", stack: "FrontendWebsiteS3Stack", when: { input: "FIXTURE_SETTING", equals: "initial" } },
  VITE_URL: { dev: { kind: "endpoint", protocol: "http", host: "localhost", port: "FIXTURE_SETTING", override: "FIXTURE_SETTING" }, prod: { kind: "input", name: "FIXTURE_SETTING" } },
  // Leave this field exactly as authored.
  VITE_UNRELATED: { kind: "empty" },
};\n`;
  writeFileSync(client, source);
  await builder.refresh();
  const standalone = intent({ fromEnv: null, modes: {
    dev: { present: true, required: false, default: null, value: "initial" },
    prod: { present: true, required: false, default: null, value: "initial" },
  } });
  const review = await service.plan(standalone, revision(), "dev");
  assert.ok(review.ok, JSON.stringify(review.diagnostics));
  assert.deepEqual(review.changes.map(change => change.file).sort(), ["framework-config/client-environment.ts", "framework-config/resources.ts"]);
  assert.equal(readFileSync(client, "utf8"), source, "preview leaves recipes untouched");
  assert.equal((await service.apply(review.planId)).status, "applied");
  const migrated = readFileSync(client, "utf8");
  assert.doesNotMatch(JSON.stringify(parseClientMappings(migrated).mappings), /FIXTURE_SETTING/);
  assert.equal((JSON.stringify(parseClientMappings(migrated).mappings).match(/resource:setting/g) ?? []).length, 5);
  assert.ok(migrated.includes("// Leave this field exactly as authored.\n  VITE_UNRELATED: { kind: \"empty\" },"));
  const moved = await service.plan({ ...standalone, group: "settings" }, revision(), "dev");
  assert.ok(moved.ok, JSON.stringify(moved.diagnostics));
  assert.equal((await service.apply(moved.planId)).status, "applied");
  const names = JSON.stringify(parseClientMappings(readFileSync(client, "utf8")).mappings);
  assert.doesNotMatch(names, /"resource:setting"/);
  assert.equal((names.match(/resource:settings\.setting/g) ?? []).length, 5);
  await assert.rejects(service.plan({ resource: "resource:settings.setting", kind: "secret", fromEnv: "NEW_SETTING_SECRET", group: "settings", requirements: {}, modes: {
    dev: { present: true, required: false, default: null }, prod: { present: true, required: false, default: null },
  } }, revision(), "dev"), /Remove this input's public client mappings/);
});



test("moving an input rewrites catalog references and keeps a derived env key stable", async () => {
  const plan = await service.plan(intent({ resource: "resource:group.derived", default: null, group: "newGroup" }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.nextResource, "resource:newGroup.derived");
  await service.apply(plan.planId);
  assert.equal(service.details(plan.nextResource, "dev").value, "derived value");
  await restoreSource();
  assert.equal(readFileSync(catalog, "utf8"), original);
  const used = await service.plan(intent({ group: "providers" }), revision(), "dev");
  assert.equal(used.ok, true, JSON.stringify(used.diagnostics));
  assert.equal(used.changes.length, 2);
  await service.apply(used.planId);
  assert.match(readFileSync(route, "utf8"), /providers.*setting/);
  await restoreSource();
  assert.equal(readFileSync(route, "utf8"), http);
});

test("secret conversion cannot keep a fallback or bypass a string-only requirement condition", async () => {
  await assert.rejects(service.plan(intent({ kind: "secret" }), revision(), "dev"), /cannot have a default/);
  const refused = await service.plan(intent({ kind: "secret", default: null }), revision(), "dev");
  assert.equal(refused.ok, false, "a selector used as a string cannot become a secret without changing its consumers");
  await assert.rejects(service.apply(refused.planId), /refuses/);
  assert.equal(readFileSync(catalog, "utf8"), original);
});

test("workload requirement edits preserve the other rule fields ", async () => {
  const consumer = () => builder.current!.snapshot.models.dev.targets.find((target) => target.ref === "lambda:fixture")!;
  const plan = await service.plan(intent({ resource: "resource:key", kind: "secret", default: null, requirements: { [consumer().ref]: "required" } }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  await service.apply(plan.planId);
  const rules = consumer().requirementRules ?? [];
  assert.ok(rules.some((rule) => !rule.when && rule.require.includes("resource:key")));
  await restoreSource();
  assert.equal(readFileSync(route, "utf8"), http);
});

test("a concurrent edit expires a preview without overwriting it", async () => {
  const plan = await service.plan(intent({ default: "changed" }), revision(), "dev");
  const theirs = original + "// concurrent edit\n";
  writeFileSync(catalog, theirs);
  await assert.rejects(service.apply(plan.planId), /changed/);
  assert.equal(readFileSync(catalog, "utf8"), theirs);
  writeFileSync(catalog, original);
  await builder.refresh();
});

test("failed multi-file resource edits preserve an external deletion and restore remaining files", async () => {
  const plan = await service.plan(intent({ group: "providers" }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.changes.length, 2);
  const refresh = builder.refresh.bind(builder);
  let fail = true;
  builder.refresh = async () => {
    if (fail) {
      fail = false;
      rmSync(route);
    }
    throw new Error("Simulated verification failure after an external deletion");
  };
  try {
    const result = await service.apply(plan.planId);
    assert.equal(result.status, "unconfirmed", result.message);
    assert.match(result.message, /snapshot could not be refreshed/);
    assert.equal(readFileSync(catalog, "utf8"), original, "one failed restoration cannot skip another file");
    assert.equal(existsSync(route), false, "the external deletion remains intact");
  } finally {
    builder.refresh = refresh;
    writeFileSync(catalog, original);
    writeFileSync(route, http);
    await builder.refresh();
    const journal = new SourceJournal(fixture), pending = journal.pending();
    assert.equal(pending.length, 1, "conflicted source restoration requires explicit completion");
    journal.keepCurrent(pending[0]!.id, pending[0]!.fingerprint, "KEEP CURRENT SOURCE");
  }
});

test("resource API rejects malformed policies and secret values never enter any preview", () => {
  assert.throws(() => readResourceIntent({ intent: { ...intent(), modes: { dev: { present: true, required: "yes", default: null }, prod: intent().modes.prod } } }));
  assert.throws(() => readResourceIntent({ intent: { ...intent(), modes: { dev: intent().modes.dev } } }), /Development and Production/);
  assert.throws(() => readResourceIntent({ intent: { ...intent(), requirements: { bad: "unknown" } } }));
  assert.deepEqual(readResourceIntent({ intent: intent() }), intent());
  assert.ok(existsSync(path.join(fixture, "cdk-app/.env.dev")));
});

test("catalog required flags persist through review and can be removed without rewriting consumers", async () => {
  for (const resource of ["resource:setting", "resource:key"]) {
    const secret = resource === "resource:key";
    const settings = { resource, kind: secret ? "secret" as const : "input" as const, default: secret ? null : "initial" };
    const change = intent({ ...settings, required: true });
    const plan = await service.plan(change, revision(), "dev");
    assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
    assert.equal(readFileSync(catalog, "utf8"), original, "review does not write");
    await service.apply(plan.planId);
    assert.equal(builder.current!.snapshot.models.dev.resources.find((item) => item.id === resource)?.required, true);
    assert.ok(builder.current!.snapshot.models.dev.targets.some((target) => target.requirementRules?.some((rule) => !rule.when && rule.require.includes(resource))));
    const remove = await service.plan(intent(settings), revision(), "dev");
    assert.equal(remove.ok, true);
    await service.apply(remove.planId);
    assert.equal(readFileSync(catalog, "utf8"), original);
    assert.equal(readFileSync(route, "utf8"), http);
  }
});

test("per-environment settings write .only(), .required(mode) and .default({ dev, prod }), editable from either graph", async () => {
  const split = intent({ modes: { dev: { present: true, required: false, default: "local" }, prod: { present: true, required: true, default: null } } });
  const unresolved = await service.plan(split, revision(), "dev");
  assert.equal(unresolved.ok, false, "a catalog without a mode cannot resolve a policy that differs by graph");
  assert.match(JSON.stringify(unresolved.diagnostics), /FRAMEWORK_MODE/);

  writeFileSync(catalog, original.replace(`from "@repo/framework/config";\n`, `from "@repo/framework/config";\nimport { FRAMEWORK_MODE } from "@repo/framework/config/source";\n`).replace("});\n", "}, { mode: FRAMEWORK_MODE });\n"));
  await builder.refresh();
  const plan = await service.plan(split, revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.match(plan.changes[0]!.diff.unified, /resource\.fromEnv\("FIXTURE_SETTING"\)\.required\("prod"\)\.default\(\{ dev: "local" \}\)/);
  await service.apply(plan.planId);
  const settings = (mode: "dev" | "prod", id: string) => builder.current!.snapshot.models[mode].resources.find((item) => item.id === id);
  assert.deepEqual(settings("dev", "resource:setting")?.modes, { dev: { present: true, required: false, default: "local" }, prod: { present: true, required: true } });
  assert.equal(settings("dev", "resource:setting")?.default, "local");
  assert.equal(settings("prod", "resource:setting")?.required, true);
  assert.equal(settings("prod", "resource:setting")?.default, undefined);

  const devOnly = intent({ resource: "resource:group.derived", group: "group", modes: { dev: { present: true, required: true, default: null }, prod: { present: false, required: false, default: null } } });
  const only = await service.plan(devOnly, revision(), "dev");
  assert.equal(only.ok, true, JSON.stringify(only.diagnostics));
  assert.match(only.changes[0]!.diff.unified, /derived: resource\.fromEnv\("GROUP_DERIVED"\)\.only\("dev"\)\.required\(\)/);
  await service.apply(only.planId);
  assert.equal(settings("prod", "resource:group.derived")?.absent, true, "production does not hold a development-only input");
  assert.equal(settings("prod", "resource:group.derived")?.kind, "input", "an input outside its graph keeps its identity");
  const envProd = builder.current!.snapshot.models.prod.resources.find((item) => item.id === "envfile:prod")?.deploymentFile;
  assert.ok(!envProd?.entries.some((entry) => entry.name === "GROUP_DERIVED"), "production's file does not offer a development-only input");

  // The graph that lacks the input can still bring it back.
  const both = await service.plan(intent({ resource: "resource:group.derived", group: "group", default: null }), revision(), "prod");
  assert.equal(both.ok, true, JSON.stringify(both.diagnostics));
  assert.match(both.changes[0]!.diff.unified, /^\+  group: \{ derived: resource\.fromEnv\("GROUP_DERIVED"\) \},$/m);
  await assert.rejects(service.plan(intent({ modes: { dev: { present: false, required: false, default: null }, prod: { present: false, required: false, default: null } } }), revision(), "dev"), /at least one environment/);
  await assert.rejects(service.plan(intent({ modes: { dev: { present: false, required: true, default: null }, prod: { present: true, required: false, default: null } } }), revision(), "dev"), /cannot be required/);
  await restoreSource();
});

test("a secret flag can be changed when consumers support the new kind", async () => {
  const plan = await service.plan(intent({ resource: "resource:key", kind: "input", default: null }), revision(), "dev");
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  await service.apply(plan.planId);
  assert.equal(builder.current!.snapshot.models.dev.resources.find((resource) => resource.id === "resource:key")?.kind, "input");
  assert.ok(!readFileSync(route, "utf8").includes(".key.arn"));
  await restoreSource();
  assert.equal(readFileSync(catalog, "utf8"), original);
  assert.equal(readFileSync(route, "utf8"), http);
  const secret = await service.plan(intent({ resource: "resource:group.derived", kind: "secret", group: "group", default: null }), revision(), "dev");
  assert.equal(secret.ok, true, JSON.stringify(secret.diagnostics));
  await service.apply(secret.planId);
  assert.equal(builder.current!.snapshot.models.dev.resources.find((resource) => resource.id === "resource:group.derived")?.kind, "secret");
  await restoreSource();
});
