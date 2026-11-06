import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../..");
// GHSA-27r3-jxmh-p828: a completed first frame must not leave the decoder
// able to crash the server on trailing bytes or consume a sibling's request stream.
for (const kind of ["json", "raw"]) {
  for (const encoding of ["gzip", "deflate"]) {
    test(`${kind} ${encoding} trailers preserve parsing and sibling stream consumers`, () => {
      const child = spawnSync(
        process.execPath,
        [
          path.join(__dirname, "fixtures/compressed-body.cjs"),
          root,
          kind,
          encoding,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), {
        kind,
        encoding,
        status: "survived",
        siblingHash: "complete",
      });
    });
  }
}
