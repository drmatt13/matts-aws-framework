import assert from "./support/assert";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readEvaluationArtifact, writeEvaluationArtifact } from "../server/evaluator/result-artifact";

function fixture(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "studio-evaluation-artifact-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("large Unicode graph data uses exact bounded artifact bytes and a small receipt", () => fixture(directory => {
  const file = path.join(directory, "result.json"), value = { label: "λ", targets: "source-graph".repeat(50_000) };
  const receipt = writeEvaluationArtifact(file, value);
  assert.equal(receipt.bytes, readFileSync(file).length);
  assert.ok(JSON.stringify(receipt).length < 150);
  assert.deepEqual(JSON.parse(readEvaluationArtifact(file, receipt)), value);
  assert.throws(() => writeEvaluationArtifact(file, { changed: true }), /EEXIST/);
}));

test("artifact receipts reject changed bytes, invalid sizes and wrong hashes", () => fixture(directory => {
  const file = path.join(directory, "result.json"), receipt = writeEvaluationArtifact(file, { state: "before" });
  writeFileSync(file, '{"state":"after!"}');
  assert.throws(() => readEvaluationArtifact(file, receipt), /changed or does not match/);
  for (const invalid of [null, {}, { ...receipt, version: 2 }, { ...receipt, bytes: 0 }, { ...receipt, bytes: 1.5 }, { ...receipt, bytes: Number.MAX_SAFE_INTEGER }, { ...receipt, hash: "invalid" }]) {
    assert.throws(() => readEvaluationArtifact(file, invalid), /invalid artifact receipt/);
  }
  assert.throws(() => readEvaluationArtifact(file, receipt, 2), /invalid artifact receipt/);
}));

test("artifact paths cannot redirect the host through symbolic links, hard links or directories", () => fixture(directory => {
  const file = path.join(directory, "result.json"), receipt = writeEvaluationArtifact(file, { value: true });
  const symbolic = path.join(directory, "symbolic.json"), hard = path.join(directory, "hard.json"), folder = path.join(directory, "folder");
  symlinkSync(file, symbolic); linkSync(file, hard); mkdirSync(folder);
  assert.throws(() => readEvaluationArtifact(symbolic, receipt));
  assert.throws(() => readEvaluationArtifact(hard, receipt), /regular file/);
  assert.throws(() => readEvaluationArtifact(file, receipt), /regular file/);
  assert.throws(() => readEvaluationArtifact(folder, receipt), /regular file/);
}));

test("artifact writer refuses missing JSON and oversized values before creating output", () => fixture(directory => {
  const file = path.join(directory, "result.json");
  assert.throws(() => writeEvaluationArtifact(file, undefined), /no JSON artifact/);
  assert.throws(() => writeEvaluationArtifact(file, "oversized", 2), /size limit/);
  assert.throws(() => readFileSync(file), /ENOENT/);
}));
