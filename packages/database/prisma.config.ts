import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as definePostgresConfig } from "@prisma/orm-postgres/config";
import { config as loadDotEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, "..", "..");

loadDotEnv({ path: resolve(repoRoot, ".env"), quiet: true });
loadDotEnv({ path: resolve(packageRoot, ".env"), quiet: true });

export default definePrismaConfig({
  orm: definePostgresConfig({
    contract: "prisma/contract.prisma",
    output: resolve(packageRoot, "src/generated"),
    migrations: {
      dir: "prisma/migrations",
    },
    db: {
      connection: process.env["DATABASE_URL"],
    },
  }),
});
