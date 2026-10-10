/**
 * Applies the committed migrations, then exits with Prisma's exit code.
 *
 * The task declares database: true, so the URL comes from the framework: in
 * AWS it logs in as the database's IAM login with a freshly signed token, and
 * TLS is verified against the RDS certificate authorities; against a local
 * Postgres it is the Compose URL. The token is good for opening connections
 * for 15 minutes, which a migration run is well inside.
 */
import { spawnSync } from "node:child_process";
import { databaseUrl as resolveDatabaseUrl } from "@repo/framework/runtime/database";

async function main(): Promise<number> {
  const databaseUrl = await resolveDatabaseUrl();
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
