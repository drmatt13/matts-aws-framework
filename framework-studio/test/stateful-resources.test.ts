import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { StatefulResourceService } from "../server/stateful-resources";
import { changeStatefulSource, readStatefulSource, STATEFUL_SOURCE_FILE } from "../server/stateful-source";
import type { CommandSpec, Runner } from "../server/deploy/process";

const cache = path.resolve(__dirname, "../../.cache/stateful-studio-tests");
mkdirSync(cache, { recursive: true });
const source = 'import type { StatefulResourcesConfiguration } from "../cdk-app/stateful-resources";\n// Keep this ownership comment.\nexport const statefulResources = { dev: {}, prod: { cognito: { retention: "retain" } } } satisfies StatefulResourcesConfiguration;\n';
function fixture(run: Runner = async () => { throw new Error("AWS must not run"); }) {
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "framework-config")); mkdirSync(path.join(root, "cdk-app"));
  writeFileSync(path.join(root, "framework.config.ts"), "export default {};\n");
  writeFileSync(path.join(root, STATEFUL_SOURCE_FILE), source);
  writeFileSync(path.join(root, "cdk-app/.env.dev"), "RETAIN_STATEFUL_RESOURCES=true\nPRIVATE_TOKEN=do-not-return\n");
  writeFileSync(path.join(root, "cdk-app/.env.prod"), "RETAIN_STATEFUL_RESOURCES=false\n");
  let revision = "r1";
  const builder = { get current() { return { snapshot: { revision } }; }, refresh: async () => ({ snapshot: { revision: revision = "r2" } }) };
  const deploy = { targets: () => [{ name: "job2-dev", mode: "dev" as const, origin: "personal" as const, account: "111122223333", region: "us-east-1" }] };
  const service = new StatefulResourceService(root, builder, deploy, run);
  return { root, service, remove() { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); } };
}

test("AST lifecycle edits preserve the other environment and refuse executable or ambiguous source", () => {
  const changed = changeStatefulSource(source, "dev", "database", { retention: "remove" });
  assert.match(changed, /Keep this ownership comment/);
  assert.ok(changed.includes('prod: { cognito: { retention: "retain" } }'));
  assert.deepEqual(JSON.parse(JSON.stringify(readStatefulSource(changed).value)), { dev: { database: { retention: "remove" } }, prod: { cognito: { retention: "retain" } } });
  for (const text of ['export const statefulResources = {dev:{...other}};', 'export const statefulResources = call();', 'export const statefulResources = {dev:{},dev:{}};', 'export const statefulResources = {dev:{[compute()]:{}}};', 'export const statefulResources = {__proto__:{}};']) assert.throws(() => readStatefulSource(text), /Edit .* in your editor/);
});

test("lifecycle property edits preserve selected-environment comments, sibling reference bytes and quote style", () => {
  const authored = `export const statefulResources = {
  dev: {
    // Database policy belongs to this team.
    database: { retention: 'retain' }, // Keep database costs visible.
    cognito: {
      // Keep original users.
      retention: 'remove' as const,
      reference: { account: '111122223333' /* explain this exact identity */ },
    },
  },
  prod: { cognito: { retention: 'retain' } },
};\n`;
  const changed = changeStatefulSource(authored, "dev", "cognito", { retention: "retain" });
  assert.equal(changed, authored.replace("retention: 'remove' as const", "retention: 'retain' as const"));
  const inserted = changeStatefulSource(authored.replace("      retention: 'remove' as const,\n", ""), "dev", "cognito", { retention: "retain" });
  assert.ok(inserted.includes("reference: { account: '111122223333' /* explain this exact identity */ },"));
  assert.match(inserted, /retention: 'retain'/);
  assert.ok(inserted.includes("// Keep original users."));
});

test("reference insertion preserves quoted source and unrelated policy comments without leaking a placeholder", () => {
  const authored = "export const statefulResources = { dev: { database: { retention: 'retain' /* keep database */ } }, prod: {} };\n";
  const changed = changeStatefulSource(authored, "dev", "cognito", { reference });
  assert.ok(changed.includes("database: { retention: 'retain' /* keep database */ }"));
  assert.deepEqual(JSON.parse(JSON.stringify(readStatefulSource(changed).value.dev?.cognito?.reference)), reference);
  assert.doesNotMatch(changed, /studio_[a-f0-9]+|PLACEHOLDER/);
});

test("commented reference replacement/removal and commented empty-object insertion require an editor", () => {
  const examples: [string, Parameters<typeof changeStatefulSource>[3]][] = [
    ["export const statefulResources = {dev:{cognito:{reference:{account:'111122223333' /* preserve */}}}};", { reference }],
    ["export const statefulResources = {dev:{cognito:{retention: /* preserve */ 'retain'}}};", { retention: undefined }],
    ["export const statefulResources = {dev:{cognito:{/* decide here */}}};", { retention: "retain" }],
  ];
  for (const [text, edit] of examples) assert.throws(() => changeStatefulSource(text, "dev", "cognito", edit), /comment|editor/);
  for (const malformed of ["export const statefulResources = { dev: { cognito: { retention: 'retain' } }", "export const statefulResources = { dev: { cognito: { retention: 'retain' retention: 'remove' } } };"] ) assert.throws(() => readStatefulSource(malformed), /Edit .* in your editor/);
});

test("four independent policies inherit exact legacy defaults and review writes only TypeScript", async () => {
  const f = fixture(); try {
    const dev = f.service.source("dev"), prod = f.service.source("prod");
    assert.equal(dev.legacy.retain, true); assert.equal(dev.resources.database.retention, undefined);
    assert.equal(prod.legacy.retain, false); assert.equal(prod.resources.cognito.retention, "retain");
    assert.doesNotMatch(JSON.stringify(dev), /PRIVATE_TOKEN|do-not-return/);
    const beforeEnv = readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8");
    const plan = f.service.retention({ mode: "dev", kind: "database", retention: "remove", hash: dev.hash, revision: "r1" });
    assert.equal(readFileSync(path.join(f.root, STATEFUL_SOURCE_FILE), "utf8"), source, "review must not write");
    assert.match(plan.changes[0]!.diff.unified, /retention: "remove"/);
    assert.match((await f.service.apply(plan.planId)).message, /no AWS resource was changed/);
    assert.equal(f.service.source("dev").resources.database.retention, "remove");
    assert.equal(f.service.source("prod").resources.cognito.retention, "retain");
    assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8"), beforeEnv);
    await assert.rejects(f.service.apply(plan.planId), /expired/);
  } finally { f.remove(); }
});

test("changed dotenv fallback or unrelated declaration invalidates source approval without writes", async () => {
  for (const file of ["cdk-app/.env.dev", "framework.config.ts", "cdk-app/cdk.json", "cdk-app/stateful-resources.ts"]) {
    const f = fixture(); try {
      const before = f.service.source("dev");
      const plan = f.service.retention({ mode: "dev", kind: "cognito", retention: "retain", hash: before.hash, revision: "r1" });
      writeFileSync(path.join(f.root, file), "// external change\n");
      await assert.rejects(f.service.apply(plan.planId), /changed/);
      assert.equal(readFileSync(path.join(f.root, STATEFUL_SOURCE_FILE), "utf8"), source);
    } finally { f.remove(); }
  }
});

test("reference inspection cannot save a descriptor from an account other than the declared destination", async () => {
  const f = fixture(async () => ({ code: 0, stdout: JSON.stringify({ kind: "cognito", reference: { account: "999988887777", region: "us-east-1" } }), stderr: "" }));
  try {
    const before = f.service.source("dev");
    await assert.rejects(f.service.reference({ selection: { profile: "wrong", deployment: "job2-dev", region: "us-east-1", mode: "dev" }, kind: "cognito", id: "us-east-1_Original", originalDeployment: "old-dev", clientId: "oldclient123", hash: before.hash, revision: "r1" }), /declared destination account/);
    assert.equal(readFileSync(path.join(f.root, STATEFUL_SOURCE_FILE), "utf8"), source);
  } finally { f.remove(); }
});

const reference = { account: "111122223333", region: "us-east-1", originalDeployment: "original-dev", userPoolId: "us-east-1_Original", userPoolClientId: "oldclient123", userPoolDomainUrl: "https://old.auth.us-east-1.amazoncognito.com" };
const selection = { profile: "dev", deployment: "job2-dev", region: "us-east-1", mode: "dev" };
test("reference approval delegates exact inspection and repeats live compatibility before a journalled source write", async () => {
  const calls: CommandSpec[] = [];
  const f = fixture(async spec => { calls.push(spec); return { code: 0, stdout: JSON.stringify({ kind: "cognito", reference, checks: ["original physical identity and client verified"] }), stderr: "" }; });
  try {
    const before = f.service.source("dev");
    const plan = await f.service.reference({ selection, kind: "cognito", id: reference.userPoolId, originalDeployment: reference.originalDeployment, clientId: reference.userPoolClientId, revision: "r1", hash: before.hash, reference: { arbitrary: "ignored" } });
    assert.equal(calls.length, 1); assert.ok(calls[0]!.args.includes("--id")); assert.ok(calls[0]!.args.includes(reference.userPoolId));
    assert.equal(readFileSync(path.join(f.root, STATEFUL_SOURCE_FILE), "utf8"), source);
    await f.service.apply(plan.planId);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(f.service.source("dev").resources.cognito.reference)), reference);
  } finally { f.remove(); }
});

test("changed resource, unowned destination and failed inspection cannot become saved reference source", async () => {
  let call = 0;
  const f = fixture(async () => ({ code: 0, stdout: JSON.stringify({ kind: "cognito", reference: { ...reference, userPoolClientId: ++call === 1 ? "oldclient123" : "changedclient" } }), stderr: "" }));
  try {
    const before = f.service.source("dev"), body = { selection, kind: "cognito", id: reference.userPoolId, originalDeployment: reference.originalDeployment, clientId: reference.userPoolClientId, revision: "r1", hash: before.hash };
    await assert.rejects(f.service.reference({ ...body, selection: { ...selection, deployment: "unknown" } }), /declared deployment/);
    const plan = await f.service.reference(body);
    await assert.rejects(f.service.apply(plan.planId), /dependencies changed/);
    assert.equal(readFileSync(path.join(f.root, STATEFUL_SOURCE_FILE), "utf8"), source);
    assert.throws(() => f.service.retention({ mode: "dev", kind: "database", retention: "maybe", revision: "r1", hash: before.hash }), /Choose retain/);
  } finally { f.remove(); }
});
