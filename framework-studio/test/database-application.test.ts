import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ok, notOk } from "@prisma/orm-framework/utils/result";
import { canonicalApplicationPath, databaseFailure, DatabaseApplicationService, guardReviewedMigrationExecution } from "../server/database-application";
import { DatabaseOperationStore } from "../server/database-operations";
import { createControlStack, hasMigrations } from "@prisma/orm-framework/components/control";
import { compileDatabaseSource, DatabaseWorkbenchService, resolvePrivateDatabaseTargets } from "../server/database-workbench";
import { DatabaseHistoryService } from "../server/database-history";
import type { DatabaseObservation } from "../shared/database-workbench";
import { sha256 } from "../server/files";

const repo = path.resolve(__dirname, "../..");
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(repo, ".cache/framework-studio/application-test-")); fixtures.push(root);
  mkdirSync(path.join(root, "packages/database"), { recursive: true });
  cpSync(path.join(repo, "packages/database/prisma"), path.join(root, "packages/database/prisma"), { recursive: true });
  writeFileSync(path.join(root, "packages/database/prisma.config.ts"), `import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";
export default definePrismaConfig({orm:defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}})});
`);
  writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=5432\n");
  writeFileSync(path.join(root, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: fixture-user
      POSTGRES_PASSWORD: fixture-password-never-output
      POSTGRES_DB: fixture
    ports: ['127.0.0.1:\${POSTGRES_HOST_PORT}:5432']
`);
  const source = readFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "utf8");
  return { root, source, sourceHash: sha256(source) };
}

test("real pinned canonical application path loads packages, snapshots and selects pending edges without running migration code", async () => {
  const { root, source } = fixture();
  const compiled = await compileDatabaseSource(root, source);
  const { createFixtureControlClient } = await import("@prisma/orm-toolchain/cli/control-api/testing");
  const markerHash = "8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47";
  const marker = { storageHash: markerHash, profileHash: "fixture-profile", contractJson: null, canonicalVersion: null, updatedAt: new Date(), appTag: null, meta: {}, invariants: [] };
  const clients: ReturnType<typeof createFixtureControlClient>[] = [];
  const planned = await canonicalApplicationPath(root, compiled.config, compiled.contract!, "postgresql://fixture-is-never-connected", () => { const client = createFixtureControlClient({ readAllMarkers: new Map([["app", marker]]) }); clients.push(client); return client; });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.dirName, "20260916T1757_add_projects");
  assert.equal(planned[0]?.from, markerHash);
  assert.equal(planned[0]?.to, compiled.validation.storageHash);
  assert.ok(clients.flatMap(client => client.calls).every(call => !["migrate", "dbUpdate", "dbInit", "sign"].includes(call.operation)));
  assert.equal(readFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "utf8"), source);
});

test("target and unknown-review application refusals never inspect or execute", async () => {
  const { root, sourceHash } = fixture();
  let inspected = 0;
  const service = new DatabaseApplicationService(root, { async inspect() { inspected++; throw new Error("Must not inspect"); } }, async () => { throw new Error("Must not load"); });
  await assert.rejects(service.review("production", sourceHash), /only for.*local/);
  await assert.rejects(service.apply("unknown", "Local PostgreSQL"), /expired/);
  assert.equal(inspected, 0);
});

async function applicationHarness() {
  const context = fixture();
  const historyService = new DatabaseHistoryService(context.root);
  const history = await historyService.load();
  const selectedMigration = history.migrations.find(item => item.name === "20260916T1757_add_projects")!;
  const target = resolvePrivateDatabaseTargets(context.root)[0]!.public;
  let inspectStatus: DatabaseObservation["status"] = "observed";
  let runCount = 0;
  let failRun = false, connectFailure = false, followUpFailure = false;
  const inspected: DatabaseObservation = { id: "inspection-fixture", targetId: "local:postgres", targetIdentity: target.identity, observedAt: new Date().toISOString(), savedRevision: context.sourceHash, historyRevision: history.revision, baseline: { label: "Saved source", storageHash: selectedMigration.to }, status: "observed", marker: { status: "differs", storageHash: selectedMigration.from! }, physical: { status: "differs", issues: [], warnings: [] }, historicalPhysical: { storageHash: selectedMigration.from!, status: "matches", issues: [], warnings: [] }, migrationState: { status: "pending", message: "fixture" }, ledger: [], message: "fixture", limits: [] };
  const { createFixtureControlClient } = await import("@prisma/orm-toolchain/cli/control-api/testing");
  const service = new DatabaseApplicationService(context.root, { async inspect() { if (followUpFailure && runCount) throw new Error("inspection failed"); return { ...inspected, status: inspectStatus }; } }, () => historyService.load(), {
    async path() { return [{ spaceId: "app", dirName: selectedMigration.name, migrationHash: selectedMigration.migrationHash, from: selectedMigration.from!, to: selectedMigration.to }]; },
    createWriteClient(_config, connection) {
      assert.ok(!new URL(connection).searchParams.get("options")!.includes("default_transaction_read_only"));
      const client = createFixtureControlClient();
      return { ...client, async connect() { if (connectFailure) throw new Error("fixture-password-never-output"); }, async close() {}, async migrate() { runCount++; return failRun ? notOk({ code: "RUNNER_FAILED" as const, summary: "fixture failure", why: undefined, meta: undefined }) : ok({ migrationsApplied: 1, markerHash: selectedMigration.to, applied: [{ spaceId: "app", dirName: selectedMigration.name, migrationHash: selectedMigration.migrationHash, from: selectedMigration.from!, to: selectedMigration.to, operationsExecuted: 1 }], summary: "fixture applied", perSpace: [] }); } };
    },
  });
  return { ...context, service, selectedMigration, history, setInspectStatus(value: typeof inspectStatus) { inspectStatus = value; }, setRunFailure() { failRun = true; }, setConnectFailure() { connectFailure = true; }, setFollowUpFailure() { followUpFailure = true; }, runs: () => runCount };
}

test("typed target approval and exact migration source bytes gate execution", async () => {
  const harness = await applicationHarness();
  const review = await harness.service.review("local:postgres", harness.sourceHash);
  assert.equal(review.confirmation, "Local PostgreSQL");
  assert.ok(review.migrations[0]?.source.includes("Migration"));
  assert.ok(review.migrations[0]?.operations.length);
  await assert.rejects(harness.service.apply(review.id, "yes"), /Type Local PostgreSQL/);
  assert.equal(harness.runs(), 0);
  const migration = path.join(harness.root, harness.selectedMigration.sourcePath);
  writeFileSync(migration, readFileSync(migration, "utf8") + "\n// External source modification after review.\n");
  await assert.rejects(harness.service.apply(review.id, "Local PostgreSQL"), /changed|incomplete|effects/);
  assert.equal(harness.runs(), 0);
});

test("reviewed database effect remains applied when follow-up inspection fails, and review is single-use", async () => {
  const harness = await applicationHarness();
  const review = await harness.service.review("local:postgres", harness.sourceHash);
  harness.setFollowUpFailure();
  const result = await harness.service.apply(review.id, "Local PostgreSQL");
  assert.equal(result.status, "applied");
  assert.equal(result.database, "applied");
  assert.equal(result.source, "unchanged");
  assert.equal(result.artifacts, "unchanged");
  assert.equal(result.observation, undefined);
  assert.match(result.message, /follow-up inspection is unavailable/);
  assert.equal(harness.runs(), 1);
  await assert.rejects(harness.service.apply(review.id, "Local PostgreSQL"), /expired/);
});

test("pre-execution failure is unchanged, while runner failure is unconfirmed with secrets omitted", async () => {
  const before = await applicationHarness();
  const review = await before.service.review("local:postgres", before.sourceHash);
  before.setConnectFailure();
  const failed = await before.service.apply(review.id, "Local PostgreSQL");
  assert.equal(failed.database, "unchanged");
  assert.equal(before.runs(), 0);
  assert.ok(!JSON.stringify(failed).includes("fixture-password-never-output"));
  const during = await applicationHarness();
  const runnerReview = await during.service.review("local:postgres", during.sourceHash);
  during.setRunFailure();
  const unconfirmed = await during.service.apply(runnerReview.id, "Local PostgreSQL");
  assert.equal(unconfirmed.database, "unconfirmed");
  assert.equal(unconfirmed.status, "unconfirmed");
  assert.equal(unconfirmed.diagnostic?.code, "RUNNER_FAILED");
  assert.equal(unconfirmed.stage, "executing");
  assert.equal(during.service.listOperations()[0]?.result?.diagnostic?.code, "RUNNER_FAILED");
  assert.equal(during.runs(), 1);
});

test("empty initialization previews SQL, rejects changed emptiness and requires its own typed approval", async () => {
  const context = fixture();
  const historyService = new DatabaseHistoryService(context.root);
  let empty = true, executions = 0;
  const { createFixtureControlClient } = await import("@prisma/orm-toolchain/cli/control-api/testing");
  const initialization = { mode: "plan" as const, plan: { operations: [{ id: "create-table", label: "Create entries", operationClass: "additive" }], preview: { statements: [{ language: "sql", text: "CREATE TABLE entries (id uuid PRIMARY KEY)" }] } }, destination: { storageHash: "fixture" }, summary: "fixture" };
  const service = new DatabaseApplicationService(context.root, { async inspect() { return { status: "observed", marker: { status: "missing" }, migrationState: { status: "unknown" } } as DatabaseObservation; } }, () => historyService.load(), {
    async empty() { return empty; },
    createReadClient(config) { const client = createFixtureControlClient(); return Object.assign(client, { async readAllMarkers() { return new Map(); }, async readLedger() { return []; }, async dbInit() {
      const target = config.target; assert.ok(hasMigrations(target));
      const runner = target.migrations.createRunner(config.family.create(createControlStack(config)));
      await runner.execute({ driver: {} as never, perSpaceOptions: [{ space: "app", destinationContract: {}, plan: { operations: [{ ...initialization.plan.operations[0], precheck: [], execute: [{ sql: initialization.plan.preview.statements[0]!.text, params: [] }], postcheck: [] }] }, migrationEdges: [] }] } as never);
      return ok(initialization);
    } }); },
    createWriteClient() { const client = createFixtureControlClient(); return Object.assign(client, { async dbInit() { executions++; return ok({ ...initialization, mode: "apply" }); } }); },
  });
  const review = await service.review("local:postgres", context.sourceHash, true);
  assert.equal(review.kind, "initialize");
  assert.equal(review.confirmation, "Initialize Local PostgreSQL");
  assert.match(review.initialization!.sql[0]!, /CREATE TABLE/);
  await assert.rejects(service.apply(review.id, "Local PostgreSQL"), /Type Initialize/);
  empty = false;
  await assert.rejects(service.apply(review.id, review.confirmation), /requires an empty/);
  assert.equal(executions, 0);
  empty = true;
  const fresh = await service.review("local:postgres", context.sourceHash, true);
  const result = await service.apply(fresh.id, fresh.confirmation);
  assert.equal(result.status, "applied");
  assert.equal(executions, 1);
  assert.equal(new DatabaseOperationStore(context.root).list()[0]?.status, "applied");
});

test("interrupted database records survive restart without resuming writes and diagnostics contain only safe codes", () => {
  const { root } = fixture();
  const store = new DatabaseOperationStore(root);
  store.write({ id: "abc-123", kind: "migrate", targetLabel: "Local PostgreSQL", targetIdentity: "private-digest", sourceHash: "source", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running", stage: "executing", migrations: ["add_entries"] });
  const recovered = new DatabaseOperationStore(root).list()[0]!;
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.stage, "interrupted");
  assert.deepEqual(databaseFailure({ code: "23505", message: "postgresql://private:password@host/database", meta: { private: "secret" } }).sqlState, "23505");
  assert.ok(!JSON.stringify(databaseFailure({ code: "unsafe-password-in-code", message: "secret" })).includes("secret"));
});

test("actual native runner boundary refuses a different path selected after the earlier database review", async () => {
  const harness = await applicationHarness();
  const review = await harness.service.review("local:postgres", harness.sourceHash);
  const compiled = await compileDatabaseSource(harness.root, harness.source);
  const target = compiled.config.target;
  assert.ok(hasMigrations(target));
  let executions = 0, inputsCurrent = true;
  const fakeTarget = { ...target, migrations: { ...target.migrations, createRunner() { return { async execute() { executions++; return ok({ perSpaceResults: [] }); } }; } } };
  const guarded = guardReviewedMigrationExecution({ ...compiled.config, target: fakeTarget }, review, () => { if (!inputsCurrent) throw new Error("Changed source bytes"); });
  assert.ok(hasMigrations(guarded.target));
  const runner = guarded.target.migrations.createRunner({} as never);
  const edge = review.migrations[0]!;
  const options = { driver: {} as never, perSpaceOptions: [{ space: "app", plan: {} as never, driver: {} as never, destinationContract: {}, policy: { allowedOperationClasses: [] }, frameworkComponents: [], migrationEdges: [{ migrationHash: edge.migrationHash, dirName: edge.name, from: edge.from, to: edge.to, operationCount: 1 }] }] };
  const changed = { ...options, perSpaceOptions: options.perSpaceOptions.map(space => ({ ...space, migrationEdges: space.migrationEdges.map(item => ({ ...item, from: "a-different-live-marker" })) })) };
  await assert.rejects(runner.execute(changed), /different migration path/);
  assert.equal(executions, 0);
  inputsCurrent = false;
  await assert.rejects(runner.execute(options), /Changed source bytes/);
  assert.equal(executions, 0);
  inputsCurrent = true;
  await runner.execute(options);
  assert.equal(executions, 1);
});

test("journal keeps unresolved outcomes visible beyond newer inspections and old lock releases preserve replacement owners", () => {
  const { root } = fixture(); const store = new DatabaseOperationStore(root);
  const unresolved = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", kind: "migrate" as const, targetLabel: "Local PostgreSQL", targetIdentity: "target", sourceHash: "source", startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", status: "unconfirmed" as const, stage: "executing" as const, migrations: [] };
  store.write(unresolved);
  for (let index = 0; index < 55; index++) store.write({ ...unresolved, id: `${index.toString(16).padStart(8, "0")}-bbbb-bbbb-bbbb-bbbbbbbbbbbb`, startedAt: "2026-10-22T00:00:00Z", status: "reviewed", stage: "complete" });
  assert.ok(store.list().some(record => record.id === unresolved.id));
  const release = store.lock(); assert.ok(release); const file = path.join(root, ".cache/framework-studio/database-operations/active.lock");
  const replacement = JSON.stringify({ pid: process.pid, token: "new-owner" }); writeFileSync(file, replacement);
  release(); assert.equal(readFileSync(file, "utf8"), replacement); assert.equal(store.lock(), undefined);
});

test("a local application review refuses changed imported migration helper bytes", async () => {
  const harness = await applicationHarness();
  const helper = path.join(harness.root, "packages/database/migration-helper.ts"); writeFileSync(helper, "export const statement = 'SELECT 1';");
  const migration = path.join(harness.root, harness.selectedMigration.sourcePath);
  writeFileSync(migration, `import {statement} from '../../../../migration-helper';\n${readFileSync(migration, "utf8")}`);
  const reviewed = await harness.service.review("local:postgres", harness.sourceHash);
  writeFileSync(helper, "export const statement = 'DROP TABLE app';");
  await assert.rejects(harness.service.apply(reviewed.id, reviewed.confirmation), /changed|effects|incomplete/);
  assert.equal(harness.runs(), 0);
});
