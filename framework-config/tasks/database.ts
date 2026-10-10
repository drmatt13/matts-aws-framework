import type { TasksSection } from "../contracts";

/**
 * Database operations that have to run inside the network.
 *
 * The database is private, so a release applies its migrations from here:
 *
 *   npm run db:migrate:cloud -- --profile <PROFILE>
 *
 * Cloud only: locally, Compose's prisma-migrate service migrates Postgres on
 * every start. In a public subnet, so it runs whether or not the network has a
 * NAT gateway. It applies them as the database's IAM login, which owns every
 * table they create.
 */
export const databaseTasks = {
  "db-migrate": {
    deploy: "cloud-only",
    database: true,
    cloud: { subnet: "public" },
  },
} satisfies TasksSection;
