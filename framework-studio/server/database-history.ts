import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { diffSchemas, type SchemaDiffIssue } from "@prisma/orm-framework/components/control";
import type { TargetBoundComponentDescriptor } from "@prisma/orm-framework/components/components";
import { canonicalizeContractToObject } from "@prisma/orm-framework/contract/hashing";
import postgresAdapter from "@prisma/orm-postgres/adapter/control";
import { buildDataTypeResolver, buildNativeTypeExpander } from "@prisma/orm-postgres/family/control";
import { createSnapshotContentVerifier, readContractSnapshotJson } from "@prisma/orm-postgres/migration-tools/contract-snapshot-store";
import { readMigrationsDir } from "@prisma/orm-postgres/migration-tools/io";
import postgresTarget from "@prisma/orm-postgres/target/control";
import { postgresResolveDefault } from "@prisma/orm-postgres/target/default-normalizer";
import { contractToPostgresDatabaseSchemaNode } from "@prisma/orm-postgres/target/planner";
import type {
  DatabaseContractReference, DatabaseHistory, DatabaseHistoryIssue, DatabaseMigration,
  DatabaseMigrationArtifact, DatabaseMigrationInstallResult, DatabaseMigrationOperation,
  DatabaseMigrationReview, DatabaseSchemaComparison, DatabaseSemanticChange,
} from "../shared/database-history";
import { CONTRACT_FILE } from "./database";
import { compileDatabaseSource, databaseConfigurationSourceFiles } from "./database-workbench";
import { EditError, sourceContents, writeSourceChange } from "./edits/io";
import { sha256 } from "./files";
import { databaseMigrationSourceFiles } from "../../packages/database/scripts/studio-migrations";

export const MIGRATIONS_DIRECTORY = "packages/database/prisma/migrations";
const CONFIG_FILE = "packages/database/prisma.config.ts";
const HASH = /^[a-f0-9]{64}$/;
const runFile = promisify(execFile);
const verifier = createSnapshotContentVerifier(postgresTarget.contractSerializer.hashCanonicalizationHooks);
const HISTORY_LIMIT = 4000;
const FILE_LIMIT = 5 * 1024 * 1024;

function issue(code: string, message: string, file?: string): DatabaseHistoryIssue {
  return { code, message, ...(file ? { path: file } : {}) };
}

/** Never traverse links in historical packages or install through a linked parent. */
function assertPath(root: string, relative: string, allowMissing = false): string {
  if (relative.includes("\\") || relative.split("/").includes("..") || path.isAbsolute(relative)) throw new EditError(400, "Invalid migration path.");
  const absoluteRoot = realpathSync(root);
  let current = absoluteRoot;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      if (allowMissing) continue;
      throw new EditError(409, `${relative} is missing. Refresh history before continuing.`);
    }
    if (lstatSync(current).isSymbolicLink()) throw new EditError(409, `${relative} uses a symbolic link. Studio does not read or write migration history through links.`);
  }
  return current;
}

function readText(root: string, relative: string): string {
  const absolute = assertPath(root, relative);
  if (lstatSync(absolute).size > FILE_LIMIT) throw new EditError(413, `${relative} is too large for Studio history review.`);
  return readFileSync(absolute, "utf8");
}

/** Identity includes every migration/snapshot/ref byte and the config; not directory timestamps. */
export function databaseHistoryFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string): void => {
    const absolute = assertPath(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${relative}/${entry.name}`;
      if (files.size >= HISTORY_LIMIT) throw new EditError(413, "Migration history is too large for one Studio review.");
      if (entry.isSymbolicLink()) throw new EditError(409, `${file} uses a symbolic link. Remove the link before reviewing migration history in Studio.`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.set(file, readText(root, file));
    }
  };
  if (existsSync(path.join(root, MIGRATIONS_DIRECTORY))) walk(MIGRATIONS_DIRECTORY);
  files.set(CONFIG_FILE, readText(root, CONFIG_FILE));
  for (const file of ["package.json", "package-lock.json", "packages/database/package.json"]) if (existsSync(path.join(root, file))) files.set(file, readText(root, file));
  // The same dependency closure used by validation belongs to the offline
  // planner and its review identity. Never copy private dotenv inputs.
  for (const absolute of [...databaseConfigurationSourceFiles(root), ...databaseMigrationSourceFiles(root)]) {
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (/(?:^|\/)\.env(?:\.|$)/.test(relative)) continue;
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new EditError(422, "Prisma configuration imports outside this checkout. Move its authored helpers into the checkout before planning in Studio.");
    if (existsSync(absolute)) files.set(relative, readText(root, relative));
  }
  return files;
}

function historyRevision(files: ReadonlyMap<string, string>): string {
  return sha256(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, contents]) => [file, sha256(contents)])));
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function migrationOperation(value: unknown): DatabaseMigrationOperation {
  const op = object(value);
  const statements: DatabaseMigrationOperation["statements"] = [];
  for (const phase of ["precheck", "execute", "postcheck"] as const) {
    for (const statement of Array.isArray(op[phase]) ? op[phase] : []) {
      const entry = object(statement);
      if (typeof entry.sql === "string") statements.push({ phase, sql: entry.sql,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(Array.isArray(entry.params) ? { params: entry.params } : {}),
      });
    }
  }
  return { id: String(op.id ?? "operation"), label: String(op.label ?? "Migration operation"),
    operationClass: String(op.operationClass ?? "unknown"),
    ...(typeof op.summary === "string" ? { summary: op.summary } : {}), statements };
}

/** Tolerant, read-only discovery: no imports/evaluation of migration.ts and no ref writes. */
export async function readDatabaseHistory(root: string): Promise<DatabaseHistory> {
  const files = databaseHistoryFiles(root);
  const revision = historyRevision(files);
  const migrations: DatabaseMigration[] = [];
  const issues: DatabaseHistoryIssue[] = [];
  const refs: DatabaseHistory["refs"] = [];
  const migrationsDir = path.join(root, MIGRATIONS_DIRECTORY);
  const spaces = existsSync(migrationsDir) ? readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "snapshots").map((entry) => entry.name).sort() : [];
  for (const space of spaces) {
    const { packages, problems } = await readMigrationsDir(path.join(migrationsDir, space), { migrationsDir, verifySnapshotContent: verifier });
    for (const problem of problems) {
      const message = problem.kind === "hashMismatch" ? "Emitted operations or metadata differ from the recorded migration hash. This package is modified."
        : problem.kind === "providedInvariantsMismatch" ? "The migration's data transformation invariants disagree with its metadata."
          : "The migration package is incomplete or has invalid JSON/metadata. Inspect its files before planning.";
      issues.push(issue(problem.kind, message, `${MIGRATIONS_DIRECTORY}/${space}/${problem.dirName}`));
    }
    for (const pkg of packages) {
      const id = `${space}/${pkg.dirName}`;
      const sourcePath = `${MIGRATIONS_DIRECTORY}/${id}/migration.ts`;
      const source = files.get(sourcePath) ?? null;
      const problemsForPackage = issues.filter((entry) => entry.path === `${MIGRATIONS_DIRECTORY}/${id}`);
      if (source === null) problemsForPackage.push(issue("sourceMissing", "Migration source is missing; emitted metadata and operations are still shown.", sourcePath));
      migrations.push({ id, space, name: pkg.dirName, from: pkg.metadata.from, to: pkg.metadata.to,
        createdAt: pkg.metadata.createdAt, migrationHash: pkg.metadata.migrationHash,
        integrity: problems.some((problem) => problem.dirName === pkg.dirName) ? "modified" : "verified",
        operations: pkg.ops.map(migrationOperation), source, sourcePath, sourceVerification: "not-executed",
        pendingPlaceholders: /\bplaceholder\s*\(/.test(source ?? ""), issues: problemsForPackage });
    }
    const prefix = `${MIGRATIONS_DIRECTORY}/${space}/refs/`;
    for (const [file, contents] of files) {
      if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
      try {
        const ref = object(JSON.parse(contents));
        if (typeof ref.hash !== "string" || !HASH.test(ref.hash) || !Array.isArray(ref.invariants) || !ref.invariants.every((value) => typeof value === "string")) throw new Error("invalid");
        refs.push({ space, name: path.basename(file, ".json"), hash: ref.hash, invariants: ref.invariants });
      } catch { issues.push(issue("invalidRef", "This migration ref is invalid. It has not been changed.", file)); }
    }
  }
  const hashes = new Set(migrations.flatMap((migration) => migration.from ? [migration.from, migration.to] : [migration.to]));
  for (const [file] of files) {
    const match = new RegExp(`^${MIGRATIONS_DIRECTORY}/snapshots/([a-f0-9]{64})/contract\\.json$`).exec(file);
    if (match) hashes.add(match[1]!);
  }
  const snapshots: DatabaseHistory["snapshots"] = [];
  for (const hash of [...hashes].sort()) {
    const file = `${MIGRATIONS_DIRECTORY}/snapshots/${hash}/contract.json`;
    try {
      const contract = await readContractSnapshotJson(migrationsDir, hash, verifier);
      postgresTarget.contractSerializer.deserializeContract(contract);
      snapshots.push({ hash, path: file, available: true, provenance: "semantic-contract", contract, issues: [] });
    } catch {
      const snapshotIssue = issue("snapshotUnavailable", "The semantic snapshot is missing, invalid, or does not reproduce its content address. Historical source cannot be reconstructed from it.", file);
      snapshots.push({ hash, path: file, available: false, provenance: "semantic-contract", issues: [snapshotIssue] });
      issues.push(snapshotIssue);
    }
  }
  for (const ref of refs) if (!hashes.has(ref.hash)) issues.push(issue("refOutsideHistory", `${ref.space}/${ref.name} points outside the known migration graph. A ref alone is not database evidence.`));
  const app = migrations.filter((migration) => migration.space === "app");
  const nodes = new Set(app.flatMap((migration) => migration.from ? [migration.from, migration.to] : [migration.to]));
  const produced = new Set(app.map((migration) => migration.to));
  for (const migration of app) if (migration.from && !produced.has(migration.from)) issues.push(issue("unexplainedOrigin", `${migration.name} starts at a contract with no producing migration in this checkout.`, migration.sourcePath));
  const outgoing = new Map<string | null, DatabaseMigration[]>();
  for (const migration of app) outgoing.set(migration.from, [...outgoing.get(migration.from) ?? [], migration]);
  for (const [hash, edges] of outgoing) if (edges.length > 1) issues.push(issue("branch", `${edges.length} migrations share ${hash ? `origin ${hash.slice(0, 12)}` : "the empty origin"}. Select a baseline explicitly; creation times do not choose a branch.`));
  const heads = [...nodes].filter((hash) => !outgoing.has(hash)).sort();
  if (historyRevision(databaseHistoryFiles(root)) !== revision) throw new EditError(409, "Migration history changed while it was being read. Refresh to load one consistent graph; nothing was written.");
  return { revision, sourceHash: sha256(readText(root, CONTRACT_FILE)), migrations, snapshots, heads, refs, issues, observedAt: new Date().toISOString() };
}

const snapshotLimitations = [
  "Historical snapshots contain emitted semantic contracts, not the original authored Prisma text or comments.",
  "Storage comparison uses the installed Prisma PostgreSQL schema differ. It does not prove data, backfill or application correctness.",
  "Migration package integrity attests metadata and emitted operations. Studio does not execute historical TypeScript to prove it matches those operations.",
];

function jsonChanges(before: unknown, after: unknown, plane: "domain" | "execution", pathParts: string[] = []): DatabaseSemanticChange[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before !== undefined && after !== undefined && before !== null && after !== null && !Array.isArray(before) && !Array.isArray(after) && typeof before === "object" && typeof after === "object") {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].sort().flatMap((key) => jsonChanges(object(before)[key], object(after)[key], plane, [...pathParts, key]));
  }
  return [{ kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", plane, path: pathParts,
    entity: pathParts.join("."), ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }];
}

/** Both inputs are hydrated with Prisma's serializer before the official schema-tree differ runs. */
export function compareDatabaseContracts(beforeJson: unknown | null, afterJson: unknown | null, components: ReadonlyArray<TargetBoundComponentDescriptor<"sql", string>> = [postgresTarget, postgresAdapter]): Pick<DatabaseSchemaComparison, "changes" | "storageChanged" | "executionChanged" | "domainChanged" | "fromStorageHash" | "toStorageHash"> {
  const before = beforeJson === null ? null : postgresTarget.contractSerializer.deserializeContract(beforeJson);
  const after = afterJson === null ? null : postgresTarget.contractSerializer.deserializeContract(afterJson);
  const schemaOptions = { annotationNamespace: "pg", resolveDefault: postgresResolveDefault,
    expandNativeType: buildNativeTypeExpander(components), dataTypeOf: buildDataTypeResolver(components) };
  // The installed serializer validates the target but its public return type widens target to string.
  const fromTree = contractToPostgresDatabaseSchemaNode(before as Parameters<typeof contractToPostgresDatabaseSchemaNode>[0], schemaOptions);
  const toTree = contractToPostgresDatabaseSchemaNode(after as Parameters<typeof contractToPostgresDatabaseSchemaNode>[0], schemaOptions);
  const storage = diffSchemas(toTree, fromTree).map((entry: SchemaDiffIssue): DatabaseSemanticChange => ({
    kind: entry.expected ? entry.actual ? "changed" : "added" : "removed", plane: "storage", path: [...entry.path],
    entity: entry.path.slice(1).join(" · "), ...(entry.explanation ? { explanation: entry.explanation } : {}),
    ...(entry.actual ? { before: JSON.parse(JSON.stringify(entry.actual)) } : {}),
    ...(entry.expected ? { after: JSON.parse(JSON.stringify(entry.expected)) } : {}),
  }));
  const canonical = (contract: NonNullable<typeof before>) => canonicalizeContractToObject(contract, {
    serializeContract: value => postgresTarget.contractSerializer.serializeContract(value as Parameters<typeof postgresTarget.contractSerializer.serializeContract>[0]),
    shouldPreserveEmpty: postgresTarget.contractSerializer.shouldPreserveEmpty,
    sortStorage: postgresTarget.contractSerializer.sortStorage,
  });
  const beforeCanonical = before ? canonical(before) : {};
  const afterCanonical = after ? canonical(after) : {};
  const domain = jsonChanges(beforeCanonical.domain, afterCanonical.domain, "domain");
  const execution = jsonChanges(beforeCanonical.execution, afterCanonical.execution, "execution").filter((entry) => entry.path.join(".") !== "executionHash");
  return { changes: [...storage, ...domain, ...execution], storageChanged: storage.length > 0, domainChanged: domain.length > 0, executionChanged: execution.length > 0,
    fromStorageHash: before?.storage.storageHash ?? null, toStorageHash: after?.storage.storageHash ?? null };
}

interface Overlay {
  root: string;
  database: string;
  files: Map<string, string>;
}

/** Only project source/config/history are copied. No dotenv, credentials, local refs outside migrations, or DB connection is copied. */
async function createOverlay(root: string, source: string, files: Map<string, string>): Promise<Overlay> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "studio-prisma-plan-"));
  try {
    await symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const copied = new Map(files);
    copied.set(CONTRACT_FILE, source);
    copied.set("packages/database/package.json", readText(root, "packages/database/package.json"));
    for (const [relative, contents] of copied) {
      const absolute = path.join(temporary, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, { flag: "wx" });
    }
    return { root: temporary, database: path.join(temporary, "packages/database"), files };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

interface PrismaEnvelope {
  ok: boolean;
  result?: Record<string, unknown>;
  diagnostics?: unknown[];
  error?: { code?: string; message?: string; summary?: string; why?: string; fix?: string };
}

async function runPrisma(root: string, overlay: Overlay, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  let stdout = "";
  try {
    const result = await runFile(process.execPath, [path.join(root, "node_modules/prisma/dist/prisma.js"), ...args, "--json", "--no-interactive"], {
      cwd: overlay.database, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal,
      // Offline commands still load config. Do not inherit DB URLs, AWS credentials, or private process inputs.
      env: { PATH: process.env.PATH, HOME: overlay.root, USERPROFILE: overlay.root, TMPDIR: overlay.root,
        DO_NOT_TRACK: "1", PRISMA_DISABLE_TELEMETRY: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", NO_COLOR: "1" },
    });
    stdout = result.stdout;
  } catch (error) {
    if (signal?.aborted) throw new EditError(409, "Migration planning was cancelled. Source, migration history and database were not changed.");
    const failure = error as { stdout?: string };
    stdout = failure.stdout ?? "";
    const envelope = parseEnvelope(stdout);
    const detail = envelope?.error;
    throw new EditError(422, `${detail?.code ? `${detail.code}: ` : ""}${detail?.summary ?? detail?.message ?? "Prisma could not complete the offline plan."} ${detail?.why ?? ""} ${detail?.fix ?? "Review the schema and chosen origin, then plan again."} Source, migration history and database were not changed.`.trim());
  }
  const envelope = parseEnvelope(stdout);
  if (!envelope?.ok || !envelope.result) throw new EditError(422, "Prisma did not return a successful structured result. Nothing in the checkout or database changed.");
  return envelope.result;
}

function parseEnvelope(stdout: string): PrismaEnvelope | undefined {
  for (const line of stdout.split("\n").reverse()) {
    try { const record = object(JSON.parse(line)); if (record.kind === "result") return record.envelope as PrismaEnvelope; } catch { /* Other CLI output is never exposed. */ }
  }
  return undefined;
}

/** Offline review and guarded artifact installation. This service never contacts a database. */
export class DatabaseHistoryService {
  private readonly reviews = new Map<string, DatabaseMigrationReview>();
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}

  async load(signal?: AbortSignal): Promise<DatabaseHistory> {
    signal?.throwIfAborted();
    const history = await readDatabaseHistory(this.root);
    signal?.throwIfAborted();
    return history;
  }

  async compare(input: { from: DatabaseContractReference; to: DatabaseContractReference; source?: string }, signal?: AbortSignal): Promise<DatabaseSchemaComparison> {
    if (!input || typeof input.from !== "string" || typeof input.to !== "string") throw new EditError(400, "Choose both a baseline and a proposed semantic schema to compare.");
    const history = await this.load();
    const source = readText(this.root, CONTRACT_FILE);
    const compiled = await compileDatabaseSource(this.root, source, signal);
    const serialize = (contract: NonNullable<typeof compiled.contract>): unknown => postgresTarget.contractSerializer.serializeContract(contract as Parameters<typeof postgresTarget.contractSerializer.serializeContract>[0]);
    const resolve = async (reference: string): Promise<unknown | null> => {
      if (reference === "empty") return null;
      if (reference === "saved") {
        if (!compiled.contract) throw new EditError(422, "Saved source does not validate. Fix its Prisma diagnostics before comparing semantic contracts.");
        return serialize(compiled.contract);
      }
      if (reference === "draft" && typeof input.source === "string") {
        const draft = await compileDatabaseSource(this.root, input.source, signal);
        if (!draft.contract) throw new EditError(422, "The draft does not validate. Its text is preserved; fix the diagnostics before comparing semantic contracts.");
        return serialize(draft.contract);
      }
      if (!HASH.test(reference)) throw new EditError(400, "Choose saved source, the draft, empty storage, or a full historical snapshot hash.");
      const snapshot = history.snapshots.find((entry) => entry.hash === reference && entry.available);
      if (!snapshot) throw new EditError(409, "That historical snapshot is unavailable. Select an intact semantic contract; Studio cannot fabricate historical source.");
      return snapshot.contract;
    };
    const before = await resolve(input.from);
    const after = await resolve(input.to);
    if (historyRevision(databaseHistoryFiles(this.root)) !== history.revision || sha256(readText(this.root, CONTRACT_FILE)) !== history.sourceHash) throw new EditError(409, "Source or migration history changed during comparison. Refresh and compare again.");
    return { from: input.from, to: input.to, historyRevision: history.revision, sourceHash: history.sourceHash,
      ...(typeof input.source === "string" && [input.from, input.to].includes("draft") ? { draftSourceHash: sha256(input.source) } : {}),
      ...compareDatabaseContracts(before, after, [compiled.config.target!, compiled.config.adapter!, ...compiled.config.extensions ?? []] as ReadonlyArray<TargetBoundComponentDescriptor<"sql", string>>), limitations: snapshotLimitations, observedAt: new Date().toISOString() };
  }

  async plan(input: { name: string; from: string; expectedSourceHash: string; expectedHistoryRevision: string }, signal?: AbortSignal): Promise<DatabaseMigrationReview> {
    if (!input || typeof input.name !== "string" || typeof input.from !== "string" || typeof input.expectedSourceHash !== "string" || typeof input.expectedHistoryRevision !== "string") throw new EditError(400, "Choose a migration name and explicit baseline from the current saved source and history review.");
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.name)) throw new EditError(400, "Name the migration with a short lowercase label, for example add_project_summary.");
    const history = await this.load();
    if (history.sourceHash !== input.expectedSourceHash || history.revision !== input.expectedHistoryRevision) throw new EditError(409, "Saved source or migration history changed. Refresh before planning.");
    if (history.issues.some((entry) => ["hashMismatch", "providedInvariantsMismatch", "packageUnloadable", "snapshotUnavailable", "invalidRef"].includes(entry.code))) throw new EditError(409, "Migration history has integrity problems. Review the highlighted files before planning; Studio has not repaired or changed them.");
    if (input.from !== "empty" && (!HASH.test(input.from) || !history.migrations.some((migration) => migration.space === "app" && (migration.to === input.from || migration.from === input.from)))) throw new EditError(400, "Select an explicit origin from the known migration graph. A folder's creation date or an orphan snapshot cannot establish the origin.");
    const source = readText(this.root, CONTRACT_FILE);
    const files = databaseHistoryFiles(this.root);
    const overlay = await createOverlay(this.root, source, files);
    try {
      await runPrisma(this.root, overlay, ["contract", "emit"], signal);
      const result = await runPrisma(this.root, overlay, ["migration", "plan", "--name", input.name, "--from", input.from === "empty" ? "@empty" : input.from], signal);
      if (historyRevision(databaseHistoryFiles(this.root)) !== history.revision || sha256(readText(this.root, CONTRACT_FILE)) !== history.sourceHash) throw new EditError(409, "Source or history changed while Prisma planned. The disposable plan was discarded; the checkout and database were not changed.");
      const artifacts: DatabaseMigrationArtifact[] = [];
      const plannedFiles = databaseHistoryFiles(overlay.root);
      for (const [file, contents] of plannedFiles) {
        if (file === CONFIG_FILE || files.get(file) === contents) continue;
        if (files.has(file)) throw new EditError(409, "Prisma proposed modifying an existing migration artifact. Studio refuses to rewrite history; nothing was installed.");
        if (!new RegExp(`^${MIGRATIONS_DIRECTORY}/(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(?:migration\\.ts|migration\\.json|ops\\.json)|snapshots/[a-f0-9]{64}/contract\\.(?:json|d\\.ts))$`).test(file)) throw new EditError(409, "Prisma proposed an unsupported artifact or ref write. Review this plan with the CLI; nothing was installed.");
        artifacts.push({ path: file, contents, hash: sha256(contents) });
      }
      const plannedHistory = await readDatabaseHistory(overlay.root);
      const newMigrations = plannedHistory.migrations.filter((migration) => !history.migrations.some((existing) => existing.id === migration.id));
      const now = new Date();
      const review: DatabaseMigrationReview = { id: randomUUID(), sourceHash: history.sourceHash, historyRevision: history.revision,
        from: typeof result.from === "string" ? result.from : null, to: String(result.to), noOp: result.noOp === true,
        summary: String(result.summary ?? "Review the generated migration artifacts."), operations: newMigrations.flatMap((migration) => migration.operations), artifacts,
        pendingPlaceholders: result.pendingPlaceholders === true || newMigrations.some((migration) => migration.pendingPlaceholders),
        warnings: [...Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === "string") : [],
          ...(result.pendingPlaceholders === true ? ["This migration needs an authored data transformation. The emitted operation list is incomplete until migration.ts placeholders are filled and self-emitted. Do not apply it yet."] : []),
          ...(input.from === "empty" && history.migrations.length ? ["This plan deliberately starts from empty storage even though migration history exists. It is not a forward path from an existing database marker."] : []),
          ...snapshotLimitations.slice(1)],
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        effects: { source: "unchanged", migrations: "review-only", database: "not-contacted" } };
      this.reviews.set(review.id, review);
      for (const [id, existing] of this.reviews) if (Date.parse(existing.expiresAt) <= Date.now()) this.reviews.delete(id);
      return review;
    } finally { await rm(overlay.root, { recursive: true, force: true }); }
  }

  install(input: { reviewId: string }): Promise<DatabaseMigrationInstallResult> {
    if (!input || typeof input.reviewId !== "string") return Promise.reject(new EditError(400, "Select an existing migration review before saving its artifacts."));
    const operation = this.mutation.then(() => this.installReviewed(input));
    this.mutation = operation.catch(() => undefined);
    return operation;
  }

  discard(reviewId: string): void { this.reviews.delete(reviewId); }

  private async installReviewed(input: { reviewId: string }): Promise<DatabaseMigrationInstallResult> {
    const review = this.reviews.get(input.reviewId);
    if (!review || Date.parse(review.expiresAt) <= Date.now()) throw new EditError(409, "This migration review expired or was discarded. Plan again; nothing was written.");
    if (sha256(readText(this.root, CONTRACT_FILE)) !== review.sourceHash || historyRevision(databaseHistoryFiles(this.root)) !== review.historyRevision) throw new EditError(409, "Saved source or migration history changed after review. Plan again; nothing was written.");
    for (const artifact of review.artifacts) {
      assertPath(this.root, artifact.path, true);
      if (existsSync(path.join(this.root, artifact.path)) || sha256(artifact.contents) !== artifact.hash) throw new EditError(409, "A reviewed artifact changed or its destination now exists. Nothing was written; plan again.");
    }
    const written: DatabaseMigrationArtifact[] = [];
    const createdDirectories = new Set<string>();
    try {
      for (const artifact of review.artifacts) {
        // Recheck every parent at the write boundary. Creation is exclusive and never overwrites history.
        assertPath(this.root, artifact.path, true);
        let parent = path.dirname(path.join(this.root, artifact.path));
        while (parent !== path.join(this.root, MIGRATIONS_DIRECTORY) && !existsSync(parent)) {
          createdDirectories.add(parent);
          parent = path.dirname(parent);
        }
        writeSourceChange(this.root, path.join(this.root, artifact.path), null, artifact.contents);
        written.push(artifact);
      }
      this.reviews.delete(review.id);
      return { status: review.noOp ? "no-op" : "installed", written: written.map((entry) => entry.path),
        message: review.noOp ? "No storage migration is needed. Source, migration history and database were unchanged."
          : `Installed ${written.length} reviewed migration artifacts. ${review.pendingPlaceholders ? "Fill the data transformation placeholders and self-emit before applying. " : ""}No database was contacted.`,
        effects: { source: "unchanged", database: "not-contacted" } };
    } catch {
      let unconfirmed = false;
      for (const artifact of [...written].reverse()) {
        try {
          if (sourceContents(path.join(this.root, artifact.path)) !== artifact.contents) { unconfirmed = true; continue; }
          writeSourceChange(this.root, path.join(this.root, artifact.path), artifact.contents, null);
        } catch { unconfirmed = true; }
      }
      // Remove only directories this attempt created, and only when they are still empty.
      for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
        try { rmdirSync(directory); } catch { /* Concurrent files and nonempty directories remain untouched. */ }
      }
      this.reviews.delete(review.id);
      return { status: unconfirmed ? "unconfirmed" : "restored", written: written.map((entry) => entry.path),
        message: unconfirmed ? "Artifact installation stopped. Some files changed concurrently and were preserved; inspect the listed paths. Authored source and database were unchanged."
          : "Artifact installation failed. Files created by this attempt were removed; authored source and database were unchanged.",
        effects: { source: "unchanged", database: "not-contacted" } };
    }
  }
}
