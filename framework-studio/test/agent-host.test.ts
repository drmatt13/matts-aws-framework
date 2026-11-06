import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTaskClient } from "../server/agent-runtime/client";
import { agentEndpoint, callAgentHost } from "../server/agent-runtime/ipc";
import type { CodingTaskStatus } from "../shared/agent-runtime";

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-agent-host-"));
  const root = path.join(directory, "project"), state = path.join(directory, "state"), control = path.join(directory, "continue"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }));
  writeFileSync(path.join(root, "application.ts"), "export const message = 'original saved source';\n");
  const children: ChildProcess[] = [], clients: AgentTaskClient[] = [];
  async function start() {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "support/agent-host-fixture.ts"), root, state, control], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let diagnostic = "";
    child.stderr!.on("data", chunk => { diagnostic += chunk.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture host startup timed out: ${diagnostic}`)), 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture host exited ${code}: ${diagnostic}`)); });
      child.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    });
    return child;
  }
  async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill(signal); await closed;
  }
  const client = () => { const value = new AgentTaskClient(root, state); clients.push(value); return value; };
  t.after(async () => { clients.forEach(value => value.close()); await Promise.all(children.map(child => stop(child))); rmSync(directory, { recursive: true, force: true }); });
  return { root, state, control, start, stop, client };
}
async function until(client: AgentTaskClient, id: string, status: CodingTaskStatus) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = await client.get(id); if (task.status === status) return task;
    if (["failed", "recovery_required"].includes(task.status)) assert.fail(task.summary ?? task.status);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Task did not reach ${status}`);
}
const intent = { requestKey: "disposable-host-request", provider: "codex" as const, prompt: "Change the fixture message and validate it." };

test("independent task host survives observer replacement and imports only an exact approved artifact", async t => {
  const f = fixture(t), host = await f.start(), first = f.client();
  const task = await first.submit(intent); await until(first, task.id, "running");
  first.close();
  const second = f.client(); assert.equal((await second.ping()).pid, host.pid);
  assert.equal((await second.submit(intent)).id, task.id);
  writeFileSync(f.control, "continue"); await until(second, task.id, "awaiting_review");
  assert.match(readFileSync(path.join(f.root, "application.ts"), "utf8"), /original saved source/);
  const proposal = await second.proposal(task.id);
  await assert.rejects(second.action(task.id, "approve", { digest: "wrong" }), /current proposal/);
  await second.action(task.id, "approve", { digest: proposal.digest }); await until(second, task.id, "completed");
  assert.match(readFileSync(path.join(f.root, "application.ts"), "utf8"), /reviewed change/);
  const events = await second.events(task.id, 2); assert.ok(events.events.every(event => event.seq > 2));
  await f.stop(host);
  const reopened = await f.start(), third = f.client();
  assert.equal((await third.get(task.id)).status, "completed");
  assert.equal((await third.ping()).pid, reopened.pid);
  assert.equal((await third.proposal(task.id)).digest, proposal.digest);
});

test("host death retains interrupted task and explicit resume reuses it without automatic replay", async t => {
  const f = fixture(t), firstHost = await f.start(), first = f.client();
  const task = await first.submit(intent); await until(first, task.id, "running");
  await f.stop(firstHost, "SIGKILL"); first.close();
  await f.start(); const second = f.client();
  assert.equal((await second.get(task.id)).status, "interrupted");
  assert.match(readFileSync(path.join(f.root, "application.ts"), "utf8"), /original saved source/);
  await assert.rejects(callAgentHost(agentEndpoint(f.root, f.state), `/tasks/${task.id}/resume`, { cwd: "/" }), /Unexpected/);
  writeFileSync(f.control, "continue"); await second.action(task.id, "resume");
  await until(second, task.id, "awaiting_review");
  assert.equal((await second.list()).tasks.length, 1);
});
