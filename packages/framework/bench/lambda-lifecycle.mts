import { performance } from "node:perf_hooks";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, totalmem, platform, release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LambdaWorkerPool } from "../src/local/lambda-process.ts";

const root = process.cwd();
const out = path.resolve(process.env.FRAMEWORK_BENCHMARK_DIRECTORY ?? ".framework/benchmarks/lambda-lifecycle");
const phase = process.argv[2] ?? "current";
if (!/^[a-zA-Z0-9_-]+$/.test(phase)) throw new Error("Choose an alphanumeric benchmark label.");
mkdirSync(out, { recursive: true });
const fixture = mkdtempSync(path.join(out, "fixture-"));
const handlerFile = path.join(fixture, "handler.mjs");
writeFileSync(handlerFile, `import { writeFileSync } from 'node:fs';
let n = 0;
export async function handler(event) {
  ++n;
  if (event.started) writeFileSync(event.started, String(process.pid));
  if (event.sleep) await new Promise(r => setTimeout(r, event.sleep));
  return { pid: process.pid, n };
}`);
const environment = { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const request = (event = {}) => ({ entry: pathToFileURL(handlerFile).href, handler: "handler", event, lambda: { functionName: "job4", memoryLimitInMB: 128, timeoutSeconds: 10 } });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const live = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(test: () => boolean) {
  const end = Date.now() + 5000;
  while (!test()) { if (Date.now() > end) throw new Error("fixture readiness deadline"); await wait(5); }
}
const timings: Record<string, number[]> = {};
async function timed(name: string, f: () => Promise<unknown>) { const start = performance.now(); const result = await f(); (timings[name] ??= []).push(performance.now()-start); return result; }
const pids = new Set<number>();
const failures: Record<string, unknown> = {};
for (let i=0; i<9; ++i) {
  const pool = new LambdaWorkerPool({ repositoryRoot: root, maxWarm: 1, idleSeconds: 30 });
  const cold = await timed("coldInvokeMs", () => pool.invoke("lambda:job4", environment, request())) as {pid: number};
  pids.add(cold.pid);
  for (let j=0; j<10; ++j) await timed("warmInvokeMs", () => pool.invoke("lambda:job4", environment, request()));
  const start = performance.now(); pool.close(); await until(() => !live(cold.pid));
  (timings.closeIdleMs ??= []).push(performance.now()-start);
}
{
  const pool = new LambdaWorkerPool({ repositoryRoot: root, maxWarm: 1, idleSeconds: 30 });
  const aborted = new AbortController(); aborted.abort(new Error("cancel-before-call"));
  const marker = path.join(fixture, `${phase}-preabort`); rmSync(marker, { force: true });
  const result = await timed("preabortedInvokeMs", () => pool.invoke("lambda:job4", environment, request({ started: marker }), aborted.signal).then(() => "fulfilled", e => String(e)));
  failures.preAborted = { result, handlerExecuted: existsSync(marker) };
  if (existsSync(marker)) pids.add(Number(readFileSync(marker, "utf8")));
  pool.close();
}
{
  const pool = new LambdaWorkerPool({ repositoryRoot: root, maxWarm: 1, idleSeconds: 30 });
  const a = path.join(fixture, `${phase}-warm`), b = path.join(fixture, `${phase}-overflow`);
  rmSync(a, {force:true}); rmSync(b, {force:true});
  const warm = pool.invoke("lambda:job4", environment, request({started:a, sleep:1500})).then(() => "fulfilled", e => String(e));
  await until(() => existsSync(a));
  const overflow = pool.invoke("lambda:job4", environment, request({started:b, sleep:1500})).then(() => "fulfilled", e => String(e));
  await until(() => existsSync(b));
  const warmPid = Number(readFileSync(a, "utf8")), overflowPid = Number(readFileSync(b, "utf8"));
  pids.add(warmPid); pids.add(overflowPid);
  const start = performance.now(); pool.close(); await wait(50);
  const aliveAfter50ms = { warm:live(warmPid), overflow:live(overflowPid) };
  const results = await Promise.all([warm, overflow]);
  failures.closeActive = { aliveAfter50ms, settledMs: performance.now()-start, results };
  const result = await pool.invoke("lambda:job4", environment, request()).then(v => {pids.add((v as {pid:number}).pid); return "fulfilled";}, e => String(e));
  failures.invokeAfterClose = result;
  pool.close();
}
await until(() => [...pids].every(pid => !live(pid)));
const summary = Object.fromEntries(Object.entries(timings).map(([name, data]) => { const sorted = [...data].sort((a,b)=>a-b); return [name, {samples:data.length, median:sorted[Math.floor(sorted.length/2)], min:sorted[0], max:sorted.at(-1)}]; }));
const report = { phase, context:{node:process.version,platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),date:new Date().toISOString()},summary,timings,failures,childPids:[...pids],childrenRemaining:[...pids].filter(live),memory:process.memoryUsage(),cpu:process.cpuUsage() };
writeFileSync(path.join(out, `${phase}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify({phase,summary,failures,childrenRemaining:report.childrenRemaining},null,2));
rmSync(fixture, { recursive: true, force: true });
