import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STUDIO_SCRATCH } from "../inputs";

export class EditError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}


/** Replaces a file by renaming a sibling written outside the watched tree. */
export function writeAtomically(repositoryRoot: string, file: string, text: string): void {
  const directory = path.join(repositoryRoot, STUDIO_SCRATCH, "tmp");
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, text);
  try {
    if (existsSync(file)) chmodSync(temporary, statSync(file).mode);
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An editor or virus scanner holding the file open on Windows.
        if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

