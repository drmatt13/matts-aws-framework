import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The deploy wrapper's local working state under .cache/deploy: its temporary
 * assemblies, one lock per deployment name so two runs on this machine
 * cannot deploy the same deployment at once, and the secret binding of each
 * reviewed plan. CloudFormation refuses concurrent updates per stack; the lock
 * also covers the secret uploads that come first.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_ID = /^plan-[a-z0-9]+-[0-9a-f]{6}$/;

/**
 * A plan's secret binding (deployment-secrets.ts), stored under `<cache>/<planId>.json`
 * and readable only by this user. It stays out of the plan directory: with its key a
 * low-entropy value could be guessed, so it is as private as the inputs file.
 */
export const secretBindings = {
  write(cache: string, planId: string, binding: unknown): void {
    const file = bindingFile(cache, planId);
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    try { chmodSync(cache, 0o700); } catch { /* Best effort where modes do not apply. */ }
    // Written whole, then linked into place: a binding is never replaced, and never read half-written.
    const temporary = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      try { writeSync(descriptor, JSON.stringify(binding)); } finally { closeSync(descriptor); }
      linkSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  },
  read(cache: string, planId: string): unknown {
    try { return JSON.parse(readFileSync(bindingFile(cache, planId), "utf8")); } catch { return undefined; }
  },
  remove(cache: string, planId: string): void {
    if (PLAN_ID.test(planId)) rmSync(bindingFile(cache, planId), { force: true });
  },
  /** Removes bindings older than a plan can be applied. */
  sweep(cache: string, now: number, maxAgeMs: number): string[] {
    let entries;
    try { entries = readdirSync(cache, { withFileTypes: true }); } catch { return []; }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^plan-.*\.json(\.\d+\.tmp)?$/.test(entry.name)) continue;
      try {
        if (now - statSync(join(cache, entry.name)).mtimeMs < maxAgeMs) continue;
        rmSync(join(cache, entry.name), { force: true });
        removed.push(entry.name);
      } catch {
        // Best effort: left for a later run.
      }
    }
    return removed.sort();
  },
};

function bindingFile(cache: string, planId: string): string {
  if (!PLAN_ID.test(planId)) throw new Error(`${JSON.stringify(planId)} is not a plan id.`);
  return join(cache, `${planId}.json`);
}

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

/** Takes `<cache>/<deployment>.lock`. Unknown/stale owners require deliberate
 * recovery: auto-unlinking can remove a contender's newly acquired lock.
 */
export function acquireDeploymentLock(cache: string, deployment: string, isAlive: (pid: number) => boolean = defaultIsAlive): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(deployment)) throw new Error(`Cannot lock deployment name ${JSON.stringify(deployment)}.`);
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `${deployment}.lock`);
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() });
  try {
    const descriptor = openSync(file, "wx", 0o600);
    try { writeSync(descriptor, record); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder: { pid?: unknown; startedAt?: unknown } | undefined;
    try { holder = JSON.parse(readFileSync(file, "utf8")); } catch { holder = undefined; }
    const known = typeof holder?.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0;
    const who = known ? `pid ${holder!.pid}, started ${String(holder!.startedAt)}` : "unknown owner";
    const message = known && isAlive(holder!.pid as number) ? `Another deployment of ${deployment} is running (${who}). Wait for it to finish.` : `A deployment lock for ${deployment} exists (${who}); its previous outcome is unconfirmed.`;
    throw new Error(`${message} Inspect recorded progress and AWS before explicitly removing ${file}; no lock was automatically reclaimed.`);
  }
  return () => {
    try {
      if (readFileSync(file, "utf8") === record) rmSync(file, { force: true });
    } catch {
      // Already gone, or explicitly replaced during inspected recovery.
    }
  };
}
