/** Manual owned acceptance probe; never targets port4590 or an existing checkout.
 * Real Studio server/routes/registration/controller; deterministic fixture provider.
 * The relocated server imports trusted helpers from this checkout, so this is not
 * evidence that a fully copied Studio toolchain builds or activates successfully. */
import assert from "./assert";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareNativeBrowserFixture } from "./agent-browser-server";
import { agentEndpoint, callAgentHost } from "../../server/agent-runtime/ipc";
import { callIpc, privateEndpoint, type CoordinatorInfo } from "../../server/operations/ipc";
import { identityAlive } from "../../server/operations/identity";
import type { ExecutionIdentity } from "../../shared/operations";
import type { CodingProposal, CodingTask } from "../../shared/agent-runtime";
import { readSourceManifest } from "../../server/agent-runtime/workspace";

const repository = path.resolve(__dirname, "../../.."), realServer = path.join(repository, "framework-studio/server/server.ts");
const requireHere = createRequire(path.join(repository, "package.json"));
const fixtureVersion = "framework-studio/server/fixture-version.ts";
interface Witness { readonly pid: number; readonly root: string; readonly entry: string; readonly version: number; readonly activation: string | null; readonly identity: ExecutionIdentity }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture() {
  const value = await prepareNativeBrowserFixture();
  const home = path.join(value.base, "private-home"), scratch = path.join(value.base, "scratch"), bin = path.join(value.base, "disabled-tools"), witnesses = path.join(value.base, "runtime-witnesses"), operationState = path.join(value.base, "operation-state");
  for (const directory of [home, scratch, bin, witnesses]) mkdirSync(directory, { mode: 0o700 });
  // No ambient credentials, cloud tools, Docker, coding CLI, hooks or PATH lookup
  // can reach the developer's authenticated tools in this lifecycle-only probe.
  for (const name of ["aws", "docker", "codex", "claude"]) writeFileSync(path.join(bin, name), "#!/bin/sh\necho 'Unavailable in the disposable Studio restart probe' >&2\nexit 64\n", { mode: 0o700, flag: "wx" });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: process.env.USER ?? "fixture", LOGNAME: process.env.USER ?? "fixture", TMPDIR: scratch,
    LANG: "en_US.UTF-8", NODE_ENV: "test", AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: path.join(home, "empty-aws-config"), AWS_SHARED_CREDENTIALS_FILE: path.join(home, "empty-aws-credentials"),
    DOCKER_HOST: `unix://${path.join(value.base, "unavailable-docker.sock")}`,
    FRAMEWORK_STUDIO_AGENT_STATE_DIRECTORY: value.state, FRAMEWORK_STUDIO_STATE_DIRECTORY: operationState,
  };
  writeFileSync(env.AWS_CONFIG_FILE!, "", { mode: 0o600, flag: "wx" }); writeFileSync(env.AWS_SHARED_CREDENTIALS_FILE!, "", { mode: 0o600, flag: "wx" });
  const write = (name: string, contents: string) => { const file = path.join(value.root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents, { flag: "wx" }); };
  const entry = path.join(value.root, "framework-studio/server/index.ts");
  // Keep startServer's implementation intact. Relocate only module resolution so
  // its STUDIO_ROOT, registered entry and private loader identify this fixture.
  const serverRequire = createRequire(realServer);
  let serverSource = readFileSync(realServer, "utf8").replace(/from (["'])([^"']+)\1/g, (match, _quote, specifier: string) => specifier.startsWith("node:") ? match : `from ${JSON.stringify(specifier.startsWith(".") ? path.resolve(path.dirname(realServer), specifier) : serverRequire.resolve(specifier))}`);
  serverSource = serverSource.replace('await import("vite")', `await import(${JSON.stringify(pathToFileURL(requireHere.resolve("vite")).href)})`);
  write("framework-studio/server/server.ts", serverSource);
  write("framework-studio/package.json", '{"name":"disposable-studio-control-plane","private":true}');
  write("framework-studio/index.html", '<!doctype html><html lang="en"><head><title>Disposable Studio restart</title></head><body>Real Studio server lifecycle probe</body></html>');
  write("framework-studio/vite.config.mts", 'export default {base:"/", optimizeDeps:{noDiscovery:true,include:[]}, server:{watch:{ignored:["**/runtime-witnesses/**"]}}};\n');
  write(fixtureVersion, "export const version = 1;\n");
  write("framework-studio/server/index.ts", `import { startServer } from './server';\nimport { version } from './fixture-version';\nimport { writeFileSync } from 'node:fs';\nimport { processIdentity } from ${JSON.stringify(path.join(repository, "framework-studio/server/operations/identity.ts"))};\nconst identity = processIdentity('owned-studio-restart-probe');\nwriteFileSync(${JSON.stringify(witnesses)} + '/' + process.pid + '.json', JSON.stringify({pid:process.pid,root:${JSON.stringify(value.root)},entry:${JSON.stringify(entry)},version,activation:process.env.FRAMEWORK_STUDIO_ACTIVATION_NONCE??null,identity}), {flag:'wx',mode:0o600});\nvoid startServer(${JSON.stringify(value.root)},process.argv.slice(2)).catch(error=>{process.stderr.write(String(error)+'\\n');process.exitCode=1;});\n`);
  write("cdk-app/.env.dev.template", "PROD_DEPLOYMENT=false\n"); write("cdk-app/.env.prod.template", "PROD_DEPLOYMENT=true\n");
  const hostEntry = path.join(value.base, "fixture-agent-host.ts");
  writeFileSync(hostEntry, `import { startAgentHost } from ${JSON.stringify(path.join(repository, "framework-studio/server/agent-runtime/host.ts"))};\nimport { integrateAgentProposal } from ${JSON.stringify(path.join(repository, "framework-studio/server/agent-runtime/integration.ts"))};\nimport { readFileSync,writeFileSync } from 'node:fs';\nimport path from 'node:path';\nvoid startAgentHost(${JSON.stringify(value.root)},${JSON.stringify(value.state)},{copyDependencies:false,canApplyRuntimeChanges:true,runProvider:async input=>{if(input.prompt.includes('fail-startup')){const file=path.join(input.cwd,'framework-studio/server/index.ts');writeFileSync(file,'throw new Error("intentional disposable startup failure");\\n'+readFileSync(file,'utf8'));}else writeFileSync(path.join(input.cwd,${JSON.stringify(fixtureVersion)}),'export const version = 2;\\n');return {status:'completed'};},validate:async input=>{if(!readFileSync(path.join(input.cwd,${JSON.stringify(fixtureVersion)}),'utf8').includes('version = 2'))return {exitCode:1};input.onOutput('Deterministic fixture source check passed; native validation is covered separately.');return {exitCode:0};},integrate:(_workspace,proposal,digest)=>integrateAgentProposal(proposal,digest)}).then(host=>{for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void host.close().then(()=>process.exit(0));});process.stdout.write('fixture-agent-host-ready\\n');},error=>{process.stderr.write(String(error)+'\\n');process.exitCode=1;});\n`, { mode: 0o600, flag: "wx" });
  return { ...value, env, entry, hostEntry, witnesses, operationState, loader: path.join(value.root, "node_modules/tsx/dist/loader.mjs") };
}

async function ephemeralPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  assert.notEqual(port, 4590); assert.ok(port > 1023); return port;
}
function startOwned(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", path.join(cwd, "node_modules/tsx/dist/loader.mjs"), file, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout!.on("data", bytes => { output = (output + String(bytes)).slice(-24_000); }); child.stderr!.on("data", bytes => { output = (output + String(bytes)).slice(-24_000); });
  child.on("error", error => { output = `${output}\n${error.message}`; });
  return { child, output: () => output };
}
async function stopOwnedChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGTERM");
  const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 10_000);
  await stopped; clearTimeout(timeout);
}

async function main() {
  const f = await fixture();
  if (process.argv.includes("--prepare-only")) { process.stdout.write(JSON.stringify({ prepared: true, base: f.base, root: f.root, entry: f.entry }) + "\n"); return; }
  const port = await ephemeralPort(), baseUrl = `http://127.0.0.1:${port}`, endpoint = agentEndpoint(f.root, f.state);
  const host = startOwned(f.hostEntry, [], f.root, f.env), studio = startOwned(f.entry, ["--port", String(port)], f.root, f.env);
  const abort = new AbortController(); for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
  const waitFor = async <T>(label: string, read: () => Promise<T | undefined>, timeout = 60_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    let lastError = "";
    while (Date.now() < deadline && !abort.signal.aborted) {
      if (host.child.exitCode !== null || label === "actual Studio startup" && studio.child.exitCode !== null) throw new Error(`${label} process exited.\nHost: ${host.output()}\nStudio: ${studio.output()}`);
      try { const value = await read(); if (value !== undefined) return value; } catch (error) { lastError = String(error).slice(-4000); }
      await pause(100);
    }
    throw new Error(`${label} did not complete. ${lastError}\nHost: ${host.output()}\nStudio: ${studio.output()}`);
  };
  const ready = async () => { const response = await fetch(`${baseUrl}/_studio/runtime-ready`, { signal: AbortSignal.timeout(1500) }); return response.ok ? await response.json() as { pid: number; activation: string | null } : undefined; };
  const browser = async () => {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) }); const html = await response.text();
    const token = html.match(/name="studio-token" content="([^"]+)"/)?.[1], protocol = html.match(/name="studio-protocol" content="([^"]+)"/)?.[1];
    if (!response.ok || !token || !protocol) throw new Error("The actual Studio page did not expose its guarded session.");
    return { "x-studio-token": token, "x-studio-protocol": protocol, origin: baseUrl, "content-type": "application/json" };
  };
  const api = async <T>(headers: Record<string, string>, route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}/api${route}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const value = await response.json(); if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(value)}`); return value as T;
  };
  const taskState = (id: string) => callAgentHost<CodingTask>(endpoint, `/tasks/${id}`, undefined, 1000);
  try {
    await waitFor("fixture agent host", async () => { const value = await callAgentHost<{ root: string }>(endpoint, "/ping", undefined, 500); return value.root === f.root ? value : undefined; });
    const first = await waitFor("actual Studio startup", ready), headers = await browser();
    assert.equal(first.pid, studio.child.pid); assert.equal(first.activation, null);
    await api(headers, "/operations"); // Settle real operation observation before managed restart admission.
    const task = await api<CodingTask>(headers, "/agent-tasks", { provider: "codex", requestKey: "actual-studio-fixture-source", prompt: "Change the disposable Studio fixture version to 2." });
    await waitFor("private self-source review", async () => { const value = await taskState(task.id); if (value.status === "failed") throw new Error(value.summary); return value.status === "awaiting_review" ? value : undefined; });
    const proposal = await api<CodingProposal>(headers, `/agent-tasks/${task.id}/proposal`);
    assert.equal(proposal.activation, "restart_required"); assert.equal(proposal.changes.length, 1);
    assert.match(readFileSync(path.join(f.root, fixtureVersion), "utf8"), /version = 1/);
    await api(headers, `/agent-tasks/${task.id}/approve`, { digest: proposal.digest });
    await waitFor("approved source import", async () => { const value = await taskState(task.id); return value.status === "completed" && value.sourceOutcome === "applied" ? value : undefined; });
    assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
    assert.equal((await ready())?.pid, first.pid, "Source approval must not restart the observer.");
    await api(headers, `/agent-tasks/${task.id}/activate`, { digest: proposal.digest });
    const activated = await waitFor("explicit managed activation", async () => { const value = await taskState(task.id); return value.runtimeActivation?.status === "ready" ? value : undefined; });
    const next = await waitFor("new Studio identity", async () => { const value = await ready(); return value && value.pid !== first.pid && !!value.activation ? value : undefined; });
    const witness = JSON.parse(readFileSync(path.join(f.witnesses, `${next.pid}.json`), "utf8")) as Witness;
    assert.equal(witness.version, 2); assert.equal(witness.activation, next.activation); assert.equal(witness.root, f.root);
    const refreshedHeaders = await browser(); assert.notEqual(refreshedHeaders["x-studio-token"], headers["x-studio-token"]);
    const retained = await api<CodingTask>(refreshedHeaders, `/agent-tasks/${task.id}`);
    assert.equal(retained.id, task.id); assert.equal(retained.proposalDigest, proposal.digest); assert.equal(retained.sourceOutcome, "applied");
    const report: Record<string, unknown> = { passed: true, fixture: f.base, port, taskId: task.id, proposalDigest: proposal.digest, firstPid: first.pid, nextPid: next.pid, activation: next.activation, version: witness.version, runtimeActivation: activated.runtimeActivation, limits: "Relocated actual server implementation imports trusted live helpers; minimal Vite page; deterministic provider/validation. Native coding, full copied frontend activation and AWS operations are separate evidence." };
    if (process.argv.includes("--startup-failure")) {
      await api(refreshedHeaders, "/operations");
      const failureTask = await api<CodingTask>(refreshedHeaders, "/agent-tasks", { provider: "codex", requestKey: "actual-studio-startup-failure", prompt: "fail-startup in the disposable Studio wrapper after reviewed approval." });
      await waitFor("startup-failure source review", async () => { const value = await taskState(failureTask.id); return value.status === "awaiting_review" ? value : undefined; });
      const failureProposal = await api<CodingProposal>(refreshedHeaders, `/agent-tasks/${failureTask.id}/proposal`);
      await api(refreshedHeaders, `/agent-tasks/${failureTask.id}/approve`, { digest: failureProposal.digest });
      await waitFor("failure candidate import", async () => { const value = await taskState(failureTask.id); return value.status === "completed" ? value : undefined; });
      await api(refreshedHeaders, `/agent-tasks/${failureTask.id}/activate`, { digest: failureProposal.digest });
      const failed = await waitFor("startup failure retention", async () => { const value = await taskState(failureTask.id); return value.runtimeActivation?.status === "failed" ? value : undefined; });
      assert.equal(failed.sourceOutcome, "applied"); assert.equal(failed.status, "completed"); assert.equal(failed.proposalDigest, failureProposal.digest);
      assert.equal((await taskState(task.id)).proposalDigest, proposal.digest);
      assert.equal(readSourceManifest(f.root).digest, failureProposal.candidateDigest);
      report.startupFailure = { taskId: failed.id, retainedSource: true, retainedPriorTask: true, runtimeActivation: failed.runtimeActivation };
    }
    writeFileSync(path.join(f.base, "acceptance.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally {
    // Stop only exact owned instance identities recorded by this fixture wrapper.
    const stopped: ExecutionIdentity[] = [];
    for (const name of readdirSync(f.witnesses)) {
      const value = JSON.parse(readFileSync(path.join(f.witnesses, name), "utf8")) as Witness;
      if (value.root === f.root && value.entry === f.entry && identityAlive(value.identity) === true) { process.kill(value.pid, "SIGTERM"); stopped.push(value.identity); }
    }
    await stopOwnedChild(studio.child); await stopOwnedChild(host.child);
    for (const identity of stopped) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && identityAlive(identity) === true) await pause(100);
      if (identityAlive(identity) === true) throw new Error(`Owned fixture Studio ${identity.pid} did not stop; retained ${f.base} for inspection.`);
    }
    try {
      const info = await callIpc<CoordinatorInfo>(privateEndpoint(f.root, f.operationState).socket, "/ping", undefined, 500);
      const command = execFileSync("/bin/ps", ["-p", String(info.pid), "-o", "command="], { encoding: "utf8", timeout: 1500 });
      if (info.root === f.root && info.state === f.operationState && command.includes("operations/coordinator.ts") && command.includes(f.root) && command.includes(f.operationState)) process.kill(info.pid, "SIGTERM");
    } catch { /* A coordinator that never started or already exited needs no action. */ }
    // Retain disposable source, journals and evidence for review, including failures.
    process.stderr.write(`Owned Studio restart fixture retained at ${f.base}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
