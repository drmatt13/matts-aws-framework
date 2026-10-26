import { mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SnapshotBuilder } from "../../server/snapshot";

/** Reset disposable test source directly, independently of Studio's edit APIs. */
export function sourceFixtureCheckpoint(root: string, builder: SnapshotBuilder): () => Promise<void> {
  const resolved = path.resolve(root);
  if (!resolved.replaceAll("\\", "/").includes("/.cache/framework-studio/")) throw new Error("Source checkpoints require a disposable Studio fixture.");
  const scan = () => {
    const files = new Map<string, Buffer>();
    const directories: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", ".framework", ".cache", ".git", "dist", "cdk.out"].includes(entry.name) || entry.isSymbolicLink()) continue;
        if (/^\.env(?:\.|$)/.test(entry.name) && !/\.(?:template|example)$/.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { directories.push(file); visit(file); }
        else if (entry.isFile()) files.set(file, readFileSync(file));
      }
    };
    visit(resolved);
    return { files, directories };
  };
  const original = scan();
  return async () => {
    const current = scan();
    let changed = false;
    for (const file of current.files.keys()) if (!original.files.has(file)) { unlinkSync(file); changed = true; }
    for (const [file, contents] of original.files) if (!contents.equals(current.files.get(file) ?? Buffer.alloc(0)) || !current.files.has(file)) {
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); changed = true;
    }
    for (const directory of current.directories.reverse()) if (!original.directories.includes(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
    if (changed) await builder.refresh();
  };
}
