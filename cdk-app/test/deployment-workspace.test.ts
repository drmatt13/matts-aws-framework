import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { acquireDeploymentLock, sweepStaleAssemblies } from "../../scripts/deployment-workspace";

const scratch = path.resolve(__dirname, "../../.cache");

function withCache(body: (cache: string) => void): void {
  mkdirSync(scratch, { recursive: true });
  const cache = mkdtempSync(path.join(scratch, "deploy-workspace-"));
  try { body(cache); } finally { rmSync(cache, { recursive: true, force: true }); }
}

test("the sweep removes only assembly directories older than the limit", () => {
  withCache((cache) => {
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
    for (const name of ["assembly-old", "assembly-new", "other-old"]) mkdirSync(path.join(cache, name));
    writeFileSync(path.join(cache, "assembly-file.txt"), "a file, not an assembly");
    writeFileSync(path.join(cache, "keep.txt"), "kept");
    for (const name of ["assembly-old", "other-old", "assembly-file.txt"]) utimesSync(path.join(cache, name), twoDaysAgo, twoDaysAgo);
    assert.deepEqual(sweepStaleAssemblies(cache, now), ["assembly-old"]);
    for (const name of ["assembly-new", "other-old", "assembly-file.txt", "keep.txt"]) assert.ok(existsSync(path.join(cache, name)), name);
    assert.equal(existsSync(path.join(cache, "assembly-old")), false);
    assert.deepEqual(sweepStaleAssemblies(path.join(cache, "missing"), now), []);
  });
});

test("one deployment of a name runs at a time", () => {
  withCache((cache) => {
    const release = acquireDeploymentLock(cache, "app");
    assert.throws(() => acquireDeploymentLock(cache, "app"), /Another deployment of app is running \(pid \d+/);
    const other = acquireDeploymentLock(cache, "other-app");
    other();
    release();
    assert.equal(existsSync(path.join(cache, "app.lock")), false);
    acquireDeploymentLock(cache, "app")();
  });
});

test("a lock left by a process that no longer exists is replaced", () => {
  withCache((cache) => {
    writeFileSync(path.join(cache, "app.lock"), JSON.stringify({ pid: 999_999_999, startedAt: "2026-01-01T00:00:00.000Z" }));
    const release = acquireDeploymentLock(cache, "app", () => false);
    assert.equal(JSON.parse(readFileSync(path.join(cache, "app.lock"), "utf8")).pid, process.pid);
    release();
    writeFileSync(path.join(cache, "app.lock"), "not json");
    acquireDeploymentLock(cache, "app", () => false)();
  });
});

test("releasing never removes a lock another run now holds", () => {
  withCache((cache) => {
    const release = acquireDeploymentLock(cache, "app");
    writeFileSync(path.join(cache, "app.lock"), JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }));
    release();
    assert.equal(existsSync(path.join(cache, "app.lock")), true);
  });
});
