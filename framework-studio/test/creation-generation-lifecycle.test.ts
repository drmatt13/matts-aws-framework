import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCreationCommand } from "../server/edits/creation-generation";

const root = path.resolve(__dirname, "../..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) { assert.ok(Date.now() < deadline, "owned creation command did not reach its expected state"); await wait(10); }
}
function fixture(): string {
  const parent = path.join(root, ".cache/framework-studio/generation-lifecycle");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, "source with spaces-"));
}
function cleanup(pids: readonly number[]) {
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
}

test("creation commands preserve literal argv, cwd, environment, stdout tail and failure output", async () => {
  const directory = fixture();
  try {
    const args = ["value with spaces", "$(literal)"];
    const source = "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.CREATION_FIXTURE_VALUE}));";
    const stdout = await runCreationCommand(process.execPath, ["-e", source, ...args], directory, { ...process.env, CREATION_FIXTURE_VALUE: "safe fixture" });
    assert.deepEqual(JSON.parse(stdout), { args, cwd: directory, value: "safe fixture" });
    const tail = await runCreationCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(7000)+'complete tail');"], directory, process.env);
    assert.equal(tail.length, 6000); assert.ok(tail.endsWith("complete tail"));
    await assert.rejects(runCreationCommand(process.execPath, ["-e", "console.error('controlled generator failure');process.exitCode=7;"], directory, process.env), error => {
      assert.equal((error as { status: number }).status, 422);
      assert.match((error as Error).message, /Creation artifact generation failed\. controlled generator failure/);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a timed-out creation command settles only after its stubborn process tree exits", { timeout: 25_000 }, async () => {
  const directory = fixture(), marker = path.join(directory, "owned-pids.json");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const source = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,process.ppid,child.pid]));setInterval(()=>{},1000);`;
  let owned: number[] = [];
  const pending = runCreationCommand(process.execPath, ["-e", source], directory, process.env, 2000);
  // Handle rejection immediately while separately observing the owned PIDs.
  const rejected = assert.rejects(pending, { status: 422, message: "Creation artifact generation timed out. Nothing was written." });
  try {
    await until(() => existsSync(marker)); owned = JSON.parse(readFileSync(marker, "utf8"));
    await rejected;
    assert.ok(owned.every(pid => !alive(pid)), "the preview cleanup continuation must run after every owned process has exited");
    assert.equal(alive(unrelated.pid!), true, "timeout preserves unrelated processes");
  } finally { await pending.catch(() => undefined); cleanup(owned); unrelated.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
});

test("actual preview generation cannot outlive a killed Studio owner", { timeout: 25_000 }, async () => {
  const directory = fixture(), marker = path.join(directory, "generator.json");
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "creation-owner-fixture", private: true, workspaces: [] }));
  writeFileSync(path.join(directory, "framework.config.ts"), `import {writeFileSync} from 'node:fs';import {defineFrameworkConfig} from '@repo/framework/config';writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd()}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);export default defineFrameworkConfig({defaults:{lambda:{runtime:'nodejs24',packaging:'zip',architecture:'arm64',memorySize:128,timeoutSeconds:10,bundling:{}}},http:[],webSocket:[],events:[],services:[]});`);
  const program = `const{generateCreationArtifacts}=require(${JSON.stringify(path.join(root, "framework-studio/server/edits/creation-generation.ts"))});generateCreationArtifacts(${JSON.stringify(directory)},new Map()).catch(()=>{});`;
  const owner = spawn(process.execPath, ["--import", "tsx", "-e", program], { cwd: root, stdio: "ignore" });
  let owned: number[] = [];
  try {
    await until(() => existsSync(marker));
    const recorded = JSON.parse(readFileSync(marker, "utf8"));
    owned = [recorded.pid, recorded.ppid];
    assert.ok(recorded.cwd.startsWith(path.join(directory, ".cache/framework-studio/previews")));
    const exited = new Promise(resolve => owner.once("exit", resolve)); owner.kill("SIGKILL"); await exited;
    await until(() => owned.every(pid => !alive(pid)));
  } finally { owner.kill("SIGKILL"); cleanup(owned); rmSync(directory, { recursive: true, force: true }); }
});

test("a successful creation command reaps its background descendants and keeps its exit status", { timeout: 15_000, skip: process.platform === "win32" }, async () => {
  const directory = fixture(), marker = path.join(directory, "background.json");
  const grandchild = `const{writeFileSync}=require('node:fs');process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.pid));process.send('ready');setInterval(()=>{},1000);`;
  const source = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>{console.log('completed successfully');process.exit(0);});`;
  let owned: number[] = [];
  try {
    const pending = runCreationCommand(process.execPath, ["-e", source], directory, process.env);
    await until(() => existsSync(marker)); owned = [JSON.parse(readFileSync(marker, "utf8"))];
    assert.equal(await pending, "completed successfully\n");
    await until(() => owned.every(pid => !alive(pid)));
  } finally { cleanup(owned); rmSync(directory, { recursive: true, force: true }); }
});

test("owner death reaps a stubborn descendant after the direct creation command exits", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
  const directory = fixture(), marker = path.join(directory, "descendants.json");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const grandchild = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);";
  const source = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,process.ppid,child.pid])));setInterval(()=>{},1000);`;
  const program = `const{runCreationCommand}=require(${JSON.stringify(path.join(root, "framework-studio/server/edits/creation-generation.ts"))});runCreationCommand(process.execPath,['-e',${JSON.stringify(source)}],${JSON.stringify(directory)},process.env).catch(()=>{});`;
  const owner = spawn(process.execPath, ["--import", "tsx", "-e", program], { cwd: root, stdio: "ignore" });
  let owned: number[] = [];
  try {
    await until(() => existsSync(marker)); owned = JSON.parse(readFileSync(marker, "utf8"));
    const exited = new Promise(resolve => owner.once("exit", resolve)); owner.kill("SIGKILL"); await exited;
    await until(() => owned.every(pid => !alive(pid)));
    assert.equal(alive(unrelated.pid!), true, "owner death preserves unrelated processes");
  } finally { owner.kill("SIGKILL"); cleanup(owned); unrelated.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
});
