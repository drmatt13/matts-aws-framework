import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { createDeploymentInput, withDeploymentInputs } from "../server/deployment-inputs";
import { InfrastructureService } from "../server/infrastructure";

import type { ModeModel } from "../shared/model";
import { buildScene } from "../src/scene/build";
import { DeploymentInputService, inputMode, readInputEdits, updateInputText } from "../server/deployment-input-edits";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/deployment-input-tests");
mkdirSync(cache, { recursive: true });
function fixture() {
  const root = mkdtempSync(path.join(cache, "case-")); mkdirSync(path.join(root, "cdk-app"));
  writeFileSync(path.join(root, "cdk-app/.env.dev.template"), "PROD_DEPLOYMENT=false\nSETTING=example\nTOKEN=\n");
  writeFileSync(path.join(root, "cdk-app/.env.prod.template"), "PROD_DEPLOYMENT=true\nSETTING=production\nTOKEN=\n");
  return root;
}
function remove(root: string) { assert.ok(path.resolve(root).startsWith(cache + path.sep)); rmSync(root, { recursive: true }); }
const model: ModeModel = { mode: "dev", status: "ok", targets: [], routes: [], workflows: [], diagnostics: [], fields: {}, evaluatedInMs: 0, edges: [], resources: [
  { id: "resource:setting", path: ["setting"], kind: "input", fromEnv: "SETTING", default: "default", absent: false },
  { id: "resource:token", path: ["token"], kind: "secret", fromEnv: "TOKEN", absent: false },
] };

test("input parameters carry comparison outcomes for each selected environment and inherit defaults", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "SETTING=DISABLED\n");
    for (const mode of ["dev", "prod"] as const) {
      const scoped = { ...model, mode, resources: model.resources.map(resource => resource.id === "resource:setting" ? { ...resource, default: "enabled", values: ["enabled", "disabled"] } : resource) };
      const projected = withDeploymentInputs(root, scoped, undefined, [{ input: "SETTING", equals: "enabled" }]);
      assert.deepEqual(projected.resources.find(resource => resource.id === "resource:setting")?.inputComparisons, { enabled: mode === "dev" ? "holds" : "fails" });
    }
  } finally { remove(root); }
});

test("both files list the same names, and the catalog decides each graph's defaults, requirements and presence", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=\nLOCAL_ONLY=1\nPORT=8080\nSKIP_EMAIL_VERIFICATION=true\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "DATABASE_ONLY=db.t3.micro\nPORT=9\nDATABASE_MULTI_AZ=true\n");
    // SETTING falls back differently per graph and is required only in production;
    // PORT is declared for development alone.
    const declared = (mode: "dev" | "prod"): ModeModel => ({ ...model, mode, resources: [
      { id: "resource:setting", path: ["setting"], kind: "input", fromEnv: "SETTING", absent: false, ...(mode === "dev" ? { default: "local" } : { required: true }), values: ["local", "cloud"],
        modes: { dev: { present: true, required: false, default: "local" }, prod: { present: true, required: true } } },
      { id: "resource:token", path: ["token"], kind: "secret", fromEnv: "TOKEN", absent: false },
      { id: "resource:port", path: ["port"], kind: "input", fromEnv: "PORT", absent: mode === "prod", modes: { dev: { present: true, required: false }, prod: { present: false, required: false } } },
    ] });
    const models = { dev: declared("dev"), prod: declared("prod") };
    const file = (mode: "dev" | "prod") => withDeploymentInputs(root, models[mode], models).resources.find((resource) => resource.id === `envfile:${mode}`)!.deploymentFile!;
    const dev = file("dev"), prod = file("prod");
    const entry = (from: typeof dev, name: string) => from.entries.find((item) => item.name === name);
    const names = ["DATABASE_MULTI_AZ", "DATABASE_ONLY", "LOCAL_ONLY", "PORT", "SETTING", "SKIP_EMAIL_VERIFICATION", "TOKEN"];
    assert.deepEqual(dev.entries.map((item) => item.name), names);
    assert.deepEqual(prod.entries.map((item) => item.name), names, "a line written where the catalog does not read it stays visible");
    // Variables the application reads outside the catalog name their owner, default and choices.
    assert.deepEqual([entry(prod, "SKIP_EMAIL_VERIFICATION")!.owner, entry(prod, "SKIP_EMAIL_VERIFICATION")!.default, entry(prod, "SKIP_EMAIL_VERIFICATION")!.choices], ["deployment", "false", ["true", "false"]]);
    assert.match(entry(prod, "SKIP_EMAIL_VERIFICATION")!.note!, /production deployment refuses/);
    assert.equal(entry(prod, "DATABASE_MULTI_AZ")!.owner, "database");
    assert.equal(entry(dev, "DATABASE_MULTI_AZ")!.notRead, undefined, "a mirrored row writes nothing, so nothing is flagged");
    assert.equal(entry(prod, "DATABASE_MULTI_AZ")!.notRead, undefined);
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=\nLOCAL_ONLY=1\nPORT=8080\nSKIP_EMAIL_VERIFICATION=true\nDATABASE_MULTI_AZ=true\n");
    assert.equal(entry(file("dev"), "DATABASE_MULTI_AZ")!.notRead, true, "development builds no RDS, so a database override written there is never read");
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=\nLOCAL_ONLY=1\nPORT=8080\nSKIP_EMAIL_VERIFICATION=true\n");
    assert.equal(entry(dev, "LOCAL_ONLY")!.owner, undefined, "nothing claims a variable it does not read");
    assert.equal(entry(dev, "DATABASE_ONLY")!.status, "missing");
    assert.equal(entry(dev, "DATABASE_ONLY")!.counterpart, "configured", "a mirrored row says the other file has it");
    assert.equal(entry(dev, "SETTING")!.default, "local");
    assert.equal(entry(dev, "SETTING")!.defaulted, true);
    assert.deepEqual(entry(dev, "SETTING")!.choices, ["local", "cloud"]);
    assert.equal(entry(prod, "SETTING")!.default, undefined);
    assert.ok(!entry(dev, "SETTING")!.requirements!.some((item) => item.required));
    assert.ok(entry(prod, "SETTING")!.requirements!.some((item) => item.required && item.status === "missing"), "required only in production, where nothing supplies it");
    assert.equal(entry(prod, "PORT")!.notRead, true, "production holds no PORT, yet its file writes one");
    assert.ok(!withDeploymentInputs(root, models.prod, models).edges.some((edge) => edge.from === "envfile:prod" && edge.to === "resource:port"));
    rmSync(path.join(root, "cdk-app/.env.prod"));
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "DATABASE_ONLY=db.t3.micro\n");
    assert.ok(!file("prod").entries.some((item) => item.name === "PORT"), "a development-only input is not offered to production");
    assert.equal(withDeploymentInputs(root, models.prod, models).resources.find((resource) => resource.id === "resource:port")!.modes!.prod.present, false);
  } finally { remove(root); }
});

test("a legacy conditional declaration takes its presence from the graph that leaves it out", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=\n");
    const dev: ModeModel = { ...model, mode: "dev" };
    const prod: ModeModel = { ...model, mode: "prod", resources: [model.resources[1]!, { id: "resource:setting", path: ["setting"], kind: "stack", absent: true }] };
    const projected = withDeploymentInputs(root, dev, { dev, prod });
    assert.deepEqual(projected.resources.find((resource) => resource.id === "resource:setting")!.modes, { dev: { present: true, required: false, default: "default" }, prod: { present: false, required: false } });
    const prodFile = withDeploymentInputs(root, prod, { dev, prod }).resources.find((resource) => resource.id === "envfile:prod")!.deploymentFile!;
    assert.ok(!prodFile.entries.some((item) => item.name === "SETTING"));
  } finally { remove(root); }
});

test("explicit file creation copies each template exclusively, never overwrites, and ignores a leftover cdk-app/.env", () => {
  const root = fixture();
  try {
    const leftover = 'SETTING=authored-in-env\nTOKEN=private-env-sentinel\n';
    writeFileSync(path.join(root, "cdk-app/.env"), leftover);
    assert.equal(createDeploymentInput(root, "dev").created, true);
    assert.equal(createDeploymentInput(root, "prod").created, true);
    const dev = readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8");
    const prod = readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8");
    assert.equal(dev, readFileSync(path.join(root, "cdk-app/.env.dev.template"), "utf8"));
    assert.equal(prod, readFileSync(path.join(root, "cdk-app/.env.prod.template"), "utf8"));
    assert.ok(!dev.includes("private-env-sentinel") && !prod.includes("private-env-sentinel"));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env"), "utf8"), leftover);
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=edited\n");
    assert.equal(createDeploymentInput(root, "dev").created, false);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), "SETTING=edited\n");
    rmSync(path.join(root, "cdk-app/.env.prod.template"));
    rmSync(path.join(root, "cdk-app/.env.prod"));
    assert.throws(() => createDeploymentInput(root, "prod"), /Missing cdk-app\/\.env\.prod\.template/);
  } finally { remove(root); }
});

test("input projection links only catalog declarations; CDK-only keys remain inside the file inspector and values stay private", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), 'SETTING=\nTOKEN="private-sentinel\nFALSE_KEY=do-not-project\nlast-line"\nCDK_ONLY=private-cdk-value\n');
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "PROD_DEPLOYMENT=true\nSETTING=production-value\n");
    const projected = withDeploymentInputs(root, model);
    const text = JSON.stringify(projected);
    for (const privateText of ["private-sentinel", "FALSE_KEY", "private-cdk-value", "production-value", "last-line"]) assert.ok(!text.includes(privateText), privateText);
    assert.equal(projected.resources.filter((resource) => resource.fromEnv === "SETTING").length, 1, "catalog identities are reused");
    const dev = projected.resources.find((resource) => resource.id === "envfile:dev")!.deploymentFile!;
    assert.equal(dev.entries.find((entry) => entry.name === "SETTING")!.status, "empty");
    assert.equal(dev.entries.find((entry) => entry.name === "SETTING")!.defaulted, true);
    assert.equal(dev.entries.find((entry) => entry.name === "TOKEN")!.sensitive, true);
    assert.equal(dev.entries.find((entry) => entry.name === "CDK_ONLY")!.source!.line, 5);
    assert.ok(projected.edges.some((edge) => edge.relation === "supplies" && edge.from === "envfile:dev" && edge.to === "resource:token"));
    assert.deepEqual(dev.entries.find((entry) => entry.name === "CDK_ONLY")!.targets, []);
    assert.ok(!projected.resources.some((resource) => resource.fromEnv === "CDK_ONLY"));
    assert.ok(!projected.resources.some((resource) => resource.id.startsWith("parameter:")));
    assert.ok(projected.edges.filter((edge) => edge.relation === "supplies").every((edge) => model.resources.some((resource) => resource.id === edge.to)));
    assert.ok(!projected.edges.some((edge) => edge.from === "envfile:prod" && edge.to === "resource:token"), "missing assignments do not pretend to supply a value");
    const scene = buildScene(projected);
    assert.equal(scene.islands.find((island) => island.id === "island:inputs")!.title, "Input parameters and secrets");
    assert.ok(scene.islands.some((island) => island.id === "island:environment"));
    assert.equal(scene.nodes.find((node) => node.id === "envfile:dev")!.island, "island:environment");
    for (const mode of ["dev", "prod"] as const) assert.equal(scene.nodes.find((node) => node.id === `envfile:${mode}`)!.label, `cdk-app/.env.${mode}`);
    assert.ok(scene.edges.some((edge) => edge.from === "envfile:dev" && edge.to === "resource:token"));
    assert.deepEqual(scene.nodes.filter((node) => node.island === "island:inputs").map((node) => node.id).sort(), ["resource:setting", "resource:token"]);
    assert.deepEqual(scene.nodes.map((node) => [node.id, node.gx, node.gy]), buildScene({ ...projected, mode: "prod" }).nodes.map((node) => [node.id, node.gx, node.gy]));
  } finally { remove(root); }
});

function editing(root: string) {
  const builder = { current: { snapshot: { revision: "initial", models: { dev: model, prod: { ...model, mode: "prod" as const } } } },
    refresh: async () => { builder.current.snapshot.revision = "saved"; return builder.current; } };
  return { builder, service: new DeploymentInputService(root, builder) };
}

test("a selected file exposes all actual variables and saves a reviewed batch without leaking values or touching other files", async () => {
  const root = fixture();
  try {
    const original = '# retained comment\r\nPGADMIN_HOST_PORT=5050\r\nTOKEN="old-private\nFAKE_NAME=not-a-variable\nend"\r\nUNRELATED=keep\r\nPGADMIN_HOST_PORT=5051\r\n';
    writeFileSync(path.join(root, "cdk-app/.env.dev"), original);
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "PROD_ONLY=unchanged\n");
    writeFileSync(path.join(root, "cdk-app/.env"), "ACTIVE=unchanged\n");
    const { service } = editing(root);
    const details = service.details("dev");
    assert.ok(details.entries.some((entry) => entry.name === "PGADMIN_HOST_PORT" && entry.value === "5051"));
    assert.ok(!details.entries.some((entry) => entry.name === "FAKE_NAME"));
    assert.equal(details.entries.find((entry) => entry.name === "TOKEN")!.sensitive, true);
    assert.deepEqual(details.entries.find((entry) => entry.name === "TOKEN"), { name: "TOKEN", value: "", sensitive: true, hidden: true }, "the file's secret value never reaches the browser with the file");
    assert.ok(!JSON.stringify(details).includes("old-private"));
    assert.deepEqual(service.reveal("dev", "TOKEN"), { name: "TOKEN", value: "old-private\nFAKE_NAME=not-a-variable\nend" }, "one value, when someone asks to reveal it");
    assert.throws(() => service.reveal("dev", "PROD_ONLY"), /not in the selected file/);
    const edits = readInputEdits([{ name: "PGADMIN_HOST_PORT", value: "6060" }, { name: "TOKEN", value: "new-private\nsecond line" }, { name: "ADDED", value: "new-value # with whitespace", create: true }]);
    const plan = service.plan("dev", edits, details.hash, "initial");
    for (const value of ["old-private", "new-private", "6060", "5051", "new-value", "keep"]) assert.ok(!JSON.stringify(plan).includes(value));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), original, "review never writes");
    assert.equal((await service.apply(plan.planId)).status, "applied");
    const after = readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8");
    // parseEnv returns a null-prototype object on newer Node releases: compare what the file holds, not its prototype.
    assert.deepEqual({ ...parseEnv(after) }, { PGADMIN_HOST_PORT: "6060", TOKEN: "new-private\nsecond line", UNRELATED: "keep", ADDED: "new-value # with whitespace" });
    assert.ok(after.startsWith("# retained comment\r\n"));
    assert.equal(after.match(/^PGADMIN_HOST_PORT=/gm)!.length, 1);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8"), "PROD_ONLY=unchanged\n");
    assert.equal(readFileSync(path.join(root, "cdk-app/.env"), "utf8"), "ACTIVE=unchanged\n");
    await assert.rejects(service.apply(plan.planId), /expired/);
  } finally { remove(root); }
});

test("a saved inputs file remains applied when snapshot refresh fails, with an actionable value-free response", async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "TOKEN=old-private\n");
    const { builder, service } = editing(root);
    const plan = service.plan("dev", [{ name: "TOKEN", value: "new-private" }], service.details("dev").hash, "initial");
    builder.refresh = async () => { throw new Error("private diagnostic sentinel"); };
    const response = await service.apply(plan.planId);
    assert.equal(response.status, "applied");
    assert.match(response.message, /Saved cdk-app\/\.env\.dev.*refresh.*Reload/s);
    assert.ok(!/old-private|new-private|private diagnostic sentinel/.test(JSON.stringify(response)));
    assert.equal(parseEnv(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8")).TOKEN, "new-private");
    await assert.rejects(service.apply(plan.planId), /expired/);
  } finally { remove(root); }
});

test("dotenv batches reject stale file hashes, intervening writes, duplicate additions, invalid names and a contradictory mode", async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "PROD_DEPLOYMENT=false\nPGADMIN_HOST_PORT=5050\n");
    const { service } = editing(root);
    const details = service.details("dev");
    assert.throws(() => inputMode("../../.env"), /Choose/);
    assert.throws(() => readInputEdits([{ name: "BAD\nNAME", value: "secret-sentinel" }]), /variable name/);
    assert.throws(() => readInputEdits([{ name: "VALID", value: "bad\0value" }]), /null/);
    assert.throws(() => service.plan("dev", [{ name: "PROD_DEPLOYMENT", value: "true" }], details.hash, "initial"), /must match/);
    assert.throws(() => service.plan("dev", [{ name: "PGADMIN_HOST_PORT", value: "6060", create: true }], details.hash, "initial"), /already exists/);
    assert.throws(() => service.plan("dev", [{ name: "NEW", value: "1", create: true }, { name: "NEW", value: "2", create: true }], details.hash, "initial"), /only once/);
    const plan = service.plan("dev", [{ name: "PGADMIN_HOST_PORT", value: "6060" }], details.hash, "initial");
    const external = "PROD_DEPLOYMENT=false\nPGADMIN_HOST_PORT=7070\n";
    writeFileSync(path.join(root, "cdk-app/.env.dev"), external);
    await assert.rejects(service.apply(plan.planId), /Nothing was written/);
    assert.throws(() => service.plan("dev", [{ name: "PGADMIN_HOST_PORT", value: "6060" }], details.hash, "initial"), /changed/);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), external);
    assert.throws(() => service.details("prod"), /Create/);
  } finally { remove(root); }
});

test("dotenv serialization preserves literal quotes, backslashes, whitespace and multiline values", () => {
  for (const value of ["", "  spaces  ", "hash#value", "apostrophe's", 'double"quote', "`backtick`", "literal\\nsequence", "first\nsecond", "quoted ' and \" text"]) {
    assert.equal(parseEnv(updateInputText("OTHER=untouched\nKEY=old", [{ name: "KEY", value }])).KEY, value);
  }
  const before = 'OTHER="long\nKEY=inside another value\nend"\nKEY=old\n';
  assert.equal(parseEnv(updateInputText(before, [{ name: "KEY", value: "updated" }])).OTHER, parseEnv(before).OTHER);
});

test("the file editor refuses alternate paths and linked input directories", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "PRIVATE=unread-sentinel\n");
    const { service } = editing(root);
    assert.throws(() => service.details("../.env" as "dev"), /Choose/);
    renameSync(path.join(root, "cdk-app"), path.join(root, "linked-inputs"));
    symlinkSync(path.join(root, "linked-inputs"), path.join(root, "cdk-app"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => service.details("dev"), /regular file/);
  } finally { remove(root); }
});

test("missing files remain observable without being created by a snapshot read", () => {
  const root = fixture();
  try {
    const projected = withDeploymentInputs(root, model);
    const dev = projected.resources.find((resource) => resource.id === "envfile:dev")!.deploymentFile!;
    assert.equal(dev.exists, false); assert.equal(dev.template, "cdk-app/.env.dev.template");
    assert.ok(dev.entries.every((entry) => entry.status === "missing"));
    assert.equal(createDeploymentInput(root, "dev").created, true, "reading did not create a file");
  } finally { remove(root); }
});

test("synthesis selects separate dev/prod files, graph flags agree and no named profile is required", async () => {
  const root = fixture();
  try {
    createDeploymentInput(root, "dev"); createDeploymentInput(root, "prod");
    writeFileSync(path.join(root, "cdk-app/.env.dev"), 'PROD_DEPLOYMENT=false\nSETTING=only-dev\nTOKEN="private\n"\n');
    let runs = 0;
    const service = new InfrastructureService(root, () => undefined, async (request) => {
      runs++; assert.equal(request.profile, undefined);
      const values = parseEnv(readFileSync(request.environment!.FRAMEWORK_INPUTS_FILE!, "utf8"));
      assert.equal(values.SETTING, request.context.useLocalDevStack ? "only-dev" : "production");
      mkdirSync(request.outputDirectory, { recursive: true });
      writeFileSync(path.join(request.outputDirectory, "manifest.json"), '{"artifacts":{}}');
    });
    assert.equal((await service.synthesize("dev")).inputs!.file, "cdk-app/.env.dev");
    assert.equal((await service.synthesize("prod")).inputs!.file, "cdk-app/.env.prod");
    assert.equal(runs, 2);
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "PROD_DEPLOYMENT=false\nSETTING=changed-dev\n");
    assert.equal(service.get("dev").stale, true);
    assert.equal(service.get("prod").stale, false, "development input changes do not stale the production assembly");
  } finally { remove(root); }
});

test("deploy outcomes read each graph's own default and file, whichever graph asks", async () => {
  const root = fixture();
  try {
    const { defineResources, resource } = await import("@repo/framework/config");
    const { resolveDeployOutcomes } = await import("../server/inputs");
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "");
    // A deploy selector that falls back to "true" in development and "false" in production.
    const flag = (mode: "dev" | "prod") => defineResources({ flag: resource.fromEnv("FEATURE").enum("true", "false").default({ dev: "true", prod: "false" }) }, { mode }).flag;
    for (const asking of ["dev", "prod"] as const) {
      const outcomes = Object.values(resolveDeployOutcomes(root, [{ resource: flag(asking), equals: "true" }]))[0];
      assert.deepEqual(outcomes, { dev: "holds", prod: "fails" }, `asked by the ${asking} evaluator`);
    }
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "FEATURE=TRUE\n");
    assert.deepEqual(Object.values(resolveDeployOutcomes(root, [{ resource: flag("dev"), equals: "true" }]))[0], { dev: "holds", prod: "holds" });
  } finally { remove(root); }
});
