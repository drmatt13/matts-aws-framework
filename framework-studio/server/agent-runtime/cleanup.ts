import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { loadAgentWorkspace } from "./workspace";

/** Explicit terminal-task cleanup only. Manifests, immutable source blobs,
 * proposals, validations, approvals and live import journals are retained. */
export async function cleanupAgentWorkspace(directory: string): Promise<void> {
  const workspace = loadAgentWorkspace(directory);
  const allowed = new Set(["working", "scratch", "architecture", "merge-inputs"]);
  for (const name of await readdir(workspace.directory)) {
    if (!allowed.has(name) && !/^provider-runtime-[A-Za-z0-9_-]+$/.test(name)) continue;
    const target = path.join(workspace.directory, name), stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || await realpath(target) !== target) throw new Error("A task cleanup directory changed identity. Retain it for inspection.");
    await rm(target, { recursive: true });
  }
}
