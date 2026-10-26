import assert from "./support/assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertWritable } from "../server/files";
import { writeSourceChange } from "../server/edits/io";
import { SourceJournal } from "../server/edits/journal";

test("source replacement preserves permissions and guards absence, empty bytes and later edits", () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-source-safety-"));
  const file = path.join(root, "framework.config.ts");
  try {
    writeFileSync(file, "original\n"); chmodSync(file, 0o640);
    const mode = statSync(file).mode & 0o777;
    writeSourceChange(root, file, "original\n", "reviewed\n");
    assert.equal(readFileSync(file, "utf8"), "reviewed\n");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, mode);
    writeFileSync(file, "external\n");
    assert.throws(() => writeSourceChange(root, file, "reviewed\n", "overwrite\n"), /changed/);
    assert.equal(readFileSync(file, "utf8"), "external\n");
    writeFileSync(file, "");
    assert.throws(() => writeSourceChange(root, file, null, "overwrite empty\n"), /changed/);
    writeSourceChange(root, file, "", "restored\n");
    assert.equal(readFileSync(file, "utf8"), "restored\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows separators stay within source authority while traversals and linked parents are rejected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-path-safety-"));
  const config = path.join(root, "framework-config");
  mkdirSync(path.join(config, "nested"), { recursive: true });
  writeFileSync(path.join(config, "nested", "settings.ts"), "export {};\n");
  writeFileSync(path.join(root, "outside.ts"), "private source\n");
  try {
    assert.equal(assertWritable(root, "framework-config\\nested\\settings.ts"), path.join(config, "nested", "settings.ts"));
    for (const file of ["framework-config\\..\\outside.ts", "framework-config/../outside.ts", "C:\\outside.ts", "\\\\host\\share\\source.ts", "/framework-config/nested/settings.ts"])
      assert.throws(() => assertWritable(root, file));
    symlinkSync(root, path.join(config, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => assertWritable(root, "framework-config/linked/outside.ts"), /symbolic link/);
    assert.throws(() => new SourceJournal(root).begin("Unsafe linked source", [{ file: path.join(config, "linked", "outside.ts"), before: "private source\n", after: "overwrite\n" }]), /symbolic/i);
    assert.equal(readFileSync(path.join(root, "outside.ts"), "utf8"), "private source\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
