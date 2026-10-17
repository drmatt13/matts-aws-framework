import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * The deploy wrapper's local working state under .cache/deploy: its temporary
 * assemblies, and one lock per deployment name so two runs on this machine
 * cannot deploy the same deployment at once. CloudFormation refuses concurrent
 * updates per stack; the lock also covers the secret uploads that come first.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Removes `assembly-*` directories an interrupted run left behind. */
export function sweepStaleAssemblies(cache: string, now: number, maxAgeMs = DAY_MS): string[] {
  let entries;
  try { entries = readdirSync(cache, { withFileTypes: true }); } catch { return []; }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("assembly-")) continue;
    const directory = join(cache, entry.name);
    try {
      if (now - statSync(directory).mtimeMs < maxAgeMs) continue;
      rmSync(directory, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Best effort: a directory another process still holds is left for a later run.
    }
  }
  return removed.sort();
}

export function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Takes `<cache>/<deployment>.lock`, replacing one whose process is gone. Returns the release. */
export function acquireDeploymentLock(cache: string, deployment: string, isAlive: (pid: number) => boolean = defaultIsAlive): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(deployment)) throw new Error(`Cannot lock deployment name ${JSON.stringify(deployment)}.`);
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${deployment}.lock`);
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try { writeSync(descriptor, record); } finally { closeSync(descriptor); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: unknown; startedAt?: unknown } | undefined;
      try { holder = JSON.parse(readFileSync(file, "utf8")); } catch { holder = undefined; }
      if (attempt > 0 || (typeof holder?.pid === "number" && isAlive(holder.pid))) {
        const who = typeof holder?.pid === "number" ? `pid ${holder.pid}, started ${String(holder.startedAt)}` : "another process";
        throw new Error(`Another deployment of ${deployment} is running (${who}). Wait for it to finish, or delete ${file} if that process no longer exists.`);
      }
      rmSync(file, { force: true });
    }
  }
  return () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Already gone, or replaced by a run that found this one dead.
    }
  };
}
