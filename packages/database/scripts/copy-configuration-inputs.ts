import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { configurationSourceFiles } from "./configuration-inputs.js";
import { databaseMigrationSourceFiles } from "./studio-migrations.js";

// Image build only: copy the same bounded relative-import closure reviewed by
// Studio. Dotenv files are excluded by the closure and the Docker build context.
const source = path.resolve(process.argv[2]!);
const destination = path.resolve(process.argv[3]!);
for (const file of new Set([...configurationSourceFiles(source), ...databaseMigrationSourceFiles(source)])) {
  if (!existsSync(file)) continue;
  const target = path.join(destination, path.relative(source, file));
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
}
