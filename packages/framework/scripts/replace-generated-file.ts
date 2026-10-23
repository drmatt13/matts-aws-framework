import { renameSync } from "node:fs";

/** Windows readers (including scanners) can briefly deny a replacement rename.
 * Keep the old file intact and retry the same atomic operation for at most 5s.
 * Permanent errors still fail generation; no unlink/chmod fallback is allowed.
 */
export function replaceGeneratedFile(from: string, to: string, replace = renameSync, platform = process.platform,
  timing: { readonly now?: () => number; readonly wait?: (milliseconds: number) => void } = {}): void {
  const now = timing.now ?? Date.now;
  const wait = timing.wait ?? ((milliseconds: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  const deadline = now() + 5_000;
  let delay = 10;
  for (;;) {
    try { replace(from, to); return; }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || remaining <= 0) throw error;
      wait(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 100);
    }
  }
}
