import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDatabaseDraft, readDatabasePlacementDraft } from "../shared/managed-database";
import { planDatabaseSettings } from "../server/edits/database";
import { SourceFiles } from "../server/source";
import { locateManagedDatabase } from "../server/source/database";
import type { StudioState } from "../server/snapshot";

const request = (settings: unknown = { multiAz: true }) => ({ kind: "database", database: "application", settings });
test("database placement requests require one registered identity and never accept public or absent placement", () => {
  const edit = { kind: "databasePlacement", database: "application", vpc: "analytics", subnet: "isolated" };
  assert.deepEqual(readDatabasePlacementDraft(edit), edit);
  for (const raw of [{ ...edit, subnet: "public" }, { ...edit, subnet: "none" }, { ...edit, vpc: null }, { ...edit, database: "../application" }, { ...edit, consumers: [] }, { ...edit, settings: {} }, { ...edit, file: "anything.ts" }]) assert.throws(() => readDatabasePlacementDraft(raw));
});
test("managed database HTTP drafts validate names, topology and typed settings", () => {
  assert.deepEqual(readDatabaseDraft(request()), request());
  const settings = { storageType: "gp3", allocatedStorage: 400, maxAllocatedStorage: 1000, iops: 12000, throughput: 500, readReplicaCount: 2, backupRetentionDays: 7 };
  assert.deepEqual(readDatabaseDraft(request(settings)), request(settings));
  assert.throws(() => readDatabaseDraft(request({ readReplicaCount: 1, backupRetentionDays: 0 })), /settings.readReplicaCount requires positive settings.backupRetentionDays/);
  assert.throws(() => readDatabaseDraft(request({ engineVersion: "latest" })), /settings.engineVersion must be a PostgreSQL/);
  for (const raw of [
    { ...request(), database: "../application" }, { ...request(), path: "cdk-app/database.ts" },
    { ...request(), networkId: "other" }, { ...request(), id: "other" },
    request({ multiAz: "true" }), request({ readReplicaCount: 1, backupRetentionDays: 0 }),
    request({ allocatedStorage: "20" }), request({ engineVersion: "latest" }),
    request({ engine: "mysql" }), request({ instanceClass: "t3.micro" }),
    request({ constructor: 1 }), request(JSON.parse('{"__proto__":true}')),
    request(Object.create({ multiAz: true })), Object.assign(Object.create({ kind: "database" }), request()),
  ]) assert.throws(() => readDatabaseDraft(raw));
});

function fixture(run: (root: string, file: string, before: string, state: StudioState) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "studio-managed-database-"));
  try {
    const file = path.join(root, "framework-config/databases/application/index.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    const before = `import { defineDatabase as managedPostgres } from "@repo/framework/config";
export const applicationDatabase = managedPostgres({
  id: "application", resource: resources.rds.database, vpc: applicationVpc,
  settings: {
    // Retain this operational explanation.
    instanceClass: 'db.t3.micro',
    multiAz: false,
    proxyEnabled: false,
  },
});\n`;
    writeFileSync(file, before);
    writeFileSync(path.join(root, "framework.config.ts"), 'import { applicationDatabase as primary } from "./framework-config/databases/application"; defineFrameworkConfig({ database: primary });');
    const managedDatabase = { id: "application", authored: { instanceClass: "db.t3.micro", multiAz: false, proxyEnabled: false } };
    const state = { snapshot: { models: { dev: { managedDatabase }, prod: { managedDatabase } } } } as unknown as StudioState;
    run(root, file, before, state);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("managed database source follows its imported declaration and changes only edited settings", () => fixture((root, file, before, state) => {
  const located = locateManagedDatabase(root, new SourceFiles());
  assert.equal(located?.id, "application");
  assert.equal(located?.file, file);
  const result = planDatabaseSettings(root, state, "application", { instanceClass: "db.t3.micro", multiAz: true, proxyEnabled: false }, new SourceFiles());
  assert.equal(result.after, before.replace("multiAz: false", "multiAz: true"));
  assert.equal(readFileSync(file, "utf8"), before, "planning writes no source");
  const removal = planDatabaseSettings(root, state, "application", { instanceClass: "db.t3.micro", multiAz: false }, new SourceFiles());
  assert.equal(removal.after, before.replace("    proxyEnabled: false,\n", ""));
}));

test("managed database source refuses hidden, computed, stale and unsupported settings", () => fixture((root, file, before, state) => {
  for (const text of [
    before.replace('from "@repo/framework/config"', 'from "./custom"'),
    before.replace("multiAz: false", "multiAz: shouldReplicate()"),
    before.replace("multiAz: false", "...defaults, multiAz: false"),
    before.replace("settings: {", "settings: computed({"),
    before.replace("proxyEnabled: false", "proxyEnabled: true"),
    before.replace('id: "application"', 'id: "other"'),
  ]) {
    const files = new SourceFiles(new Map([[file, text]]));
    assert.throws(() => planDatabaseSettings(root, state, "application", { instanceClass: "db.t3.micro", multiAz: true, proxyEnabled: false }, files));
  }
  assert.throws(() => planDatabaseSettings(root, state, "application", { instanceClass: "db.t3.micro", multiAz: false }, new SourceFiles(new Map([[file, before.replace("proxyEnabled: false", "// Preserve Proxy intent.\n    proxyEnabled: false")]]))), /comment/);
  const withLogs = before.replace("    proxyEnabled: false,", "    proxyEnabled: false,\n    logExports: [/* Keep audit context. */ 'postgresql'],");
  const managedDatabase = { id: "application", authored: { instanceClass: "db.t3.micro", multiAz: false, proxyEnabled: false, logExports: ["postgresql"] } };
  const logsState = { snapshot: { models: { dev: { managedDatabase }, prod: { managedDatabase } } } } as unknown as StudioState;
  assert.throws(() => planDatabaseSettings(root, logsState, "application", { ...managedDatabase.authored, logExports: ["postgresql", "upgrade"] }, new SourceFiles(new Map([[file, withLogs]]))), /contains a source comment/);
  assert.throws(() => planDatabaseSettings(root, state, "unknown", {}, new SourceFiles()), /Unknown managed database/);
}));
