import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ok, notOk } from "@prisma/orm-framework/utils/result";
import { canonicalApplicationPath, DatabaseApplicationService, guardReviewedMigrationExecution } from "../server/database-application";
import { hasMigrations } from "@prisma/orm-framework/components/control";
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
  assert.equal(during.runs(), 1);
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
