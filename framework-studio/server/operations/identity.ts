import { spawnSync } from "node:child_process";
import type { ExecutionIdentity } from "../../shared/operations";

/** A PID alone is not an execution identity. A failed probe never proves death. */
function inspect(pid: number): { uid: number; started: string } | null | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "uid=", "-o", "lstart="], {
    encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, windowsHide: true,
  });
  if (result.error || result.signal) return undefined;
  const output = result.stdout.trim();
  if (result.status === 1 && !output && !result.stderr.trim()) return null;
  if (result.status !== 0) return undefined;
  const match = /^(\d+)\s+(.+)$/.exec(output);
  return match ? { uid: Number(match[1]), started: match[2]!.replace(/\s+/g, " ").trim() } : undefined;
}

export function processIdentity(token: string): ExecutionIdentity {
  const identity = inspect(process.pid);
  if (!identity || typeof process.getuid !== "function" || identity.uid !== process.getuid()) {
    throw new Error("Operations runner cannot verify this process's user and start time. Host process inspection is required.");
  }
  return { pid: process.pid, ...identity, token };
}

export function identityAlive(identity: ExecutionIdentity): boolean | undefined {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !Number.isSafeInteger(identity.uid) || !identity.started || !identity.token) return undefined;
  const observed = inspect(identity.pid);
  if (observed === undefined) return undefined;
  if (observed === null) return false;
  return observed.uid === identity.uid && observed.started === identity.started;
}
