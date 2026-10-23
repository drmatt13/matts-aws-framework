import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceGeneratedFile } from "../scripts/replace-generated-file";

test("a transient Windows reader preserves the complete old generated file until atomic replacement", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "framework-replace-"));
  const from = path.join(directory, "next.ts"), to = path.join(directory, "current.ts");
  writeFileSync(from, "new complete module\n"); writeFileSync(to, "old complete module\n");
  let attempts = 0, elapsed = 0;
  try {
    replaceGeneratedFile(from, to, (source, destination) => {
      assert.equal(readFileSync(destination, "utf8"), "old complete module\n");
      if (++attempts < 3) throw Object.assign(new Error("reader owns a handle"), { code: "EPERM" });
      renameSync(source, destination);
    }, "win32", { now: () => elapsed, wait: milliseconds => { elapsed += milliseconds; } });
    assert.equal(attempts, 3);
    assert.equal(readFileSync(to, "utf8"), "new complete module\n");
  } finally { rmSync(directory, { recursive: true }); }
});

test("persistent Windows sharing failures stop at the five-second deadline and preserve both files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "framework-replace-"));
  const from = path.join(directory, "next.ts"), to = path.join(directory, "current.ts");
  writeFileSync(from, "new complete module\n"); writeFileSync(to, "old complete module\n");
  const failure = Object.assign(new Error("reader still owns a handle"), { code: "EBUSY" });
  const waits: number[] = [];
  let elapsed = 0;
  try {
    assert.throws(() => replaceGeneratedFile(from, to, () => { throw failure; }, "win32", {
      now: () => elapsed, wait: milliseconds => { waits.push(milliseconds); elapsed += milliseconds; },
    }), error => error === failure);
    assert.equal(elapsed, 5_000);
    assert.ok(waits.every(milliseconds => milliseconds > 0 && milliseconds <= 100));
    assert.equal(readFileSync(to, "utf8"), "old complete module\n");
    assert.equal(readFileSync(from, "utf8"), "new complete module\n");
  } finally { rmSync(directory, { recursive: true }); }
});

test("non-Windows sharing failures fail immediately with the original error", () => {
  let attempts = 0;
  const failure = Object.assign(new Error("sharing failure"), { code: "EPERM" });
  assert.throws(() => replaceGeneratedFile("from", "to", () => { attempts++; throw failure; }, "linux", {
    wait: () => assert.fail("Non-Windows failures must not wait"),
  }), error => error === failure);
  assert.equal(attempts, 1);
});

test("nontransient replacement failures are not retried or converted into deletion", () => {
  let attempts = 0;
  const failure = Object.assign(new Error("bad destination"), { code: "ENOENT" });
  assert.throws(() => replaceGeneratedFile("from", "to", () => { attempts++; throw failure; }, "win32"), error => error === failure);
  assert.equal(attempts, 1);
});
