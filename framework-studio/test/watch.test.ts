import assert from "./support/assert";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { watchRepository } from "../server/watch";
import type { SourceWatchState } from "../shared/watch";

const until = async (accept: () => boolean) => {
  const end = Date.now() + 3000;
  while (!accept()) { assert.ok(Date.now() < end, "watcher did not report expected state/change"); await new Promise(resolve => setTimeout(resolve, 10)); }
};
class FakeWatcher extends EventEmitter { closed = false; close() { this.closed = true; } }

test("EMFILE/ENOSPC uses visible polling, survives atomic saves/deletions, then restores native watches", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-watch-"));
  const statuses: SourceWatchState[] = [], batches: string[][] = [];
  let blocked = true, stop = () => {};
  const native: FakeWatcher[] = [];
  try {
    mkdirSync(path.join(root, "framework-config"));
    writeFileSync(path.join(root, "framework.config.ts"), "before");
    stop = watchRepository(root, files => batches.push([...files]), 5, {
      pollIntervalMs: 30, retryIntervalMs: 60, onStatus: status => statuses.push(status),
      createWatcher: () => {
        if (blocked) throw Object.assign(new Error("native watch limit"), { code: "EMFILE" });
        const watcher = new FakeWatcher(); native.push(watcher); return watcher as unknown as FSWatcher;
      },
    });
    assert.equal(statuses.at(-1)?.status, "polling");
    assert.ok(statuses.at(-1)?.problems.some(problem => problem.code === "EMFILE"));
    writeFileSync(path.join(root, "temp"), "after"); renameSync(path.join(root, "temp"), path.join(root, "framework.config.ts"));
    await until(() => batches.some(files => files.includes("framework.config.ts")));
    const handler = "cdk-app/lambda_functions/event_functions/new/index.ts";
    mkdirSync(path.dirname(path.join(root, handler)), { recursive: true }); writeFileSync(path.join(root, handler), "export const lambdaHandler = () => ({ ok: true });");
    await until(() => batches.some(files => files.includes(handler)));
    batches.length = 0; rmSync(path.dirname(path.join(root, handler)), { recursive: true });
    await until(() => batches.some(files => files.includes(handler)));
    blocked = false; await until(() => statuses.at(-1)?.status === "watching");
    native[0]!.emit("error", Object.assign(new Error("queue overflow"), { code: "ENOSPC" }));
    assert.equal(statuses.at(-1)?.status, "polling");
    assert.ok(statuses.at(-1)?.problems.some(problem => problem.code === "ENOSPC"));
    await until(() => statuses.at(-1)?.status === "watching");
  } finally { stop(); rmSync(root, { recursive: true, force: true }); }
  assert.ok(native.every(watcher => watcher.closed));
});

test("polling notices a missed event but excludes dependencies and secret output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-watch-ignore-"));
  const statuses: SourceWatchState[] = [], batches: string[][] = []; let stop = () => {};
  try {
    const folder = path.join(root, "agents/sample"); mkdirSync(path.join(folder, "node_modules"), { recursive: true });
    stop = watchRepository(root, files => batches.push([...files]), 5, {
      pollIntervalMs: 20, onStatus: state => statuses.push(state), createWatcher: () => new FakeWatcher() as unknown as FSWatcher,
    });
    writeFileSync(path.join(folder, "index.ts"), "a missed native event");
    writeFileSync(path.join(folder, "node_modules/ignored.ts"), "do not read");
    writeFileSync(path.join(folder, ".env"), "TOP_SECRET=not for metadata");
    await until(() => batches.some(files => files.includes("agents/sample/index.ts")));
    assert.ok(!batches.flat().some(file => /ignored|\.env/.test(file)));
    assert.ok(!JSON.stringify(statuses).includes("TOP_SECRET"));
  } finally { stop(); rmSync(root, { recursive: true, force: true }); }
});

test("linked ancestor directories are visibly unavailable and never watched as checkout source", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-watch-linked-")), outside = mkdtempSync(path.join(tmpdir(), "studio-watch-outside-"));
  const statuses: SourceWatchState[] = [], batches: string[][] = [], watched: string[] = []; let stop = () => {};
  try {
    const handler = path.join(outside, "lambda_functions/http_functions/external/index.ts");
    mkdirSync(path.dirname(handler), { recursive: true }); writeFileSync(handler, "before");
    symlinkSync(outside, path.join(root, "cdk-app"), "dir");
    stop = watchRepository(root, files => batches.push([...files]), 5, {
      pollIntervalMs: 20, retryIntervalMs: 30, onStatus: state => statuses.push(state),
      createWatcher: directory => { watched.push(directory); return new FakeWatcher() as unknown as FSWatcher; },
    });
    assert.equal(statuses.at(-1)?.status, "unavailable");
    assert.ok(statuses.at(-1)?.problems.some(problem => problem.path === "cdk-app" && problem.code === "LINKED_SOURCE_ROOT"));
    assert.ok(!watched.some(directory => directory.startsWith(path.join(root, "cdk-app"))));
    writeFileSync(handler, "outside update");
    await until(() => statuses.length >= 3);
    assert.deepEqual(batches, []);
    rmSync(path.join(root, "cdk-app")); mkdirSync(path.join(root, "cdk-app"));
    await until(() => statuses.at(-1)?.status === "watching");
  } finally { stop(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
