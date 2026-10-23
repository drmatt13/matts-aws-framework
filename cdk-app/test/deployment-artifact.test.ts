import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceFileAtomic } from "../../scripts/atomic-replace.cjs";
import { writeDeploymentRecordAtomic } from "../../scripts/deployment-artifact";

test("Windows sharing failures keep the previous record complete until one atomic rename succeeds", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deployment-atomic-replace-"));
  const from = path.join(directory, "record.tmp"), to = path.join(directory, "record.json");
  let elapsed = 0, attempts = 0;
  try {
    writeFileSync(from, "new complete record\n");
    writeFileSync(to, "previous complete record\n");
    replaceFileAtomic(from, to, {
      platform: "win32", now: () => elapsed, wait: milliseconds => { elapsed += milliseconds; },
      replace: (source, destination) => {
        assert.equal(readFileSync(destination, "utf8"), "previous complete record\n");
        const code = ["EPERM", "EACCES", "EBUSY"][attempts++];
        if (code) throw Object.assign(new Error("reader holds a handle"), { code });
        renameSync(source, destination);
      },
    });
    assert.equal(attempts, 4);
    assert.equal(readFileSync(to, "utf8"), "new complete record\n");
    assert.deepEqual(readdirSync(directory), ["record.json"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("exhausted sharing retries preserve both the previous destination and complete replacement bytes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deployment-atomic-exhausted-"));
  const from = path.join(directory, "record.tmp"), to = path.join(directory, "record.json");
  const failure = Object.assign(new Error("persistent sharing violation"), { code: "EPERM" });
  let elapsed = 0, attempts = 0;
  const waits: number[] = [];
  try {
    writeFileSync(from, "next complete record\n");
    writeFileSync(to, "previous complete record\n");
    assert.throws(() => replaceFileAtomic(from, to, {
      platform: "win32", now: () => elapsed, wait: milliseconds => { waits.push(milliseconds); elapsed += milliseconds; },
      replace: () => { attempts++; assert.equal(readFileSync(to, "utf8"), "previous complete record\n"); throw failure; },
    }), error => error === failure);
    assert.equal(elapsed, 5_000, "the default retry budget is bounded without a real five-second test delay");
    assert.ok(attempts > 1);
    assert.ok(waits.every(milliseconds => milliseconds > 0 && milliseconds <= 100));
    assert.equal(readFileSync(to, "utf8"), "previous complete record\n");
    assert.equal(readFileSync(from, "utf8"), "next complete record\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("non-sharing errors and non-Windows failures are never retried", () => {
  for (const [platform, code] of [["win32", "ENOENT"], ["win32", "EIO"], ["linux", "EPERM"]] as const) {
    const failure = Object.assign(new Error("not a transient Windows sharing failure"), { code });
    let attempts = 0;
    assert.throws(() => replaceFileAtomic("from", "to", {
      platform, replace: () => { attempts++; throw failure; }, wait: () => assert.fail("must not retry"),
    }), error => error === failure);
    assert.equal(attempts, 1);
  }
});

test("deployment journals replace existing complete JSON and clean their own temporary files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deployment-journal-"));
  const file = path.join(directory, "result.json");
  try {
    writeDeploymentRecordAtomic(file, { stage: "before", completed: [] });
    writeDeploymentRecordAtomic(file, { stage: "after", completed: ["owned-stack"] });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { stage: "after", completed: ["owned-stack"] });
    assert.deepEqual(readdirSync(directory), ["result.json"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
