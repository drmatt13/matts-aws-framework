/** Manual native acceptance harness. Real task/snapshot/watcher paths; disposable
 * source only. AWS and Docker operations are unavailable in this server. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { build } from "esbuild";
import { defaults } from "../../../framework-config/defaults";
import { SnapshotBuilder } from "../../server/snapshot";
import { watchRepository } from "../../server/watch";
import { AgentLabService, agentLabRouter } from "../../server/agent-lab";
import { AgentTaskClient } from "../../server/agent-runtime/client";
import { agentTaskRouter } from "../../server/agent-runtime/router";
import { pinAgentRuntime } from "../../server/agent-runtime/runtime-release";
import { agentEndpoint, callAgentHost } from "../../server/agent-runtime/ipc";
import { apiGuard, hostGuard } from "../../server/guards";
import { STUDIO_PROTOCOL_VERSION } from "../../shared/protocol";
import type { SnapshotResponse } from "../../shared/api";
import type { SourceWatchState } from "../../shared/watch";

const studioRoot = path.resolve(__dirname, "../.."), repository = path.resolve(studioRoot, "..");
export const NATIVE_BROWSER_PROMPT = "Fix add(a, b) in cdk-app/lambda_functions/http_functions/sum/math.cjs to add instead of subtract. Rename only the /add HTTP route to /sum in framework-config/workloads/http.ts, preserving the sum target identity. Do not change tests, manifests, or framework helpers. Run npm run verify and repair failures. Keep changes limited to those two source files.";

export async function prepareNativeBrowserFixture() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-native-browser-"))), root = path.join(base, "project"), state = path.join(base, "agent-state");
  mkdirSync(root, { mode: 0o700 });
  const write = (name: string, content: string) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content, { flag: "wx" }); };
  const api = await build({ entryPoints: [path.join(repository, "packages/framework/src/config/index.ts")], bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" });
  write("AGENTS.md", "This is a disposable native coding acceptance fixture. No AWS, database, Docker, deployment, account, Git, network, or package-install actions are authorized. Run npm run verify after source edits. Do not edit tests or framework helper code.\n");
  write("package.json", JSON.stringify({ name: "native-agent-fixture", private: true, scripts: { verify: "node test.cjs" } }, null, 2));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", moduleResolution: "node", esModuleInterop: true } }));
  write("packages/framework/package.json", '{"name":"@repo/framework","exports":{"./config":"./index.cjs"}}');
  write("packages/framework/index.cjs", api.outputFiles![0]!.text);
  write("framework-config/defaults.ts", `export const defaults = ${JSON.stringify(defaults, null, 2)};\n`);
  write("framework-config/workloads/http.ts", 'export const http = { "/add": { directory: "/lambda_functions/http_functions/sum", methods: ["GET"] } };\n');
  write("framework.config.ts", 'import { defineFrameworkConfig } from "@repo/framework/config";\nimport { defaults } from "./framework-config/defaults";\nimport { http } from "./framework-config/workloads/http";\nexport default defineFrameworkConfig({ defaults, resources: {}, http: [http], webSocket: [], events: [], services: [], tasks: [], workflows: [], tools: [], agents: [] });\n');
  write("cdk-app/lambda_functions/http_functions/sum/index.ts", 'export async function handler() { return { statusCode: 200, body: "Native agent fixture" }; }\n');
  write("cdk-app/lambda_functions/http_functions/sum/math.cjs", "exports.add = (a, b) => a - b;\n");
  write("test.cjs", "const assert = {equal:(a,b)=>{if(!Object.is(a,b))throw new Error('Unexpected sum')},ok:v=>{if(!v)throw new Error('Expected /sum route')}}; const fs = require('node:fs'); const { add } = require('./cdk-app/lambda_functions/http_functions/sum/math.cjs'); assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); assert.ok(fs.readFileSync('framework-config/workloads/http.ts','utf8').includes('/sum')); console.log('PASS: addition and /sum route');\n");
  write("cdk-app/cdk.json", JSON.stringify({ context: { "framework:app": "native-agent-fixture", "framework:appId": "8de7cc59-85f8-4ad3-b196-c7991a26033a" } }));
  mkdirSync(path.join(root, "node_modules/@repo"), { recursive: true });
  symlinkSync("../../packages/framework", path.join(root, "node_modules/@repo/framework"));
  // Small, private installed transform closure, never live dependency symlinks.
  for (const name of ["tsx", "esbuild", "@esbuild"]) await cp(path.join(repository, "node_modules", name), path.join(root, "node_modules", name), { recursive: true, mode: constants.COPYFILE_FICLONE, dereference: false });
  return { base, root, state };
}

/** Reconnect only an owned, known disposable harness; never accept a checkout. */
export function loadNativeBrowserFixture(input: string) {
  const base = realpathSync(input), temporary = realpathSync(os.tmpdir());
  if (path.resolve(input) !== base || path.dirname(base) !== temporary || !/^studio-native-browser-[A-Za-z0-9_-]+$/.test(path.basename(base))) throw new Error("Reuse requires the canonical path of an owned native browser fixture.");
  const root = path.join(base, "project"), state = path.join(base, "agent-state");
  for (const directory of [base, root, state]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync(directory) !== directory) throw new Error("Fixture reuse refused: directory identity or ownership changed.");
  }
  const packageFile = path.join(root, "package.json"), instructionsFile = path.join(root, "AGENTS.md");
  for (const file of [packageFile, instructionsFile]) {
    const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Error("Fixture reuse refused: source identity changed.");
  }
  if (JSON.parse(readFileSync(packageFile, "utf8")).name !== "native-agent-fixture" || !readFileSync(instructionsFile, "utf8").startsWith("This is a disposable native coding acceptance fixture.")) throw new Error("This directory is not the native acceptance project.");
  return { base, root, state };
}

async function main() {
  const port = Number(process.env.STUDIO_NATIVE_BROWSER_PORT ?? 4594);
  if (!Number.isInteger(port) || port < 4594 || port > 4599) throw new Error("Native browser acceptance uses only disposable ports4594–4599.");
  const reuseAt = process.argv.indexOf("--reuse");
  if (reuseAt >= 0 && !process.argv[reuseAt + 1]) throw new Error("Provide the disposable fixture base after --reuse.");
  const fixture = reuseAt >= 0 ? loadNativeBrowserFixture(process.argv[reuseAt + 1]!) : await prepareNativeBrowserFixture();
  const builder = new SnapshotBuilder(fixture.root, line => process.stderr.write(`${line}\n`));
  let current = (await builder.refresh()).snapshot;
  if (current.models.dev.status !== "ok" || current.models.prod.status !== "ok") {
    await builder.dispose(); throw new Error(`Fixture declarations did not load: ${JSON.stringify([current.models.dev.diagnostics, current.models.prod.diagnostics])}`);
  }
  if (process.argv.includes("--prepare-only")) { process.stdout.write(JSON.stringify({ ...fixture, revision: current.revision, routes: current.models.dev.routes.map(route => route.path) }) + "\n"); await builder.dispose(); return; }
  if (!existsSync(path.join(studioRoot, "dist/index.html"))) throw new Error("Build framework-studio before starting this acceptance server.");
  const release = await pinAgentRuntime(fixture.root, fixture.state);
  const host = spawn(process.execPath, [release.entry, fixture.root, fixture.state, release.directory], { cwd: release.directory, stdio: ["ignore", "pipe", "pipe"] });
  let hostError = "";
  host.stderr?.on("data", bytes => { hostError = `${hostError}${String(bytes)}`.slice(-4000); });
  let connected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await callAgentHost(agentEndpoint(fixture.root, fixture.state), "/ping", undefined, 500); connected = true; break; } catch { /* Wait only for this owned host. */ }
    if (host.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!connected) { host.kill("SIGTERM"); await builder.dispose(); throw new Error(`Fixture agent host did not start. ${hostError}`); }
  const client = new AgentTaskClient(fixture.root, fixture.state), lab = new AgentLabService(fixture.root);
  const app = express(), server = createServer(app), clients = new Set<ServerResponse>(), token = randomBytes(24).toString("hex");
  let evaluating = false, disposed = false, running: Promise<void> | undefined;
  let sourceWatch: SourceWatchState = { status: "watching", checkedAt: new Date().toISOString(), pollIntervalMs: 1000, problems: [] };
  const broadcast = (name: string, value: unknown) => { for (const response of clients) response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`); };
  const refresh = (external: readonly string[] = []) => {
    if (disposed || running) return;
    evaluating = true; broadcast("status", { evaluating });
    running = (async () => {
      try { current = (await builder.refresh()).snapshot; broadcast("snapshot", { revision: current.revision, external }); }
      catch (error) { process.stderr.write(`Fixture refresh: ${String(error)}\n`); }
      finally { evaluating = false; running = undefined; broadcast("status", { evaluating }); }
    })();
  };
  const stopWatching = watchRepository(fixture.root, refresh, 150, { pollIntervalMs: 1000, onStatus: status => { sourceWatch = status; broadcast("source-watch", status); } });
  const publicationTimer = setInterval(() => { if (builder.publicationState.status === "refresh_required") refresh(); }, 1000);
  app.disable("x-powered-by"); app.use(hostGuard(port));
  const api = express.Router(); api.use(express.json({ limit: "640kb" }), apiGuard(token));
  api.use((request, response, next) => { if (request.method !== "GET" && request.get("x-studio-protocol") !== STUDIO_PROTOCOL_VERSION) response.status(409).json({ error: "Reload this fixture with the current Studio protocol." }); else next(); });
  api.use("/agent-lab", agentLabRouter(lab)); api.use("/agent-tasks", agentTaskRouter(client));
  api.get("/snapshot", (_request, response) => response.json({ snapshot: builder.current?.snapshot ?? current, evaluating, commands: {}, busy: null, sourceRecovery: [], sourceWatch } satisfies SnapshotResponse));
  api.get("/events", (request, response) => { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" }); clients.add(response); response.write(`event: hello\ndata: ${JSON.stringify({ sourceWatch })}\n\n`); request.once("close", () => clients.delete(response)); });
  api.get("/source-recovery", (_request, response) => response.json([]));
  api.get("/operations", (_request, response) => response.json({ jobs: [] }));
  api.get("/deploy/profiles", (_request, response) => response.json([]));
  api.get("/aws-connections", (_request, response) => response.json({ revision: "native-fixture-no-aws", profiles: [], sessions: [], diagnostics: [], environment: { credentialsPresent: false, endpointOverridesPresent: false }, capabilities: { available: false } }));
  const local = { project: "native-agent-fixture", docker: { engine: "unknown", desktop: false }, services: [], watch: { running: false }, client: { running: false }, exported: { client: false }, startedBy: "none", restartNeeded: [] };
  api.get("/deploy/local", (_request, response) => response.json(local));
  api.get("/deploy/overview", (_request, response) => response.json({ targets: [], prerequisites: [], local, jobs: [], preferences: { profiles: {} }, profiles: [] }));
  api.get("/machine/docker", (_request, response) => response.json({ docker: local.docker, observedAt: new Date().toISOString(), checks: [{ id: "docker", label: "Docker", status: "unknown", summary: "Unavailable in the native coding acceptance fixture." }] }));
  api.use((_request, response) => response.status(501).json({ error: "This isolated acceptance server does not expose AWS, database, or Docker operations." })); app.use("/api", api);
  app.get("/__fixture/info", (_request, response) => response.json({ ...fixture, hostPid: host.pid, protocol: STUDIO_PROTOCOL_VERSION, prompt: NATIVE_BROWSER_PROMPT, revision: current.revision, routes: current.models.dev.routes.map(route => route.path), modelStatus: current.models.dev.status }));
  app.get("/__fixture/source", (_request, response) => response.json({ math: readFileSync(path.join(fixture.root, "cdk-app/lambda_functions/http_functions/sum/math.cjs"), "utf8"), routes: readFileSync(path.join(fixture.root, "framework-config/workloads/http.ts"), "utf8"), revision: current.revision }));
  const fonts = path.join(studioRoot, "test/browser/assets/fonts");
  app.get("/fixture-fonts/fonts.css", (_request, response) => response.type("text/css").send(readFileSync(path.join(fonts, "fonts.css"), "utf8").replaceAll("https://fonts.gstatic.com/studio-fixtures/", "/fixture-fonts/")));
  app.use("/fixture-fonts", express.static(fonts)); app.use(express.static(path.join(studioRoot, "dist"), { index: false }));
  const html = readFileSync(path.join(studioRoot, "dist/index.html"), "utf8").replace(/<link[^>]*rel="preconnect"[^>]*>/g, "").replace(/https:\/\/fonts\.googleapis\.com\/[^"\s]+/g, "/fixture-fonts/fonts.css").replace("</head>", `<meta name="studio-token" content="${token}"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head>`);
  app.use((_request, response) => response.type("html").send(html));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    disposed = true; clearInterval(publicationTimer); stopWatching(); for (const response of clients) response.end();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    client.close(); await lab.dispose(); await builder.dispose(); await running;
    if (host.exitCode === null) {
      const stopped = new Promise<void>(resolve => host.once("exit", () => resolve())); host.kill("SIGTERM");
      const escalation = setTimeout(() => { if (host.exitCode === null) host.kill("SIGKILL"); }, 10_000); await stopped; clearTimeout(escalation);
    }
  })();
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); }
  catch (error) { await close(); throw error; }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
  process.stdout.write(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, ...fixture, hostPid: host.pid, prompt: NATIVE_BROWSER_PROMPT }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
