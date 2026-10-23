import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ok } from "@prisma/orm-framework/utils/result";
import { hasMigrations } from "@prisma/orm-framework/components/control";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import type { ControlClient } from "@prisma/orm-toolchain/cli/control-api";
import type { DatabaseApplicationResult, DatabaseApplicationReview, DatabaseOperationRecord } from "../shared/database-application";
import type { DatabaseHistory } from "../shared/database-history";
import { EditError } from "./edits/io";
import { sha256 } from "./files";
import { compileDatabaseSource, databaseConfigurationRevision, databaseContractPath, DatabaseWorkbenchService, resolvePrivateDatabaseTargets } from "./database-workbench";
import { DatabaseOperationStore } from "./database-operations";
import { isDatabaseEmpty } from "./database-empty";
import { databaseMigrationSourceFiles, digest, guardCloudDatabasePath, planDatabaseInitialization } from "../../packages/database/scripts/studio-migrations";

/** Exact package bytes are approval inputs, including executable migration.ts. */
function migrationBytes(root: string): string {
  const directory = path.join(root, "packages/database/prisma/migrations");
  const entries: string[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new EditError(422, "Migration history contains a symbolic link. Review it outside Studio; no database changes were requested.");
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) entries.push(`${path.relative(directory, file)}:${sha256(readFileSync(file, "utf8"))}`);
      if (entries.length > 20_000) throw new EditError(422, "Migration history is too large for a reviewed Studio application. Use the framework CLI workflow.");
    }
  };
  if (existsSync(directory)) visit(directory);
  for (const file of databaseMigrationSourceFiles(root)) if (existsSync(file) && path.relative(directory, file).split(path.sep).includes("..")) entries.push(`${path.relative(root, file)}:${sha256(readFileSync(file, "utf8"))}`);
  return sha256(entries.join("\n"));
}

/** Canonical db migrate --show, with emitted JSON confined to a disposable directory. */
export async function canonicalApplicationPath(root: string, config: PrismaNextConfig, contract: Contract, connection: string, createClient?: typeof import("@prisma/orm-toolchain/cli/control-api").createControlClient) {
  const { createControlClient, executeMigrateShowPlan } = await import("@prisma/orm-toolchain/cli/control-api");
  const client = createControlClient(config);
  const directory = mkdtempSync(path.join(tmpdir(), "studio-database-apply-"));
  try {
    const emitted = await client.emit({ contractConfig: { output: path.join(directory, "contract.json"), source: { format: "psl", async load() { return ok(contract); } } } });
    if (!emitted.ok) throw new EditError(422, "Prisma could not prepare the saved contract for application review. No database changes were requested.");
    writeFileSync(path.join(directory, "contract.json"), emitted.value.contractJson);
    const preview = await executeMigrateShowPlan({ config: { ...config, db: { connection }, contract: { ...config.contract!, output: path.join(directory, "contract.json") } }, cwd: path.join(root, "packages/database"), createClient });
    if (!preview.ok) throw new EditError(422, `Prisma cannot determine a reviewed migration path (${preview.failure.code}). Review migration history, marker and invariants; no database changes were requested.`);
    return preview.value.migrations;
  } finally { await client.close(); rmSync(directory, { recursive: true, force: true }); }
}

interface StoredApplication { readonly review: DatabaseApplicationReview; readonly packageBytes: string; readonly configHash: string; readonly pathHash: string }

interface DatabaseApplicationDependencies {
  readonly path?: typeof canonicalApplicationPath;
  readonly createWriteClient?: (config: PrismaNextConfig, connection: string) => ControlClient;
  readonly createReadClient?: (config: PrismaNextConfig, connection: string) => ControlClient;
  readonly empty?: typeof isDatabaseEmpty;
}

/** Only stable codes cross the private driver boundary, never free-form messages/meta. */
export function databaseFailure(error: unknown): NonNullable<DatabaseApplicationResult["diagnostic"]> {
  const entry = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof entry.code === "string" && /^[A-Z][A-Z0-9_.]{1,80}$/.test(entry.code) ? entry.code : "DATABASE_OPERATION_FAILED";
  const sqlState = typeof entry.code === "string" && /^[0-9A-Z]{5}$/.test(entry.code) ? entry.code : undefined;
  return { code, ...(sqlState ? { sqlState } : {}), action: "Inspect this target and its migration ledger before retrying. Open the reviewed migration source; use its stable error code to investigate without exposing connection values." };
}

/**
 * The marker can move between --show and migrate. Check the actual canonical
 * runner input as well as the earlier preview, before handing it to Prisma's
 * transactional runner (which locks and rechecks its origin marker).
 */
export function guardReviewedMigrationExecution(config: PrismaNextConfig, review: DatabaseApplicationReview, assertCurrent: () => void): PrismaNextConfig {
  const target = config.target;
  if (!hasMigrations(target)) throw new EditError(422, "The configured target cannot execute reviewed migration packages.");
  const expected = review.migrations.map(item => ({ spaceId: item.id.split("/")[0], dirName: item.name, migrationHash: item.migrationHash, from: item.from, to: item.to }));
  const guardedTarget: typeof target = { ...target, migrations: { ...target.migrations,
    createRunner(family) {
      const runner = target.migrations.createRunner(family);
      return { async execute(options) {
        assertCurrent();
        const actual = options.perSpaceOptions.flatMap(space => space.migrationEdges.map(edge => ({ spaceId: space.space, dirName: edge.dirName, migrationHash: edge.migrationHash, from: edge.from, to: edge.to })));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new EditError(409, "The database marker selected a different migration path after review. No reviewed migration runner was started; inspect and review again.");
        return runner.execute(options);
      } };
    },
  } };
  return { ...config, target: guardedTarget };
}

/** The sole GUI database-write authority. All other workbench operations are read-only. */
export class DatabaseApplicationService {
  private readonly reviews = new Map<string, StoredApplication>();
  private busy = false;
  private readonly operations: DatabaseOperationStore;
  constructor(private readonly root: string, private readonly workbench: Pick<DatabaseWorkbenchService, "inspect">, private readonly history: () => Promise<DatabaseHistory>, private readonly dependencies: DatabaseApplicationDependencies = {}) { this.operations = new DatabaseOperationStore(root); }
  listOperations(): DatabaseOperationRecord[] { return this.operations.list(); }

  private async initializationPlan(config: PrismaNextConfig, contract: Contract, connection: string) {
    if (!await (this.dependencies.empty ?? isDatabaseEmpty)(this.root, connection)) throw new EditError(422, "Initialization requires an empty database with no application objects. This target contains objects or markers; investigate it without resetting or signing it.");
    const { createControlClient } = await import("@prisma/orm-toolchain/cli/control-api");
    const client = this.dependencies.createReadClient?.(config, connection) ?? createControlClient({ ...config, connection });
    try {
      await client.connect();
      return await planDatabaseInitialization(this.root, config, contract, client, () => (this.dependencies.empty ?? isDatabaseEmpty)(this.root, connection), captured => this.dependencies.createReadClient?.(captured, connection) ?? createControlClient({ ...captured, connection }));
    } finally { await client.close(); }
  }

  async review(targetId: string, sourceHash: string, initialize = false): Promise<DatabaseApplicationReview> {
    if (targetId !== "local:postgres") throw new EditError(422, "Reviewed database application is supported only for the explicitly selected local Compose PostgreSQL target.");
    const target = resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === targetId)!;
    if (!target.connection) throw new EditError(422, target.public.detail);
    const history = await this.history();
    if (history.sourceHash !== sourceHash || history.issues.length || history.migrations.some(item => item.integrity !== "verified" || item.issues.length)) throw new EditError(409, "Saved source or migration history is incomplete or changed. Refresh and resolve history issues before reviewing application.");
    const bytes = migrationBytes(this.root);
    const observation = await this.workbench.inspect(targetId, sourceHash, history.revision, history);
    if (initialize ? observation.status !== "observed" || observation.marker.status !== "missing" : observation.status !== "observed" || observation.migrationState.status !== "pending" || !observation.marker.storageHash || observation.historicalPhysical?.status !== "matches") throw new EditError(422, initialize ? "Initialization requires a successfully inspected target without a marker. Existing populated databases must be investigated; no reset or automatic signing is offered." : "Database application needs a known marker, matching historical physical schema and a recorded forward migration path. Inspect the database and resolve the evidence first; no database writes were requested.");
    const source = readFileSync(databaseContractPath(this.root), "utf8");
    const compiled = await compileDatabaseSource(this.root, source);
    if (!compiled.contract || compiled.validation.sourceHash !== sourceHash) throw new EditError(409, "Saved source changed during review. No database writes were requested.");
    const initialization = initialize ? await this.initializationPlan(compiled.config, compiled.contract, target.connection) : undefined;
    const selected = initialize ? [] : await (this.dependencies.path ?? canonicalApplicationPath)(this.root, compiled.config, compiled.contract, target.connection);
    if (!initialize && !selected.length) throw new EditError(422, "Prisma found no pending migration packages. Nothing needs applying.");
    const migrations = selected.map(edge => {
      const entry = history.migrations.find(item => item.migrationHash === edge.migrationHash && item.space === edge.spaceId);
      if (!entry || !entry.source || entry.pendingPlaceholders) throw new EditError(422, "A selected migration is missing reviewed source or still contains data-transform placeholders. Complete and review that package before application.");
      return { id: entry.id, name: entry.name, migrationHash: entry.migrationHash, from: edge.from, to: edge.to, source: entry.source, operations: entry.operations };
    });
    const freshHistory = await this.history();
    if (freshHistory.revision !== history.revision || migrationBytes(this.root) !== bytes || sha256(readFileSync(databaseContractPath(this.root), "utf8")) !== sourceHash || resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === targetId)?.public.identity !== target.public.identity) throw new EditError(409, "Source, history or target identity changed while reviewing. Review again; no database writes were requested.");
    const now = Date.now();
    for (const [id, item] of this.reviews) if (Date.parse(item.review.expiresAt) <= now) this.reviews.delete(id);
    const review: DatabaseApplicationReview = { id: randomUUID(), kind: initialize ? "initialize" : "migrate", ...(initialization ? { initialization } : {}), targetId, targetLabel: target.public.label, targetIdentity: target.public.identity, sourceHash, historyRevision: history.revision, from: observation.marker.storageHash ?? "@empty", to: compiled.contract.storage.storageHash, migrations, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(), confirmation: initialize ? `Initialize ${target.public.label}` : target.public.label,
      effects: [initialize ? "Creates the reviewed saved schema and its marker using Prisma's additive initialization in an explicitly verified empty local database. Existing migration packages are not executed or rewritten." : "Executes the exact selected migration packages against this local PostgreSQL database, including reviewed SQL and migration.ts data transforms.", "Prisma updates physical storage and contract markers. Migration execution can transform or delete application data.", "Source and migration artifacts remain unchanged. This does not deploy infrastructure, start Compose, prune users, set up test identity, or provide database rollback.", "The target, saved source, package bytes and physical baseline are checked again immediately before execution."] };
    this.reviews.set(review.id, { review, packageBytes: bytes, configHash: databaseConfigurationRevision(this.root), pathHash: sha256(JSON.stringify(selected)) });
    return review;
  }

  async apply(reviewId: string, confirmation: string): Promise<DatabaseApplicationResult> {
    const stored = this.reviews.get(reviewId);
    if (!stored || Date.parse(stored.review.expiresAt) <= Date.now()) throw new EditError(409, "The database application review expired. Inspect and review the selected target again; no database writes were requested.");
    if (confirmation !== stored.review.confirmation) throw new EditError(400, `Type ${stored.review.confirmation} to authorize this reviewed database application. No database writes were requested.`);
    if (this.busy) throw new EditError(409, "A reviewed database application is already running.");
    const release = this.operations.lock();
    if (!release) throw new EditError(409, "Another Studio process owns a database operation. Inspect operation history and wait for it to finish before retrying.");
    this.busy = true;
    try {
      const initialize = stored.review.kind === "initialize";
      const fresh = await this.review(stored.review.targetId, stored.review.sourceHash, initialize);
      this.reviews.delete(fresh.id);
      const target = resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === stored.review.targetId)!;
      if (fresh.historyRevision !== stored.review.historyRevision || fresh.targetIdentity !== stored.review.targetIdentity || fresh.from !== stored.review.from || fresh.to !== stored.review.to || sha256(JSON.stringify([fresh.migrations, fresh.initialization])) !== sha256(JSON.stringify([stored.review.migrations, stored.review.initialization])) || migrationBytes(this.root) !== stored.packageBytes || databaseConfigurationRevision(this.root) !== stored.configHash) throw new EditError(409, "The target or reviewed migration effects changed. Review again; no database writes were requested.");
      const compiled = await compileDatabaseSource(this.root, readFileSync(databaseContractPath(this.root), "utf8"));
      if (!compiled.contract || compiled.validation.sourceHash !== stored.review.sourceHash || !target.connection) throw new EditError(409, "Saved source or target changed before execution. Review again; no database writes were requested.");
      const selected = initialize ? [] : await (this.dependencies.path ?? canonicalApplicationPath)(this.root, compiled.config, compiled.contract, target.connection);
      if (sha256(JSON.stringify(selected)) !== stored.pathHash || migrationBytes(this.root) !== stored.packageBytes) throw new EditError(409, "The selected migration path or package bytes changed. Review again; no database writes were requested.");
      const { createControlClient } = await import("@prisma/orm-toolchain/cli/control-api");
      // Drop only the read-only option at the explicit, target-bound write boundary.
      const writable = new URL(target.connection); writable.searchParams.set("options", "-c statement_timeout=60000");
      const assertCurrent = () => {
        if (migrationBytes(this.root) !== stored.packageBytes || sha256(readFileSync(databaseContractPath(this.root), "utf8")) !== stored.review.sourceHash || databaseConfigurationRevision(this.root) !== stored.configHash || resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === stored.review.targetId)?.public.identity !== stored.review.targetIdentity) throw new EditError(409, "Reviewed inputs changed before migration execution.");
      };
      const guardedConfig = initialize ? guardCloudDatabasePath(compiled.config, { kind: "initialize", initialization: stored.review.initialization, markerIdentity: digest([]), ledgerIdentity: digest([]), migrations: [] }, assertCurrent) : guardReviewedMigrationExecution(compiled.config, stored.review, assertCurrent);
      const client = this.dependencies.createWriteClient?.(guardedConfig, writable.toString()) ?? createControlClient({ ...guardedConfig, connection: writable.toString() });
      this.reviews.delete(stored.review.id);
      let applied: DatabaseApplicationResult["applied"] = [];
      let succeeded = false;
      let executionStarted = false;
      let diagnostic: DatabaseApplicationResult["diagnostic"];
      let record: DatabaseOperationRecord = { id: randomUUID(), ownerPid: process.pid, kind: initialize ? "initialize" : "migrate", targetLabel: stored.review.targetLabel, targetIdentity: stored.review.targetIdentity, sourceHash: stored.review.sourceHash, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running", stage: "connecting", migrations: stored.review.migrations.map(item => item.name) };
      this.operations.write(record);
      try {
        await client.connect();
        assertCurrent();
        if (initialize && !await (this.dependencies.empty ?? isDatabaseEmpty)(this.root, target.connection)) throw new EditError(409, "Database is no longer empty.");
        executionStarted = true;
        record = { ...record, stage: "executing", updatedAt: new Date().toISOString() }; this.operations.write(record);
        if (initialize) {
          const result = await client.dbInit({ contract: compiled.contract, mode: "apply", migrationsDir: path.join(this.root, "packages/database/prisma/migrations") });
          succeeded = result.ok; if (!result.ok) diagnostic = databaseFailure(result.failure);
        } else {
          const result = await client.migrate({ contract: compiled.contract, migrationsDir: path.join(this.root, "packages/database/prisma/migrations") });
          if (result.ok) { succeeded = true; applied = result.value.applied.map(item => ({ name: item.dirName, from: item.from, to: item.to })); } else diagnostic = databaseFailure(result.failure);
        }
      } catch (error) { diagnostic = databaseFailure(error); }
      finally { try { await client.close(); } catch { /* Application effect remains independent of cleanup. */ } }
      let observation;
      record = { ...record, stage: "inspecting", updatedAt: new Date().toISOString() }; this.operations.write(record);
      try { const history = await this.history(); observation = await this.workbench.inspect(stored.review.targetId, stored.review.sourceHash, history.revision, history); } catch { /* A refresh failure cannot undo a successful application. */ }
      const result: DatabaseApplicationResult = { operationId: record.id, stage: succeeded ? "complete" : executionStarted ? "executing" : "connecting", ...(diagnostic ? { diagnostic } : {}), status: succeeded ? "applied" : executionStarted ? "unconfirmed" : "failed", database: succeeded ? "applied" : executionStarted ? "unconfirmed" : "unchanged", source: "unchanged", artifacts: "unchanged", targetId: stored.review.targetId, applied, observation,
        message: succeeded ? observation?.status === "observed" ? "Reviewed database changes applied. The follow-up database observation is available; authored source and migration artifacts were unchanged." : "Reviewed database changes applied, but follow-up inspection is unavailable. Inspect this target again; do not repeat application merely to refresh status." : executionStarted ? "Prisma did not confirm successful application. Database effects are unconfirmed; inspect this target and review the migration package before retrying. Studio did not alter authored source or migration artifacts." : "The database application stopped before migration execution because the connection failed or reviewed inputs changed. No database writes were requested; inspect and review again." };
      this.operations.write({ ...record, stage: result.stage!, status: result.status, updatedAt: new Date().toISOString(), result });
      return result;
    } finally { this.busy = false; release(); }
  }
}
