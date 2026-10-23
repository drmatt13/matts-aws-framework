import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ControlClient } from "@prisma/orm-toolchain/cli/control-api";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { hasMigrations, hasOperationPreview, type ControlFamilyInstance, type MigrationPlanOperation } from "@prisma/orm-framework/components/control";
import { ok } from "@prisma/orm-framework/utils/result";
import { UNBOUND_NAMESPACE_ID } from "@prisma/orm-framework/components/ir";
import { configurationSourceFiles, migrationSourceFiles } from "./configuration-inputs.js";
import type { DatabaseCloudEnvelope, DatabaseCloudRequest, DatabaseCloudReview } from "./studio-migrations-types.js";
import type { DatabaseInitializationPlan } from "./studio-migrations-types.js";
import { DATABASE_EMPTY_SQL } from "./empty-database.js";
export type { DatabaseCloudEnvelope, DatabaseCloudIdentity, DatabaseCloudRequest, DatabaseCloudReview } from "./studio-migrations-types.js";

export const DATABASE_REVIEW_PROTOCOL = 1;
export const DATABASE_REVIEW_PREFIX = "AWS_STUDIO_DATABASE_V1:";
export const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

/** Exact authored inputs bind the host review to the immutable task image. */
export function databaseMigrationSourceFiles(root: string): readonly string[] {
  const entrypoints: string[] = [];
  const directory = path.join(root, "packages/database/prisma/migrations");
  const visit = (file: string) => { if (!existsSync(file)) return; if (lstatSync(file).isSymbolicLink()) throw new Error("Linked migration source is unsupported"); if (lstatSync(file).isDirectory()) for (const name of readdirSync(file)) visit(path.join(file, name)); else if (path.basename(file) === "migration.ts") entrypoints.push(file); };
  visit(directory);
  return migrationSourceFiles(root, entrypoints);
}
export function databaseInputsDigest(root: string): string {
  const entries = new Map<string, string>();
  const add = (file: string) => {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (!existsSync(file)) { entries.set(relative, "missing"); return; }
    if (lstatSync(file).isSymbolicLink()) throw new Error("Linked database migration input is unsupported");
    if (lstatSync(file).isDirectory()) { for (const name of readdirSync(file).sort()) add(path.join(file, name)); }
    else entries.set(relative, digest(readFileSync(file, "utf8")));
    if (entries.size > 20_000) throw new Error("Database review inputs exceed the supported bound");
  };
  for (const file of configurationSourceFiles(root)) add(file);
  for (const file of databaseMigrationSourceFiles(root)) add(file);
  add(path.join(root, "packages/database/prisma"));
  return digest([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

export function readDatabaseCloudRequest(raw: string): DatabaseCloudRequest {
  const request = JSON.parse(raw) as DatabaseCloudRequest;
  if (request.version !== 1 || !/^[a-f0-9-]{16,64}$/.test(request.requestId) || !["review", "apply"].includes(request.mode) || !/^[a-z][a-z0-9-]{0,62}$/.test(request.identity?.deployment ?? "") || !/^\d{12}$/.test(request.identity?.account ?? "") || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(request.identity?.region ?? "") || !/^arn:aws(?:-us-gov)?:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/.test(request.identity?.taskDefinitionArn ?? "") || !/^[a-f0-9]{64}$/.test(request.inputsDigest) || request.mode === "apply" && !/^[a-f0-9]{64}$/.test(request.expectedDigest ?? "")) throw new Error("DATABASE_REVIEW_REQUEST_INVALID");
  const arn = request.identity.taskDefinitionArn.split(":");
  if (arn[3] !== request.identity.region || arn[4] !== request.identity.account) throw new Error("DATABASE_REVIEW_IDENTITY_MISMATCH");
  return request;
}

/** Lower the canonical runner's own control-table bootstrap without executing it. */
async function controlSql(family: ControlFamilyInstance<string, unknown>, contract: Contract) {
  if (!("bootstrapControlTableQueries" in family) || typeof family.bootstrapControlTableQueries !== "function" || !("lowerAst" in family) || typeof family.lowerAst !== "function") throw new Error("DATABASE_INITIALIZATION_PREVIEW_UNSUPPORTED");
  const postgres = family as typeof family & { bootstrapControlTableQueries(): readonly unknown[]; lowerAst(ast: unknown, context: { contract: Contract }): Promise<{ sql: string; params?: readonly unknown[] }> };
  return Promise.all(postgres.bootstrapControlTableQueries().map(async ast => { const statement = await postgres.lowerAst(ast, { contract }); return { sql: statement.sql, ...(statement.params?.length ? { params: statement.params } : {}) }; }));
}

async function nativeInitializationPlan(family: ControlFamilyInstance<string, unknown>, contract: Contract, operations: readonly MigrationPlanOperation[]): Promise<DatabaseInitializationPlan> {
  if (operations.some(operation => operation.operationClass !== "additive")) throw new Error("DATABASE_INITIALIZATION_PLAN_REFUSED");
  const statements = operations.flatMap(operation => ["precheck", "execute", "postcheck"].flatMap(phase => {
    const steps = (operation as unknown as Record<string, unknown>)[phase];
    if (!Array.isArray(steps)) throw new Error("DATABASE_INITIALIZATION_PREVIEW_UNSUPPORTED");
    return steps.map((step: { sql?: unknown; params?: unknown }) => { if (typeof step.sql !== "string" || step.params !== undefined && !Array.isArray(step.params)) throw new Error("DATABASE_INITIALIZATION_PREVIEW_UNSUPPORTED"); return { operationId: operation.id, phase, sql: step.sql, ...(Array.isArray(step.params) ? { params: step.params } : {}) }; });
  }));
  return { operations: operations.map(({ id, label, operationClass }) => ({ id, label, operationClass })), operationsDigest: digest(operations), statements, sql: hasOperationPreview(family) ? family.toOperationPreview(operations).statements.map(statement => statement.text) : [], controlSql: await controlSql(family, contract) };
}

export async function planDatabaseInitialization(root: string, config: PrismaNextConfig, contract: Contract, client: ControlClient, empty: () => Promise<boolean>, createReadClient: (config: PrismaNextConfig) => ControlClient): Promise<DatabaseInitializationPlan> {
  if ((await client.readAllMarkers()).size || (await client.readLedger()).length || !await empty()) throw new Error("DATABASE_INITIALIZATION_REQUIRES_EMPTY");
  const target = config.target; if (!hasMigrations(target)) throw new Error("DATABASE_INITIALIZATION_PREVIEW_UNSUPPORTED");
  let captured: DatabaseInitializationPlan | undefined;
  // The canonical planner can expose complete native operations only at its
  // runner boundary. Replace that runner entirely, while the connection stays
  // read-only. No real runner is constructed and no DDL/marker write executes.
  const captureTarget: typeof target = { ...target, migrations: { ...target.migrations, createRunner(family) { return { async execute(options) {
    const operations = await Promise.all(options.perSpaceOptions.flatMap(space => space.plan.operations));
    captured = await nativeInitializationPlan(family, contract, operations);
    return ok({ perSpaceResults: options.perSpaceOptions.map(space => ({ space: space.space, value: { operationsPlanned: 0, operationsExecuted: 0 } })) });
  } }; } } };
  const probe = createReadClient({ ...config, target: captureTarget });
  try { await probe.connect(); const planned = await probe.dbInit({ contract, mode: "apply", migrationsDir: path.join(root, "packages/database/prisma/migrations") }); if (!planned.ok || !captured) throw new Error("DATABASE_INITIALIZATION_PREVIEW_UNSUPPORTED"); return captured; }
  finally { await probe.close(); }
}

/** Capture only structured, reviewed source/SQL. No connection values or row data. */
export async function reviewCloudDatabase(root: string, request: DatabaseCloudRequest, config: PrismaNextConfig, contract: Contract, client: ControlClient, selected: DatabaseCloudReview["migrations"], empty?: () => Promise<boolean>, initializationClient?: (config: PrismaNextConfig) => ControlClient): Promise<DatabaseCloudReview> {
  if (databaseInputsDigest(root) !== request.inputsDigest) throw new Error("DATABASE_TASK_SOURCE_STALE");
  const marker = await client.readMarker();
  let initialization: DatabaseInitializationPlan | undefined;
  if (!marker) {
    if (!empty || !initializationClient) throw new Error("DATABASE_MARKER_UNKNOWN");
    initialization = await planDatabaseInitialization(root, config, contract, client, empty, initializationClient);
    selected = [];
  } else {
    const snapshotFile = path.join(root, "packages/database/prisma/migrations/snapshots", marker.storageHash, "contract.json");
    if (!/^[a-f0-9]{64}$/.test(marker.storageHash) || !existsSync(snapshotFile)) throw new Error("DATABASE_HISTORICAL_CONTRACT_MISSING");
    const historical = config.target.contractSerializer.deserializeContract(JSON.parse(readFileSync(snapshotFile, "utf8")));
    const physical = await client.schemaVerify({ contract: historical, strict: true });
    if (!physical.ok) throw new Error("DATABASE_PHYSICAL_DRIFT");
  }
  const markers = [...await client.readAllMarkers()].sort(([a], [b]) => a.localeCompare(b));
  const helpers = databaseMigrationSourceFiles(root).filter(file => existsSync(file) && path.relative(path.join(root, "packages/database/prisma"), file).split(path.sep).includes("..") && /\.[cm]?[jt]s$/.test(file) && !/\.d\.ts$/.test(file)).map(file => ({ file: path.relative(root, file).replace(/\\/g, "/"), source: readFileSync(file, "utf8") }));
  const value = { version: 1 as const, kind: initialization ? "initialize" as const : "migrate" as const, ...(initialization ? { initialization } : {}), identity: request.identity, inputsDigest: request.inputsDigest, markerHash: marker?.storageHash ?? "@empty", markerIdentity: digest(markers), ledgerIdentity: digest(await client.readLedger()), storageHash: contract.storage.storageHash, helpers, migrations: selected };
  return { ...value, digest: digest(value) };
}

/** Pinned PostgreSQL runner adapter. Acquire its same per-space transaction
 * locks immediately after BEGIN, then verify origin on that same connection,
 * before control-table DDL or migration SQL. Unknown transaction protocols fail
 * closed. The canonical runner still owns policy, execution and commit/rollback.
 */
export function guardCloudDatabasePath(config: PrismaNextConfig, review: Pick<DatabaseCloudReview, "kind" | "initialization" | "migrations" | "markerIdentity" | "ledgerIdentity">, assertInputs: () => void, historical?: Contract): PrismaNextConfig {
  const target = config.target;
  if (!hasMigrations(target)) throw new Error("DATABASE_RUNNER_UNSUPPORTED");
  const expected = review.migrations.map(({ spaceId, dirName, migrationHash, from, to }) => ({ spaceId, dirName, migrationHash, from, to }));
  const guardedTarget: typeof target = { ...target, migrations: { ...target.migrations, createRunner(family) {
    const runner = target.migrations.createRunner(family);
    return { async execute(options) {
      assertInputs();
      const actual = options.perSpaceOptions.flatMap(space => space.migrationEdges.map(edge => ({ spaceId: space.space, dirName: edge.dirName, migrationHash: edge.migrationHash, from: edge.from, to: edge.to })));
      if (review.kind === "initialize") {
        if (!review.initialization) throw new Error("DATABASE_INITIALIZATION_PREVIEW_UNSUPPORTED");
        const operations = await Promise.all(options.perSpaceOptions.flatMap(space => space.plan.operations));
        const planned = await nativeInitializationPlan(family, options.perSpaceOptions.find(space => space.space === "app")?.destinationContract as Contract, operations);
        if (digest(planned) !== digest(review.initialization)) throw new Error("DATABASE_INITIALIZATION_PLAN_CHANGED");
      } else if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("DATABASE_REVIEW_PATH_CHANGED");
      let verified = false;
      const original = options.driver;
      if (!("query" in original) || typeof original.query !== "function") throw new Error("DATABASE_RUNNER_TRANSACTION_UNSUPPORTED");
      const query = original.query.bind(original) as (sql: string, params?: readonly unknown[]) => Promise<unknown>;
      const guarded = new Proxy(original, { get(value, key) {
        if (key !== "query") { const member = Reflect.get(value, key); return typeof member === "function" ? member.bind(value) : member; }
        return async (sql: string, params?: readonly unknown[]) => {
          if (sql === "BEGIN") {
            const begun = await query(sql, params);
            try {
            const keys = options.perSpaceOptions.map(space => {
              const postgres = space as typeof space & { schemaName?: string; destinationContract: Contract };
              return `prisma_8.contract.marker:${postgres.schemaName ?? Object.keys(postgres.destinationContract.storage.namespaces).find(id => id !== UNBOUND_NAMESPACE_ID) ?? UNBOUND_NAMESPACE_ID}:${space.space ?? space.plan.spaceId}`;
            }).sort();
            for (const key of new Set(keys)) await query("select pg_advisory_xact_lock(hashtext($1))", [key]);
            if (review.kind === "initialize") await query("SELECT pg_advisory_xact_lock(4590, 1)");
            const markers = [...await family.readAllMarkers({ driver: original })].sort(([a], [b]) => a.localeCompare(b));
            if (digest(markers) !== review.markerIdentity || digest(await family.readLedger({ driver: original })) !== review.ledgerIdentity) throw new Error("DATABASE_REVIEW_HISTORY_CHANGED");
            if (review.kind === "initialize") {
              const metadata = await query(DATABASE_EMPTY_SQL) as { rows: Record<string, unknown>[] };
              if (markers.length || metadata.rows[0]?.occupied !== false) throw new Error("DATABASE_INITIALIZATION_REQUIRES_EMPTY");
            } else {
              if (!historical) throw new Error("DATABASE_HISTORICAL_CONTRACT_MISSING");
              const schema = await family.introspect({ driver: original, contract: historical });
              const physical = family.verifySchema({ contract: historical, schema, strict: true, frameworkComponents: options.perSpaceOptions.flatMap(space => space.frameworkComponents) });
              if (!physical.ok) throw new Error("DATABASE_PHYSICAL_DRIFT");
            }
            assertInputs(); verified = true;
            return begun;
            } catch (error) { await query("ROLLBACK").catch(() => {}); throw error; }
          }
          if (!verified && sql !== "ROLLBACK") throw new Error("DATABASE_RUNNER_TRANSACTION_UNSUPPORTED");
          return query(sql, params);
        };
      } });
      return runner.execute({ ...options, driver: guarded });
    } };
  } } };
  return { ...config, target: guardedTarget };
}

/** Correlated bounded chunks prevent truncation/old logs from looking successful. */
export function encodeDatabaseEnvelope(envelope: DatabaseCloudEnvelope): string[] {
  const json = JSON.stringify(envelope); if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error("DATABASE_REVIEW_TOO_LARGE");
  const encoded = Buffer.from(json).toString("base64");
  const chunks = encoded.match(/.{1,24000}/g) ?? [""];
  return chunks.map((data, index) => DATABASE_REVIEW_PREFIX + JSON.stringify({ requestId: envelope.requestId, hash: digest(json), index, total: chunks.length, data }));
}
export function decodeDatabaseEnvelope(messages: readonly string[], requestId: string): DatabaseCloudEnvelope {
  const chunks = messages.flatMap(message => { if (!message.startsWith(DATABASE_REVIEW_PREFIX)) return []; try { const value = JSON.parse(message.slice(DATABASE_REVIEW_PREFIX.length)); return value.requestId === requestId ? [value] : []; } catch { return []; } });
  const unique = [...new Map(chunks.map(chunk => [chunk.index, chunk])).values()].sort((a, b) => a.index - b.index);
  if (!unique.length || unique.length > 250 || unique.length !== unique[0].total || unique.some((chunk, index) => chunk.index !== index || chunk.total !== unique.length || chunk.hash !== unique[0].hash || typeof chunk.data !== "string" || chunk.data.length > 24000)) throw new Error("DATABASE_REVIEW_OUTPUT_INCOMPLETE");
  const json = Buffer.from(unique.map(chunk => chunk.data).join(""), "base64").toString("utf8");
  if (digest(json) !== unique[0].hash) throw new Error("DATABASE_REVIEW_OUTPUT_CHANGED");
  const envelope = JSON.parse(json) as DatabaseCloudEnvelope;
  if (envelope.version !== 1 || envelope.requestId !== requestId || !["reviewed", "applied", "unchanged", "unconfirmed", "refused"].includes(envelope.status)) throw new Error("DATABASE_REVIEW_OUTPUT_INVALID");
  if (envelope.code && !/^[A-Z][A-Z0-9_.]{1,80}$/.test(envelope.code) || envelope.applied?.some(name => !/^[A-Za-z0-9_.-]+$/.test(name))) throw new Error("DATABASE_REVIEW_OUTPUT_INVALID");
  if (envelope.review) { const { digest: expected, ...value } = envelope.review; if (digest(value) !== expected) throw new Error("DATABASE_REVIEW_OUTPUT_CHANGED"); }
  return envelope;
}
