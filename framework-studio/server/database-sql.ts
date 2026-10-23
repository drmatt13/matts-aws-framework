import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import express from "express";
import { SQL_DIRECTORY, type SavedSqlCommand, type SqlCatalog, type SqlExecutionRecord, type SqlExecutionResult, type SqlExecutionReview, type SqlSourceReview } from "../shared/database-sql";
import { EditError, writeSourceChange } from "./edits/io";
import { sha256 } from "./files";
import { sendJson } from "./http";
import { resolvePrivateDatabaseTargets, type PrivateDatabaseTarget } from "./database-workbench";
import { DatabaseOperationStore } from "./database-operations";

const KINDS = ["seed", "backfill", "operation", "inspection"] as const;
const HEADER = "-- framework-sql: ";
const TTL = 5 * 60_000;
const MAX_BYTES = 128 * 1024;
interface QueryResult { rows: Record<string, unknown>[]; rowCount?: number | null }
export interface SqlClient {
  connect(): Promise<void>;
  query(sql: string | { text: string; values: readonly unknown[]; queryMode: "extended" }, values?: readonly unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}
interface Dependencies { targets?: () => readonly PrivateDatabaseTarget[]; client?: (connection: string) => SqlClient }

/** Remove quoted contents/comments to identify unsupported control commands. The
 * server's extended protocol enforces the final single-statement boundary. */
function sqlWords(sql: string): string {
  let output = "", i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) { const start = i, end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end; output += " ".repeat(i - start); }
    else if (sql.startsWith("/*", i)) {
      const start = i; let depth = 1; i += 2;
      while (i < sql.length && depth) { if (sql.startsWith("/*", i)) { depth++; i += 2; } else if (sql.startsWith("*/", i)) { depth--; i += 2; } else i++; }
      if (depth) throw new EditError(422, "Close the SQL block comment before reviewing.");
      output += " ".repeat(i - start);
    } else if (sql[i] === "'" || sql[i] === '"') {
      const start = i, quote = sql[i++]!; let closed = false;
      while (i < sql.length) { if (sql[i] === quote) { if (sql[i + 1] === quote) i += 2; else { i++; closed = true; break; } } else i++; }
      if (!closed) throw new EditError(422, "Close the SQL quoted value or identifier before reviewing.");
      output += " ".repeat(i - start);
    } else {
      const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (dollar) { const start = i, end = sql.indexOf(dollar[0], i + dollar[0].length); if (end < 0) throw new EditError(422, "Close the SQL dollar-quoted value before reviewing."); i = end + dollar[0].length; output += " ".repeat(i - start); }
      else output += sql[i++];
    }
  }
  return output;
}
/** Preserve authored trailing comments while removing only the real statement
 * terminator before wrapping an inspection query with the bounded result limit. */
function inspectionStatement(sql: string): string {
  const terminator = /;\s*$/.exec(sqlWords(sql));
  return terminator ? sql.slice(0, terminator.index) + sql.slice(terminator.index + 1) : sql;
}

export function readSqlCommand(raw: unknown): SavedSqlCommand {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["name", "kind", "intent", "description", "parameters", "sql"].includes(key)) || typeof item.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.name) || !KINDS.includes(item.kind as typeof KINDS[number]) || !["once", "repeatable"].includes(String(item.intent)) || typeof item.description !== "string" || item.description.length > 1000 || !Array.isArray(item.parameters) || item.parameters.length > 32 || item.parameters.some(value => typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) || new Set(item.parameters).size !== item.parameters.length || typeof item.sql !== "string" || !item.sql.trim() || Buffer.byteLength(item.sql) > MAX_BYTES) throw new EditError(400, "Give the SQL command a lowercase name, category, execution intent, description, up to 32 unique parameter names, and SQL smaller than 128 KiB.");
  const words = sqlWords(item.sql).trim().replace(/;\s*$/, "");
  if (words.includes(";") || !/^(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(words)) throw new EditError(422, "Saved commands accept one SELECT, WITH, INSERT, UPDATE or DELETE statement. Use Prisma migrations for schema changes; transaction control and multiple statements are not supported.");
  if (/\bSELECT\b[\s\S]*\bINTO\b/i.test(words.replace(/\bINSERT\s+INTO\b/gi, "INSERT "))) throw new EditError(422, "SELECT INTO creates schema objects. Use the Prisma migration workflow for schema changes.");
  if (item.kind === "inspection" && !/^(SELECT|WITH)\b/i.test(words)) throw new EditError(422, "Inspection commands require SELECT or WITH and execute in a PostgreSQL read-only transaction.");
  const positions = [...words.matchAll(/\$(\d+)\b/g)].map(match => Number(match[1]));
  const parameterNames = item.parameters;
  if (positions.some(position => position < 1 || position > parameterNames.length) || parameterNames.some((_, index) => !positions.includes(index + 1))) throw new EditError(422, "Use every declared parameter as its positional placeholder ($1, $2, …). Values are bound by PostgreSQL; SQL is never interpolated.");
  return { name: item.name, kind: item.kind as SavedSqlCommand["kind"], intent: item.intent as SavedSqlCommand["intent"], description: item.description, parameters: item.parameters as string[], sql: item.sql };
}
function contents(command: SavedSqlCommand): string { const { sql, ...metadata } = command; return `${HEADER}${JSON.stringify({ version: 1, ...metadata })}\n${sql.trim()}\n`; }
function parse(contents: string): SavedSqlCommand {
  const newline = contents.indexOf("\n");
  if (!contents.startsWith(HEADER) || newline < 0) throw new Error("Missing framework-sql metadata header");
  const { version, ...metadata } = JSON.parse(contents.slice(HEADER.length, newline));
  if (version !== 1) throw new Error("Unsupported SQL metadata version");
  return readSqlCommand({ ...metadata, sql: contents.slice(newline + 1).trim() });
}
function sourcePath(command: SavedSqlCommand): string { return `${SQL_DIRECTORY}/${command.kind}/${command.name}.sql`; }

/** Fixed repository authority. Every component is checked before reading/writing. */
function guardPath(root: string, relative: string): string {
  if (!new RegExp(`^${SQL_DIRECTORY}/(?:${KINDS.join("|")})/[a-z][a-z0-9_-]{0,63}\\.sql$`).test(relative)) throw new EditError(400, "Select a command inside the framework-owned SQL directory.");
  let current = realpathSync(root);
  for (const component of relative.split("/")) { current = path.join(current, component); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new EditError(422, "SQL source cannot traverse symbolic links. Review its repository location."); }
  return current;
}

/** State paths can be configured outside the checkout; none of their existing
 * ancestors may redirect history reads/writes through a filesystem link. */
function guardStateDirectory(directory: string): string {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "SQL operation history cannot traverse symbolic links. Review the configured state directory."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return absolute;
}

/** Uses the repository's installed pg driver and existing private Compose target.
 * Never reads DATABASE_URL and never starts containers or runs during startup. */
export class DatabaseSqlService {
  private readonly sourceReviews = new Map<string, SqlSourceReview>();
  private readonly executionReviews = new Map<string, SqlExecutionReview>();
  private readonly store: DatabaseOperationStore;
  constructor(private readonly root: string, private readonly dependencies: Dependencies = {}) { guardStateDirectory(path.join(process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ?? path.join(root, ".cache/framework-studio"), "database-operations")); this.store = new DatabaseOperationStore(root); }
  private targets() { return this.dependencies.targets?.() ?? resolvePrivateDatabaseTargets(this.root); }
  private historyDirectory(): string { return guardStateDirectory(path.join(process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ?? path.join(this.root, ".cache/framework-studio"), "sql-operations")); }
  private history(): SqlExecutionRecord[] {
    const directory = this.historyDirectory();
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).flatMap(name => {
      try { const file = path.join(directory, name); if (lstatSync(file).isSymbolicLink()) throw new Error(); const record = JSON.parse(readFileSync(file, "utf8")) as SqlExecutionRecord; if (!record.id || !record.status || !record.path) throw new Error(); return [{ ...record, ...(record.status === "running" ? { status: "unconfirmed" as const, database: "unconfirmed" as const, message: "Execution was interrupted or is still in progress. Inspect the target before retrying; Studio does not replay SQL." } : {}) }]; }
      catch { return [{ id: name.slice(0, -5), name: "Unreadable operation", path: "unknown", revision: "unknown", targetLabel: "Unknown database", targetIdentity: "unknown", startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), status: "unconfirmed" as const, database: "unconfirmed" as const, message: "SQL history is unreadable. Preserve the record and inspect the database before retrying." }]; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).filter((record, index) => index < 50 || record.status === "unconfirmed");
  }
  private record(record: SqlExecutionRecord): void {
    const directory = this.historyDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new EditError(422, "SQL operation history must be a private regular directory.");
    const file = path.join(directory, `${record.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`, descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(record)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, file);
    let directoryDescriptor: number | undefined;
    try { directoryDescriptor = openSync(directory, "r"); fsyncSync(directoryDescriptor); }
    catch (error) { if (!["EINVAL", "ENOTSUP", ...(process.platform === "win32" ? ["EPERM", "EACCES", "EISDIR", "EBADF"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { if (directoryDescriptor !== undefined) closeSync(directoryDescriptor); }
  }
  load(): SqlCatalog {
    const commands: SqlCatalog["commands"][number][] = [], issues: string[] = [];
    for (const kind of KINDS) {
      const directory = path.join(this.root, SQL_DIRECTORY, kind);
      guardPath(this.root, `${SQL_DIRECTORY}/${kind}/placeholder.sql`);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).sort()) {
        if (!name.endsWith(".sql")) continue;
        const relative = `${SQL_DIRECTORY}/${kind}/${name}`;
        try { const file = guardPath(this.root, relative); if (lstatSync(file).size > MAX_BYTES + 4096) throw new Error(); const text = readFileSync(file, "utf8"); const command = parse(text); if (sourcePath(command) !== relative) throw new Error(); commands.push({ path: relative, revision: sha256(text), command }); }
        catch { issues.push(`${relative}: metadata, SQL, or source location is invalid. Open the file in your editor; Studio did not execute it.`); }
        if (commands.length + issues.length > 500) throw new EditError(422, "SQL catalog exceeds 500 entries. Narrow the repository catalog before using Studio.");
      }
    }
    return { directory: SQL_DIRECTORY, commands, issues, history: this.history(), targets: this.targets().map(target => target.public) };
  }
  reviewSource(raw: unknown, expectedRevision: unknown): SqlSourceReview {
    if (expectedRevision !== null && typeof expectedRevision !== "string") throw new EditError(400, "Select the current file revision, or create a new command.");
    const command = readSqlCommand(raw), relative = sourcePath(command), file = guardPath(this.root, relative);
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    if ((before === null ? null : sha256(before)) !== expectedRevision) throw new EditError(409, "SQL source changed or the destination already exists. Reload the command and review again.");
    const review = { id: randomUUID(), path: relative, before, after: contents(command), command, expiresAt: new Date(Date.now() + TTL).toISOString() };
    if (this.sourceReviews.size >= 20) this.sourceReviews.clear(); this.sourceReviews.set(review.id, review); return review;
  }
  saveSource(id: string) {
    const review = this.sourceReviews.get(id); if (!review || Date.parse(review.expiresAt) < Date.now()) throw new EditError(409, "SQL source review expired. Review again; nothing was saved.");
    this.sourceReviews.delete(id);
    const file = guardPath(this.root, review.path); mkdirSync(path.dirname(file), { recursive: true }); guardPath(this.root, review.path);
    writeSourceChange(this.root, file, review.before, review.after);
    return { saved: true, path: review.path, revision: sha256(review.after), message: "Saved the reviewed SQL source. No database was contacted." };
  }
  reviewExecution(relative: string, revision: string, targetId: string, rawParameters: unknown): SqlExecutionReview {
    if (targetId !== "local:postgres") throw new EditError(422, "Saved SQL execution is local only. Production stays behind the versioned IAM/TLS migration task and a separate target-bound approval; this action cannot run arbitrary SQL in production.");
    const target = this.targets().find(item => item.public.id === targetId); if (!target?.connection || !target.public.available) throw new EditError(422, target?.public.detail ?? "The selected local PostgreSQL target is unavailable.");
    const text = readFileSync(guardPath(this.root, relative), "utf8"); if (sha256(text) !== revision) throw new EditError(409, "Saved SQL changed. Reload before reviewing execution.");
    const command = parse(text);
    if (!Array.isArray(rawParameters) || rawParameters.length !== command.parameters.length || rawParameters.some(value => value !== null && !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && value.length > 16_384)) throw new EditError(400, "Provide one JSON scalar value for each positional parameter. Parameter values are never stored in Studio history.");
    const review: SqlExecutionReview = { id: randomUUID(), path: relative, revision, command, targetId, targetLabel: target.public.label, targetIdentity: target.public.identity, parameters: rawParameters, confirmation: `Run ${command.name} on ${target.public.label}`, expiresAt: new Date(Date.now() + TTL).toISOString(), effects: [command.kind === "inspection" ? "Runs one statement in a read-only PostgreSQL transaction, returning up to 100 rows." : "Runs one statement in an explicit transaction. Only a confirmed COMMIT is reported as applied; connection loss can leave an uncertain outcome.", command.intent === "once" && command.kind !== "inspection" ? "Once-only intent is enforced by a database ledger for this command path and parameter set. Edits do not reset it; use a new command name for a new backfill." : "Repeatable intent allows reruns; author ON CONFLICT or equivalent idempotence in the SQL itself.", "No migrations, generated files, deployments, containers or production data are changed by saving this command. Query results and parameter values are excluded from persistent Studio history."] };
    if (this.executionReviews.size >= 20) this.executionReviews.clear(); this.executionReviews.set(review.id, review); return review;
  }
  async execute(id: string, confirmation: string): Promise<SqlExecutionResult> {
    const review = this.executionReviews.get(id); if (!review || Date.parse(review.expiresAt) < Date.now()) throw new EditError(409, "SQL execution review expired or was consumed. Review again; no statement was run.");
    if (confirmation !== review.confirmation) throw new EditError(400, "Type the exact command and target confirmation before execution.");
    this.executionReviews.delete(id);
    const target = this.targets().find(item => item.public.id === review.targetId);
    if (!target?.connection || target.public.identity !== review.targetIdentity || sha256(readFileSync(guardPath(this.root, review.path), "utf8")) !== review.revision) throw new EditError(409, "SQL source or private database target changed after review. Nothing was executed; review again.");
    const release = this.store.lock(); if (!release) throw new EditError(409, "Another database operation or an unrecovered operation lock exists. Inspect its history before retrying; no SQL was run.");
    const now = new Date().toISOString();
    let record: SqlExecutionRecord = { id: randomUUID(), name: review.command.name, path: review.path, revision: review.revision, targetLabel: review.targetLabel, targetIdentity: review.targetIdentity, startedAt: now, updatedAt: now, status: "running", database: "unconfirmed", message: "SQL execution started; commit outcome is not yet confirmed." };
    let client: SqlClient | undefined, transaction = false, commitStarted = false, committed = false;
    const readOnly = review.command.kind === "inspection";
    try {
      this.record(record);
      const connection = new URL(target.connection); if (!readOnly) connection.searchParams.set("options", "-c statement_timeout=15000 -c lock_timeout=5000");
      const pg = this.dependencies.client ? undefined : createRequire(path.join(this.root, "packages/database/package.json"))("pg") as { Client: new (options: { connectionString: string }) => SqlClient };
      client = this.dependencies.client?.(connection.toString()) ?? new pg!.Client({ connectionString: connection.toString() });
      await client.connect();
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN"); transaction = true;
      await client.query("SET LOCAL statement_timeout = '15s'"); await client.query("SET LOCAL lock_timeout = '5s'");
      // Same lock as reviewed initialization; serializes the SQL ledger within the target too.
      await client.query("SELECT pg_advisory_xact_lock(4590, 1)");
      let skipped = false;
      const parameterKey = sha256(JSON.stringify(review.parameters));
      if (!readOnly && review.command.intent === "once") {
        // Operational metadata must not add a table to the application's public
        // namespace: Prisma strict schema verification owns that namespace.
        await client.query("CREATE SCHEMA IF NOT EXISTS framework_studio");
        await client.query("CREATE TABLE IF NOT EXISTS framework_studio.sql_runs (command_path text NOT NULL, parameter_key text NOT NULL, revision text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(command_path, parameter_key))");
        skipped = (await client.query("SELECT revision FROM framework_studio.sql_runs WHERE command_path = $1 AND parameter_key = $2", [review.path, parameterKey])).rows.length > 0;
      }
      const sql = readOnly ? `SELECT * FROM (${inspectionStatement(review.command.sql)}\n) AS studio_inspection LIMIT 101` : review.command.sql;
      const result = skipped ? { rows: [], rowCount: 0 } : await client.query({ text: sql, values: review.parameters, queryMode: "extended" });
      if (!readOnly && !skipped && review.command.intent === "once") await client.query("INSERT INTO framework_studio.sql_runs(command_path, parameter_key, revision) VALUES ($1, $2, $3)", [review.path, parameterKey, review.revision]);
      commitStarted = true; await client.query("COMMIT"); transaction = false; committed = true;
      record = { ...record, updatedAt: new Date().toISOString(), status: skipped ? "skipped" : readOnly ? "read" : "committed", database: readOnly || skipped ? "unchanged" : "committed", rowCount: result.rowCount ?? result.rows.length, message: skipped ? "Once-only command already committed for this parameter set; the statement was not rerun." : readOnly ? "Read-only transaction completed. Results are not persisted in Studio history." : "PostgreSQL confirmed COMMIT. Repeatable commands rely on their authored idempotence." };
      this.record(record);
      return { ...record, rows: result.rows.slice(0, 100), truncated: result.rows.length > 100 };
    } catch (error) {
      let rolledBack = !transaction && !commitStarted;
      if (transaction && !commitStarted) try { await client?.query("ROLLBACK"); rolledBack = true; } catch { /* Cannot assert effects without acknowledgement. */ }
      const code = (error as { code?: unknown })?.code;
      const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
      const unchanged = readOnly || !committed && !commitStarted && rolledBack;
      record = { ...record, updatedAt: new Date().toISOString(), status: unchanged ? "failed" : "unconfirmed", database: unchanged ? "unchanged" : "unconfirmed", ...(sqlState ? { sqlState } : {}), message: unchanged ? `SQL failed${sqlState ? ` (${sqlState})` : ""}; no transaction changes committed. Review the SQL and inspect the target before a new approval.` : "COMMIT or durable-history outcome is uncertain. Inspect the selected database and once-only ledger before retrying; Studio never retries writes automatically." };
      this.record(record); return { ...record, rows: [], truncated: false };
    } finally { try { await client?.end(); } catch { /* A close failure does not undo an acknowledged COMMIT. */ } release(); }
  }
}

/** Mounted behind Studio's existing token/origin/protocol guards. */
export function databaseSqlRouter(root: string) {
  const router = express.Router(), service = new DatabaseSqlService(root);
  router.get("/", (_req, res) => sendJson(res, () => service.load()));
  router.post("/review", (req, res) => sendJson(res, () => service.reviewSource(req.body?.command, req.body?.expectedRevision)));
  router.post("/save", (req, res) => sendJson(res, () => service.saveSource(req.body?.id)));
  router.post("/execute-review", (req, res) => sendJson(res, () => service.reviewExecution(req.body?.path, req.body?.revision, req.body?.targetId, req.body?.parameters)));
  router.post("/execute", (req, res) => sendJson(res, () => service.execute(req.body?.id, req.body?.confirmation)));
  return router;
}
