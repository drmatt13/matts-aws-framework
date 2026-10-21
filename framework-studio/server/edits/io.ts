import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/** null means absence, distinct from an existing empty file. */
export function sourceContents(file: string): string | null {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** A new file is linked exclusively, so another editor's new file wins. */
export function writeSourceChange(root: string, file: string, before: string | null, after: string | null): void {
  if (sourceContents(file) !== before) throw new EditError(409, "A source file changed while applying the draft.");
  if (after === null) { unlinkSync(file); return; }
  if (before !== null) { writeAtomically(root, file, after); return; }
  mkdirSync(path.dirname(file), { recursive: true });
  const directory = path.join(root, STUDIO_SCRATCH, "tmp");
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `create-${randomUUID()}.tmp`);
  writeFileSync(temporary, after, { flag: "wx" });
  try { linkSync(temporary, file); }
  finally { unlinkSync(temporary); }
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

