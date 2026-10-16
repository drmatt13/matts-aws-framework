import { findRepositoryRoot } from "./inputs";
import { SnapshotBuilder } from "./snapshot";

/**
 * `npm run studio`: the Framework Studio server.
 *
 * `npm run studio -- --print` evaluates once and prints the snapshot as JSON,
 * which is the whole model the browser would receive.
 */

async function main(): Promise<void> {
  const repositoryRoot = findRepositoryRoot(process.cwd());
  const args = process.argv.slice(2);
  if (args.includes("--print")) {
    const builder = new SnapshotBuilder(repositoryRoot, (line) => process.stderr.write(`${line}\n`));
    try {
      const { snapshot } = await builder.refresh();
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } finally {
      await builder.dispose();
    }
    return;
  }
  const { startServer } = await import("./server");
  await startServer(repositoryRoot, args);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
