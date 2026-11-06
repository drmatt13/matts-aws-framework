import assert from "./support/assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskService } from "../server/agent-runtime/service";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import { AgentTaskStore, validateTaskRequest } from "../server/agent-runtime/store";

test("bounded parallel coding retains proposals, serializes approved imports, and cleans only terminal execution files", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-agent-concurrency-")), root = path.join(directory, "project"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"fixture"}}'); writeFileSync(path.join(root, "saved.txt"), "developer source");
  let running = 0, maxRunning = 0, importing = 0, maxImporting = 0;
  const releases = new Map<string, () => void>();
  const service = new AgentTaskService(root, path.join(directory, "state"), { concurrency: 2, copyDependencies: false,
    runProvider: async options => {
      running++; maxRunning = Math.max(maxRunning, running);
      const name = options.prompt.includes("task-alpha") ? "alpha" : options.prompt.includes("task-bravo") ? "bravo" : "charlie";
      await new Promise<void>(resolve => { releases.set(name, resolve); options.signal.addEventListener("abort", () => resolve(), { once: true }); });
      running--; if (options.signal.aborted) return { status: "cancelled" };
      writeFileSync(path.join(options.cwd, `${name}.txt`), `proposed ${name}`); return { status: "completed" };
    }, validate: async () => ({ exitCode: 0 }),
    integrate: async (_workspace, proposal, digest) => {
      importing++; maxImporting = Math.max(maxImporting, importing);
      try { await new Promise(resolve => setTimeout(resolve, 30)); return await integrateAgentProposal(proposal, digest); }
      finally { importing--; }
    },
  });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); }); service.start();
  const tasks = ["alpha", "bravo", "charlie"].map(name => service.submit({ requestKey: `parallel-${name}`, provider: "codex", prompt: `task-${name}` }));
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail("Expected fixture state was not reached."); };
  await wait(() => releases.size === 2); assert.equal(maxRunning, 2); assert.equal(service.get(tasks[2]!.id).status, "queued");
  await assert.rejects(service.cleanup(tasks[0]!.id), /completed or rejected/);
  releases.get("alpha")!(); await wait(() => releases.has("charlie")); releases.get("bravo")!(); releases.get("charlie")!();
  await wait(() => tasks.every(task => service.get(task.id).status === "awaiting_review"));
  const first = tasks[0]!, second = tasks[1]!, rejected = tasks[2]!;
  const firstProposal = service.proposal(first.id), secondProposal = service.proposal(second.id);
  await Promise.all([service.approve(first.id, firstProposal.digest), service.approve(second.id, secondProposal.digest)]);
  await wait(() => service.get(first.id).status === "completed" && service.get(second.id).status === "conflicted");
  assert.equal(maxImporting, 1); assert.equal(existsSync(path.join(root, "bravo.txt")), false);
  assert.equal(readFileSync(path.join(root, "saved.txt"), "utf8"), "developer source");
  service.reject(rejected.id);
  const working = path.join(service.store.get(rejected.id)!.workspaceDirectory!, "working"), digest = service.proposal(rejected.id).digest;
  assert.equal((await service.cleanup(rejected.id)).workspaceDisposition, "source_only");
  assert.equal(existsSync(working), false); assert.equal(service.proposal(rejected.id).digest, digest);
  assert.equal((await service.cleanup(rejected.id)).workspaceDisposition, "source_only");
  assert.equal(readFileSync(path.join(root, "alpha.txt"), "utf8"), "proposed alpha");
  // An observer may disconnect immediately after cleanup acceptance. Host close
  // must join that owned filesystem operation before closing durable state.
  const clearing = service.cleanup(first.id), closing = service.close();
  await closing;
  assert.equal((await clearing).workspaceDisposition, "source_only");
  const reopened = new AgentTaskStore(path.join(directory, "state"), root);
  assert.equal(reopened.get(first.id)!.view.workspaceDisposition, "source_only"); reopened.close();
});

test("validation intent rejects escaping paths and replay pages stay below the IPC bound", t => {
  assert.throws(() => validateTaskRequest({ requestKey: "validation-fixture", provider: "codex", prompt: "test", validation: { kind: "tests", paths: ["../private.ts"] } }), /invalid source path/);
  assert.throws(() => validateTaskRequest({ requestKey: "validation-fixture", provider: "codex", prompt: "test", validation: { kind: "tests", paths: [".env.prod"] } }), /private or runtime/);
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-agent-replay-")), root = path.join(directory, "project"); mkdirSync(root);
  const store = new AgentTaskStore(path.join(directory, "state"), root); t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const task = store.accept({ requestKey: "replay-fixture", provider: "codex", prompt: "test" });
  for (let i = 0; i < 45; i++) store.append(task.id, "message", { text: "x".repeat(60000) });
  const page = store.events(task.id), next = store.events(task.id, page.events.at(-1)!.seq);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 3 * 1024 * 1024);
  assert.equal([...page.events, ...next.events].length, 46); assert.equal(next.events.at(-1)?.seq, task.lastSeq + 45);
});
