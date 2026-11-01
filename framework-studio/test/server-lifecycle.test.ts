import assert from "./support/assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(__dirname, "../..");
const entry = pathToFileURL(path.join(root, "framework-studio/server/server.ts")).href;

function fixture() {
  const cache = path.join(root, ".cache/framework-studio/server-lifecycle-tests");
  mkdirSync(cache, { recursive: true });
  return mkdtempSync(path.join(cache, "case-"));
}

function inputTemplates(directory: string): void {
  mkdirSync(path.join(directory, "cdk-app/lambda_functions"), { recursive: true });
  writeFileSync(path.join(directory, "cdk-app/.env.dev.template"), "SETTING=development\nTOKEN=private-template-dev\n");
  writeFileSync(path.join(directory, "cdk-app/.env.prod.template"), "SETTING=production\nTOKEN=private-template-prod\n");
}

async function studioSession(running: ReturnType<typeof start>, port: number) {
  const deadline = Date.now() + 10_000;
  while (!running.output().includes("Framework Studio is running")) {
    assert.ok(Date.now() < deadline, running.output());
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const base = `http://127.0.0.1:${port}`, page = await (await fetch(base)).text();
  const headers = { "x-studio-token": page.match(/name="studio-token" content="([^"]+)"/)![1]!, "x-studio-protocol": page.match(/name="studio-protocol" content="([^"]+)"/)![1]!, origin: base, "content-type": "application/json" };
  return { base, headers };
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return (server.address() as { port: number }).port;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function start(directory: string, port: number): { child: ChildProcess; exited: Promise<number | null>; output: () => string } {
  const program = `import { startServer } from ${JSON.stringify(entry)};
startServer(${JSON.stringify(directory)}, ["--port", ${JSON.stringify(String(port))}]).catch(error => {
  process.stderr.write(String(error) + "\\n"); process.exitCode = 1;
});`;
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", program], {
    cwd: root,
    env: { ...process.env, FRAMEWORK_STUDIO_STATE_DIRECTORY: path.join(directory, "state") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Studio did not release its resources:\n${output}`)); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  return { child, exited, output: () => output };
}

test("an occupied Studio port fails before creating services or evaluator state and exits naturally", async () => {
  const directory = fixture();
  inputTemplates(directory);
  const blocker = createServer();
  const port = await listen(blocker);
  const process = start(directory, port);
  try {
    assert.equal(await process.exited, 1, process.output());
    assert.match(process.output(), /EADDRINUSE/);
    assert.equal(existsSync(path.join(directory, "state")), false);
    assert.equal(existsSync(path.join(directory, ".cache")), false);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.dev")), false);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.prod")), false);
    assert.equal(blocker.listening, true, "the caller's listener stays owned by the caller");
  } finally {
    process.child.kill();
    await stop(blocker);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("interactive startup initializes both files before its first snapshot without exposing their values", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const response = await fetch(`${base}/api/snapshot`, { headers });
    const text = await response.text();
    const state = JSON.parse(text) as { snapshot: { models: Record<string, { resources: { id: string; deploymentFile?: { exists: boolean; setupProblem?: string } }[] }> } };
    for (const mode of ["dev", "prod"]) {
      assert.equal(readFileSync(path.join(directory, `cdk-app/.env.${mode}`), "utf8"), readFileSync(path.join(directory, `cdk-app/.env.${mode}.template`), "utf8"));
      const file = state.snapshot.models.dev!.resources.find(resource => resource.id === `envfile:${mode}`)!.deploymentFile!;
      assert.equal(file.exists, true);
      assert.equal(file.setupProblem, undefined);
    }
    assert.ok(state.snapshot.models.dev!.resources.some(resource => resource.id === "envfile:cdk"));
    assert.ok(!text.includes("private-template") && !running.output().includes("private-template"));
    rmSync(path.join(directory, "cdk-app/.env.prod"));
    const refreshed = await fetch(`${base}/api/snapshot/refresh`, { method: "POST", headers, body: "{}" });
    assert.equal(refreshed.status, 200);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.prod")), false, "refresh does not recreate a deliberate mid-session deletion");
  } finally {
    running.child.kill("SIGTERM"); await running.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one startup setup failure stays recoverable in Studio and retry preserves the other file", async () => {
  const directory = fixture();
  inputTemplates(directory);
  rmSync(path.join(directory, "cdk-app/.env.prod.template"));
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const files = async () => {
      const state = await (await fetch(`${base}/api/snapshot`, { headers })).json() as { snapshot: { models: { dev: { resources: { id: string; deploymentFile?: { exists: boolean; setupProblem?: string } }[] } } } };
      return state.snapshot.models.dev.resources;
    };
    const initial = await files();
    assert.equal(initial.find(resource => resource.id === "envfile:dev")!.deploymentFile!.exists, true);
    assert.match(initial.find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem!, /could not initialize.*\.env\.prod/);
    const failed = await fetch(`${base}/api/deployment-inputs/create`, { method: "POST", headers, body: JSON.stringify({ mode: "prod" }) });
    assert.equal(failed.status, 422);
    assert.match(await failed.text(), /retry setup/);
    writeFileSync(path.join(directory, "cdk-app/.env.dev"), "TOKEN=private-user-authored\n");
    writeFileSync(path.join(directory, "cdk-app/.env.prod.template"), "SETTING=production\n");
    const repaired = await fetch(`${base}/api/deployment-inputs/create`, { method: "POST", headers, body: JSON.stringify({ mode: "prod" }) });
    assert.equal(repaired.status, 200);
    assert.deepEqual(await repaired.json(), { file: "cdk-app/.env.prod", created: true });
    assert.equal((await files()).find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem, undefined);
    assert.equal(readFileSync(path.join(directory, "cdk-app/.env.dev"), "utf8"), "TOKEN=private-user-authored\n");
    assert.ok(!running.output().includes("private-user-authored"));
  } finally {
    running.child.kill("SIGTERM"); await running.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the print command observes missing inputs without initializing them", () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  try {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", path.join(root, "framework-studio/server/index.ts"), "--print"], {
      cwd: directory, env: { ...process.env, FRAMEWORK_STUDIO_STATE_DIRECTORY: path.join(directory, "state") }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.dev")), false);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.prod")), false);
    assert.ok(!result.stdout.includes("private-template"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an initialization failure after binding releases the port and exits naturally", async () => {
  const directory = fixture();
  const invalidRoot = path.join(directory, "file-instead-of-checkout");
  writeFileSync(invalidRoot, "fixture");
  const reservation = createServer();
  const port = await listen(reservation);
  await stop(reservation);
  const process = start(invalidRoot, port);
  try {
    assert.equal(await process.exited, 1, process.output());
    assert.match(process.output(), /ENOTDIR/);
    const replacement = createServer();
    await listen(replacement, port);
    await stop(replacement);
  } finally {
    process.child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const { queued, ignoreTerm } of [{ queued: false, ignoreTerm: false }, { queued: true, ignoreTerm: false }, { queued: false, ignoreTerm: true }]) test(`SIGTERM during startup stops blocked evaluators${queued ? " and refuses a queued refresh" : ignoreTerm ? " even when they register SIGTERM handlers" : ""} before reporting readiness`, async () => {
  const directory = fixture();
  const pidLog = path.join(directory, "all-owned-pids");
  const source = `import {writeFileSync,appendFileSync} from 'node:fs'; import path from 'node:path'; ${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""} writeFileSync(path.join(${JSON.stringify(directory)},'pid-'+process.env.FRAMEWORK_MODE),String(process.pid)); appendFileSync(${JSON.stringify(pidLog)},process.pid+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); export default {};`;
  writeFileSync(path.join(directory, "framework.config.ts"), source);
  const reservation = createServer(), port = await listen(reservation);
  await stop(reservation);
  const running = start(directory, port);
  const owned: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
  try {
    const deadline = Date.now() + 10_000;
    while (!["dev", "prod"].every(mode => existsSync(path.join(directory, `pid-${mode}`)))) {
      assert.ok(Date.now() < deadline, running.output());
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    owned.push(...["dev", "prod"].map(mode => Number(readFileSync(path.join(directory, `pid-${mode}`), "utf8"))));
    assert.ok(owned.every(alive), "both evaluators must be blocked before interruption");
    assert.ok(!running.output().includes("Framework Studio is running"));
    if (queued) {
      writeFileSync(path.join(directory, "framework.config.ts"), `${source}\n// controlled queued refresh\n`);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    running.child.kill("SIGTERM");
    assert.equal(await running.exited, 0, running.output());
    assert.ok(owned.every(pid => !alive(pid)), `Owned evaluator PIDs must exit before Studio: ${owned}`);
    assert.ok(!running.output().includes("Framework Studio is running"));
    assert.equal(readFileSync(pidLog, "utf8").trim().split("\n").length, 2, "shutdown cannot launch a follow-up evaluator pair");
    const replacement = createServer(); await listen(replacement, port); await stop(replacement);
  } finally {
    running.child.kill("SIGKILL");
    if (existsSync(pidLog)) owned.push(...readFileSync(pidLog, "utf8").trim().split("\n").map(Number));
    for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown owns blocked source-review evaluators independently of the snapshot pair", async () => {
  const directory = fixture(), flag = path.join(directory, "private-review-control"), pidLog = path.join(directory, "review-owned-pids");
  mkdirSync(path.join(directory, "framework-config"));
  mkdirSync(path.join(directory, "cdk-app/lambda_functions/http_functions/fixture"), { recursive: true });
  copyFileSync(path.join(root, "framework-config/defaults.ts"), path.join(directory, "framework-config/defaults.ts"));
  const source = `import{defineFrameworkConfig}from'@repo/framework/config';import{defaults}from'./framework-config/defaults';import{existsSync,appendFileSync}from'node:fs';if(existsSync(${JSON.stringify(flag)})){appendFileSync(${JSON.stringify(pidLog)},process.pid+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}export default defineFrameworkConfig({defaults,http:[{'/fixture':{directory:'/lambda_functions/http_functions/fixture',methods:['GET']}}],webSocket:[],events:[],services:[]});`;
  writeFileSync(path.join(directory, "framework.config.ts"), source);
  writeFileSync(path.join(directory, "cdk-app/lambda_functions/http_functions/fixture/index.ts"), 'export const lambdaHandler=async()=>({statusCode:200,body:"fixture"});');
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port), owned: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) { assert.ok(Date.now() < deadline, running.output()); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await until(() => running.output().includes("Framework Studio is running"));
    const base = `http://127.0.0.1:${port}`, page = await (await fetch(base)).text();
    const headers = { "x-studio-token": page.match(/name="studio-token" content="([^"]+)"/)![1]!, "x-studio-protocol": page.match(/name="studio-protocol" content="([^"]+)"/)![1]!, origin: base, "content-type": "application/json" };
    const state = await (await fetch(`${base}/api/snapshot`, { headers })).json() as { snapshot: { revision: string } };
    writeFileSync(flag, "block review only");
    const request = fetch(`${base}/api/edits/batch/plan`, { method: "POST", headers, body: JSON.stringify({ revision: state.snapshot.revision, edits: [{ kind: "tags", entity: "lambda:fixture", tags: { qa: "review" } }] }) }).then(response => response.text()).catch(() => undefined);
    await until(() => existsSync(pidLog) && readFileSync(pidLog, "utf8").trim().split("\n").length === 2);
    owned.push(...readFileSync(pidLog, "utf8").trim().split("\n").map(Number));
    assert.ok(owned.every(alive));
    running.child.kill("SIGTERM");
    assert.equal(await running.exited, 0, running.output());
    assert.ok(owned.every(pid => !alive(pid)), "all independently created review evaluators must exit with Studio");
    assert.equal(readFileSync(path.join(directory, "framework.config.ts"), "utf8"), source);
    await request;
  } finally {
    running.child.kill("SIGKILL");
    for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});


test("source history endpoints are removed and snapshots omit their history state", async () => {
  const directory = fixture();
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const deadline = Date.now() + 10_000;
    while (!running.output().includes("Framework Studio is running")) {
      assert.ok(Date.now() < deadline, running.output());
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const base = `http://127.0.0.1:${port}`, page = await (await fetch(base)).text();
    const headers = { "x-studio-token": page.match(/name="studio-token" content="([^"]+)"/)![1]!, "x-studio-protocol": page.match(/name="studio-protocol" content="([^"]+)"/)![1]!, origin: base, "content-type": "application/json" };
    const state = await (await fetch(`${base}/api/snapshot`, { headers })).json();
    assert.equal(Object.hasOwn(state, "history"), false);
    for (const route of ["edits/undo", "edits/redo", "resources/undo", "resources/redo"]) {
      const response = await fetch(`${base}/api/${route}`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 404, `${route} must not remain a source-writing API`);
    }
  } finally {
    running.child.kill("SIGKILL"); await running.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
