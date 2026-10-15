import type { TasksSection } from "../contracts";

/**
 * Database operations that have to run inside the network.
 *
 * The database is private, so a release applies its migrations from here:
 *
 *   npm run db:migrate:cloud -- --profile <PROFILE>
 *
 * Cloud only: locally, Compose's prisma-migrate service migrates Postgres on
 * every start. In the default public subnet (defaults.container.subnet), so it
 * starts whatever network.ts declares, and reaches the database as any
 * workload that declares database: true does. It applies them as the
 * database's IAM login, which owns every table they create.
 */
export const databaseTasks = {
  "db-migrate": {
    deploy: "cloud-only",
    database: { connection: "direct" },
  },
} satisfies TasksSection;
