import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { computeExecutionHash } from "@prisma/orm-framework/contract/hashing";
import type { ContractSourceDiagnostic, PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable, isPrismaNextSchema, mapPslDiagnostics } from "@prisma/orm-framework/psl-parser";
import { format as formatPrisma } from "@prisma/orm-framework/psl-parser/format";
import { hasPslInterpreter, withSeedDiagnostics } from "@prisma/orm-framework/psl-parser/interpret";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { notOk } from "@prisma/orm-framework/utils/result";
import { parseCompose } from "../../packages/framework/scripts/compose-services";
import type { DatabaseDiagnostic, DatabaseObservation, DatabaseSaveResult, DatabaseSourceReview, DatabaseTarget, DatabaseValidation, DatabaseWorkbench } from "../shared/database-workbench";
import type { DatabaseHistory } from "../shared/database-history";
import type { ControlClient } from "@prisma/orm-postgres/control";
import { CONTRACT_FILE, parseDeclaredSchema } from "./database";
import { EditError, writeSourceChange } from "./edits/io";
import { sha256 } from "./files";
import { repositoryTargets } from "@repo/framework/deploy/node";
import { execFileSync } from "node:child_process";
import { configurationSourceFiles } from "../../packages/database/scripts/configuration-inputs";

const CONFIG_FILE = "packages/database/prisma.config.ts";
const MAX_SOURCE = 512 * 1024;
const REVIEW_TTL = 15 * 60_000;
const configurationSalt = randomBytes(32);
// Prisma's authored config loads dotenv into process.env. Only a value that
// existed before that load is a genuine shell override of fresh root .env.
const inheritedPostgresHostPort = process.env.POSTGRES_HOST_PORT;

/** Compose resolves its own merges/interpolation without starting an engine or container. */
function effectivePostgres(root: string) {
  const replacement = process.env.FRAMEWORK_DOCKER_CLI;
  const output = execFileSync(replacement ? process.execPath : "docker", [...(replacement ? [replacement] : []), "compose", "config", "--format", "json"], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const service = parseCompose(output).services?.postgres;
  if (!service) throw new Error("No effective PostgreSQL service");
  return { environment: service.environment, ports: service.ports };
}

/** Private values contribute only through a per-process keyed digest, never browser-readable hashes. */
export function databaseConfigurationRevision(root: string, files?: Set<string>): string {
  const digest = createHmac("sha256", configurationSalt);
  const visit = (file: string) => {
    files?.add(file);
    if (!existsSync(file)) { digest.update(file + ":missing\n"); return; }
    const contents = readFileSync(file, "utf8"); digest.update(file + "\0" + contents + "\0");
  };
  for (const file of configurationSourceFiles(root)) visit(file);
  for (const relative of [".env", "packages/database/.env"]) visit(path.join(root, relative));
  // Authored config may condition extension composition on inherited environment.
  for (const name of Object.keys(process.env).sort()) digest.update(name + "\0" + process.env[name] + "\0");
  return digest.digest("hex");
}

/** Server-only watch inputs; contains paths, never dotenv or environment values. */
export function databaseConfigurationSourceFiles(root: string): readonly string[] {
  const files = new Set<string>();
  databaseConfigurationRevision(root, files);
  return [...files];
}

function checkSource(source: unknown): asserts source is string {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SOURCE) throw new EditError(400, "A schema draft must be text smaller than 512 KiB. Nothing was saved.");
}

function rangedDiagnostic(diagnostic: ContractSourceDiagnostic, length: number): DatabaseDiagnostic {
  const from = Math.min(length, Math.max(0, diagnostic.span?.start.offset ?? 0));
  return { from, to: Math.min(length, Math.max(from + 1, diagnostic.span?.end.offset ?? from + 1)), severity: diagnostic.severity ?? "error", code: diagnostic.code, message: diagnostic.message };
}

function isSourceDiagnostic(value: unknown): value is ContractSourceDiagnostic {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string" && "sourceId" in value && typeof value.sourceId === "string";
}

/** Load the actual authored Prisma config. Never construct a second set of target/extension settings. */
export async function databasePrismaConfig(root: string): Promise<PrismaNextConfig> {
  const { loadConfig, requireConfigSections } = await import("@prisma/orm-toolchain/config-loader");
  const loaded = await loadConfig(path.join(root, CONFIG_FILE), { cwd: path.join(root, "packages/database") });
  if (!loaded.ok) throw new EditError(422, `Prisma configuration could not be loaded. Check ${CONFIG_FILE}. Nothing was saved.`);
  const required = requireConfigSections(loaded.value, ["family", "target", "adapter", "extensions", "contract"]);
  if (!required.ok) throw new EditError(422, `Prisma configuration is invalid. Check ${CONFIG_FILE}. Nothing was saved.`);
  const config = required.value;
  if (config.target.targetId !== "postgres" || !config.contract || config.contract.source.inputs?.length !== 1 || path.resolve(config.contract.source.inputs[0]!) !== path.join(root, CONTRACT_FILE)) {
    throw new EditError(422, `This workbench supports the single authored PostgreSQL contract at ${CONTRACT_FILE}. Review the Prisma configuration in your editor.`);
  }
  return config;
}

export interface CompiledDatabaseSource {
  readonly validation: DatabaseValidation;
  readonly contract?: Contract;
  readonly config: PrismaNextConfig;
  readonly configRevision: string;
}

/**
 * Canonical Prisma source loading, with the exact draft replacing the one source
 * provider's disk read. The provider's interpreter and the canonical control
 * stack own semantics. No output is emitted, no file is written, no DB connects.
 */
export async function compileDatabaseSource(root: string, source: string, signal?: AbortSignal): Promise<CompiledDatabaseSource> {
  checkSource(source);
  signal?.throwIfAborted();
  const config = await databasePrismaConfig(root);
  const configRevision = databaseConfigurationRevision(root);
  const { loadContractSource } = await import("@prisma/orm-toolchain/cli/control-api");
  const provider = config.contract!.source;
  if (!hasPslInterpreter(provider)) throw new EditError(422, "The configured Prisma source does not expose the Prisma 8 interpreter. Open this contract in your editor.");
  const warnings: ContractSourceDiagnostic[] = [];
  const draftProvider = {
    ...provider,
    async load(context: Parameters<typeof provider.load>[0]) {
      if (!isPrismaNextSchema(source)) return notOk({ summary: "The Prisma 8 directive is required.", diagnostics: [{ code: "PSL_NO_OPTED_IN_SCHEMA_FILES", message: 'Add "// use prisma-8" at the beginning of this Prisma 8 contract.', sourceId: CONTRACT_FILE }] });
      const parsed = parse(source, CONTRACT_FILE);
      const symbols = buildSymbolTable({ documents: [parsed.document], sources: parsed.sources });
      const seed = mapPslDiagnostics([...parsed.diagnostics, ...symbols.diagnostics], parsed.sources);
      return withSeedDiagnostics(provider.interpret({ documents: [parsed.document], sources: parsed.sources, symbolTable: symbols.symbolTable }, context), seed);
    },
  };
  const result = await loadContractSource({ ...config, contract: { ...config.contract!, source: draftProvider } }, { signal, onWarning: warning => {
    if (isSourceDiagnostic(warning)) warnings.push(warning);
  } });
  signal?.throwIfAborted();
  if (databaseConfigurationRevision(root) !== configRevision) throw new EditError(409, "Prisma configuration changed during validation. Validate the draft again; nothing was written.");
  const diagnostics = [...(result.ok ? [] : result.failure.diagnostics), ...warnings].filter(isSourceDiagnostic).map(item => rangedDiagnostic(item, source.length));
  const contract = result.ok ? result.value : undefined;
  return {
    config, configRevision, contract,
    validation: {
      sourceHash: sha256(source), valid: result.ok, diagnostics,
      ...(contract ? { schema: parseDeclaredSchema(source), storageHash: contract.storage.storageHash, executionHash: contract.execution?.executionHash } : {}),
      validatedAt: new Date().toISOString(),
    },
  };
}

/** Separate, fixed PSL authority; generic framework config writers remain unchanged. */
export function databaseContractPath(root: string): string {
  const canonicalRoot = realpathSync(root);
  let current = canonicalRoot;
  for (const segment of CONTRACT_FILE.split("/")) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "The authored contract uses a symbolic link. Save it in your editor; Studio does not write through links.");
  }
  if (path.relative(canonicalRoot, realpathSync(current)) !== CONTRACT_FILE) throw new EditError(422, "The contract resolves outside its fixed source authority.");
  return current;
}

export interface PrivateDatabaseTarget { readonly public: DatabaseTarget; readonly connection?: string }

/** Resolve only the declared Compose PostgreSQL binding; never inherit DATABASE_URL. */
export function resolvePrivateDatabaseTargets(root: string): readonly PrivateDatabaseTarget[] {
  let local: PrivateDatabaseTarget;
  let handoffs: NonNullable<DatabaseTarget["handoffs"]> = [];
  try { handoffs = repositoryTargets(root).filter(target => target.mode === "prod").map(target => ({ deployment: target.name, account: target.account, region: target.region, command: `npm run db:migrate:cloud -- --deployment ${target.name} -c deployment=${target.name} --profile <PROFILE>${target.region ? ` --region ${target.region}` : ""}`, detail: "Separately authorized database write: launches the declared db-migrate task inside its VPC with direct IAM/TLS access. Review migration SQL and old/new application compatibility first; task logs and exit code establish execution outcome." })); } catch { /* Invalid target catalogs remain an explicit setup prerequisite. */ }
  const production: PrivateDatabaseTarget = { public: { id: "production", label: "Production RDS", available: false, identity: sha256(JSON.stringify(["production-task-review-v1", handoffs])), handoffs, detail: "Production database access uses the declared VPC db-migrate task with private-database IAM/TLS access. Select a named deployment and profile below, check the deployed task destination, then explicitly authorize a billed read-only task. Applying reviewed SQL requires a separate approval. Direct local inspection is unavailable; Studio never opens database ingress or accepts connection URLs." } };
  try {
    const compose = parseCompose(readFileSync(path.join(root, "docker-compose.yml"), "utf8"));
    const override = path.join(root, "docker-compose.override.yml");
    const postgresOverride = existsSync(override) ? parseCompose(readFileSync(override, "utf8")).services?.postgres : undefined;
    // Non-identity overrides do not change the safely established connection.
    // Identity-changing Compose merge/interpolation remains fail-closed until
    // its effective binding can be established; never silently use base ports.
    const safeOverrideKeys = new Set(["healthcheck", "restart", "labels", "logging", "deploy", "mem_limit", "cpus", "shm_size", "stop_grace_period"]);
    let postgres: { environment?: unknown; ports?: unknown } | undefined = compose.services?.postgres;
    let effective = false;
    if (postgresOverride && Object.keys(postgresOverride).some(key => !safeOverrideKeys.has(key))) {
      try {
        postgres = effectivePostgres(root); effective = true;
      } catch {
        return [{ public: { id: "local:postgres", label: "Local PostgreSQL", available: false, identity: sha256("unsupported-postgres-override"), detail: "Compose overrides PostgreSQL and its effective configuration could not be resolved. Install the Compose CLI and resolve docker compose config errors, then refresh. Studio does not start containers or expose connection values." } }, production];
      }
    }
    const environment = postgres?.environment;
    const env = Array.isArray(environment) ? Object.fromEntries(environment.flatMap(item => typeof item === "string" && item.includes("=") ? [[item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]] : [])) : environment;
    const inputs = existsSync(path.join(root, ".env")) ? parseEnv(readFileSync(path.join(root, ".env"), "utf8")) : {};
    const effectiveBinding = effective && Array.isArray(postgres?.ports) ? postgres.ports.find((value: unknown) => !!value && typeof value === "object" && (value as Record<string, unknown>).host_ip === "127.0.0.1" && Number((value as Record<string, unknown>).target) === 5432 && ((value as Record<string, unknown>).protocol ?? "tcp") === "tcp") as Record<string, unknown> | undefined : undefined;
    const portInput = effective ? String(effectiveBinding?.published ?? "") : inheritedPostgresHostPort ?? inputs.POSTGRES_HOST_PORT;
    const ports = postgres?.ports;
    if (!postgres || !env || !Array.isArray(ports) || (effective ? !effectiveBinding || ports.some((value: unknown) => !!value && typeof value === "object" && Number((value as Record<string, unknown>).target) === 5432 && (value as Record<string, unknown>).host_ip !== "127.0.0.1") : !ports.some(value => value === "127.0.0.1:${POSTGRES_HOST_PORT}:5432")) || !portInput || !/^\d+$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535) throw new Error("Unsupported Compose connection");
    const value = (key: string) => { const raw = (env as Record<string, unknown>)[key]; if (typeof raw !== "string" || raw.includes("${")) throw new Error("Nonliteral Compose connection"); return raw; };
    const connection = new URL(`postgresql://127.0.0.1:${Number(portInput)}`);
    connection.username = value("POSTGRES_USER"); connection.password = value("POSTGRES_PASSWORD"); connection.pathname = `/${value("POSTGRES_DB")}`;
    // Enforce read-only at the PostgreSQL session level as well as API selection.
    connection.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=15000");
    connection.searchParams.set("connect_timeout", "5");
    local = { public: { id: "local:postgres", label: "Local PostgreSQL", available: true, identity: createHmac("sha256", configurationSalt).update(connection.toString()).digest("hex"), detail: `Compose postgres · loopback port ${Number(portInput)} · existing database only` }, connection: connection.toString() };
  } catch {
    local = { public: { id: "local:postgres", label: "Local PostgreSQL", available: false, identity: sha256("unconfigured-local"), detail: "Set POSTGRES_HOST_PORT in root .env and use the declared loopback Compose binding. Studio never starts Compose." } };
  }
  return [local, production];
}

const OBSERVATION_LIMITS = [
  "Prisma strict schema verification covers modeled storage objects; it does not establish data correctness, backfill completion, or downstream application compatibility.",
  "PostgreSQL views, triggers, functions and other unsupported objects may require separate review.",
  "A matching marker alone is not physical-schema evidence. Creation and application timestamps have different meanings.",
];

export type DatabaseInspectionClient = Pick<ControlClient, "connect" | "close" | "readMarker" | "readLedger" | "schemaVerify">;

async function emittedContractEvidence(root: string, compiled: CompiledDatabaseSource): Promise<DatabaseWorkbench["emitted"]> {
  const output = compiled.config.contract?.output;
  const relative = output ? path.relative(root, output).replaceAll("\\", "/") : "";
  const base = { file: relative && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : "Configured generated contract", observedAt: new Date().toISOString(), revision: "missing" };
  if (!output) return { ...base, status: "missing", message: "The Prisma configuration does not name emitted output. No artifacts were generated." };
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return { ...base, status: "unknown", message: "Configured output is outside this checkout. Review it in your editor; Studio did not read or write that file." };
  if (!existsSync(output)) return { ...base, status: "missing", message: "Emitted contract artifacts are missing. Generate separately after reviewing saved source; no migration or database change is implied." };
  try {
    let component = root;
    for (const segment of relative.split("/")) { component = path.join(component, segment); if (lstatSync(component).isSymbolicLink()) throw new Error("Linked generated artifact"); }
    if (lstatSync(output).size > 5 * 1024 * 1024) throw new Error("Generated artifact too large");
    const contents = readFileSync(output, "utf8");
    const json = JSON.parse(contents);
    const contract = compiled.config.target.contractSerializer.deserializeContract(json);
    const { createSnapshotContentVerifier } = await import("@prisma/orm-postgres/migration-tools/contract-snapshot-store");
    createSnapshotContentVerifier(compiled.config.target.contractSerializer.hashCanonicalizationHooks).assertSnapshotContentMatches(json, contract.storage.storageHash, output);
    const execution = json.execution;
    if (execution) {
      const { executionHash, ...body } = execution;
      if (computeExecutionHash({ target: contract.target, targetFamily: contract.targetFamily, execution: body }) !== executionHash) throw new Error("Invalid emitted execution hash");
    }
    const evidence = { ...base, revision: sha256(contents), storageHash: contract.storage.storageHash, executionHash: contract.execution?.executionHash };
    if (!compiled.validation.valid) return { ...evidence, status: "unknown", message: "Emitted artifact integrity is valid, but saved source is invalid and cannot provide a comparison baseline." };
    const storageMatches = contract.storage.storageHash === compiled.validation.storageHash;
    const executionMatches = contract.execution?.executionHash === compiled.validation.executionHash;
    return { ...evidence, status: storageMatches && executionMatches ? "matches" : "differs", storageMatches, executionMatches,
      message: storageMatches && executionMatches ? "Emitted storage and execution hashes match saved source. This does not establish migration or live database state." : storageMatches ? "Saved execution behavior differs from generated artifacts, while storage matches. Regenerate artifacts separately; storage SQL may be unnecessary." : "Saved storage differs from generated artifacts. Generate separately, then review a migration plan; no artifact or database has been changed." };
  } catch { return { ...base, status: "invalid", message: "The emitted contract is unreadable, invalid, linked, too large, or does not reproduce its canonical storage/execution hashes. Regenerate artifacts separately from reviewed saved source." }; }
}

export class DatabaseWorkbenchService {
  readonly ownWrites = new Map<string, string>();
  private readonly reviews = new Map<string, DatabaseSourceReview>();
  private readonly compiled = new Map<string, CompiledDatabaseSource>();
  private saving = false;

  constructor(readonly root: string, private readonly refresh?: () => Promise<unknown>, private readonly inspectionClient?: (connection: string, config: PrismaNextConfig) => DatabaseInspectionClient) {}

  async compile(source: string, signal?: AbortSignal): Promise<CompiledDatabaseSource> {
    checkSource(source);
    // Config identity is part of every cache key; source text is never keyed by a generation alone.
    const key = databaseConfigurationRevision(this.root) + ":" + sha256(source);
    signal?.throwIfAborted();
    const existing = this.compiled.get(key);
    if (existing) return existing;
    const result = await compileDatabaseSource(this.root, source, signal);
    if (this.compiled.size >= 12) this.compiled.delete(this.compiled.keys().next().value!);
    this.compiled.set(result.configRevision + ":" + sha256(source), result);
    return result;
  }

  async load(): Promise<DatabaseWorkbench> {
    const source = readFileSync(databaseContractPath(this.root), "utf8");
    const compiled = await this.compile(source);
    const { validation, configRevision } = compiled;
    return { file: CONTRACT_FILE, source, revision: sha256(source), configRevision, validation,
      capabilities: { dialect: "Prisma 8 · installed 8.0.0-rc.14", semanticValidation: true, formatting: true, languageServer: false,
        notes: ["Validation and formatting use the installed Prisma 8 parser and configured PostgreSQL interpreter.", "Completion provides syntax and local model suggestions. A compatible distributable language server is not exported by the installed packages; semantic completion, refactoring and safe rename are unavailable.", "The diagram is a projection. Valid declarations outside its supported surface remain accessible in source."] },
      targets: resolvePrivateDatabaseTargets(this.root).map(target => target.public), emitted: await emittedContractEvidence(this.root, compiled) };
  }

  async validate(source: string, signal?: AbortSignal): Promise<DatabaseValidation> { return (await this.compile(source, signal)).validation; }

  async format(source: string): Promise<{ source: string; sourceHash: string; formattedHash: string }> {
    checkSource(source);
    if (parse(source, CONTRACT_FILE).diagnostics.length) throw new EditError(422, "Fix the draft syntax diagnostics before formatting. Your text and undo history are unchanged.");
    const config = await databasePrismaConfig(this.root);
    const formatted = formatPrisma(source, config.formatter);
    return { source: formatted, sourceHash: sha256(source), formattedHash: sha256(formatted) };
  }

  async review(source: string, expectedRevision: string): Promise<DatabaseSourceReview> {
    checkSource(source);
    const before = readFileSync(databaseContractPath(this.root), "utf8");
    if (sha256(before) !== expectedRevision) throw new EditError(409, "Saved source changed outside this draft. Your draft is preserved. Compare it with the new saved source before reviewing again.");
    if (source === before) throw new EditError(422, "The draft already matches saved source. Nothing needs saving.");
    const { validation, configRevision } = await this.compile(source);
    if (!validation.valid) throw new EditError(422, "The draft has Prisma diagnostics. Fix them before reviewing a source save. Nothing was written.");
    if (sha256(readFileSync(databaseContractPath(this.root), "utf8")) !== expectedRevision) throw new EditError(409, "Source changed during validation. Your draft is preserved; review the new saved source.");
    const now = Date.now();
    for (const [id, item] of this.reviews) if (Date.parse(item.expiresAt) <= now) this.reviews.delete(id);
    if (databaseConfigurationRevision(this.root) !== configRevision) throw new EditError(409, "Prisma configuration changed while reviewing source. Validate and review again; nothing was saved.");
    const review: DatabaseSourceReview = { reviewId: randomUUID(), file: CONTRACT_FILE, before, after: source, expectedRevision, configRevision, sourceHash: sha256(source), expiresAt: new Date(now + REVIEW_TTL).toISOString(), validation,
      effects: ["Writes only the authored contract.prisma source after this review.", "Does not emit generated artifacts, create a migration, connect to a database, or apply storage changes.", "After saving, review downstream types, repositories, GraphQL authorization and client impact; generation remains a separate action."] };
    this.reviews.set(review.reviewId, review);
    return review;
  }

  async save(reviewId: string): Promise<DatabaseSaveResult> {
    if (this.saving) throw new EditError(409, "Another source save is running. Retry after it completes.");
    const review = this.reviews.get(reviewId);
    if (!review || Date.parse(review.expiresAt) <= Date.now()) throw new EditError(409, "This source review expired. Review the draft again; nothing was saved.");
    this.saving = true;
    try {
      const file = databaseContractPath(this.root);
      if (readFileSync(file, "utf8") !== review.before) throw new EditError(409, "Saved source changed after review. Your draft is preserved. Review the new saved source before saving.");
      if (databaseConfigurationRevision(this.root) !== review.configRevision) throw new EditError(409, "The Prisma configuration changed after review. Validate and review again; nothing was saved.");
      const validation = await compileDatabaseSource(this.root, review.after);
      if (!validation.validation.valid) throw new EditError(422, "The reviewed source no longer validates with the current Prisma configuration. Nothing was saved; validate and review again.");
      if (validation.configRevision !== review.configRevision || validation.validation.storageHash !== review.validation.storageHash || validation.validation.executionHash !== review.validation.executionHash) throw new EditError(409, "The reviewed Prisma semantics changed before saving. Review again; nothing was saved.");
      writeSourceChange(this.root, file, review.before, review.after);
      this.ownWrites.set(CONTRACT_FILE, review.sourceHash);
      this.reviews.clear();
      let refreshed = true;
      try { if (this.refresh) refreshed = (await this.refresh()) !== undefined; } catch { refreshed = false; }
      return { saved: true, revision: review.sourceHash, source: review.after, file: CONTRACT_FILE, refresh: refreshed ? "complete" : "unavailable", message: refreshed ? "Authored schema saved. Generated artifacts and databases were not changed." : "Authored schema saved. The framework graph could not refresh; retry refresh. Generated artifacts and databases were not changed." };
    } finally { this.saving = false; }
  }

  async inspect(targetId: string, expectedRevision: string, historyRevision = "", history?: DatabaseHistory): Promise<DatabaseObservation> {
    const target = resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === targetId);
    if (!target) throw new EditError(400, "Choose a database target before inspection.");
    const source = readFileSync(databaseContractPath(this.root), "utf8");
    if (sha256(source) !== expectedRevision) throw new EditError(409, "Saved source changed. Reload it before inspecting this target.");
    const { contract, validation, config, configRevision } = await this.compile(source);
    const base = { id: randomUUID(), targetId: target.public.id, targetIdentity: target.public.identity, observedAt: new Date().toISOString(), savedRevision: expectedRevision, historyRevision,
      baseline: { label: "Saved authored contract", storageHash: validation.storageHash }, marker: { status: "unknown" as const }, physical: { status: "unknown" as const, issues: [], warnings: [] }, ledger: [], migrationState: { status: "unknown" as const, message: "No database migration evidence has been observed." }, limits: OBSERVATION_LIMITS };
    if (!target.public.available || !target.connection) return { ...base, status: "unsupported", message: target.public.detail };
    if (!contract) return { ...base, status: "unsupported", message: "Saved source is invalid. Fix and review a source save before comparing its storage contract with a database." };
    const { createPostgresControlClient } = await import("@prisma/orm-postgres/control");
    const client = this.inspectionClient?.(target.connection, config) ?? createPostgresControlClient({ connection: target.connection, extensions: config.extensions });
    try {
      await client.connect();
      // All operations use Prisma's read-only control capabilities. No migration modules execute.
      const marker = await client.readMarker();
      const ledger = await client.readLedger();
      const physical = await client.schemaVerify({ contract, strict: true });
      const historical = marker ? history?.snapshots.find(snapshot => snapshot.hash === marker.storageHash && snapshot.available && !snapshot.issues.length)?.contract : undefined;
      let historicalPhysical: DatabaseObservation["historicalPhysical"];
      if (marker && historical && marker.storageHash !== contract.storage.storageHash) {
        try {
          const historicalContract = config.target.contractSerializer.deserializeContract(historical);
          const checked = await client.schemaVerify({ contract: historicalContract, strict: true });
          historicalPhysical = { storageHash: marker.storageHash, status: checked.ok ? "matches" : "differs", issues: checked.schema.issues.map(issue => JSON.stringify(issue)), warnings: checked.schema.warnings?.issues.map(issue => JSON.stringify(issue)) ?? [] };
        } catch { historicalPhysical = { storageHash: marker.storageHash, status: "unknown", issues: ["The marker's historical snapshot could not be verified with the installed Prisma target."], warnings: [] }; }
      }
      const stale = sha256(readFileSync(databaseContractPath(this.root), "utf8")) !== expectedRevision || databaseConfigurationRevision(this.root) !== configRevision || resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === targetId)?.public.identity !== target.public.identity;
      const issues = physical.schema.issues.map(issue => typeof issue === "object" ? JSON.stringify(issue) : String(issue));
      const warnings = physical.schema.warnings?.issues.map(issue => typeof issue === "object" ? JSON.stringify(issue) : String(issue)) ?? [];
      const markerMatches = marker?.storageHash === contract.storage.storageHash;
      let migrationState: DatabaseObservation["migrationState"] = { status: "unknown", message: "The migration graph cannot explain this database yet. Review marker, snapshots and package integrity before selecting a baseline." };
      if (markerMatches) migrationState = { status: physical.ok ? "current" : "divergent", message: physical.ok ? "The marker and modeled physical schema match saved source." : "The marker names saved source, but physical verification found differences: schema drift exists within Prisma's modeled surface." };
      else if (historicalPhysical?.status === "differs") migrationState = { status: "divergent", message: "The physical schema differs from the known historical contract named by its marker: schema drift exists within Prisma's modeled surface." };
      else if (historicalPhysical?.status === "matches" && history && !history.issues.length && history.migrations.every(item => item.integrity === "verified" && !item.issues.length)) {
        const { hasMigrationPath } = await import("@prisma/orm-toolchain/cli/control-api");
        const edges = history.migrations.filter(item => item.space === "app").map(item => ({ from: item.from ?? "@empty", to: item.to, migrationHash: item.migrationHash, dirName: item.name, createdAt: item.createdAt, invariants: [] }));
        const forwardChain = new Map<string, typeof edges>(); const reverseChain = new Map<string, typeof edges>();
        for (const edge of edges) { forwardChain.set(edge.from, [...(forwardChain.get(edge.from) ?? []), edge]); reverseChain.set(edge.to, [...(reverseChain.get(edge.to) ?? []), edge]); }
        const reachable = hasMigrationPath({ nodes: new Set(edges.flatMap(edge => [edge.from, edge.to])), forwardChain, reverseChain, migrationByHash: new Map(edges.map(edge => [edge.migrationHash, edge])) }, marker!.storageHash, contract.storage.storageHash);
        migrationState = reachable ? { status: "pending", message: "Physical storage matches the marker's historical snapshot, and Prisma finds a forward graph path to saved source. Pending migration packages still require operation, invariant and data-transform review before execution." } : { status: "unknown", message: "Physical storage matches a known historical contract, but no recorded forward path reaches saved source. Plan from a reviewed baseline; do not assume the newest folder is the origin." };
      }
      return { ...base, status: stale ? "stale" : "observed", observedAt: new Date().toISOString(),
        marker: { status: marker ? markerMatches ? "matches" : "differs" : "missing", ...(marker ? { storageHash: marker.storageHash, updatedAt: marker.updatedAt.toISOString() } : {}) },
        physical: { status: physical.ok ? "matches" : "differs", issues, warnings },
        historicalPhysical, migrationState,
        ledger: ledger.map(item => ({ migrationHash: item.migrationHash, name: item.migrationName, from: item.from, to: item.to, appliedAt: item.appliedAt.toISOString() })),
        message: stale ? "Source or connection identity changed during inspection. Inspect again before using this evidence." : migrationState.status === "pending" || migrationState.status === "divergent" ? migrationState.message : physical.ok && markerMatches ? "The saved storage contract and marker match this database's modeled physical schema. Data and application correctness remain separate." : physical.ok ? "The modeled physical schema matches saved source, but migration marker evidence differs or is missing. Review history before selecting a migration baseline." : "The physical schema differs from saved source. A pending migration can explain this; compare the marker's historical contract before calling it drift." };
    } catch {
      // Driver and PostgreSQL error messages may embed credentials or URLs. Never return them.
      return { ...base, status: "unreachable", message: "This target could not be inspected. No database writes were requested. Confirm the existing Compose PostgreSQL is running and POSTGRES_HOST_PORT matches its published loopback port, then retry. Studio does not start Compose because startup can apply migrations." };
    } finally { try { await client.close(); } catch { /* Connection cleanup failure does not change observation evidence. */ } }
  }
}
