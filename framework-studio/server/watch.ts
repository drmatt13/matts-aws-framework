import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * What the studio re-reads when it changes.
 *
 * The composition root and its section modules (the editable source), the
 * framework's config machinery (which decides what that source means), the
 * application stacks (whose classes are the catalog's members and whose
 * `linkResources` calls bind them), and cdk-app/.env. Graph evaluation uses
 * only two deployment flags; the input inspector loads its selected key separately. Directories are watched rather than files: a file replaced by a
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
    { directory: repositoryRoot, recursive: false, accept: (name) => name === "framework.config.ts" || name === "docker-compose.yml" },
    { directory: path.join(repositoryRoot, "packages", "database", "prisma"), recursive: false, accept: (name) => name === "contract.prisma" },
    { directory: path.join(repositoryRoot, "framework-config"), recursive: true },
    { directory: path.join(repositoryRoot, "packages", "framework", "src", "config"), recursive: true },
    { directory: path.join(repositoryRoot, "cdk-app", "lib"), recursive: true },
    { directory: path.join(repositoryRoot, "cdk-app", "bin"), recursive: true },
    { directory: path.join(repositoryRoot, "cdk-app"), recursive: false, accept: (name) => name === ".env" },
  ];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];

  for (const target of targets) {
    if (!existsSync(target.directory)) continue;
    const watcher = watch(target.directory, { recursive: target.recursive }, (_event, name) => {
      if (!name) return;
      const file = name.toString();
      if (target.accept && !target.accept(file)) return;
      if (!file.endsWith(".ts") && !target.accept) return;
      pending.add(path.relative(repositoryRoot, path.join(target.directory, file)).replaceAll("\\", "/"));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending.clear();
        onChange(files);
      }, quietMs);
    });
    watcher.on("error", () => {});
    watchers.push(watcher);
  }

  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
