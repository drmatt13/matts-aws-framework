import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { DatabaseApplicationService } from "../server/database-application";
import { DatabaseHistoryService } from "../server/database-history";
import { DatabaseSqlService } from "../server/database-sql";
import { DatabaseWorkbenchService, resolvePrivateDatabaseTargets } from "../server/database-workbench";
import type { SavedSqlCommand } from "../shared/database-sql";

/** Real Docker and PostgreSQL only. Never opens the ordinary project's database.
 * The opt-in creates and removes only a random, independently labeled Compose project. */
test("disposable Compose: reviewed initialization/migration, SQL failures, retained volume and recovery", { skip: process.env.STUDIO_DATABASE_LIVE !== "job3-disposable", timeout: 120_000 }, async t => {
  // These inherited controls can redirect target resolution, history, or
  // Compose away from this invocation's owned fixture. Refuse before setup.
  for (const name of ["POSTGRES_HOST_PORT", "FRAMEWORK_STUDIO_STATE_DIRECTORY", "COMPOSE_FILE"]) {
    assert.equal(process.env[name], undefined, `Unset ${name} before this disposable live test; inherited overrides must not redirect its database, history, or Compose project.`);
  }
  const repository = path.resolve(__dirname, "../..");
  const directory = path.join(repository, ".cache/framework-studio"); mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(path.join(directory, "database-live-"));
  const project = `matts-job3-db-${randomUUID().slice(0, 8)}`, ownership = "com.matts-aws-framework.job3";
  const volume = `${project}_campaign_data`;
  const evidence: Record<string, unknown>[] = [];
  function docker(args: string[], optional = false) {
    const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", timeout: 45_000 });
    if (!optional) assert.equal(result.status, 0, result.stderr);
    return result;
  }
  function compose(...args: string[]) { return docker(["compose", "--project-name", project, ...args]).stdout.trim(); }
  const source = '// use prisma-8\nmodel DemoItem {\n  label String @id(map: "demo_items_pkey")\n  @@map("demo_items")\n}\n';
  mkdirSync(path.join(root, "packages/database/prisma"), { recursive: true });
  symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(root, "packages/database/package.json"), '{"private":true}');
  writeFileSync(path.join(root, "packages/database/prisma.config.ts"), 'import {definePrismaConfig} from "@prisma/cli-engine";\nimport {defineConfig} from "@prisma/orm-postgres/config";\nexport default definePrismaConfig({orm:defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}})});\n');
  writeFileSync(path.join(root, "packages/database/prisma/contract.prisma"), source);
  writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=0\n");
  writeFileSync(path.join(root, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: campaign
      POSTGRES_PASSWORD: campaign-disposable
      POSTGRES_DB: campaign
    ports: ['127.0.0.1:\${POSTGRES_HOST_PORT}:5432']
    volumes: ['campaign_data:/var/lib/postgresql/data']
    labels: {'${ownership}': '${project}'}
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U campaign -d campaign']
      interval: 1s
      retries: 30
volumes:
  campaign_data:
    labels: {'${ownership}': '${project}'}
`);
  const workbench = new DatabaseWorkbenchService(root), history = new DatabaseHistoryService(root);
  const application = new DatabaseApplicationService(root, workbench, () => history.load());
  let sql = new DatabaseSqlService(root);
  const save = (command: SavedSqlCommand) => sql.saveSource(sql.reviewSource(command, null).id);
  const execute = (saved: ReturnType<typeof save>, values: readonly unknown[] = []) => { const review = sql.reviewExecution(saved.path, saved.revision, "local:postgres", values); return sql.execute(review.id, review.confirmation); };
  const seed: SavedSqlCommand = { name: "retained_seed", kind: "seed", intent: "repeatable", description: "Owned live-test records", parameters: ["label"], sql: "INSERT INTO demo_items(label) VALUES ($1) ON CONFLICT (label) DO NOTHING RETURNING label" };
  async function query(text: string, values?: unknown[]) {
    const connection = new URL(resolvePrivateDatabaseTargets(root)[0]!.connection!); connection.searchParams.delete("options");
    const client = new pg.Client({ connectionString: connection.toString() });
    try { await client.connect(); return await client.query(text, values); } finally { await client.end(); }
  }
  try {
    compose("up", "-d", "--wait");
    const binding = compose("port", "postgres", "5432"); assert.match(binding, /^127\.0\.0\.1:\d+$/);
    writeFileSync(path.join(root, ".env"), `POSTGRES_HOST_PORT=${binding.split(":")[1]}\n`);
    assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume]).stdout.trim(), project);
    evidence.push({ project, volume, binding });
    let savedSource = await workbench.load();
    await t.test("changed empty target refuses initialization; fresh native review initializes", async () => {
      const review = await application.review("local:postgres", savedSource.revision, true);
      assert.ok(review.initialization?.sql.some(statement => statement.includes("CREATE TABLE")));
      await assert.rejects(application.apply(review.id, "Local PostgreSQL"), /Type Initialize/);
      await query("CREATE VIEW occupied AS SELECT 1 AS value");
      await assert.rejects(application.apply(review.id, review.confirmation), /empty database|contains objects/);
      await query("DROP VIEW occupied");
      const fresh = await application.review("local:postgres", savedSource.revision, true);
      const result = await application.apply(fresh.id, fresh.confirmation);
      assert.equal(result.status, "applied"); assert.equal(result.observation?.migrationState.status, "current");
      await assert.rejects(application.apply(fresh.id, fresh.confirmation), /expired/);
      evidence.push({ initialization: result.status, physical: result.observation?.physical.status });
    });
    const savedSeed = save(seed), once = save({ ...seed, name: "retained_once", intent: "once" });
    const retained = "retained bound value ' ; DROP TABLE demo_items; --";
    await t.test("bound SQL, repeatable idempotence, once ledger and actual constraint rollback", async () => {
      const first = await execute(savedSeed, [retained]), rerun = await execute(savedSeed, [retained]);
      assert.equal(first.status, "committed"); assert.equal(first.rowCount, 1); assert.equal(rerun.rowCount, 0);
      assert.equal((await execute(once, ["once-retained"])).status, "committed"); assert.equal((await execute(once, ["once-retained"])).status, "skipped");
      const duplicate = save({ ...seed, name: "duplicate", sql: "INSERT INTO demo_items(label) VALUES ($1)" });
      const failure = await execute(duplicate, [retained]); assert.equal(failure.status, "failed"); assert.equal(failure.database, "unchanged"); assert.equal(failure.sqlState, "23505");
      assert.equal((await query("SELECT count(*)::int AS count FROM demo_items")).rows[0]?.count, 2);
      evidence.push({ seed: first.status, rerun: rerun.rowCount, rollbackSqlstate: failure.sqlState });
    });
    await t.test("real read-only session rejects sequence mutation and retains its value", async () => {
      await query("CREATE SEQUENCE framework_studio.readonly_probe");
      const inspection = save({ ...seed, name: "readonly_probe", kind: "inspection", parameters: [], sql: "SELECT nextval('framework_studio.readonly_probe')" });
      const denied = await execute(inspection); assert.equal(denied.status, "failed"); assert.equal(denied.sqlState, "25006");
      assert.equal((await query("SELECT is_called FROM framework_studio.readonly_probe")).rows[0]?.is_called, false);
      await query("DROP SEQUENCE framework_studio.readonly_probe");
      evidence.push({ readOnlyDeniedSqlstate: denied.sqlState });
    });
    await t.test("saved bytes and target identity changes invalidate SQL review without effects", async () => {
      const review = sql.reviewExecution(savedSeed.path, savedSeed.revision, "local:postgres", ["must-not-write"]);
      const file = path.join(root, savedSeed.path), bytes = readFileSync(file, "utf8"); writeFileSync(file, bytes + "-- external edit\n");
      await assert.rejects(sql.execute(review.id, review.confirmation), /source or private database target changed/); writeFileSync(file, bytes);
      const targetReview = sql.reviewExecution(savedSeed.path, savedSeed.revision, "local:postgres", ["must-not-write"]);
      const env = readFileSync(path.join(root, ".env"), "utf8"); writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=1\n");
      await assert.rejects(sql.execute(targetReview.id, targetReview.confirmation), /source or private database target changed/); writeFileSync(path.join(root, ".env"), env);
      assert.equal((await query("SELECT count(*)::int AS count FROM demo_items")).rows[0]?.count, 2);
    });
    await t.test("retained credentials reject a mismatched Compose password without exposing it", async () => {
      const file = path.join(root, "docker-compose.yml"), bytes = readFileSync(file, "utf8");
      const rejectedPassword = "job3-incorrect-password-never-return";
      writeFileSync(file, bytes.replace("POSTGRES_PASSWORD: campaign-disposable", `POSTGRES_PASSWORD: ${rejectedPassword}`));
      try {
        const failed = await execute(savedSeed, ["authentication-must-not-write"]);
        assert.equal(failed.status, "failed"); assert.equal(failed.database, "unchanged"); assert.equal(failed.sqlState, "28P01");
        assert.ok(!JSON.stringify(failed).includes(rejectedPassword)); assert.ok(!JSON.stringify(sql.load().history).includes(rejectedPassword));
        evidence.push({ wrongRetainedCredentialsSqlstate: failed.sqlState, database: failed.database });
      } finally { writeFileSync(file, bytes); }
      assert.equal((await query("SELECT count(*)::int AS count FROM demo_items")).rows[0]?.count, 2);
    });
    await t.test("native offline plan, drift refusal, stale package refusal and real forward migration", async () => {
      let h = await history.load();
      const baseline = await history.plan({ name: "baseline", from: "empty", expectedSourceHash: savedSource.revision, expectedHistoryRevision: h.revision });
      assert.equal((await history.install({ reviewId: baseline.id })).status, "installed");
      const change = await workbench.review(source.replace("  label String", "  description String?\n  label String"), savedSource.revision); await workbench.save(change.reviewId);
      savedSource = await workbench.load(); h = await history.load();
      const forward = await history.plan({ name: "add_description", from: baseline.to, expectedSourceHash: savedSource.revision, expectedHistoryRevision: h.revision });
      assert.equal((await history.install({ reviewId: forward.id })).status, "installed");
      await query("ALTER TABLE demo_items ADD COLUMN unexpected text");
      h = await history.load(); const drift = await workbench.inspect("local:postgres", savedSource.revision, h.revision, h); assert.equal(drift.migrationState.status, "divergent");
      await assert.rejects(application.review("local:postgres", savedSource.revision), /known marker|physical schema/);
      await query("ALTER TABLE demo_items DROP COLUMN unexpected");
      const review = await application.review("local:postgres", savedSource.revision);
      const migration = h.migrations.find(item => item.to === forward.to)!, file = path.join(root, migration.sourcePath), bytes = readFileSync(file, "utf8");
      writeFileSync(file, bytes + "\n// changed after review\n"); await assert.rejects(application.apply(review.id, review.confirmation), /changed|incomplete/); writeFileSync(file, bytes);
      const fresh = await application.review("local:postgres", savedSource.revision), result = await application.apply(fresh.id, fresh.confirmation);
      assert.equal(result.status, "applied"); assert.equal(result.applied.length, 1); assert.equal(result.observation?.migrationState.status, "current");
      assert.equal((await query("SELECT count(*)::int AS count FROM demo_items WHERE description IS NULL")).rows[0]?.count, 2);
      evidence.push({ drift: drift.migrationState.status, migration: result.status, packages: result.applied.length });
    });
    await t.test("unavailable database is explicit; restart preserves data and durable SQL history", async () => {
      compose("stop", "--timeout", "2", "postgres");
      const unavailable = await workbench.inspect("local:postgres", savedSource.revision); assert.equal(unavailable.status, "unreachable"); assert.match(unavailable.message, /selected Compose project's PostgreSQL/);
      const failed = await execute(savedSeed, ["unavailable-must-not-write"]); assert.equal(failed.status, "failed"); assert.equal(failed.database, "unchanged");
      compose("up", "-d", "--wait"); sql = new DatabaseSqlService(root);
      assert.ok(sql.load().history.some(record => record.sqlState === "23505")); assert.ok(!JSON.stringify(sql.load().history).includes(retained));
      assert.equal((await query("SELECT count(*)::int AS count FROM demo_items")).rows[0]?.count, 2);
      evidence.push({ unavailable: unavailable.status, sqlWhileStopped: failed.status, rowsAfterRestart: 2 });
    });
    await t.test("container removal retains original volume, rows, marker and once ledger on fresh compute", async () => {
      const before = compose("ps", "-q", "postgres"); compose("stop", "--timeout", "2", "postgres");
      assert.equal(docker(["inspect", "--format", `{{index .Config.Labels "${ownership}"}}`, before]).stdout.trim(), project);
      docker(["rm", before]);
      assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume]).stdout.trim(), project);
      compose("up", "-d", "--wait"); assert.notEqual(compose("ps", "-q", "postgres"), before);
      sql = new DatabaseSqlService(root); assert.equal((await execute(once, ["once-retained"])).status, "skipped");
      const observation = await new DatabaseWorkbenchService(root).inspect("local:postgres", savedSource.revision); assert.equal(observation.migrationState.status, "current");
      assert.equal((await query("SELECT count(*)::int AS count FROM demo_items")).rows[0]?.count, 2);
      evidence.push({ reusedVolume: volume, freshContainer: true, physical: observation.physical.status, onceLedger: "skipped", retainedRows: 2 });
    });
  } finally {
    // Cleanup requires both the random project identity and independent ownership label.
    const owned = docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume], true);
    if (owned.status === 0 && owned.stdout.trim() === project) {
      compose("down"); assert.equal(docker(["ps", "-aq", "--filter", `label=${ownership}=${project}`]).stdout.trim(), "");
      docker(["volume", "rm", volume]); assert.notEqual(docker(["volume", "inspect", volume], true).status, 0);
      evidence.push({ cleanup: "container/network removed; owned volume removed and absence verified" });
    }
    console.log(JSON.stringify({ databaseLiveEvidence: evidence }));
    rmSync(root, { recursive: true, force: true });
  }
});
