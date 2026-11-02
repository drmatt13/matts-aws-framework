import assert from "./support/assert";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { createDeploymentInput, initializeDeploymentInputs, withDeploymentInputs } from "../server/deployment-inputs";
import { CDK_ENVIRONMENT_ID, isUndeclaredEnvironmentInput } from "../shared/deployment-inputs";
import { REQUIRED_FRAMEWORK_INPUTS } from "../../cdk-app/framework-inputs";
import { InfrastructureService } from "../server/infrastructure";

import type { ModeModel } from "../shared/model";
import { buildScene } from "../src/scene/build";
import { DeploymentInputService, inputMode, readInputEdits, readInputFiles, updateInputText } from "../server/deployment-input-edits";

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

test("every written variable needs a linked input or secret across the two input models", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=\nTOKEN=private-test-token\nLOCAL_AWS_REGION=us-east-1\nUNKNOWN_BLANK=\nSOURCE_ONLY=ignored\nPROD_ONLY=written-in-dev\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "UNKNOWN_PROD=private-test-value\nPROD_ONLY=production\n");
    const dev: ModeModel = { ...model, resources: [...model.resources,
      { id: "resource:source", path: ["source"], kind: "input", authoredValue: "public", absent: false },
    ] };
    const prod: ModeModel = { ...model, mode: "prod", resources: [...model.resources,
      { id: "resource:group", path: ["group"], kind: "group", absent: false },
      { id: "resource:group.production", path: ["group", "production"], parent: "resource:group", kind: "input", fromEnv: "PROD_ONLY", absent: false },
    ] };
    for (const mode of ["dev", "prod"] as const) {
      const projected = withDeploymentInputs(root, { dev, prod }[mode], { dev, prod });
      const file = projected.resources.find((resource) => resource.id === `envfile:${mode}`)!.deploymentFile!;
      assert.deepEqual(file.entries.filter(isUndeclaredEnvironmentInput).map((entry) => entry.name),
        mode === "dev" ? ["SOURCE_ONLY", "UNKNOWN_BLANK"] : ["UNKNOWN_PROD"]);
      assert.equal(file.entries.find((entry) => entry.name === "PROD_ONLY")!.targets[0], "resource:group.production", "a declaration in the other model counts, even when not read here");
      assert.ok(!JSON.stringify(projected).includes("private-test-"), "declaration errors never need input values");
    }
  } finally { remove(root); }
});

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
    // Each file also lists the framework lines its own environment requires, written or not.
    const required = (mode: "dev" | "prod") => REQUIRED_FRAMEWORK_INPUTS[mode].filter((name) => !name.startsWith("DATABASE_"));
    assert.deepEqual(dev.entries.map((item) => item.name), [...new Set([...names, ...required("dev")])].sort());
    assert.deepEqual(prod.entries.map((item) => item.name), [...new Set([...names, ...required("prod")])].sort(), "a line written where the catalog does not read it stays visible");
    // Variables the application reads outside the catalog name their owner, default and choices.
    assert.deepEqual([entry(prod, "SKIP_EMAIL_VERIFICATION")!.owner, entry(prod, "SKIP_EMAIL_VERIFICATION")!.default, entry(prod, "SKIP_EMAIL_VERIFICATION")!.choices], ["deployment", undefined, ["true", "false"]],
      "a framework setting keeps its choices but takes no default: the file supplies it");
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

test("framework inputs project as managed groups with no defaults, and a required line left unset is a missing value", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "CDK_APP_NAME=private-name-value\nPOSTGRES_HOST_PORT=15432\nPGADMIN_HOST_PORT=\nLOCAL_AWS_PROFILE=\nSETTING=\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "DATABASE_MULTI_AZ=true\nPOSTGRES_HOST_PORT=15432\n");
    const dev: ModeModel = { ...model, mode: "dev" }, prod: ModeModel = { ...model, mode: "prod" };
    const project = (graph: ModeModel, models = { dev, prod }) => withDeploymentInputs(root, graph, models);
    const projected = project(dev);
    const byId = new Map(projected.resources.map((resource) => [resource.id, resource]));
    const group = byId.get("framework:deployment")!;
    assert.deepEqual([group.kind, group.frameworkInput, group.absent, group.path], ["group", "deployment", false, ["Deployment settings"]]);
    assert.equal(byId.get("framework:local")!.absent, false);
    assert.equal(byId.has("framework:database"), false, "no managed database, so no database group");
    const entry = (id: string) => byId.get(id)!;
    const cdk = entry("framework:deployment.cdkAppName");
    assert.deepEqual([cdk.kind, cdk.parent, cdk.fromEnv, cdk.default, cdk.required, cdk.inputRequirement!.status], ["input", "framework:deployment", "CDK_APP_NAME", undefined, true, "configured"]);
    assert.deepEqual(cdk.modes, { dev: { present: true, required: true }, prod: { present: true, required: false } }, "required where its template writes it");
    assert.equal(entry("framework:local.pgadminHostPort").inputRequirement!.status, "missing", "a blank required line has no default to stand in");
    assert.equal(entry("framework:deployment.skipEmailVerification").inputRequirement!.status, "missing", "an unwritten required line is missing");
    assert.equal(entry("framework:local.localAwsProfile").inputRequirement!.status, "optional", "the template writes LOCAL_AWS_PROFILE, but blank is allowed");
    assert.equal(entry("framework:deployment.retainStatefulResources").inputRequirement!.status, "optional", "a commented template line is optional");
    assert.ok(!projected.resources.some((resource) => resource.frameworkInput && resource.default !== undefined), "framework inputs take no default");
    assert.ok(!JSON.stringify(projected.resources).includes("private-name-value") && !JSON.stringify(projected.resources).includes("15432"), "values never enter the graph");
    const shadowed = project({ ...dev, resources: [...model.resources, { id: "resource:devUrl", path: ["devUrl"], kind: "input", fromEnv: "LOCAL_DEV_URL", absent: false }] });
    assert.ok(!shadowed.resources.some((resource) => resource.id === "framework:deployment.localDevUrl"), "a name the catalog declares stays the catalog's");
    // Supply connections reach each framework input like any input's, carrying its requirement.
    const wires = (graph: ModeModel, models = { dev, prod }) => project(graph, models).edges.filter((edge) => edge.to.startsWith("framework:")).map((edge) => `${edge.from} ${edge.label} ${edge.inputRequirement?.status}`);
    const devWires = wires(dev);
    for (const wire of ["envfile:dev CDK_APP_NAME configured", "envfile:dev PGADMIN_HOST_PORT missing", "envfile:dev SKIP_EMAIL_VERIFICATION missing", "envfile:dev LOCAL_AWS_PROFILE optional", "envfile:prod USE_FRONTEND_CUSTOM_DOMAIN missing"]) assert.ok(devWires.includes(wire), wire);
    assert.ok(!devWires.some((wire) => wire.startsWith("envfile:prod POSTGRES_HOST_PORT")), "production never reads a local setting");
    assert.ok(!devWires.some((wire) => wire.includes("RETAIN_STATEFUL_RESOURCES")), "an optional line nobody wrote has no connection");
    const devFile = projected.resources.find((item) => item.id === "envfile:dev")!.deploymentFile!;
    const line = devFile.entries.find((item) => item.name === "SKIP_EMAIL_VERIFICATION")!;
    assert.deepEqual([line.owner, line.targets, line.default, line.status, line.requirements![0]!.required], ["deployment", ["framework:deployment.skipEmailVerification"], undefined, "missing", true], "a required line is listed before it is written");
    const prodPort = project(prod).resources.find((item) => item.id === "envfile:prod")!.deploymentFile!.entries.find((item) => item.name === "POSTGRES_HOST_PORT")!;
    assert.deepEqual([prodPort.owner, prodPort.notRead, prodPort.requirements], ["local", true, []]);
    const managed = { ...prod, managedDatabase: { settings: { multiAz: false } } as unknown as ModeModel["managedDatabase"] };
    const withDatabase = new Map(project(dev, { dev, prod: managed }).resources.map((resource) => [resource.id, resource]));
    assert.equal(withDatabase.get("framework:database")!.absent, true, "development holds the database group as absent");
    assert.deepEqual(withDatabase.get("framework:database.multiAz")!.values, ["true", "false"]);
    assert.ok(wires(managed, { dev, prod: managed }).includes("envfile:prod DATABASE_MULTI_AZ configured"));
    assert.ok(wires(managed, { dev, prod: managed }).includes("envfile:prod DATABASE_INSTANCE_CLASS missing"));
  } finally { remove(root); }
});

test("sign-in providers are a framework-managed catalog group whose lines are all or nothing in each file", () => {
  const root = fixture();
  try {
    // Google is partly set in development and complete in production; Meta and Microsoft are unset.
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "GOOGLE_CLIENT_ID=private-client-value\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "GOOGLE_CLIENT_ID=private-client-value\nGOOGLE_CLIENT_SECRET=private-secret-value\n");
    const signIn: ModeModel["resources"] = [
      { id: "resource:signInProviders", path: ["signInProviders"], kind: "group", absent: false },
      ...([["googleClientId", "GOOGLE_CLIENT_ID", "input"], ["googleClientSecret", "GOOGLE_CLIENT_SECRET", "secret"], ["metaAppId", "META_APP_ID", "input"], ["metaAppSecret", "META_APP_SECRET", "secret"]] as const)
        .map(([key, fromEnv, kind]) => ({ id: `resource:signInProviders.${key}`, path: ["signInProviders", key], parent: "resource:signInProviders", kind, fromEnv, absent: false })),
    ];
    const dev: ModeModel = { ...model, mode: "dev", resources: [...model.resources, ...signIn] }, prod: ModeModel = { ...dev, mode: "prod" };
    const projected = (graph: ModeModel) => new Map(withDeploymentInputs(root, graph, { dev, prod }).resources.map((resource) => [resource.id, resource]));
    const inDev = projected(dev), inProd = projected(prod);
    assert.equal(inDev.get("resource:signInProviders")!.frameworkInput, "authentication", "the group is framework managed");
    assert.equal(inDev.get("resource:signInProviders.googleClientSecret")!.frameworkInput, "authentication", "and so is each entry");
    const secret = inDev.get("resource:signInProviders.googleClientSecret")!;
    assert.deepEqual([secret.inputRequirement!.required, secret.inputRequirement!.status], [true, "missing"], "a partly set provider needs the rest of its lines");
    assert.match(secret.inputRequirement!.reasons.join(" "), /Google sign-in reads GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET together/);
    assert.deepEqual(secret.modes, { dev: { present: true, required: true }, prod: { present: true, required: true } });
    assert.equal(inProd.get("resource:signInProviders.googleClientSecret")!.inputRequirement!.status, "configured");
    const meta = inDev.get("resource:signInProviders.metaAppId")!;
    assert.deepEqual([meta.inputRequirement!.required, meta.inputRequirement!.status, meta.modes!.dev.required], [false, "optional", false], "an unset provider is simply off");
    const edges = withDeploymentInputs(root, dev, { dev, prod }).edges.filter((edge) => edge.to.startsWith("resource:signInProviders")).map((edge) => `${edge.from} ${edge.label} ${edge.inputRequirement?.status}`);
    assert.ok(edges.includes("envfile:dev GOOGLE_CLIENT_SECRET missing"), "the missing line is an errored connection");
    assert.ok(!edges.some((edge) => edge.includes("META_")), "an unset provider has no connection");
    assert.ok(!JSON.stringify([...inDev.values(), ...inProd.values()]).includes("private-"), "values never enter the graph");
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

test("file initialization copies each template privately, never overwrites, and ignores other input files", () => {
  const root = fixture();
  try {
    const leftover = 'SETTING=authored-in-env\nTOKEN=private-env-sentinel\n';
    writeFileSync(path.join(root, "cdk-app/.env"), leftover);
    writeFileSync(path.join(root, "cdk-app/.env.staging"), leftover);
    assert.deepEqual(initializeDeploymentInputs(root).map(result => [result.mode, result.created, result.problem]), [["dev", true, undefined], ["prod", true, undefined]]);
    const dev = readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8");
    const prod = readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8");
    assert.equal(dev, readFileSync(path.join(root, "cdk-app/.env.dev.template"), "utf8"));
    assert.equal(prod, readFileSync(path.join(root, "cdk-app/.env.prod.template"), "utf8"));
    assert.ok(!dev.includes("private-env-sentinel") && !prod.includes("private-env-sentinel"));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env"), "utf8"), leftover);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.staging"), "utf8"), leftover);
    if (process.platform !== "win32") for (const mode of ["dev", "prod"]) assert.equal(statSync(path.join(root, `cdk-app/.env.${mode}`)).mode & 0o777, 0o600);
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SETTING=edited\n");
    assert.equal(createDeploymentInput(root, "dev").created, false);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), "SETTING=edited\n");
    rmSync(path.join(root, "cdk-app/.env.prod.template"));
    rmSync(path.join(root, "cdk-app/.env.prod"));
    assert.throws(() => createDeploymentInput(root, "prod"), /Missing cdk-app\/\.env\.prod\.template/);
  } finally { remove(root); }
});

test("initialization preserves empty and incomplete authored files and handles modes independently", () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "");
    rmSync(path.join(root, "cdk-app/.env.prod.template"));
    const results = initializeDeploymentInputs(root);
    assert.deepEqual(results.map(result => [result.mode, result.created, !!result.problem]), [["dev", false, false], ["prod", false, true]]);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), "");
    assert.equal(existsSync(path.join(root, "cdk-app/.env.prod")), false);
    const before = "# preserve this comment\nTOKEN=private-existing-sentinel\n";
    writeFileSync(path.join(root, "cdk-app/.env.prod"), before);
    assert.ok(initializeDeploymentInputs(root).every(result => !result.created && !result.problem));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8"), before);
    assert.ok(!JSON.stringify(results).includes("private-existing-sentinel"));
    rmSync(path.join(root, "cdk-app/.env.dev"));
    assert.deepEqual(initializeDeploymentInputs(root).map(result => result.created), [true, false]);
  } finally { remove(root); }
});

test("initialization refuses linked or nonregular paths, including dangling symlinks", () => {
  for (const target of ["input", "template", "directory", "dangling-input", "dangling-template", "dangling-directory", "input-directory"] as const) {
    const root = fixture();
    try {
      const source = path.join(root, "outside-input"), destination = path.join(root, target.includes("directory") && target !== "input-directory" ? "cdk-app" : target.includes("template") ? "cdk-app/.env.dev.template" : "cdk-app/.env.dev");
      if (target === "input-directory") mkdirSync(destination);
      else {
        rmSync(destination, { recursive: true, force: true });
        if (!target.startsWith("dangling")) {
          if (target === "directory") mkdirSync(source);
          else writeFileSync(source, "TOKEN=private-linked-sentinel\n");
        }
        symlinkSync(source, destination, target.includes("directory") ? process.platform === "win32" ? "junction" : "dir" : "file");
      }
      const results = initializeDeploymentInputs(root);
      assert.ok(results[0]!.problem, target);
      assert.ok(!JSON.stringify(results).includes("private-linked-sentinel"));
      if (!target.includes("directory") || target === "input-directory") assert.equal(results[1]!.created, true, "the other mode remains usable");
      if (target.startsWith("dangling")) assert.equal(existsSync(source), false, "setup must never follow or populate a dangling link");
    } finally { remove(root); }
  }
});

test("initialization reports permission failures without changing a file or exposing values", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const root = fixture();
  const directory = path.join(root, "cdk-app");
  try {
    chmodSync(directory, 0o500);
    assert.ok(initializeDeploymentInputs(root).every(result => !!result.problem && !result.created));
    assert.equal(existsSync(path.join(directory, ".env.dev")), false);
    assert.equal(existsSync(path.join(directory, ".env.prod")), false);
  } finally { chmodSync(directory, 0o700); remove(root); }
});

test("a concurrent creator wins without an overwrite, while a racing link is refused", (context) => {
  for (const linked of [false, true]) {
    const root = fixture();
    const file = path.join(root, "cdk-app/.env.dev");
    const originalLink = fs.linkSync;
    const winner = "TOKEN=concurrent-private-sentinel\n";
    const mocked = context.mock.method(fs, "linkSync", ((source: fs.PathLike, destination: fs.PathLike) => {
      if (destination === file) {
        assert.equal(readFileSync(source, "utf8"), readFileSync(path.join(root, "cdk-app/.env.dev.template"), "utf8"), "only complete template bytes can be published");
        if (linked) symlinkSync(path.join(root, "outside-input"), file);
        else writeFileSync(file, winner, { flag: "wx", mode: 0o600 });
      }
      return originalLink(source, destination);
    }) as typeof fs.linkSync);
    try {
      const result = initializeDeploymentInputs(root, ["dev"])[0]!;
      assert.equal(result.created, false);
      assert.equal(!!result.problem, linked);
      if (!linked) assert.equal(readFileSync(file, "utf8"), winner);
      assert.deepEqual(readdirSync(path.join(root, "cdk-app")).filter(name => name.endsWith(".tmp")), []);
      assert.ok(!JSON.stringify(result).includes("private"));
    } finally { mocked.mock.restore(); remove(root); }
  }
});

test("partial writes and flush or publication failures leave no final file and permit a clean retry", (context) => {
  for (const phase of ["write", "flush", "publish"] as const) {
    const root = fixture(), directory = path.join(root, "cdk-app"), file = path.join(directory, ".env.dev");
    const unrelated = path.join(directory, ".env.dev.studio-unrelated.tmp");
    writeFileSync(unrelated, "KEEP=unrelated-private-sentinel\n");
    const originalWrite = fs.writeFileSync, originalFlush = fs.fsyncSync, originalLink = fs.linkSync;
    const fail = () => { throw Object.assign(new Error("private-failure-sentinel"), { code: phase === "write" ? "ENOSPC" : "EIO" }); };
    let failed = false;
    const write = context.mock.method(fs, "writeFileSync", ((destination: Parameters<typeof fs.writeFileSync>[0], ...rest: unknown[]) => {
      if (phase === "write" && typeof destination === "number" && !failed) {
        failed = true;
        originalWrite(destination, "PARTIAL=private-partial-sentinel\n");
        fail();
      }
      return (originalWrite as (...args: unknown[]) => void)(destination, ...rest);
    }) as typeof fs.writeFileSync);
    const flush = context.mock.method(fs, "fsyncSync", (descriptor: number) => {
      if (phase === "flush" && !failed) { failed = true; fail(); }
      return originalFlush(descriptor);
    });
    const publish = context.mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => {
      if (phase === "publish" && destination === file && !failed) { failed = true; fail(); }
      return originalLink(source, destination);
    });
    try {
      const results = initializeDeploymentInputs(root);
      assert.equal(failed, true, phase);
      assert.deepEqual(results.map(result => [result.mode, result.created, !!result.problem]), [["dev", false, true], ["prod", true, false]], phase);
      assert.equal(existsSync(file), false, "a failed preparation never publishes partial bytes");
      assert.deepEqual(readdirSync(directory).filter(name => name.endsWith(".tmp")), [path.basename(unrelated)], "cleanup removes only this attempt's temporary file");
      assert.equal(readFileSync(unrelated, "utf8"), "KEEP=unrelated-private-sentinel\n");
      assert.ok(!JSON.stringify(results).includes("private"));
      const projected = withDeploymentInputs(root, model, undefined, [], { dev: results[0]!.problem! });
      const evidence = projected.resources.find(resource => resource.id === "envfile:dev")!.deploymentFile!;
      assert.equal(evidence.exists, false);
      assert.equal(evidence.setupProblem, results[0]!.problem, "the failed attempt stays actionable instead of looking complete");
      assert.equal(createDeploymentInput(root, "dev").created, true);
      assert.equal(readFileSync(file, "utf8"), readFileSync(path.join(directory, ".env.dev.template"), "utf8"));
    } finally { write.mock.restore(); flush.mock.restore(); publish.mock.restore(); remove(root); }
  }
});

test("two prepared creators publish exactly once and both remove their own staging files", (context) => {
  const root = fixture(), file = path.join(root, "cdk-app/.env.dev");
  const originalLink = fs.linkSync;
  const staged: fs.PathLike[] = [];
  let winner: ReturnType<typeof createDeploymentInput> | undefined;
  const mocked = context.mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (destination === file) {
      staged.push(source);
      assert.equal(readFileSync(source, "utf8"), readFileSync(path.join(root, "cdk-app/.env.dev.template"), "utf8"));
      // Interleave a second complete creator immediately before the first publishes.
      if (staged.length === 1) winner = createDeploymentInput(root, "dev");
    }
    return originalLink(source, destination);
  });
  try {
    const loser = createDeploymentInput(root, "dev");
    assert.deepEqual(winner, { file: "cdk-app/.env.dev", created: true });
    assert.deepEqual(loser, { file: "cdk-app/.env.dev", created: false });
    assert.equal(new Set(staged).size, 2);
    assert.ok(staged.every(temporary => !existsSync(temporary)));
    assert.equal(readFileSync(file, "utf8"), readFileSync(path.join(root, "cdk-app/.env.dev.template"), "utf8"));
  } finally { mocked.mock.restore(); remove(root); }
});

test("an exclusive temporary-file collision never removes the unowned file", (context) => {
  const root = fixture();
  const originalOpen = fs.openSync;
  let competing: fs.PathLike | undefined;
  const mocked = context.mock.method(fs, "openSync", ((file: fs.PathLike, flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
    if (typeof file === "string" && file.endsWith(".tmp")) {
      competing = file;
      const descriptor = originalOpen(file, "wx", 0o600);
      try { writeFileSync(descriptor, "KEEP=competing-private-sentinel\n"); }
      finally { fs.closeSync(descriptor); }
    }
    return originalOpen(file, flags, mode);
  }) as typeof fs.openSync);
  try {
    const result = initializeDeploymentInputs(root, ["dev"])[0]!;
    assert.ok(result.problem);
    assert.equal(existsSync(path.join(root, "cdk-app/.env.dev")), false);
    assert.ok(competing);
    assert.equal(readFileSync(competing, "utf8"), "KEEP=competing-private-sentinel\n");
    assert.ok(!JSON.stringify(result).includes("private"));
  } finally { mocked.mock.restore(); remove(root); }
});

test("the logical environment retains physical file evidence and only unresolved setup failures", () => {
  const root = fixture();
  try {
    const setupProblem = "Studio could not initialize cdk-app/.env.prod. Retry setup.";
    const projected = withDeploymentInputs(root, model, undefined, [], { prod: setupProblem });
    const logical = projected.resources.find(resource => resource.id === CDK_ENVIRONMENT_ID)!;
    assert.deepEqual([logical.path, logical.kind, logical.absent, logical.deploymentFiles], [["CDK environment"], "envFile", false, { dev: "envfile:dev", prod: "envfile:prod" }]);
    assert.equal(projected.resources.find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem, setupProblem);
    assert.equal(projected.resources.find(resource => resource.id === "envfile:dev")!.deploymentFile!.setupProblem, undefined);
    assert.equal(existsSync(path.join(root, "cdk-app/.env.prod")), false, "projection does not retry creation");
    createDeploymentInput(root, "prod");
    const repaired = withDeploymentInputs(root, projected, undefined, [], { prod: setupProblem });
    assert.equal(repaired.resources.find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem, undefined);
    assert.equal(repaired.resources.filter(resource => resource.id === CDK_ENVIRONMENT_ID).length, 1, "refresh cannot duplicate the logical resource");
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
    assert.ok(projected.edges.filter((edge) => edge.relation === "supplies").every((edge) => model.resources.some((resource) => resource.id === edge.to) || edge.to.startsWith("framework:")),
      "supplies reach catalog declarations or framework-managed inputs, never an unknown key");
    assert.ok(!projected.edges.some((edge) => edge.from === "envfile:prod" && edge.to === "resource:token"), "missing assignments do not pretend to supply a value");
    const scene = buildScene(projected);
    assert.equal(scene.islands.find((island) => island.id === "island:inputs")!.title, "Input parameters and secrets");
    assert.ok(scene.islands.some((island) => island.id === "island:environment"));
    assert.equal(scene.nodes.find((node) => node.id === CDK_ENVIRONMENT_ID)!.island, "island:environment");
    assert.equal(scene.nodes.find((node) => node.id === CDK_ENVIRONMENT_ID)!.label, "CDK environment");
    for (const mode of ["dev", "prod"] as const) assert.ok(!scene.nodes.some((node) => node.id === `envfile:${mode}`));
    assert.ok(scene.edges.some((edge) => edge.from === CDK_ENVIRONMENT_ID && edge.to === "resource:token"));
    assert.deepEqual(scene.nodes.filter((node) => node.island === "island:inputs").map((node) => node.id).sort(), ["framework:deployment", "framework:local", "resource:setting", "resource:token"],
      "framework-managed groups stand beside the catalog's inputs; an unknown key does not");
    assert.deepEqual(scene.nodes.map((node) => [node.id, node.gx, node.gy]), buildScene({ ...projected, mode: "prod" }).nodes.map((node) => [node.id, node.gx, node.gy]));
  } finally { remove(root); }
});

function editing(root: string) {
  const builder = { current: { snapshot: { revision: "initial", models: { dev: model, prod: { ...model, mode: "prod" as const } } } },
    refresh: async () => { builder.current.snapshot.revision = "saved"; return builder.current; } };
  return { builder, service: new DeploymentInputService(root, builder) };
}

test("reviewed removal deletes both files' duplicate and multiline assignments without exposing their values", async () => {
  const root = fixture();
  try {
    const before = '# retained\r\nKEEP="first\nUNUSED=inside-another-value\nlast"\r\nUNUSED="private-multiline\nFAKE=inside-removed-value"\r\nUNUSED=private-duplicate\r\nAFTER=unchanged\r\n';
    writeFileSync(path.join(root, "cdk-app/.env.dev"), before);
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "# production\nUNUSED=\nOTHER=preserved\n");
    const { service } = editing(root);
    const files = readInputFiles((["dev", "prod"] as const).map(mode => ({ mode, hash: service.details(mode).hash, edits: [{ name: "UNUSED", value: "", remove: true }] })));
    const plan = service.plan(files, "initial");
    assert.deepEqual(plan.summaries, ["Remove UNUSED from .env.dev", "Remove UNUSED from .env.prod"]);
    assert.ok(!JSON.stringify(plan).includes("private-"));
    assert.ok(plan.changes.every(change => !change.diff.lines.some(line => line.kind === "add")));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), before, "review does not write");
    assert.equal((await service.apply(plan.planId)).status, "applied");
    const after = readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8");
    assert.equal(after, '# retained\r\nKEEP="first\nUNUSED=inside-another-value\nlast"\r\nAFTER=unchanged\r\n');
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8"), "# production\nOTHER=preserved\n");
    assert.equal(parseEnv(after).UNUSED, undefined);
    for (const bad of [{ remove: false }, { remove: true, create: true }, { remove: true, value: "private" }])
      assert.throws(() => readInputEdits([{ name: "UNUSED", value: "", ...bad }]), /removal|variable name/);
  } finally { remove(root); }
});

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
    const plan = service.plan([{ mode: "dev", hash: details.hash, edits: edits }], "initial");
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
    const plan = service.plan([{ mode: "dev", hash: service.details("dev").hash, edits: [{ name: "TOKEN", value: "new-private" }] }], "initial");
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
    assert.throws(() => service.plan([{ mode: "dev", hash: details.hash, edits: [{ name: "PROD_DEPLOYMENT", value: "true" }] }], "initial"), /must match/);
    assert.throws(() => service.plan([{ mode: "dev", hash: details.hash, edits: [{ name: "PGADMIN_HOST_PORT", value: "6060", create: true }] }], "initial"), /already exists/);
    assert.throws(() => service.plan([{ mode: "dev", hash: details.hash, edits: [{ name: "NEW", value: "1", create: true }, { name: "NEW", value: "2", create: true }] }], "initial"), /only once/);
    const plan = service.plan([{ mode: "dev", hash: details.hash, edits: [{ name: "PGADMIN_HOST_PORT", value: "6060" }] }], "initial");
    const external = "PROD_DEPLOYMENT=false\nPGADMIN_HOST_PORT=7070\n";
    writeFileSync(path.join(root, "cdk-app/.env.dev"), external);
    await assert.rejects(service.apply(plan.planId), /Nothing was written/);
    assert.throws(() => service.plan([{ mode: "dev", hash: details.hash, edits: [{ name: "PGADMIN_HOST_PORT", value: "6060" }] }], "initial"), /changed/);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), external);
    assert.throws(() => service.details("prod"), /Create/);
  } finally { remove(root); }
});

test("one review saves both CDK files, checks every file before writing either, and names each change's file", async () => {
  const root = fixture();
  const read = (mode: "dev" | "prod") => readFileSync(path.join(root, `cdk-app/.env.${mode}`), "utf8");
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "SHARED=dev-old\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "SHARED=prod-old\n");
    const { service } = editing(root);
    const edits = (mode: "dev" | "prod") => [{ name: "SHARED", value: `${mode}-new` }];
    const files = () => [{ mode: "prod" as const, hash: service.details("prod").hash, edits: edits("prod") },
      { mode: "dev" as const, hash: service.details("dev").hash, edits: [...edits("dev"), { name: "ADDED", value: "", create: true as const }] }];
    assert.throws(() => readInputFiles([{ mode: "dev", hash: "a", edits: edits("dev") }, { mode: "dev", hash: "b", edits: edits("dev") }]), /once/);
    assert.throws(() => readInputFiles([]), /one or both/);
    assert.throws(() => service.plan([files()[1]!, { ...files()[0]!, hash: "stale" }], "initial"), /changed/, "one stale file refuses the whole review");
    const plan = service.plan(files(), "initial");
    assert.deepEqual(plan.changes.map((change) => change.file), ["cdk-app/.env.dev", "cdk-app/.env.prod"]);
    assert.deepEqual(plan.summaries, ["Update SHARED in .env.dev", "Add ADDED in .env.dev", "Update SHARED in .env.prod"]);
    assert.ok(!/dev-new|prod-new|-old/.test(JSON.stringify(plan)), "values stay out of the review");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "SHARED=prod-external\n");
    await assert.rejects(service.apply(plan.planId), /Nothing was written/);
    assert.equal(read("dev"), "SHARED=dev-old\n", "an external edit to either file writes neither");
    const response = await service.apply(service.plan(files(), "initial").planId);
    assert.match(response.message, /^Saved cdk-app\/\.env\.dev and cdk-app\/\.env\.prod\./);
    assert.deepEqual({ ...parseEnv(read("dev")) }, { SHARED: "dev-new", ADDED: "" });
    assert.deepEqual({ ...parseEnv(read("prod")) }, { SHARED: "prod-new" });
    assert.deepEqual(readdirSync(path.join(root, "cdk-app")).filter((name) => name.endsWith(".tmp")), [], "no staging file is left behind");
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
