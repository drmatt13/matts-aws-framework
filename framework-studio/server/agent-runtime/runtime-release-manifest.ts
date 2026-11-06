import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface AgentRuntimeRelease {
  readonly version: 1;
  readonly protocol: number;
  readonly digest: string;
  readonly directory: string;
  readonly entry: string;
  readonly projector: { readonly file: string; readonly digest: string };
}
export const releaseHash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
export function readAgentRuntimeRelease(directory: string): AgentRuntimeRelease {
  const canonical = realpathSync(directory);
  let ancestor = path.resolve(directory);
  while (ancestor !== path.dirname(ancestor)) {
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Pinned agent runtime contains a linked directory.");
    ancestor = path.dirname(ancestor);
  }
  const stat = lstatSync(canonical);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Pinned agent runtime is not private to this user.");
  const manifest = JSON.parse(readFileSync(path.join(canonical, "release.json"), "utf8")) as { version: number; protocol: number; files: Record<string, string>; digest: string };
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.protocol) || manifest.protocol < 1 || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(["host.cjs", "projector.cjs", "tether.mjs"]) || manifest.digest !== releaseHash(JSON.stringify({ version: 1, protocol: manifest.protocol, files: manifest.files }))) throw new Error("Pinned agent runtime manifest is invalid.");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(canonical, name), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o022 || releaseHash(readFileSync(file)) !== expected) throw new Error("Pinned agent runtime bytes changed. Preserve tasks and rebuild the runtime before starting it.");
  }
  return { version: 1, protocol: manifest.protocol, digest: manifest.digest, directory: canonical, entry: path.join(canonical, "host.cjs"), projector: { file: path.join(canonical, "projector.cjs"), digest: manifest.files["projector.cjs"]! } };
}
