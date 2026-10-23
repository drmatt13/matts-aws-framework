import { readFileSync } from "node:fs";
import path from "node:path";
import { databaseInputsDigest, guardCloudDatabasePath, readDatabaseCloudRequest, reviewCloudDatabase, type DatabaseCloudEnvelope, type DatabaseCloudIdentity, type DatabaseCloudReview } from "../../../../packages/database/scripts/studio-migrations";
import { isDatabaseEmpty } from "../../../../packages/database/scripts/empty-database";

export async function runningDatabaseTaskIdentity(expected: DatabaseCloudIdentity): Promise<void> {
  const endpoint = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!endpoint) throw new Error("DATABASE_TASK_METADATA_UNAVAILABLE");
  const metadata = await fetch(`${endpoint}/task`, { signal: AbortSignal.timeout(5000) }).then(response => { if (!response.ok) throw new Error("DATABASE_TASK_METADATA_UNAVAILABLE"); return response.json(); }) as { TaskARN?: string; Family?: string; Revision?: string };
  const arn = metadata.TaskARN?.split(":");
  const definition = arn && `arn:${arn[1]}:ecs:${arn[3]}:${arn[4]}:task-definition/${metadata.Family}:${metadata.Revision}`;
  if (!arn || arn[3] !== expected.region || arn[4] !== expected.account || definition !== expected.taskDefinitionArn) throw new Error("DATABASE_TASK_IDENTITY_CHANGED");
}

export async function executeReviewedDatabaseTask(root: string, raw: string, databaseUrl: string, dependencies: { verifyIdentity?: typeof runningDatabaseTaskIdentity; createClient?: typeof import("@prisma/orm-toolchain/cli/control-api").createControlClient; plan?: typeof import("@prisma/orm-toolchain/cli/control-api").executeMigrateShowPlan; empty?: typeof isDatabaseEmpty } = {}): Promise<DatabaseCloudEnvelope> {
  const request = readDatabaseCloudRequest(raw);
  let executing = false;
  try {
    const { createControlClient, executeMigrateShowPlan, loadContractSource } = await import("@prisma/orm-toolchain/cli/control-api");
    const { loadConfig, requireConfigSections } = await import("@prisma/orm-toolchain/config-loader");
    await (dependencies.verifyIdentity ?? runningDatabaseTaskIdentity)(request.identity);
    if (databaseInputsDigest(root) !== request.inputsDigest) throw new Error("DATABASE_TASK_SOURCE_STALE");
    const loaded = await loadConfig(path.join(root, "packages/database/prisma.config.ts"), { cwd: path.join(root, "packages/database") });
    if (!loaded.ok) throw new Error("DATABASE_TASK_CONFIG_INVALID");
    const required = requireConfigSections(loaded.value, ["family", "target", "adapter", "extensions", "contract"]);
    if (!required.ok) throw new Error("DATABASE_TASK_CONFIG_INVALID");
    const config = required.value;
    const compiled = await loadContractSource(config);
    if (!compiled.ok) throw new Error("DATABASE_TASK_CONTRACT_INVALID");
    const contract = compiled.value;
    const readOnly = new URL(databaseUrl); readOnly.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=60000");
    const readClient = (dependencies.createClient ?? createControlClient)({ ...config, connection: readOnly.toString() });
    let review: DatabaseCloudReview;
    try {
      await readClient.connect();
      let selected: DatabaseCloudReview["migrations"] = [];
      if (await readClient.readMarker()) {
        const planned = await (dependencies.plan ?? executeMigrateShowPlan)({ config: { ...config, db: { connection: readOnly.toString() } }, cwd: path.join(root, "packages/database") });
        if (!planned.ok) throw new Error("DATABASE_TASK_PATH_UNAVAILABLE");
        selected = planned.value.migrations.map(edge => {
        if (!/^[A-Za-z0-9_.-]+$/.test(edge.dirName) || !/^[A-Za-z0-9_-]+$/.test(edge.spaceId)) throw new Error("DATABASE_TASK_PATH_INVALID");
        const directory = path.join(root, "packages/database/prisma/migrations", edge.spaceId, edge.dirName);
        const operations = JSON.parse(readFileSync(path.join(directory, "ops.json"), "utf8")) as Record<string, unknown>[];
        const sql = operations.flatMap(operation => ["precheck", "execute", "postcheck"].flatMap(phase => (Array.isArray(operation[phase]) ? operation[phase] as Record<string, unknown>[] : []).flatMap(statement => typeof statement.sql === "string" ? [{ phase, sql: statement.sql, ...(Array.isArray(statement.params) ? { params: statement.params } : {}) }] : [])));
        return { spaceId: edge.spaceId, dirName: edge.dirName, migrationHash: edge.migrationHash, from: edge.from, to: edge.to, source: readFileSync(path.join(directory, "migration.ts"), "utf8"), sql };
        });
      }
      review = await reviewCloudDatabase(root, request, config, contract, readClient, selected, () => (dependencies.empty ?? isDatabaseEmpty)(root, readOnly.toString()), config => (dependencies.createClient ?? createControlClient)({ ...config, connection: readOnly.toString() }));
    } finally { await readClient.close(); }
    if (request.mode === "review") return { version: 1, requestId: request.requestId, status: "reviewed", review };
    if (request.expectedDigest !== review.digest) throw new Error("DATABASE_REVIEW_CHANGED");
    if (!review.migrations.length && review.kind !== "initialize") return { version: 1, requestId: request.requestId, status: "unchanged", applied: [] };
    const historical = review.kind === "initialize" ? undefined : config.target.contractSerializer.deserializeContract(JSON.parse(readFileSync(path.join(root, "packages/database/prisma/migrations/snapshots", review.markerHash, "contract.json"), "utf8")));
    const guarded = guardCloudDatabasePath(config, review, () => { if (databaseInputsDigest(root) !== review.inputsDigest) throw new Error("DATABASE_TASK_SOURCE_CHANGED"); }, historical);
    const writer = (dependencies.createClient ?? createControlClient)({ ...guarded, connection: databaseUrl });
    try {
      await writer.connect(); executing = true;
      if (review.kind === "initialize") {
        const result = await writer.dbInit({ contract, mode: "apply", migrationsDir: path.join(root, "packages/database/prisma/migrations") });
        if (!result.ok) return { version: 1, requestId: request.requestId, status: "unconfirmed", code: "DATABASE_INITIALIZATION_FAILED" };
        return { version: 1, requestId: request.requestId, status: "applied", applied: ["initialized-storage"] };
      }
      const result = await writer.migrate({ contract, migrationsDir: path.join(root, "packages/database/prisma/migrations") });
      if (!result.ok) return { version: 1, requestId: request.requestId, status: "unconfirmed", code: /^[A-Z][A-Z0-9_.]{1,80}$/.test(result.failure.code) ? result.failure.code : "DATABASE_RUNNER_FAILED" };
      return { version: 1, requestId: request.requestId, status: "applied", applied: result.value.applied.map(item => item.dirName) };
    } finally { await writer.close(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { version: 1, requestId: request.requestId, status: executing ? "unconfirmed" : "refused", code: /^[A-Z][A-Z0-9_]{1,80}$/.test(message) ? message : "DATABASE_TASK_FAILED" };
  }
}
