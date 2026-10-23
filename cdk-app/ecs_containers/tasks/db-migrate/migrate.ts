/**
 * Explicit CLI input applies committed migrations. A versioned Studio request
 * instead selects read-only review or separately approved reviewed application.
 *
 * The task declares database: true, so the URL comes from the framework: in
 * AWS it logs in as the database's IAM login with a freshly signed token, and
 * TLS is verified against the RDS certificate authorities; against a local
 * Postgres it is the Compose URL. The token is good for opening connections
 * for 15 minutes, which a migration run is well inside.
 */
import { spawnSync } from "node:child_process";
import { databaseUrl as resolveDatabaseUrl } from "@repo/framework/runtime/database";
import { encodeDatabaseEnvelope } from "../../../../packages/database/scripts/studio-migrations";
import { executeReviewedDatabaseTask } from "./review-task";

async function main(): Promise<number> {
  const databaseUrl = await resolveDatabaseUrl();
  const input = process.env.FRAMEWORK_TASK_INPUT;
  if (input) {
    const envelope = await executeReviewedDatabaseTask(process.cwd(), input, databaseUrl);
    for (const line of encodeDatabaseEnvelope(envelope)) console.log(line);
    return ["reviewed", "applied", "unchanged"].includes(envelope.status) ? 0 : 1;
  }
  const migrate = spawnSync(
    "npm",
    ["--workspace", "@repo/database", "run", "db:migrate", "--", "--no-interactive"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  return migrate.status ?? 1;
}

main().then(
  (status) => process.exit(status),
  (error: unknown) => {
    console.error(process.env.FRAMEWORK_TASK_INPUT ? "DATABASE_TASK_ENTRY_FAILED" : error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
