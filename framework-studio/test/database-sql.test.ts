import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSqlService, readSqlCommand, type SqlClient } from "../server/database-sql";
import type { SavedSqlCommand } from "../shared/database-sql";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const directory = path.resolve(__dirname, "../../.cache/framework-studio"); mkdirSync(directory, { recursive: true }); const root = mkdtempSync(path.join(directory, "sql-test-")); roots.push(root); return root; }
function command(overrides: Partial<SavedSqlCommand> = {}): SavedSqlCommand { return { name: "demo_seed", kind: "seed", intent: "repeatable", description: "Disposable test rows", parameters: ["label"], sql: "INSERT INTO demo_items(label) VALUES ($1) ON CONFLICT (label) DO NOTHING RETURNING label;", ...overrides }; }
function harness() {
  const root = fixture(), calls: { sql: string; values?: readonly unknown[]; extended?: boolean }[] = [];
  let connections = 0, targetIdentity = "target-a", fail: "constraint" | "commit" | "connect" | undefined, recorded = false;
  let receivedConnection = "";
  const service = new DatabaseSqlService(root, { targets: () => [{ public: { id: "local:postgres", label: "Isolated PostgreSQL", identity: targetIdentity, available: true, detail: "fixture" }, connection: "postgresql://fixture:private-dummy@127.0.0.1:5432/fixture?options=-c%20default_transaction_read_only=on" }], client(connection): SqlClient {
    connections++; receivedConnection = connection;
    return { async connect() { if (fail === "connect") throw new Error("private-dummy connection refused"); }, async end() {}, async query(query, values) {
      const sql = typeof query === "string" ? query : query.text; calls.push({ sql, values: typeof query === "string" ? values : query.values, extended: typeof query !== "string" });
      if (sql === "COMMIT" && fail === "commit") throw Object.assign(new Error("private-dummy connection lost"), { code: "ECONNRESET" });
      if (sql.startsWith("INSERT INTO demo_items") && fail === "constraint") throw Object.assign(new Error("private-dummy secret-row-value"), { code: "23505", detail: "private row details" });
      if (sql.startsWith("SELECT revision FROM")) return { rows: recorded ? [{ revision: "old" }] : [] };
      if (sql.startsWith("INSERT INTO framework_studio.sql_runs")) recorded = true;
      if (sql.startsWith("SELECT * FROM (")) return { rows: Array.from({ length: 101 }, (_, index) => ({ label: `row-${index}` })), rowCount: 101 };
      return { rows: sql.startsWith("INSERT INTO demo_items") ? [{ label: "transient-result-never-journaled" }] : [], rowCount: 1 };
    } };
  } });
  const save = (value = command()) => { const review = service.reviewSource(value, null); const saved = service.saveSource(review.id); return { review, saved }; };
  return { root, service, calls, save, get connections() { return connections; }, get receivedConnection() { return receivedConnection; }, fail(value: typeof fail) { fail = value; }, changeTarget() { targetIdentity = "target-b"; } };
}

test("SQL source proposal creates a real reusable file; saving and catalog discovery never connect", () => {
  const h = harness(), value = command(); const review = h.service.reviewSource(value, null);
  assert.equal(h.service.load().commands.length, 0);
  assert.equal(review.before, null); assert.match(review.after, /^-- framework-sql:/);
  const saved = h.service.saveSource(review.id), entry = h.service.load().commands[0]!;
  assert.equal(saved.saved, true); assert.equal(entry.path, "packages/database/sql/seed/demo_seed.sql");
  assert.deepEqual(entry.command, value); assert.match(readFileSync(path.join(h.root, entry.path), "utf8"), /ON CONFLICT/);
  assert.equal(h.connections, 0); assert.throws(() => h.service.saveSource(review.id), /expired/);
});
test("stale source review preserves hand edits and linked catalog paths are refused", () => {
  const h = harness(), { saved } = h.save();
  const edited = h.service.reviewSource(command({ description: "Proposed change" }), saved.revision);
  writeFileSync(path.join(h.root, saved.path), "External editor bytes\n");
  assert.throws(() => h.service.saveSource(edited.id), /source file changed/);
  assert.equal(readFileSync(path.join(h.root, saved.path), "utf8"), "External editor bytes\n");
  assert.equal(h.service.load().issues.length, 1);
  const linkRoot = fixture(), destination = fixture(); mkdirSync(path.join(linkRoot, "packages/database"), { recursive: true });
  symlinkSync(destination, path.join(linkRoot, "packages/database/sql"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new DatabaseSqlService(linkRoot).reviewSource(command(), null), /symbolic links/);
});
test("single statement and parameter checks keep migration/transaction controls separate", () => {
  for (const sql of ["COMMIT", "DROP TABLE users", "INSERT INTO demo_items VALUES ($1); DELETE FROM users", "SELECT 1; COMMIT", "/* open"]) assert.throws(() => readSqlCommand(command({ sql })), /one SELECT|Close/);
  assert.throws(() => readSqlCommand(command({ sql: "SELECT $2" })), /every declared parameter/);
  assert.throws(() => readSqlCommand(command({ kind: "inspection", sql: "DELETE FROM demo_items WHERE label=$1" })), /read-only/);
  assert.equal(readSqlCommand(command({ sql: "SELECT $1, ';COMMIT', $$;DROP TABLE users$$ /* ; BEGIN */;" })).parameters[0], "label");
  assert.throws(() => readSqlCommand(command({ sql: "SELECT $1 INTO schema_change" })), /SELECT INTO creates/);
});
test("execution needs exact target/source approval and production cannot use a local SQL connection", async () => {
  const h = harness(), { saved } = h.save();
  assert.throws(() => h.service.reviewExecution(saved.path, saved.revision, "production", ["demo"]), /versioned IAM\/TLS/);
  const review = h.service.reviewExecution(saved.path, saved.revision, "local:postgres", ["demo"]);
  await assert.rejects(h.service.execute(review.id, "wrong"), /exact command/); assert.equal(h.connections, 0);
  h.changeTarget(); await assert.rejects(h.service.execute(review.id, review.confirmation), /target changed/); assert.equal(h.connections, 0);
  await assert.rejects(h.service.execute(review.id, review.confirmation), /consumed/);
});
test("pg extended query binds values; confirmed COMMIT and redacted history survive service restart", async () => {
  const h = harness(), { saved } = h.save(); const values = ["bound-value-private-123"];
  const review = h.service.reviewExecution(saved.path, saved.revision, "local:postgres", values);
  const result = await h.service.execute(review.id, review.confirmation);
  assert.equal(result.status, "committed"); assert.equal(result.database, "committed");
  assert.deepEqual(h.calls.find(call => call.extended)?.values, values);
  assert.ok(!new URL(h.receivedConnection).searchParams.get("options")!.includes("default_transaction_read_only"));
  const journal = JSON.stringify(new DatabaseSqlService(h.root).load().history);
  for (const privateValue of ["bound-value-private-123", "transient-result-never-journaled", "private-dummy"]) assert.ok(!journal.includes(privateValue));
  assert.equal(new DatabaseSqlService(h.root).load().history[0]?.status, "committed");
});
test("constraint failure rolls back with only SQLSTATE exposed; COMMIT loss is uncertain and never retried", async () => {
  const h = harness(), { saved } = h.save(); h.fail("constraint");
  let review = h.service.reviewExecution(saved.path, saved.revision, "local:postgres", ["demo"]);
  const failed = await h.service.execute(review.id, review.confirmation);
  assert.equal(failed.status, "failed"); assert.equal(failed.database, "unchanged"); assert.equal(failed.sqlState, "23505"); assert.ok(h.calls.some(call => call.sql === "ROLLBACK")); assert.ok(!JSON.stringify(failed).includes("private"));
  h.calls.splice(0); h.fail("commit"); review = h.service.reviewExecution(saved.path, saved.revision, "local:postgres", ["demo"]);
  const uncertain = await h.service.execute(review.id, review.confirmation);
  assert.equal(uncertain.status, "unconfirmed"); assert.equal(uncertain.database, "unconfirmed"); assert.equal(h.calls.filter(call => call.sql === "COMMIT").length, 1); assert.equal(h.calls.filter(call => call.sql === "ROLLBACK").length, 0);
});
test("once-only ledger skips a previously committed parameter set; read-only execution remains protected and bounded", async () => {
  const h = harness(), { saved } = h.save(command({ intent: "once" }));
  for (const expected of ["committed", "skipped"]) { const review = h.service.reviewExecution(saved.path, saved.revision, "local:postgres", ["demo"]); const result = await h.service.execute(review.id, review.confirmation); assert.equal(result.status, expected); }
  assert.equal(h.calls.filter(call => call.sql.startsWith("INSERT INTO demo_items")).length, 1);
  const { saved: inspection } = h.save(command({ name: "inspect_demo", kind: "inspection", parameters: [], sql: "SELECT * FROM demo_items; -- trailing review comment" }));
  h.calls.splice(0); const review = h.service.reviewExecution(inspection.path, inspection.revision, "local:postgres", []); const result = await h.service.execute(review.id, review.confirmation);
  assert.equal(result.status, "read"); assert.equal(result.database, "unchanged"); assert.equal(result.rows.length, 100); assert.equal(result.truncated, true); assert.equal(h.calls[0]?.sql, "BEGIN READ ONLY"); assert.match(h.receivedConnection, /default_transaction_read_only/);
  assert.match(h.calls.find(call => call.extended)!.sql, /demo_items -- trailing review comment\n\) AS studio_inspection/);
});
test("interrupted history is visible after restart without executing or inferring rollback", () => {
  const h = harness(), directory = path.join(h.root, ".cache/framework-studio/sql-operations"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"), JSON.stringify({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "lost_operation", path: "packages/database/sql/operation/lost.sql", status: "running", startedAt: new Date().toISOString() }));
  assert.equal(h.service.load().history[0]?.status, "unconfirmed"); assert.equal(h.service.load().history[0]?.database, "unconfirmed"); assert.equal(h.connections, 0);
});
test("linked history ancestors cannot read or write outside the selected state directory", () => {
  const root = fixture(), destination = fixture(); mkdirSync(path.join(root, ".cache"), { recursive: true });
  symlinkSync(destination, path.join(root, ".cache/framework-studio"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new DatabaseSqlService(root).load(), /history cannot traverse symbolic links/);
});
