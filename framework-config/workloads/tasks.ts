import { applicationVpc } from "../networks/application";
import type { TasksSection } from "../contracts";

/** Tasks declarations. Tags describe concerns independently of this module. */
export const tasks = {

  "invocation-test-task": {
    deploy: "both",
    cloud: {
      vpc: applicationVpc,
      cpu: 256,
      memoryMiB: 512,
    },
    tags: { area: "tasks" },
  },
  /**
   * Database operations that have to run inside the network.
   *
   * The database is private, so a release applies its migrations from here:
   *
   *   npm run db:migrate:cloud -- --profile <PROFILE>
   *
   * Cloud only: local compute only verifies Postgres. Migrations are a separate
   * reviewed/authorized Studio action or explicit prisma-migrate service run.
   * In the default public subnet (defaults.container.subnet), so it
   * starts whatever the selected VPC declares, and reaches the database as any
   * workload that declares database: true does. It applies them as the
   * database's IAM login, which owns every table they create.
   */

  "db-migrate": {
    deploy: "cloud-only",
    environment: { DATABASE_REVIEW_PROTOCOL: "1" },
    cloud: { vpc: applicationVpc },
    database: { connection: "direct" },
    tags: { area: "database" },
  },
} satisfies TasksSection;
