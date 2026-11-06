import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { OperationsClient } from "../server/operations/client";
import { startCoordinator } from "../server/operations/coordinator";
import { callIpc, privateEndpoint } from "../server/operations/ipc";
import { identityAlive } from "../server/operations/identity";
import { prepareIntent } from "../server/operations/adapter";
import { OperationStore } from "../server/operations/store";
import { sourceCoordinationState } from "../server/edits/source-gate";

const repository = path.resolve(__dirname, "../..");
const clientModule = path.join(repository, "framework-studio/server/operations/client.ts");
const loader = require.resolve("tsx");

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for independent operation evidence.");
}

function fixture(ticks = 65): { root: string; state: string } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-operations-process-")));
  const scripts = path.join(root, "packages/framework/scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "operations-process-fixture", private: true }));
  symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  writeFileSync(path.join(scripts, "generate-contracts.ts"), `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync('launches.txt', 'launched\\n');
writeFileSync('command.pid', String(process.pid));
let tick = 0;
console.log('fixture start');
const timer = setInterval(() => { console.log('fixture tick ' + (++tick)); if (tick >= ${ticks}) { clearInterval(timer); console.log('fixture complete'); } }, 100);
`);
  writeFileSync(path.join(scripts, "check-local.ts"), "console.log('second approved check');\n");
  return { root, state: path.join(root, ".state") };
}

async function stopCoordinator(client: OperationsClient): Promise<void> {
  const info = await client.ping();
  process.kill(info.pid, "SIGTERM");
  await until(async () => { try { process.kill(info.pid, 0); return false; } catch { return true; } }, Boolean);
}

async function cleanup(root: string, state: string, client: OperationsClient): Promise<void> {
  try {
    for (const job of await client.list()) if (job.status === "running") await client.cancel(job.id);
    await until(() => client.list(), jobs => jobs.every(job => job.status !== "running"));
    await stopCoordinator(client);
  } finally {
    client.close();
    rmSync(privateEndpoint(root, state).directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("runner rejects platforms without private Unix IPC", { skip: process.platform !== "win32" }, () => {
  assert.throws(() => privateEndpoint(process.cwd(), os.tmpdir()), /requires macOS or Linux private Unix sockets/);
});

test("private IPC rejects an exposed socket directory and has no TCP fallback", { skip: process.platform === "win32" }, () => {
  const { root, state } = fixture(1);
  const endpoint = privateEndpoint(root, state);
  try {
    chmodSync(endpoint.directory, 0o755);
    assert.throws(() => privateEndpoint(root, state), /private directory/);
  } finally {
    chmodSync(endpoint.directory, 0o700);
    rmSync(endpoint.directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("state-directory aliases share one coordinator and another checkout cannot claim its database", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const { root, state } = fixture(1), other = fixture(1);
  const first = new OperationsClient(root, state);
  const alias = path.join(root, "state-alias");
  symlinkSync(state, alias, "dir");
  const second = new OperationsClient(root, alias);
  try {
    assert.equal(first.state, second.state);
    const [a, b] = await Promise.all([first.ping(), second.ping()]);
    assert.equal(a.pid, b.pid, "aliases of one database use the same coordinator lease and socket");
    await assert.rejects(startCoordinator(other.root, state), /workspace|checkout/i);
    assert.equal((await first.ping()).pid, a.pid, "the original coordinator retains ownership");
    assert.deepEqual(await first.list(), []);
    assert.equal(existsSync(path.join(root, "launches.txt")), false);
    assert.equal(existsSync(path.join(other.root, "launches.txt")), false);
  } finally {
    second.close();
    rmSync(privateEndpoint(other.root, state).directory, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
    await cleanup(root, state, first);
  }
});

test("worker survives Studio-client death and coordinator death, with durable replay and one launch", { timeout: 45_000, skip: process.platform === "win32" }, async () => {
  // These are only fixed framework-check scripts in a disposable checkout; no AWS tool is run.
  const { root, state } = fixture();
  const studioFile = path.join(root, "studio.ts");
  writeFileSync(studioFile, `import { OperationsClient } from ${JSON.stringify(clientModule)};
const client = new OperationsClient(${JSON.stringify(root)}, ${JSON.stringify(state)});
void client.submit({ kind: 'framework-check', params: {}, requestKey: 'studio-crash-request' }).then(job => {
  console.log(JSON.stringify({ id: job.id })); setInterval(() => {}, 1000);
}, error => { console.error(error); process.exit(1); });
`);
  let studio: ChildProcess | undefined;
  const client = new OperationsClient(root, state);
  try {
    studio = spawn(process.execPath, ["--import", loader, studioFile], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    studio.stdout!.on("data", chunk => { stdout += chunk; });
    studio.stderr!.on("data", chunk => { stderr += chunk; });
    await until(async () => {
      if (studio!.exitCode !== null) throw new Error(`Fixture Studio exited: ${stderr}`);
      return stdout;
    }, text => text.includes('"id"'));
    const id = JSON.parse(stdout.trim().split("\n").at(-1)!).id as string;
    await until(() => client.log(id), page => page.lines.some(line => line.text.includes("fixture tick")));
    const before = await client.log(id);
    studio.kill("SIGKILL");
    await new Promise<void>(resolve => studio!.once("exit", () => resolve()));
    const afterStudio = await until(() => client.log(id, before.job.lastSeq), page => page.lines.some(line => line.text.includes("fixture tick")));
    assert.ok(afterStudio.lines.every(line => line.seq > before.job.lastSeq));
    const owner = (await client.get(id))!.owner!;
    assert.equal(identityAlive(owner), true, "the execution worker is independently owned");
    const coordinator = await client.ping();
    process.kill(coordinator.pid, "SIGKILL");
    await until(async () => { try { process.kill(coordinator.pid, 0); return false; } catch { return true; } }, Boolean);
    const replacement = await client.ping();
    assert.notEqual(replacement.pid, coordinator.pid);
    assert.deepEqual((await client.get(id))!.owner, owner, "restart adopts the existing worker identity");
    const repeated = await client.submit({ kind: "framework-check", params: {}, requestKey: "studio-crash-request" });
    assert.equal(repeated.id, id);
    await assert.rejects(client.submit({ kind: "export", params: {}, requestKey: "studio-crash-request" }), /different operation intent/);
    const finished = await until(() => client.get(id), operation => operation?.view.execution === "finished");
    assert.equal(finished!.view.status, "succeeded");
    assert.equal(readFileSync(path.join(root, "launches.txt"), "utf8"), "launched\n");
    const replay = await client.log(id);
    assert.deepEqual(replay.lines.map(line => line.seq), Array.from({ length: replay.lines.length }, (_, index) => index + 1));
    assert.ok(replay.lines.some(line => line.text === "fixture complete"));
    assert.equal((await client.log(id, replay.job.lastSeq)).lines.length, 0);
    assert.equal((await client.submit({ kind: "framework-check", params: {}, requestKey: "studio-crash-request" })).id, id, "terminal idempotency survives completion");
  } finally {
    if (studio?.exitCode === null) studio.kill("SIGKILL");
    await cleanup(root, state, client);
  }
});

test("concurrent clients share one coordinator and unsupported commands never execute", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const { root, state } = fixture(2);
  const first = new OperationsClient(root, state), second = new OperationsClient(root, state);
  try {
    const [a, b] = await Promise.all([first.ping(), second.ping()]);
    assert.equal(a.pid, b.pid);
    const endpoint = privateEndpoint(root, state);
    await assert.rejects(callIpc(endpoint.socket, "/submit", { kind: "shell", params: { command: "echo unsafe" }, requestKey: "unsupported-operation" }), /not supported/);
    assert.equal(existsSync(path.join(root, "launches.txt")), false);
    const [left, right] = await Promise.all([
      first.submit({ kind: "framework-check", params: {}, requestKey: "concurrent-request" }),
      second.submit({ kind: "framework-check", params: {}, requestKey: "concurrent-request" }),
    ]);
    assert.equal(left.id, right.id);
    await until(() => first.get(left.id), record => record?.view.execution === "finished");
    assert.equal(readFileSync(path.join(root, "launches.txt"), "utf8"), "launched\n");
  } finally { second.close(); await cleanup(root, state, first); }
});

test("worker death preserves uncertainty and locks across coordinator restart without replay", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const { root, state } = fixture();
  const client = new OperationsClient(root, state);
  try {
    const job = await client.submit({ kind: "framework-check", params: {}, requestKey: "worker-loss-request" });
    await until(() => client.log(job.id), page => page.lines.some(line => line.text.includes("fixture tick")));
    const worker = (await client.get(job.id))!.owner!;
    const commandPid = Number(readFileSync(path.join(root, "command.pid"), "utf8"));
    process.kill(worker.pid, "SIGKILL");
    const interrupted = await until(() => client.get(job.id), record => record?.view.execution === "lost");
    assert.equal(interrupted!.view.outcome, "uncertain");
    assert.match(interrupted!.view.recovery!, /not be replayed/);
    await until(async () => { try { process.kill(commandPid, 0); return false; } catch { return true; } }, Boolean);
    assert.equal((await client.submit({ kind: "framework-check", params: {}, requestKey: "worker-loss-request" })).id, job.id);
    await assert.rejects(client.submit({ kind: "framework-check", params: {}, requestKey: "conflicting-new-attempt" }), /Source integration or tooling is active or interrupted/);
    assert.equal(sourceCoordinationState(root).status, "recovery_required", "the killed worker retains source admission until explicit recovery");
    assert.equal(sourceCoordinationState(root).ownerPid, worker.pid);
    const coordinator = await client.ping();
    process.kill(coordinator.pid, "SIGKILL");
    await until(async () => { try { process.kill(coordinator.pid, 0); return false; } catch { return true; } }, Boolean);
    assert.equal((await client.get(job.id))!.view.execution, "lost");
    assert.equal(readFileSync(path.join(root, "launches.txt"), "utf8"), "launched\n");
  } finally { await cleanup(root, state, client); }
});

test("a coordinator lost after recording dispatch never dispatches that ambiguous attempt again", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const { root, state } = fixture(1);
  const request = { kind: "framework-check" as const, params: {}, requestKey: "ambiguous-dispatch-request" };
  const intent = await prepareIntent(root, state, request);
  // Controlled clock injection represents a dispatch journal left by an earlier process.
  const previous = new OperationStore(path.join(state, "operations"), { now: () => Date.now() - 30_000 });
  const accepted = previous.accept(intent, request.requestKey);
  assert.ok(previous.dispatch(accepted.id));
  previous.event(accepted.id, "deploy-stacks", { deployment: "fixture", stacks: [{ name: "Fixture", status: "CREATE_IN_PROGRESS" }] });
  previous.event(accepted.id, "deploy-event", { deployment: "fixture", stack: "Fixture", event: { logicalId: "Bucket", status: "CREATE_COMPLETE" } });
  previous.close();
  const client = new OperationsClient(root, state);
  try {
    const recovered = await until(() => client.get(accepted.id), record => record?.view.execution === "lost");
    assert.equal(recovered!.view.outcome, "uncertain");
    assert.equal((await client.submit(request)).id, accepted.id);
    assert.equal(existsSync(path.join(root, "launches.txt")), false, "no command was launched while recovering dispatch uncertainty");
    const events = await client.events(accepted.id);
    assert.deepEqual(events.events.map(event => [event.seq, event.event]), [[1, "deploy-stacks"], [2, "deploy-event"]]);
    assert.equal(events.lastSeq, 2);
    await stopCoordinator(client);
    const replay = await client.events(accepted.id, 1);
    assert.deepEqual(replay.events, events.events.slice(1), "structured deployment progress replays after coordinator restart");
    assert.deepEqual((await client.events(accepted.id, 2)).events, []);
  } finally { await cleanup(root, state, client); }
});
