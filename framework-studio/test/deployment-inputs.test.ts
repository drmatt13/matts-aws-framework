import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { createDeploymentInput, withDeploymentInputs } from "../server/deployment-inputs";
import { InfrastructureService } from "../server/infrastructure";
import { readDeploymentSettings, readModeWebSocketApi } from "../server/inputs";
import type { ModeModel } from "../shared/model";
import { buildScene } from "../src/scene/build";
import { DeploymentInputService, inputMode, readInputEdits, updateInputText } from "../server/deployment-input-edits";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/deployment-input-tests");
mkdirSync(cache, { recursive: true });
function fixture() {
  const root = mkdtempSync(path.join(cache, "case-")); mkdirSync(path.join(root, "cdk-app"));
  writeFileSync(path.join(root, "cdk-app/.env.dev.example"), "PROD_DEPLOYMENT=false\nSETTING=example\nTOKEN=\nDEPLOY_PROD_WEBSOCKET_API=true\n");
  writeFileSync(path.join(root, "cdk-app/.env.prod.example"), "PROD_DEPLOYMENT=true\nSETTING=production\nTOKEN=\nDEPLOY_PROD_WEBSOCKET_API=false\n");
  return root;
}
function remove(root: string) { assert.ok(path.resolve(root).startsWith(cache + path.sep)); rmSync(root, { recursive: true }); }
const model: ModeModel = { mode: "dev", status: "ok", targets: [], routes: [], workflows: [], diagnostics: [], fields: {}, evaluatedInMs: 0, edges: [], resources: [
  { id: "resource:setting", path: ["setting"], kind: "input", fromEnv: "SETTING", default: "default", absent: false },
  { id: "resource:token", path: ["token"], kind: "secret", fromEnv: "TOKEN", absent: false },
] };

test("explicit file creation preserves active inputs and existing files, and never copies development secrets into production", () => {
  const root = fixture();
  try {
    const original = 'PROD_DEPLOYMENT=false\nSETTING=authored-dev\nTOKEN=private-dev-sentinel\nONLY_DEV=keep\n';
    writeFileSync(path.join(root, "cdk-app/.env"), original);
    assert.equal(createDeploymentInput(root, "dev").created, true);
    assert.equal(createDeploymentInput(root, "prod").created, true);
    const dev = readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8");
    const prod = readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8");
    assert.equal(parseEnv(dev).TOKEN, "private-dev-sentinel");
    assert.equal(parseEnv(dev).DEPLOY_PROD_WEBSOCKET_API, "true");
    assert.equal(parseEnv(prod).PROD_DEPLOYMENT, "true");
    assert.ok(!prod.includes("private-dev-sentinel")); assert.ok(!prod.includes("ONLY_DEV"));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env"), "utf8"), original);
    assert.equal(createDeploymentInput(root, "dev").created, false);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), dev);
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
    const edits = readInputEdits([{ name: "PGADMIN_HOST_PORT", value: "6060" }, { name: "TOKEN", value: "new-private\nsecond line" }, { name: "ADDED", value: "new-value # with whitespace", create: true }]);
    const plan = service.plan("dev", edits, details.hash, "initial");
    for (const value of ["old-private", "new-private", "6060", "5051", "new-value", "keep"]) assert.ok(!JSON.stringify(plan).includes(value));
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8"), original, "review never writes");
    assert.equal((await service.apply(plan.planId)).status, "applied");
    const after = readFileSync(path.join(root, "cdk-app/.env.dev"), "utf8");
    assert.deepEqual(parseEnv(after), { PGADMIN_HOST_PORT: "6060", TOKEN: "new-private\nsecond line", UNRELATED: "keep", ADDED: "new-value # with whitespace" });
    assert.ok(after.startsWith("# retained comment\r\n"));
    assert.equal(after.match(/^PGADMIN_HOST_PORT=/gm)!.length, 1);
    assert.equal(readFileSync(path.join(root, "cdk-app/.env.prod"), "utf8"), "PROD_ONLY=unchanged\n");
    assert.equal(readFileSync(path.join(root, "cdk-app/.env"), "utf8"), "ACTIVE=unchanged\n");
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
    assert.equal(dev.exists, false); assert.equal(dev.synthesisSource, "cdk-app/.env");
    assert.ok(dev.entries.every((entry) => entry.status === "missing"));
    assert.equal(createDeploymentInput(root, "dev").created, true, "reading did not create a file");
  } finally { remove(root); }
});

test("synthesis selects separate dev/prod files, graph flags agree and no named profile is required", async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, "cdk-app/.env"), "PROD_DEPLOYMENT=false\nDEPLOY_PROD_WEBSOCKET_API=false\n");
    createDeploymentInput(root, "dev"); createDeploymentInput(root, "prod");
    writeFileSync(path.join(root, "cdk-app/.env.dev"), 'PROD_DEPLOYMENT=false\nSETTING=only-dev\nDEPLOY_PROD_WEBSOCKET_API=true\nTOKEN="private\nDEPLOY_PROD_WEBSOCKET_API=false\n"\n');
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
    assert.equal(readDeploymentSettings(root).webSocketApi, true);
    assert.equal(readModeWebSocketApi(root, "prod", true), false);
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "PROD_DEPLOYMENT=false\nSETTING=changed-dev\n");
    assert.equal(service.get("dev").stale, true);
    assert.equal(service.get("prod").stale, false, "development input changes do not stale the production assembly");
  } finally { remove(root); }
});
