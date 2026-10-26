import assert from "./support/assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSqlService } from "../server/database-sql";
import { compileDatabaseSource, resolvePrivateDatabaseTargets } from "../server/database-workbench";
import type { SavedSqlCommand } from "../shared/database-sql";

/** Opt-in only: the campaign's owned container, never a developer's ordinary DB.
 * Setup creates demo_items separately; Studio SQL does not replace migrations. */
test("real disposable PostgreSQL: seed rerun, once ledger, query and constraint rollback", { skip: process.env.STUDIO_SQL_LIVE !== "campaign-sql-20261023" }, async () => {
  const directory = path.resolve(__dirname, "../../.cache/framework-studio"); mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(path.join(directory, "sql-live-"));
  try {
    mkdirSync(path.join(root, "packages/database"), { recursive: true });
    writeFileSync(path.join(root, "packages/database/package.json"), '{"private":true}');
    mkdirSync(path.join(root, "packages/database/prisma"), { recursive: true });
    const source = `// use prisma-8
model DemoItem {
  label String @id(map: "demo_items_pkey")
  @@map("demo_items")
}
`;
    writeFileSync(path.join(root, "packages/database/prisma/contract.prisma"), source);
    writeFileSync(path.join(root, "packages/database/prisma.config.ts"), `import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";
export default definePrismaConfig({orm:defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}})});
`);
    writeFileSync(path.join(root, ".env"), "POSTGRES_HOST_PORT=15463\n");
    writeFileSync(path.join(root, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: campaign
      POSTGRES_PASSWORD: campaign-disposable
      POSTGRES_DB: campaign
    ports: ['127.0.0.1:\${POSTGRES_HOST_PORT}:5432']
`);
    const service = new DatabaseSqlService(root);
    const seed: SavedSqlCommand = { name: "campaign_seed", kind: "seed", intent: "repeatable", description: "Disposable campaign data", parameters: ["label"], sql: "INSERT INTO demo_items(label) VALUES ($1) ON CONFLICT (label) DO NOTHING RETURNING label;" };
    const save = (command: SavedSqlCommand) => { const review = service.reviewSource(command, null); return service.saveSource(review.id); };
    const execute = (saved: ReturnType<typeof save>, values: readonly string[]) => { const review = service.reviewExecution(saved.path, saved.revision, "local:postgres", values); return service.execute(review.id, review.confirmation); };
    const label = `live-${path.basename(root)}`;
    const saved = save(seed), first = await execute(saved, [label]), second = await execute(saved, [label]);
    assert.equal(first.status, "committed"); assert.equal(first.rowCount, 1); assert.equal(second.status, "committed"); assert.equal(second.rowCount, 0);
    const inspection = save({ ...seed, name: "campaign_inspection", kind: "inspection", sql: "SELECT label FROM demo_items WHERE label=$1" });
    assert.deepEqual((await execute(inspection, [label])).rows, [{ label }]);
    const backfill = save({ ...seed, name: "campaign_once", kind: "backfill", intent: "once" });
    assert.equal((await execute(backfill, [`${label}-once`])).status, "committed"); assert.equal((await execute(backfill, [`${label}-once`])).status, "skipped");
    const failing = save({ ...seed, name: "campaign_duplicate", sql: "INSERT INTO demo_items(label) VALUES ($1)" });
    const failure = await execute(failing, [label]); assert.equal(failure.status, "failed"); assert.equal(failure.database, "unchanged"); assert.equal(failure.sqlState, "23505");
    const readonly = save({ ...seed, name: "campaign_readonly_write", kind: "inspection", sql: "WITH modified AS (DELETE FROM demo_items WHERE label=$1 RETURNING label) SELECT * FROM modified" });
    const denied = await execute(readonly, [label]); assert.equal(denied.status, "failed"); assert.equal(denied.database, "unchanged");
    assert.deepEqual((await execute(inspection, [label])).rows, [{ label }]);
    const history = new DatabaseSqlService(root).load().history;
    assert.equal(history.length, 8); assert.ok(history.some(record => record.status === "skipped")); assert.ok(history.some(record => record.sqlState === "23505")); assert.ok(!JSON.stringify(history).includes(label));
    // The operational ledger must not make later schema inspection/migrations
    // report drift in application-owned public tables or unknown namespaces.
    const compiled = await compileDatabaseSource(root, source);
    assert.ok(compiled.contract, "real Prisma source compiles");
    const { createPostgresControlClient } = await import("@prisma/orm-postgres/control");
    const client = createPostgresControlClient({ connection: resolvePrivateDatabaseTargets(root)[0]!.connection!, extensions: compiled.config.extensions });
    try { await client.connect(); const verified = await client.schemaVerify({ contract: compiled.contract!, strict: true }); assert.equal(verified.ok, true, JSON.stringify(verified.schema)); }
    finally { await client.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
