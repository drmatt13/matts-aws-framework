import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sourceDiff } from "../server/edits/diff";

test("distant changes preserve unchanged lines and give independent accurate hunks", () => {
  const before = Array.from({ length: 100 }, (_, at) => `line ${at + 1}`).join("\n") + "\n";
  const after = before.replace("line 3\n", "changed 3\n").replace("line 97\n", "changed 97\n");
  const diff = sourceDiff("sample.txt", before, after);
  assert.equal(diff.lines.filter(line => line.kind === "remove").length, 2);
  assert.equal(diff.lines.filter(line => line.kind === "add").length, 2);
  assert.equal(diff.lines.filter(line => line.hunk).length, 2);
  assert.match(diff.unified, /@@ -94,7 \+94,7 @@/);
  assert.ok(!diff.unified.includes("line 50"));
});

test("review patches apply byte-for-byte for sparse, repeated, empty and newline changes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-diff-"));
  try {
    const cases = [
      ["a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "insert\na\nb\nchanged\nd\ne\nf\ng\nh\ni\n"],
      ["same\nsame\nfirst\nsame\nsame\nlast\n", "same\nfirst\nsame\ninsert\nsame\nlast\n"],
      ["", "one\ntwo\n"], ["one\ntwo\n", ""], ["one", "one\n"], ["one\n", "one"],
      ["one\ntwo", "one\nthree"], ["\n", ""],
    ];
    for (const [before, after] of cases) {
      writeFileSync(path.join(root, "sample.txt"), before!);
      const patch = sourceDiff("sample.txt", before!, after!).unified;
      // This fixture verifies authored bytes, independent of the user's checkout policy.
      const result = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--no-index", "--whitespace=nowarn", "-"], { cwd: root, input: patch, encoding: "utf8" });
      assert.equal(result.status, 0, `${JSON.stringify([before, after])}: ${result.stderr}\n${patch}`);
      assert.equal(readFileSync(path.join(root, "sample.txt"), "utf8"), after);
    }
    assert.deepEqual(sourceDiff("sample.txt", "same", "same"), { unified: "", lines: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large regenerated files retain unique common anchors with bounded comparison", () => {
  const before = Array.from({ length: 1600 }, (_, at) => at % 100 === 0 ? `anchor ${at}` : `old ${at}`).join("\n");
  const after = before.replaceAll("old ", "new ");
  const result = sourceDiff("large.json", before, after, 0);
  assert.ok(!result.lines.some(line => line.kind !== "context" && line.text.startsWith("anchor ")));
});
