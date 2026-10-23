import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { SourceJournal } from "../server/edits/journal";

const repository = path.resolve(__dirname, "../..");
const cache = path.join(repository, ".cache/framework-studio/source-lock-race-tests");
mkdirSync(cache, { recursive: true });
function fixture() {
  const root = mkdtempSync(path.join(cache, "case-"));
  const file = path.join(root, "framework-config/qa.ts");
  mkdirSync(path.dirname(file)); writeFileSync(file, "original\n");
  return { root, file, changes: [{ file, before: "original\n", after: "reviewed\n" }], cleanup: () => { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true, force: true }); } };
}

test("a contender refuses an initializing live lock without reading partial metadata or changing source", async () => {
  const f = fixture();
  const release = path.join(f.root, "release-owner");
  const module = path.join(repository, "framework-studio/server/edits/journal.ts");
  // Pause the actual owner's fd write after SourceJournal has created its wx
  // lock, making the normally tiny initialization window deterministic.
  const script = `const fs=require("node:fs");const original=fs.writeFileSync;let paused=false;fs.writeFileSync=function(file,...args){if(typeof file==="number"&&!paused){paused=true;process.stdout.write("metadata-pending\\n");while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return original.call(this,file,...args);};const {SourceJournal}=require(${JSON.stringify(module)});const id=new SourceJournal(${JSON.stringify(f.root)}).begin("Paused owner",${JSON.stringify(f.changes)});process.stdout.write("acquired "+id+"\\n");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { errors += String(chunk); });
  const until = async (ready: () => boolean) => { const started = Date.now(); while (!ready()) { if (Date.now() - started > 15_000) throw Error(JSON.stringify({ output, errors })); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    await until(() => output.includes("metadata-pending"));
    const lock = path.join(f.root, ".cache/framework-studio/transactions/source.lock");
    assert.equal(readFileSync(lock, "utf8"), "");
    assert.throws(() => new SourceJournal(f.root).begin("Contender", f.changes), error => (error as { status?: number }).status === 409);
    assert.equal(readFileSync(lock, "utf8"), "", "contender must not rewrite or remove another owner's initializing lock");
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
    writeFileSync(release, "continue"); await until(() => output.includes("acquired "));
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).ownerPid, child.pid);
    assert.deepEqual(new SourceJournal(f.root).pending(), [], "a live owner is unavailable for recovery");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited; }
    f.cleanup();
  }
});

test("an unknown incomplete lock stays untouched and requires explicit inspection", () => {
  const f = fixture();
  const folder = path.join(f.root, ".cache/framework-studio/transactions"), lock = path.join(folder, "source.lock");
  mkdirSync(folder, { recursive: true }); writeFileSync(lock, "");
  try {
    const journal = new SourceJournal(f.root);
    assert.throws(() => journal.pending(), /incomplete or invalid/);
    assert.throws(() => journal.begin("Never reclaim", f.changes), error => (error as { status?: number }).status === 409);
    assert.ok(existsSync(lock)); assert.equal(readFileSync(lock, "utf8"), "");
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
  } finally { f.cleanup(); }
});

test("pending records without a lock refuse a new begin and release only its new checkout lock", () => {
  const f = fixture();
  const folder = path.join(f.root, ".cache/framework-studio/transactions"), lock = path.join(folder, "source.lock");
  const id = randomUUID(), record = path.join(folder, `${id}.json`);
  const previous = JSON.stringify({ version: 1, id, root: realpathSync(f.root), ownerPid: process.pid, label: "Interrupted record without lock", createdAt: "2026-10-23T00:00:00Z", status: "pending", changes: [{ file: "framework-config/qa.ts", before: "original\n", after: "reviewed\n" }] });
  mkdirSync(folder, { recursive: true }); writeFileSync(record, previous);
  try {
    const journal = new SourceJournal(f.root);
    assert.throws(() => journal.begin("Must review recovery", f.changes), error => (error as { status?: number }).status === 409 && /recovery/i.test((error as Error).message));
    assert.equal(existsSync(lock), false, "a refusal releases the lock acquired by this begin");
    assert.equal(readFileSync(record, "utf8"), previous, "the older pending record is never rewritten or reclaimed");
    assert.equal(readFileSync(f.file, "utf8"), "original\n");
    assert.equal(journal.pending()[0]?.id, id);
  } finally { f.cleanup(); }
});
