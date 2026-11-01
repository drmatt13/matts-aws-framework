import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "./support/assert";
import type { ModelResource, Snapshot } from "../shared/model";
import { FRAMEWORK_INPUT_GROUPS } from "../shared/deployment-inputs";
import { SnapshotBuilder } from "../server/snapshot";
import { listResourceDeclarations } from "../../packages/framework/src/config/resources";
import { DATABASE_SETTING_INPUTS } from "../../packages/framework/src/config/database";
import { deploymentInputs } from "../../cdk-app/deployment-inputs";
import { localInputs, REQUIRED_FRAMEWORK_INPUTS } from "../../cdk-app/framework-inputs";
import { resourceIssues } from "../src/issues";

/**
 * Framework inputs are the variables the framework itself reads from the CDK inputs files. They
 * project as framework-managed input groups with no defaults, required where their environment's
 * template writes them. These hold the templates, the required list and their readers together,
 * and every variable the templates name to exactly one place.
 */

const root = path.resolve(__dirname, "..", "..");
const text = (relative: string) => readFileSync(path.join(root, relative), "utf8");
let builder: SnapshotBuilder;
let snapshot: Snapshot;

before(async () => {
  builder = new SnapshotBuilder(root);
  snapshot = (await builder.refresh()).snapshot;
});
after(() => builder.dispose());

const local = listResourceDeclarations(localInputs());
const framework = new Set([
  ...(["dev", "prod"] as const).flatMap((mode) => listResourceDeclarations(deploymentInputs(mode)).map((item) => item.fromEnv!)),
  ...Object.values(DATABASE_SETTING_INPUTS),
  ...local.map((item) => item.fromEnv!),
]);
/** Written by its template, yet blank is meaningful: the default AWS profile. */
const OPTIONAL_WRITTEN = new Set(["LOCAL_AWS_PROFILE"]);
const lines = (template: string, commented: boolean) =>
  [...text(template).matchAll(commented ? /^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm : /^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);

test("each template writes exactly the framework lines its environment requires", () => {
  for (const mode of ["dev", "prod"] as const) {
    const template = `cdk-app/.env.${mode}.template`;
    const written = lines(template, false).filter((name) => framework.has(name));
    const required = REQUIRED_FRAMEWORK_INPUTS[mode];
    for (const name of required) {
      assert.ok(framework.has(name), `${name} is a framework setting`);
      assert.ok(written.includes(name), `${template} writes ${name}, which ${mode} requires`);
    }
    for (const name of written) assert.ok(required.includes(name) || OPTIONAL_WRITTEN.has(name), `${template} writes ${name}: require it, or comment it out as optional`);
  }
});

test("local framework inputs have a reader and take no default", () => {
  const readers = ["docker-compose.yml", "scripts/local-export.ts", "scripts/dev.mjs", "packages/framework/src/local/lambda-process.ts",
    "packages/framework/src/local/environment.ts", "packages/database/scripts/seed-test-user-cli.ts"].map(text).join("\n");
  for (const setting of local) {
    assert.ok(readers.includes(setting.fromEnv!), `${setting.fromEnv} has a reader`);
    assert.equal(setting.default, undefined, `${setting.fromEnv}: the inputs file supplies it`);
  }
});

test("every host port Docker Compose publishes is a catalog input or a required local framework input", () => {
  const ports = [...(/LOCAL_HOST_PORT_NAMES = \[([\s\S]*?)\]/.exec(text("scripts/local-export.ts"))?.[1] ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]!);
  assert.ok(ports.length >= 6, "found scripts/local-export.ts LOCAL_HOST_PORT_NAMES");
  const catalog = new Set(snapshot.models.dev.resources.filter((resource) => resource.kind === "input" && !resource.frameworkInput).map((resource) => resource.fromEnv));
  for (const port of ports) {
    const setting = local.find((item) => item.fromEnv === port);
    assert.ok(catalog.has(port) !== !!setting, `${port} belongs to exactly one place`);
    if (setting) assert.ok(REQUIRED_FRAMEWORK_INPUTS.dev.includes(port), `${port} is required in development`);
  }
});

test("every variable the inputs templates name belongs to exactly one place", () => {
  const resources = (["dev", "prod"] as const).flatMap((mode) => snapshot.models[mode].resources);
  const catalog = new Set(resources.filter((resource) => (resource.kind === "input" || resource.kind === "secret") && !resource.frameworkInput).flatMap((resource) => resource.fromEnv ? [resource.fromEnv] : []));
  // The sign-in providers are the framework's, declared in the catalog for their secrets.
  const signIn = new Set(resources.filter((resource) => resource.frameworkInput === "authentication").flatMap((resource) => resource.fromEnv ? [resource.fromEnv] : []));
  assert.ok(signIn.has("GOOGLE_CLIENT_SECRET") && signIn.has("MICROSOFT_TENANT_ID") && signIn.has("META_APP_ID"), "the sign-in providers are framework inputs");
  for (const template of ["cdk-app/.env.dev.template", "cdk-app/.env.prod.template"]) {
    // Commented assignments count: they document a variable the file may set.
    const names = lines(template, true);
    assert.ok(names.length > 10, template);
    for (const name of names) assert.ok(catalog.has(name) !== (framework.has(name) || signIn.has(name)), `${template}: ${name} is ${catalog.has(name) ? "claimed twice" : "claimed by nothing"}`);
  }
});

test("the repository projects framework-managed groups by reader, held only where their file is read", () => {
  for (const mode of ["dev", "prod"] as const) {
    const resources = snapshot.models[mode].resources;
    for (const owner of ["deployment", "database", "local"] as const) {
      const group = resources.find((item) => item.id === FRAMEWORK_INPUT_GROUPS[owner].id);
      if (owner === "database" && !snapshot.models.prod.managedDatabase) {
        assert.equal(group, undefined);
        continue;
      }
      assert.ok(group, `${mode}: ${owner}`);
      assert.deepEqual([group.kind, group.frameworkInput, group.absent], ["group", owner, !FRAMEWORK_INPUT_GROUPS[owner].modes.includes(mode)], `${mode}: ${owner}`);
      const entries = resources.filter((item) => item.parent === group.id);
      assert.ok(entries.length > 0 && entries.every((entry) => entry.kind === "input" && entry.frameworkInput === owner && entry.default === undefined), `${owner} entries take no default`);
    }
  }
});

test("a missing framework input never offers a default as the remedy", () => {
  const requirement = { resource: "framework:local.postgresHostPort", name: "POSTGRES_HOST_PORT", mode: "dev" as const, file: "cdk-app/.env.dev", required: true, status: "missing" as const, reasons: [] };
  const entry: ModelResource = { id: "framework:local.postgresHostPort", path: ["Local development", "postgresHostPort"], parent: "framework:local", kind: "input", absent: false,
    frameworkInput: "local", fromEnv: "POSTGRES_HOST_PORT", inputRequirement: requirement };
  const group: ModelResource = { id: "framework:local", path: ["Local development"], kind: "group", absent: false, frameworkInput: "local" };
  assert.deepEqual(resourceIssues(entry)[0]!.details, ["POSTGRES_HOST_PORT has no value for Development: cdk-app/.env.dev leaves it unset and no default stands in.",
    "Set it in cdk-app/.env.dev; the framework reads it from there and takes no default."]);
  assert.deepEqual(resourceIssues(group, [group, entry])[0]!.details, ["1 input has no value: cdk-app/.env.dev leaves it unset.", "Set it in cdk-app/.env.dev."]);
});
