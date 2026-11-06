import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";

export interface EvaluationArtifactReceipt { readonly version: 1; readonly hash: string; readonly bytes: number; }

/** Run inside the restricted child, with a host-selected scratch path. */
export function writeEvaluationArtifact(file: string, value: unknown, limit = 8 * 1024 * 1024): EvaluationArtifactReceipt {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("Restricted evaluation produced no JSON artifact.");
  const bytes = Buffer.from(serialized);
  if (bytes.length < 1 || bytes.length > limit) throw new Error("Restricted evaluation artifact exceeded its size limit.");
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return { version: 1, hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/** The file path is selected by the host, never accepted from sandbox output. */
export function readEvaluationArtifact(file: string, receipt: unknown, limit = 8 * 1024 * 1024): string {
  const value = receipt as EvaluationArtifactReceipt | undefined;
  if (!value || value.version !== 1 || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > limit) throw new Error("Restricted evaluation returned an invalid artifact receipt.");
  // NONBLOCK prevents an authored FIFO from stalling the host before fstat can
  // reject it. The host accepts only a single-link regular file.
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size !== value.bytes) throw new Error("Restricted evaluation artifact is not a bounded regular file.");
    const bytes = Buffer.alloc(value.bytes + 1);
    let count = 0;
    for (;;) { const read = readSync(descriptor, bytes, count, bytes.length - count, count); count += read; if (!read || count === bytes.length) break; }
    const after = fstatSync(descriptor);
    if (count !== value.bytes || after.size !== before.size || after.nlink !== 1 || createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !== value.hash) throw new Error("Restricted evaluation artifact changed or does not match its receipt.");
    return bytes.subarray(0, count).toString("utf8");
  } finally { closeSync(descriptor); }
}
