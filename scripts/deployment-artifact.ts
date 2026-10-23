import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Whole-file durable records: a crash leaves either the old or new JSON, never half a journal. */
export function writeDeploymentRecordAtomic(file: string, document: unknown): void {
  const temporary = file + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(document, null, 2) + "\n");
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, file);
    // Directory fsync is unavailable on some platforms; other I/O failures matter.
    try { const directory = openSync(path.dirname(file), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
    catch (error) {
      if (!["EINVAL", "ENOTSUP", ...(process.platform === "win32" ? ["EPERM", "EISDIR", "EBADF"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
