import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SourceJournal } from "../server/edits/journal";

test("incomplete checkout source locks fail closed with a named inspection handoff", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-journal-lock-")), folder = path.join(root, ".cache/framework-studio/transactions"); mkdirSync(folder, { recursive: true });
  try {
    for (const text of ["", '{"id":']) {
      writeFileSync(path.join(folder, "source.lock"), text);
      assert.throws(() => new SourceJournal(root).pending(), error => !!error && typeof error === "object" && "status" in error && error.status === 422 && "message" in error && typeof error.message === "string" && error.message.includes("transactions/source.lock") && error.message.includes("will not reclaim"));
    }
    rmSync(path.join(root, ".cache"), { recursive: true }); symlinkSync(path.join(root, "absent"), path.join(root, ".cache"));
    assert.throws(() => new SourceJournal(root).pending(), /symbolic links/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewed native stack source and generated artifacts retain separate recovery authorities", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-journal-native-")), stack = path.join(root, "cdk-app/lib/custom/stacks.ts"), generated = path.join(root, "docker-compose.services.yml");
  mkdirSync(path.dirname(stack), { recursive: true }); writeFileSync(stack, "before stack\n"); writeFileSync(generated, "before compose\n");
  try {
    const journal = new SourceJournal(root);
    const id = journal.begin("Native trigger edit", [{ file: stack, before: "before stack\n", after: "after stack\n", authority: "native" }, { file: generated, before: "before compose\n", after: "after compose\n" }]);
    writeFileSync(stack, "after stack\n"); writeFileSync(generated, "after compose\n"); journal.finish(id, "conflicted");
    assert.deepEqual(journal.pending()[0]!.files.map(file => file.state), ["written", "written"]);
    assert.deepEqual(journal.restore(id, "RESTORE SOURCE"), []);
    assert.equal(readFileSync(stack, "utf8"), "before stack\n"); assert.equal(readFileSync(generated, "utf8"), "before compose\n");
    assert.throws(() => journal.begin("Invalid native path", [{ file: path.join(root, "outside.ts"), before: null, after: "code", authority: "native" }]), /native stack recovery path/);
    assert.throws(() => journal.begin("Unreviewed stack", [{ file: stack, before: "before stack\n", after: "code" }]), /creator-owned source path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
