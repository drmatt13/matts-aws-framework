import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { SourceWatchState } from "../shared/watch";
import { databaseConfigurationSourceFiles } from "./database-workbench";

interface Watched {
  readonly directory: string;
  readonly recursive: boolean;
  readonly accept?: (name: string) => boolean;
  readonly identity?: string;
}
interface WatchOptions {
  readonly onStatus?: (state: SourceWatchState) => void;
  readonly pollIntervalMs?: number;
  readonly retryIntervalMs?: number;
  /** Inject native failures without depending on the machine's descriptor limit. */
  readonly createWatcher?: (directory: string, recursive: boolean, changed: (name: string | Buffer | null) => void) => FSWatcher;
}
const ignored = new Set(["node_modules", ".git", ".cache", "dist", "cdk.out", "__pycache__"]);
const implementation = (name: string) => /(?:\.(?:ts|tsx|js|mjs|cjs|py|json)|(?:^|\/)Dockerfile|(?:^|\/)requirements\.txt)$/.test(name);

/** Directory watches survive atomic saves. Polling also catches lost events and newly created roots. */
export function watchRepository(repositoryRoot: string, onChange: (files: readonly string[]) => void, quietMs = 200, options: WatchOptions = {}): () => void {
  const targets: Watched[] = [
    { directory: repositoryRoot, recursive: false, accept: name => ["framework.config.ts", "docker-compose.yml", "docker-compose.override.yml", ".env", "package.json", "package-lock.json"].includes(name) },
    { directory: path.join(repositoryRoot, "packages/database/prisma"), recursive: false, accept: name => name === "contract.prisma" },
    { directory: path.join(repositoryRoot, "packages/database/prisma/migrations"), recursive: true, accept: name => /\.(?:ts|json)$/.test(name) },
    { directory: path.join(repositoryRoot, "packages/database"), recursive: false, accept: name => ["prisma.config.ts", ".env"].includes(name) },
    { directory: path.join(repositoryRoot, "packages/database/src/generated"), recursive: false, accept: name => name === "contract.json" },
    ...["framework-config", "packages/framework/src/config", "cdk-app/lib", "cdk-app/bin"].map(directory => ({ directory: path.join(repositoryRoot, directory), recursive: true })),
    ...["cdk-app/lambda_functions", "cdk-app/ecs_containers", "agents"].map(directory => ({ directory: path.join(repositoryRoot, directory), recursive: true, accept: implementation })),
    { directory: path.join(repositoryRoot, "cdk-app"), recursive: false, accept: name => [".env.dev", ".env.prod", ".env.dev.template", ".env.prod.template", "cdk.json"].includes(name) },
  ];
  const pollIntervalMs = options.pollIntervalMs ?? 5000, retryIntervalMs = options.retryIntervalMs ?? 30000;
  const createWatcher = options.createWatcher ?? ((directory, recursive, changed) => watch(directory, { recursive }, (_event, name) => changed(name)));
  const pending = new Set<string>(), watchers = new Map<string, FSWatcher>();
  const failures = new Map<string, { path: string; code: string }>();
  let timer: NodeJS.Timeout | undefined, disposed = false, lastRetry = 0;
  let specs = targets, baseline = new Map<string, string>();
  const relative = (file: string) => path.relative(repositoryRoot, file).replaceAll("\\", "/") || ".";
  const directoryProblem = (directory: string): { path: string; code: string } | undefined => {
    const name = path.relative(repositoryRoot, directory);
    if (name === ".." || name.startsWith(`..${path.sep}`) || path.isAbsolute(name)) return { path: relative(directory), code: "OUTSIDE_CHECKOUT" };
    let current = repositoryRoot;
    for (const part of name.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) return { path: relative(current), code: "LINKED_SOURCE_ROOT" }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; return { path: relative(current), code: (error as NodeJS.ErrnoException).code ?? "READ_FAILED" }; }
    }
  };
  const key = (spec: Watched) => JSON.stringify([spec.directory, spec.recursive, spec.identity ?? spec.accept?.toString() ?? "ts"]);
  const accepted = (spec: Watched, name: string) => !name.split(/[\\/]/).some(part => ignored.has(part)) && (spec.accept ? spec.accept(name) : name.endsWith(".ts"));
  const schedule = (files: readonly string[]) => {
    if (disposed) return;
    for (const file of files) pending.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      reconcile();
      const observed = fingerprint();
      if (!observed.errors.length) {
        for (const file of new Set([...baseline.keys(), ...observed.values.keys()])) if (baseline.get(file) !== observed.values.get(file)) pending.add(file);
        baseline = observed.values;
      }
      report(observed.errors);
      const files = [...pending]; pending.clear();
      if (files.length) onChange(files);
    }, quietMs);
  };
  // Config imports are watched by literal filename, including dependencies outside
  // packages/database. The set is recomputed after changes and every polling cycle.
  const dependencies = (): Watched[] => {
    try {
      const files = databaseConfigurationSourceFiles(repositoryRoot);
      failures.delete("configuration");
      return files.filter(file => { const name = relative(file); return name !== ".." && !name.startsWith("../") && !path.isAbsolute(name); })
        .map(file => ({ directory: path.dirname(file), recursive: false, identity: file, accept: (name: string) => name === path.basename(file) }));
    } catch (error) {
      failures.set("configuration", { path: "Prisma configuration imports", code: (error as NodeJS.ErrnoException).code ?? "CONFIG_IMPORTS_UNREADABLE" }); return [];
    }
  };
  const report = (scanErrors: readonly { path: string; code: string }[] = []) => options.onStatus?.({
    status: scanErrors.length ? "unavailable" : failures.size ? "polling" : "watching",
    checkedAt: new Date().toISOString(), pollIntervalMs, problems: [...failures.values(), ...scanErrors],
  });
  const reconcile = (retry = false) => {
    specs = [...targets, ...dependencies()];
    const wanted = new Set(specs.map(key));
    for (const [id, watcher] of watchers) if (!wanted.has(id)) { watcher.close(); watchers.delete(id); failures.delete(id); }
    for (const id of failures.keys()) if (id !== "configuration" && !wanted.has(id)) failures.delete(id);
    for (const spec of specs) {
      const id = key(spec);
      const problem = directoryProblem(spec.directory);
      if (problem) { watchers.get(id)?.close(); watchers.delete(id); failures.set(id, problem); continue; }
      if (!existsSync(spec.directory)) { watchers.get(id)?.close(); watchers.delete(id); failures.delete(id); continue; }
      if (watchers.has(id) || failures.has(id) && !retry) continue;
      try {
        const watcher = createWatcher(spec.directory, spec.recursive, name => {
          if (!name) { scan(); return; }
          const file = name.toString().replaceAll("\\", "/");
          if (accepted(spec, file)) schedule([relative(path.join(spec.directory, file))]);
          else if (!path.extname(file)) scan(); // Directory deletion/replacement.
        });
        watchers.set(id, watcher); failures.delete(id);
        watcher.on("error", error => {
          if (disposed || watchers.get(id) !== watcher) return;
          failures.set(id, { path: relative(spec.directory), code: (error as NodeJS.ErrnoException).code ?? "WATCH_FAILED" });
          watcher.close(); watchers.delete(id); report();
        });
      } catch (error) { failures.set(id, { path: relative(spec.directory), code: (error as NodeJS.ErrnoException).code ?? "WATCH_FAILED" }); }
    }
  };
  const fingerprint = () => {
    const values = new Map<string, string>(), errors: { path: string; code: string }[] = [];
    for (const spec of specs) {
      const problem = directoryProblem(spec.directory);
      if (problem) { errors.push(problem); continue; }
      const walk = (directory: string) => {
        try {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
            const file = path.join(directory, entry.name), name = path.relative(spec.directory, file).replaceAll("\\", "/");
            if (entry.isDirectory() && spec.recursive) walk(file);
            else if (entry.isFile() && accepted(spec, name) && !values.has(relative(file))) values.set(relative(file), createHash("sha256").update(readFileSync(file)).digest("hex"));
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ path: relative(directory), code: (error as NodeJS.ErrnoException).code ?? "READ_FAILED" }); }
      };
      walk(spec.directory);
    }
    return { values, errors };
  };
  const scan = () => {
    if (disposed) return;
    const now = Date.now(); reconcile(now - lastRetry >= retryIntervalMs);
    if (now - lastRetry >= retryIntervalMs) lastRetry = now;
    const { values, errors } = fingerprint();
    if (!errors.length) {
      const changed = [...new Set([...baseline.keys(), ...values.keys()])].filter(file => baseline.get(file) !== values.get(file));
      baseline = values;
      if (changed.length) schedule(changed);
    }
    report(errors);
  };
  reconcile();
  const initial = fingerprint(); baseline = initial.values; report(initial.errors);
  const polling = setInterval(scan, pollIntervalMs); polling.unref();
  return () => { disposed = true; clearTimeout(timer); clearInterval(polling); for (const watcher of watchers.values()) watcher.close(); watchers.clear(); };
}
