import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTaskService, type AgentServiceOptions } from "../server/agent-runtime/service";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import type { ReviewedStructuredSource } from "../server/agent-runtime/structured-proposal";
import { readSourceManifest } from "../server/agent-runtime/workspace";
import type { CodingTask, CodingTaskStatus } from "../shared/agent-runtime";

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "studio-structured-service-")));
  const root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "structured-fixture", scripts: { "framework:check": "fixture declaration check" } }));
  writeFileSync(path.join(root, "framework.config.ts"), "export const route = '/before';\n");
  writeFileSync(path.join(root, "untracked.txt"), "saved developer work\n");
  const baseline = readSourceManifest(root).digest;
  const review: ReviewedStructuredSource = {
    planId: "trusted-editor-plan", revision: "accepted-source-revision",
    changes: [
      { path: "framework.config.ts", before: "export const route = '/before';\n", after: "export const route = '/after';\n" },
      { path: "handler.ts", before: null, after: "export const handler = () => 'reviewed';\n" },
    ],
    preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } },
    select: "route:http:/after", entityRemap: { "route:http:/before": "route:http:/after" },
  };
  const open = new Set<AgentTaskService>();
  let providerCalls = 0, validations = 0, imports = 0;
  const service = (overrides: Partial<AgentServiceOptions> = {}) => {
    const instance = new AgentTaskService(root, state, {
      copyDependencies: false,
      runProvider: async () => { providerCalls++; throw new Error("Structured source must never invoke a model."); },
      validate: async options => {
        validations++;
        assert.notEqual(options.cwd, root);
        assert.ok(options.cwd.startsWith(`${state}${path.sep}`));
        assert.deepEqual(options.command, { file: "npm", args: ["run", "framework:check"] });
        assert.equal(readFileSync(path.join(options.cwd, "framework.config.ts"), "utf8"), review.changes[0]!.after);
        assert.equal(readFileSync(path.join(options.cwd, "handler.ts"), "utf8"), review.changes[1]!.after);
        assert.equal(readSourceManifest(root).digest, baseline);
        options.onOutput("Fixture declaration validation passed.\n");
        return { exitCode: 0 };
      },
      integrate: async (_workspace, proposal, digest) => { imports++; return integrateAgentProposal(proposal, digest); },
      ...overrides,
    });
    open.add(instance); return instance;
  };
  const close = async (instance: AgentTaskService) => { if (open.delete(instance)) await instance.close(); };
  t.after(async () => { for (const instance of open) await instance.close(); rmSync(directory, { recursive: true, force: true }); });
  return { root, state, baseline, review, service, close, counts: () => ({ providerCalls, validations, imports }) };
}

async function until(service: AgentTaskService, id: string, expected: CodingTaskStatus): Promise<CodingTask> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const task = service.get(id);
    if (task.status === expected) return task;
    if (["failed", "recovery_required"].includes(task.status)) assert.fail(`Expected ${expected}, received ${task.status}: ${task.summary}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Structured task did not reach ${expected}: ${JSON.stringify(service.get(id))}`);
}

test("trusted structured handoff validates privately and imports only the approved frozen proposal without a model", async t => {
  const f = fixture(t), service = f.service(); service.start();
  const task = service.submitStructured(f.review, "structured-handoff-request");
  assert.equal(service.submitStructured(f.review, "structured-handoff-request").id, task.id);
  await until(service, task.id, "awaiting_review");
  const proposal = service.proposal(task.id), record = service.store.get(task.id)!;
  assert.deepEqual(record.request.validation, { kind: "framework" });
  assert.equal(JSON.parse(record.request.context!).planId, f.review.planId);
  const provenance = JSON.parse(readFileSync(path.join(record.proposalDirectory!, "structured-review.json"), "utf8"));
  assert.equal(provenance.planId, f.review.planId);
  assert.equal(provenance.proposalDigest, proposal.digest);
  assert.deepEqual(proposal.changes.map(change => change.path), ["framework.config.ts", "handler.ts"]);
  assert.equal(proposal.validation[0]?.status, "passed");
  assert.equal(proposal.validation[0]?.candidateDigest, proposal.candidateDigest);
  assert.equal(readSourceManifest(f.root).digest, f.baseline);
  assert.deepEqual(f.counts(), { providerCalls: 0, validations: 1, imports: 0 });
  assert.ok(service.events(task.id).events.some(event => event.type === "diagnostic" && event.data.planId === f.review.planId));

  // Later private mutation must not replace approved immutable source bytes.
  writeFileSync(path.join(record.workspaceDirectory!, "working", "handler.ts"), "unreviewed later candidate edit\n");
  await assert.rejects(service.approve(task.id, "different-digest"), /current proposal/);
  assert.equal(f.counts().imports, 0);
  await service.approve(task.id, proposal.digest);
  await until(service, task.id, "completed");
  assert.equal(service.get(task.id).sourceOutcome, "applied");
  assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
  assert.equal(readFileSync(path.join(f.root, "handler.ts"), "utf8"), f.review.changes[1]!.after);
  assert.equal(readFileSync(path.join(f.root, "untracked.txt"), "utf8"), "saved developer work\n");
  await service.approve(task.id, proposal.digest);
  assert.deepEqual(f.counts(), { providerCalls: 0, validations: 1, imports: 1 });
});

test("queued structured acceptance survives host reopening without falling through to a native coding prompt", async t => {
  const f = fixture(t);
  let blockerCalls = 0;
  const first = f.service({ runProvider: async options => {
    blockerCalls++;
    assert.match(options.prompt, /Occupy the single fixture execution slot/);
    await new Promise<void>(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { status: "cancelled" };
  } });
  first.start();
  const blocker = first.submit({ requestKey: "structured-queue-blocker", provider: "codex", prompt: "Occupy the single fixture execution slot." });
  await until(first, blocker.id, "running");
  const accepted = first.submitStructured(f.review, "structured-queued-request");
  assert.equal(accepted.status, "queued");
  const captured = first.store.get(accepted.id)!.structuredSource!;
  assert.deepEqual(JSON.parse(readFileSync(captured, "utf8")), f.review);
  await f.close(first);

  const second = f.service();
  assert.equal(second.get(accepted.id).status, "queued");
  assert.equal(second.store.get(accepted.id)!.structuredSource, captured);
  second.start();
  assert.equal(second.submitStructured(f.review, "structured-queued-request").id, accepted.id);
  await until(second, accepted.id, "awaiting_review");
  assert.equal(blockerCalls, 1);
  assert.deepEqual(f.counts(), { providerCalls: 0, validations: 1, imports: 0 });
  assert.equal(readSourceManifest(f.root).digest, f.baseline);
  const proposal = second.proposal(accepted.id);
  await second.approve(accepted.id, proposal.digest);
  await until(second, accepted.id, "completed");
  assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
  assert.deepEqual(f.counts(), { providerCalls: 0, validations: 1, imports: 1 });
});

test("structured source still requires independent final validation before common approval", async t => {
  const f = fixture(t), service = f.service({ validate: async options => {
    assert.deepEqual(options.command, { file: "npm", args: ["run", "framework:check"] });
    return { exitCode: 1 };
  } });
  service.start();
  const task = service.submitStructured(f.review, "structured-failed-validation");
  await until(service, task.id, "awaiting_review");
  const proposal = service.proposal(task.id);
  assert.equal(proposal.validation[0]?.status, "failed");
  await assert.rejects(service.approve(task.id, proposal.digest), /validation must pass/);
  assert.equal(f.counts().providerCalls, 0); assert.equal(f.counts().imports, 0);
  assert.equal(readSourceManifest(f.root).digest, f.baseline);
});

test("explicit structured resume recaptures saved source and retains an interrupted staged workspace", async t => {
  const f = fixture(t);
  let stagedDirectory = "", staged!: () => void;
  const enteredValidation = new Promise<void>(resolve => { staged = resolve; });
  const first = f.service({ validate: async options => {
    if (options.signal.aborted) return { exitCode: 130 };
    stagedDirectory = options.cwd;
    assert.equal(readFileSync(path.join(options.cwd, "framework.config.ts"), "utf8"), f.review.changes[0]!.after);
    writeFileSync(path.join(options.cwd, "interrupted-validation.txt"), "retained partial validation output\n");
    return new Promise(resolve => {
      options.signal.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true });
      staged();
    });
  } });
  first.start();
  const task = first.submitStructured(f.review, "structured-interrupted-after-staging");
  await enteredValidation;
  assert.equal(first.get(task.id).status, "validating");
  await f.close(first);
  assert.equal(readSourceManifest(f.root).digest, f.baseline);

  // Unrelated saved user work must enter the new baseline, while partial output
  // from the interrupted candidate must remain only in that retained attempt.
  writeFileSync(path.join(f.root, "untracked.txt"), "newer saved developer work\n");
  const savedAtResume = readSourceManifest(f.root).digest;
  let resumedValidations = 0, resumedDirectory = "";
  const second = f.service({ validate: async options => {
    resumedValidations++; resumedDirectory = options.cwd;
    assert.notEqual(options.cwd, stagedDirectory);
    assert.deepEqual(options.command, { file: "npm", args: ["run", "framework:check"] });
    assert.equal(readFileSync(path.join(options.cwd, "untracked.txt"), "utf8"), "newer saved developer work\n");
    assert.equal(readFileSync(path.join(options.cwd, "framework.config.ts"), "utf8"), f.review.changes[0]!.after);
    assert.equal(Object.hasOwn(readSourceManifest(options.cwd).files, "interrupted-validation.txt"), false);
    assert.equal(readSourceManifest(f.root).digest, savedAtResume);
    return { exitCode: 0 };
  } });
  second.start();
  assert.equal(second.get(task.id).status, "cancelled");
  assert.equal(resumedValidations, 0);
  second.resume(task.id);
  await until(second, task.id, "awaiting_review");
  assert.equal(resumedValidations, 1); assert.equal(f.counts().providerCalls, 0);
  assert.notEqual(resumedDirectory, stagedDirectory);
  assert.equal(readFileSync(path.join(stagedDirectory, "interrupted-validation.txt"), "utf8"), "retained partial validation output\n");
  const proposal = second.proposal(task.id);
  assert.equal(proposal.baselineDigest, savedAtResume);
  assert.deepEqual(proposal.changes.map(change => change.path), ["framework.config.ts", "handler.ts"]);
  const provenance = JSON.parse(readFileSync(path.join(second.store.get(task.id)!.proposalDirectory!, "structured-review.json"), "utf8"));
  assert.equal(provenance.planId, f.review.planId); assert.equal(provenance.proposalDigest, proposal.digest);
  await second.approve(task.id, proposal.digest);
  await until(second, task.id, "completed");
  assert.equal(readSourceManifest(f.root).digest, proposal.candidateDigest);
  assert.equal(readFileSync(path.join(f.root, "untracked.txt"), "utf8"), "newer saved developer work\n");
  assert.equal(f.counts().providerCalls, 0); assert.equal(f.counts().imports, 1);
});
