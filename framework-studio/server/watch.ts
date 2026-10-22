import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { databaseConfigurationSourceFiles } from "./database-workbench";

/**
 * What the studio re-reads when it changes.
 *
 * The composition root and its section modules (the editable source), the
 * framework's config machinery (which decides what that source means), the
 * application stacks (whose classes are the catalog's members and whose
 * `linkResources` calls bind them), and cdk-app/.env. Graph evaluation uses
 * only two deployment flags; inspectors load selected keys or a selected file privately.
 * Directories are watched rather than files: a file replaced by a
 * rename — the studio's own atomic write, or an editor's — keeps being seen.
 *
 * Changes are collected for a short quiet period and reported together, as
 * repository-relative paths.
 */

interface Watched {
  readonly directory: string;
  readonly recursive: boolean;
  readonly accept?: (name: string) => boolean;
}

export function watchRepository(
  repositoryRoot: string,
  onChange: (files: readonly string[]) => void,
  quietMs = 200,
): () => void {
  const targets: Watched[] = [
    { directory: repositoryRoot, recursive: false, accept: (name) => ["framework.config.ts", "docker-compose.yml", "docker-compose.override.yml", ".env"].includes(name) },
    { directory: path.join(repositoryRoot, "packages", "database", "prisma"), recursive: false, accept: (name) => name === "contract.prisma" },
    { directory: path.join(repositoryRoot, "packages", "database", "prisma", "migrations"), recursive: true, accept: (name) => /\.(?:ts|json)$/.test(name) },
    { directory: path.join(repositoryRoot, "packages", "database"), recursive: false, accept: (name) => ["prisma.config.ts", ".env"].includes(name) },
    { directory: path.join(repositoryRoot, "packages", "database", "src", "generated"), recursive: false, accept: (name) => name === "contract.json" },
    { directory: path.join(repositoryRoot, "framework-config"), recursive: true },
    { directory: path.join(repositoryRoot, "packages", "framework", "src", "config"), recursive: true },
    { directory: path.join(repositoryRoot, "cdk-app", "lib"), recursive: true },
    { directory: path.join(repositoryRoot, "cdk-app", "bin"), recursive: true },
    { directory: path.join(repositoryRoot, "cdk-app"), recursive: false, accept: (name) => [".env.dev", ".env.prod", ".env.dev.template", ".env.prod.template"].includes(name) },
  ];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  let configurationWatchers: FSWatcher[] = [];

  const changed = (target: Watched, name: string | Buffer | null) => {
    if (!name) return;
    const file = name.toString();
    if (target.accept && !target.accept(file)) return;
    if (!file.endsWith(".ts") && !target.accept) return;
    pending.add(path.relative(repositoryRoot, path.join(target.directory, file)).replaceAll("\\", "/"));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending.clear();
      refreshConfigurationWatches();
      onChange(files);
    }, quietMs);
  };

  // Config may import a chain of local modules outside packages/database.
  // Directory watches survive atomic replacement; rebuild the dependency set
  // after an import changes, so newly referenced members are watched too.
  const refreshConfigurationWatches = () => {
    let files: readonly string[];
    try { files = databaseConfigurationSourceFiles(repositoryRoot); } catch { return; }
    const groups = new Map<string, Set<string>>();
    for (const file of files) {
      const directory = path.dirname(file);
      if (!existsSync(directory)) continue;
      const names = groups.get(directory) ?? new Set<string>(); names.add(path.basename(file)); groups.set(directory, names);
    }
    for (const watcher of configurationWatchers) watcher.close();
    configurationWatchers = [];
    for (const [directory, names] of groups) {
      const target: Watched = { directory, recursive: false, accept: name => names.has(name) };
      try {
        const watcher = watch(directory, (_event, name) => changed(target, name));
        watcher.on("error", () => {});
        configurationWatchers.push(watcher);
      } catch { /* Static config watchers still permit recovery after a missing module is fixed. */ }
    }
  };

  for (const target of targets) {
    if (!existsSync(target.directory)) continue;
    const watcher = watch(target.directory, { recursive: target.recursive }, (_event, name) => changed(target, name));
    watcher.on("error", () => {});
    watchers.push(watcher);
  }
  refreshConfigurationWatches();

  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const watcher of configurationWatchers) watcher.close();
  };
}
