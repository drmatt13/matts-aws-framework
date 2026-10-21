import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { sha256 } from "../files";

/**
 * Parsed dependency declarations, shared by the studio's two TypeScript
 * programs: trigger capability discovery and candidate type-checks.
 *
 * Each program otherwise parses about 3,500 files under node_modules
 * (aws-cdk-lib is most of them), roughly 1.5s of every run. Those files change
 * only when dependencies do, so the cache is keyed on package-lock.json and the
 * compiler options. Repository files, and the overlay a review checks, are
 * always read fresh; the cache never holds authored source or values. It holds
 * several hundred megabytes, so it is dropped after ten idle minutes.
 */

const IDLE_MS = 10 * 60_000;
let cache: { readonly key: string; readonly files: Map<string, ts.SourceFile> } | undefined;
let idle: NodeJS.Timeout | undefined;

function lockfile(root: string): string {
  try { return sha256(readFileSync(path.join(root, "package-lock.json"), "utf8")); }
  catch { return "absent"; }
}

/** A compiler host whose node_modules source files outlive the program that parsed them. */
export function declarationHost(root: string, options: ts.CompilerOptions): ts.CompilerHost {
  const key = sha256(JSON.stringify([ts.version, options, lockfile(root)]));
  if (cache?.key !== key) cache = { key, files: new Map() };
  const files = cache.files;
  clearTimeout(idle);
  idle = setTimeout(() => { cache = undefined; }, IDLE_MS);
  idle.unref();
  const host = ts.createCompilerHost(options);
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, version, onError, fresh) => {
    if (!/[\\/]node_modules[\\/]/.test(fileName)) return parse(fileName, version, onError, fresh);
    const id = typeof version === "object" ? `${fileName}\0${version.languageVersion}\0${version.impliedNodeFormat ?? ""}` : `${fileName}\0${version}`;
    const cached = fresh ? undefined : files.get(id);
    if (cached) return cached;
    const file = parse(fileName, version, onError, fresh);
    if (file) files.set(id, file);
    return file;
  };
  return host;
}
