import assert from "./support/assert";
import { after, test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { computeMigrationHash } from "@prisma/orm-postgres/migration-tools/hash";
import postgresTarget from "@prisma/orm-postgres/target/control";
import { DatabaseHistoryService, compareDatabaseContracts, readDatabaseHistory } from "../server/database-history";
import { compileDatabaseSource } from "../server/database-workbench";
import { CONTRACT_FILE } from "../server/database";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
after(async () => { for (const directory of temporary) await rm(directory, { recursive: true, force: true }); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-history-test-"));
  temporary.push(root);
  await mkdir(path.join(root, "packages/database"), { recursive: true });
  await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await cp(path.join(repository, "packages/database/prisma"), path.join(root, "packages/database/prisma"), { recursive: true });
  for (const file of ["package.json", "packages/database/package.json", "packages/database/prisma.config.ts"]) {
    await writeFile(path.join(root, file), await readFile(path.join(repository, file)));
  }
  return root;
}

const migrationPath = (root: string, name: string) => path.join(root, "packages/database/prisma/migrations/app", name);
const contractJson = (contract: NonNullable<Awaited<ReturnType<typeof compileDatabaseSource>>["contract"]>) => postgresTarget.contractSerializer.serializeContract(contract as Parameters<typeof postgresTarget.contractSerializer.serializeContract>[0]);

test("history reads the actual graph, SQL and bookend semantic contracts without evaluating migration code", async () => {
  const root = await fixture();
  const marker = path.join(root, "migration-was-executed");
  await writeFile(path.join(migrationPath(root, "20260916T1757_add_projects"), "migration.ts"), `throw new Error(${JSON.stringify(marker)});`);
  const history = await readDatabaseHistory(root);
  assert.equal(history.migrations.length, 3);
  assert.equal(history.snapshots.length, 3);
  assert.equal(history.heads.length, 1);
  assert.equal(history.issues.length, 0);
  assert.equal(history.migrations[0]!.from, null);
  assert.equal(history.migrations[2]!.from, history.migrations[1]!.to);
  assert.equal(history.migrations[2]!.sourceVerification, "not-executed");
  assert.equal(history.migrations[2]!.integrity, "verified", "hash integrity attests emitted bytes, not TypeScript correspondence");
  assert(history.migrations[2]!.operations.some((entry) => entry.statements.some((statement) => statement.sql.includes("CREATE TABLE"))));
  assert(history.snapshots.every((snapshot) => snapshot.provenance === "semantic-contract" && snapshot.available));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("branches, invalid metadata, missing snapshots and modified operations are explicit evidence", async () => {
  const root = await fixture();
  const history = await readDatabaseHistory(root);
  const original = history.migrations[2]!;
  const branch = migrationPath(root, "20000101T0000_branch_created_earlier");
  await cp(migrationPath(root, original.name), branch, { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(branch, "migration.json"), "utf8"));
  metadata.createdAt = "2000-01-01T00:00:00.000Z";
  const operations = JSON.parse(await readFile(path.join(branch, "ops.json"), "utf8"));
  metadata.migrationHash = computeMigrationHash(metadata, operations);
  await writeFile(path.join(branch, "migration.json"), JSON.stringify(metadata));
  const invalid = migrationPath(root, "invalid_package");
  await mkdir(invalid);
  await writeFile(path.join(invalid, "migration.json"), "{ invalid metadata");
  await writeFile(path.join(migrationPath(root, original.name), "ops.json"), "[]");
  await rm(path.join(root, history.snapshots[0]!.path));
  const changed = await readDatabaseHistory(root);
  assert(changed.issues.some((entry) => entry.code === "branch"));
  assert(changed.issues.some((entry) => entry.code === "packageUnloadable"));
  assert(changed.issues.some((entry) => entry.code === "hashMismatch"));
  assert(changed.issues.some((entry) => entry.code === "snapshotUnavailable"));
  assert.equal(changed.migrations.find((entry) => entry.id === original.id)!.integrity, "modified");
  assert.notEqual(changed.revision, history.revision);
});

test("Prisma's hydrated differ reconstructs historical additions and destructive removals", async () => {
  const history = await readDatabaseHistory(repository);
  const initial = history.snapshots.find((snapshot) => snapshot.hash === history.migrations[0]!.to)!.contract;
  const afterDrop = history.snapshots.find((snapshot) => snapshot.hash === history.migrations[1]!.to)!.contract;
  const latest = history.snapshots.find((snapshot) => snapshot.hash === history.migrations[2]!.to)!.contract;
  const drop = compareDatabaseContracts(initial, afterDrop);
  assert(drop.storageChanged);
  assert(drop.changes.some((change) => change.kind === "removed" && change.entity.includes("profile_picture")));
  const addition = compareDatabaseContracts(afterDrop, latest);
  assert(addition.changes.some((change) => change.kind === "added" && change.entity === "public · projects"));
  const removal = compareDatabaseContracts(latest, null);
  assert(removal.changes.some((change) => change.kind === "removed" && change.entity === "public · projects"));
  assert.equal(compareDatabaseContracts(latest, latest).changes.length, 0);
});

test("real pinned Prisma distinguishes mapped logical renames, parameterized types, enums and composite keys", async () => {
  const source = `// use prisma-8\n// This comment is not a historical source reconstruction.\nenum Mood {\n  CALM\n  BUSY\n}\nmodel Entry {\n  tenant String\n  key String\n  title String @map("display_title")\n  mood Mood\n  moment TimestamptzString(3)\n  @@id([tenant, key])\n  @@map("entries")\n}\n`;
  const first = await compileDatabaseSource(repository, source);
  assert(first.validation.valid, JSON.stringify(first.validation.diagnostics));
  const renamed = await compileDatabaseSource(repository, source.replace("title String", "name String"));
  assert(renamed.validation.valid, JSON.stringify(renamed.validation.diagnostics));
  const rename = compareDatabaseContracts(contractJson(first.contract!), contractJson(renamed.contract!));
  assert.equal(rename.storageChanged, false);
  assert.equal(rename.domainChanged, true);
  const widened = await compileDatabaseSource(repository, source.replace("TimestamptzString(3)", "TimestamptzString(6)"));
  assert(widened.validation.valid, JSON.stringify(widened.validation.diagnostics));
  const precision = compareDatabaseContracts(contractJson(first.contract!), contractJson(widened.contract!));
  assert(precision.storageChanged, "parameterized native types must not collapse to the same base type");
  assert(precision.changes.some((change) => change.entity.includes("moment")));
});

test("an explicit graph origin is required; snapshots and folder dates never select it", async () => {
  const root = await fixture();
  const service = new DatabaseHistoryService(root);
  const history = await service.load();
  await assert.rejects(service.plan({ name: "add_test", from: "", expectedSourceHash: history.sourceHash, expectedHistoryRevision: history.revision }), /Select an explicit origin/);
  const orphanHash = "a".repeat(64);
  await assert.rejects(service.plan({ name: "add_test", from: orphanHash, expectedSourceHash: history.sourceHash, expectedHistoryRevision: history.revision }), /Select an explicit origin/);
  await assert.rejects(service.plan({ name: "add_test", from: history.heads[0]!, expectedSourceHash: "stale", expectedHistoryRevision: history.revision }), /changed/);
});

test("real pinned Prisma plans actual artifacts in an overlay; install is reviewed and hash guarded", async () => {
  const root = await fixture();
  const source = await readFile(path.join(root, CONTRACT_FILE), "utf8");
  const changed = source.replace("  name      String", "  summary   String?\n  name      String");
  assert.notEqual(changed, source, "fixture must add a real optional field");
  await writeFile(path.join(root, CONTRACT_FILE), changed);
  const service = new DatabaseHistoryService(root);
  const history = await service.load();
  const review = await service.plan({ name: "add_summary", from: history.heads[0]!, expectedSourceHash: history.sourceHash, expectedHistoryRevision: history.revision });
  assert.equal(review.noOp, false);
  assert(review.artifacts.some((entry) => entry.path.endsWith("migration.ts")));
  assert(review.artifacts.some((entry) => entry.path.endsWith("ops.json")));
  assert(review.operations.some((entry) => entry.statements.some((statement) => statement.sql.includes('"summary"'))));
  assert.equal((await service.load()).revision, history.revision, "planning must not install artifacts");
  assert.deepEqual(review.effects, { source: "unchanged", migrations: "review-only", database: "not-contacted" });
  const installed = await service.install({ reviewId: review.id });
  assert.equal(installed.status, "installed");
  assert.equal(installed.written.length, review.artifacts.length);
  assert.equal(await readFile(path.join(root, CONTRACT_FILE), "utf8"), changed);
  for (const artifact of review.artifacts) assert.equal(await readFile(path.join(root, artifact.path), "utf8"), artifact.contents);
  await assert.rejects(service.install({ reviewId: review.id }), /expired or was discarded/);
});

test("planning copies transitive authored config helpers and expires review when a helper changes", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "packages/database/settings"));
  await writeFile(path.join(root, "packages/database/settings/indent.ts"), "export const indent = 2;\n");
  await writeFile(path.join(root, "packages/database/settings/index.ts"), 'export { indent } from "./indent.js";\n');
  await writeFile(path.join(root, "packages/database/prisma.config.ts"), `import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";
import { indent } from "./settings/index.js";
export default definePrismaConfig({orm:{...defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}}),formatter:{indent}}});
`);
  const service = new DatabaseHistoryService(root);
  const history = await service.load();
  const review = await service.plan({ name: "imported_config", from: history.heads[0]!, expectedSourceHash: history.sourceHash, expectedHistoryRevision: history.revision });
  assert.equal(review.noOp, true);
  await writeFile(path.join(root, "packages/database/settings/indent.ts"), "export const indent = 4;\n");
  assert.notEqual((await service.load()).revision, history.revision);
  await assert.rejects(service.install({ reviewId: review.id }), /changed after review/);
});

test("external source changes preserve the draft and refuse a reviewed artifact install", async () => {
  const root = await fixture();
  const service = new DatabaseHistoryService(root);
  const history = await service.load();
  const review = await service.plan({ name: "source_conflict", from: history.heads[0]!, expectedSourceHash: history.sourceHash, expectedHistoryRevision: history.revision });
  const file = path.join(root, CONTRACT_FILE);
  await writeFile(file, `${await readFile(file, "utf8")}\n// External editor\n`);
  await assert.rejects(service.install({ reviewId: review.id }), /changed after review/);
  assert.equal((await service.load()).revision, history.revision);
});

test("history comparison labels execution-only changes without claiming storage SQL is required", async () => {
  const service = new DatabaseHistoryService(repository);
  const history = await service.load();
  const comparison = await service.compare({ from: history.heads[0]!, to: "saved" });
  assert.equal(comparison.storageChanged, false);
  assert.equal(comparison.executionChanged, true);
  assert(comparison.limitations.some((limit) => limit.includes("not the original authored Prisma text")));
});

test("required-field plans expose actual unfilled transformations without inventing executable operations", async () => {
  const root = await fixture();
  const file = path.join(root, CONTRACT_FILE);
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace("  name      String", "  required  String\n  name      String"));
  const service = new DatabaseHistoryService(root);
  const history = await service.load();
  const review = await service.plan({ name: "required_field", from: history.heads[0]!, expectedSourceHash: history.sourceHash, expectedHistoryRevision: history.revision });
  assert(review.pendingPlaceholders);
  assert(review.warnings.some((warning) => warning.includes("operation list is incomplete")));
  assert(review.artifacts.some((artifact) => artifact.path.endsWith("migration.ts") && artifact.contents.includes("placeholder(")));
  assert.equal(review.artifacts.find((artifact) => artifact.path.endsWith("ops.json"))!.contents.trim(), "[]", "pending Prisma source is shown honestly instead of invented SQL");
  assert.equal((await service.load()).revision, history.revision);
  service.discard(review.id);
  await assert.rejects(service.install({ reviewId: review.id }), /discarded/);
});

test("malformed API bodies produce actionable failures before any read or write", async () => {
  const service = new DatabaseHistoryService("/does-not-exist");
  await assert.rejects(service.plan(undefined as never), /Choose a migration name/);
  await assert.rejects(service.compare(null as never), /Choose both/);
  await assert.rejects(service.install({} as never), /Select an existing migration review/);
});

test("semantic comparison includes enum membership and relationship action changes", async () => {
  const source = `// use prisma-8\nenum Mood {\n  CALM\n  BUSY\n}\nmodel Owner {\n  id String @id\n}\nmodel Entry {\n  id String @id\n  ownerId String\n  owner Owner @relation(fields: [ownerId], references: [id], onDelete: Restrict)\n  mood Mood\n}\n`;
  const before = await compileDatabaseSource(repository, source);
  const after = await compileDatabaseSource(repository, source.replace("  BUSY", "  BUSY\n  HAPPY").replace("onDelete: Restrict", "onDelete: Cascade"));
  assert(before.validation.valid && after.validation.valid, JSON.stringify([before.validation.diagnostics, after.validation.diagnostics]));
  const changes = compareDatabaseContracts(contractJson(before.contract!), contractJson(after.contract!));
  assert(changes.storageChanged);
  assert(changes.changes.some((change) => change.plane === "domain" && change.entity.includes("Mood.members")));
  assert(changes.changes.some((change) => change.plane === "storage" && change.entity.includes("foreign-key")));
});
