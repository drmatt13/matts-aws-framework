import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { JobManager } from "../server/deploy/jobs";
import type { CommandSpec } from "../server/deploy/process";

/**
 * The job manager over real child processes: numbered logs, steps, locks,
 * cancellation of a process tree, and what a restarted Studio reports.
 */

const scratchRoot = path.resolve(__dirname, "..", "..", ".cache");

function scratch(): string {
  mkdirSync(scratchRoot, { recursive: true });
  return mkdtempSync(path.join(scratchRoot, "studio-jobs-"));
}

function node(code: string): CommandSpec {
  return { file: process.execPath, args: ["-e", code], cwd: process.cwd(), env: process.env, display: "node -e …" };
}

test("a job runs its steps in order, numbers its log and records the outcome", async () => {
  const directory = scratch();
  const events: string[] = [];
  const jobs = new JobManager({ directory, emit: (event) => events.push(event) });
  try {
    const started = jobs.start({
      kind: "export", title: "Export", params: { deployment: "my-aws-app" }, locks: ["deployment:my-aws-app"],
      steps: [
        { label: "First", command: () => node("console.log('one'); console.error('warning: two')") },
        { label: "Second", command: () => node("console.log('three')") },
      ],
    });
    assert.equal(started.status, "running");
    const done = await jobs.wait(started.id);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.steps?.map((step) => step.status), ["done", "done"]);
    const { lines } = jobs.log(started.id);
    const texts = lines.map((line) => line.text);
    assert.ok(texts.includes("one") && texts.includes("warning: two") && texts.includes("three"), texts.join("|"));
    assert.ok(texts.indexOf("one") < texts.indexOf("three"), "step order is kept");
    assert.deepEqual(lines.map((line) => line.seq), lines.map((_line, index) => index + 1), "lines are numbered from one");
    assert.equal(lines.find((line) => line.text === "warning: two")?.stream, "err");
    assert.deepEqual(jobs.log(started.id, lines.at(-2)!.seq).lines.map((line) => line.seq), [lines.at(-1)!.seq], "a reader resumes after the last line it saw");
    assert.ok(events.includes("deploy-job") && events.includes("deploy-log"));
    assert.equal(JSON.parse(readFileSync(path.join(directory, `${started.id}.json`), "utf8")).status, "succeeded", "the record on disk follows");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("a failing step fails the job, names why and skips what follows", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const job = jobs.start({
      kind: "export", title: "Export", params: {}, locks: [],
      steps: [
        { label: "Fails", command: () => node("console.log('working'); console.error('Unable to read the stacks.'); process.exit(3)") },
        { label: "Never", command: () => node("console.log('unreachable')") },
      ],
    });
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.exitCode, 3);
    assert.equal(done.summary, "Unable to read the stacks.");
    assert.deepEqual(done.steps?.map((step) => step.status), ["failed", "skipped"]);
    assert.ok(!jobs.log(job.id).lines.some((line) => line.text === "unreachable"));
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("one change per deployment at a time: a held lock refuses a second job", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const first = jobs.start({ kind: "deploy-apply", title: "Apply", params: {}, locks: ["deployment:my-aws-app"], steps: [{ label: "Wait", command: () => node("setTimeout(() => {}, 1500)") }] });
    assert.throws(
      () => jobs.start({ kind: "destroy", title: "Delete", params: {}, locks: ["deployment:my-aws-app"], steps: [] }),
      (error: Error & { status?: number }) => error.status === 409 && /Apply is still running/.test(error.message),
    );
    const other = jobs.start({ kind: "export", title: "Other", params: {}, locks: ["deployment:my-aws-app-prod"], steps: [{ label: "Quick", command: () => node("") }] });
    assert.equal((await jobs.wait(other.id)).status, "succeeded", "another deployment is not held");
    await jobs.wait(first.id);
    const after = jobs.start({ kind: "destroy", title: "Delete", params: {}, locks: ["deployment:my-aws-app"], steps: [{ label: "Quick", command: () => node("") }] });
    assert.equal((await jobs.wait(after.id)).status, "succeeded", "the lock is released when the job ends");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("cancelling stops the running process and everything it started", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const marker = path.join(directory, "grandchild.pid");
    const parent = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid)); console.log("started"); setInterval(() => {}, 1000);`;
    const job = jobs.start({ kind: "deploy-apply", title: "Apply", params: {}, locks: ["deployment:x"], cancelNote: "A CloudFormation operation already started continues in AWS.", steps: [{ label: "Long", command: () => node(parent) }] });
    for (let attempt = 0; attempt < 100 && !jobs.log(job.id).lines.some((line) => line.text === "started"); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    const grandchild = Number(readFileSync(marker, "utf8"));
    jobs.cancel(job.id);
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "cancelled");
    assert.ok(jobs.log(job.id).lines.some((line) => /continues in AWS/.test(line.text)), "the log says what cancelling cannot stop");
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      try { process.kill(grandchild, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, "the grandchild is gone too");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("a job a previous Studio left running is reported interrupted, with its log", async () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, "old.json"), JSON.stringify({ id: "old", kind: "deploy-apply", title: "Apply my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00.000Z", lastSeq: 1, deployment: "my-aws-app" }));
    writeFileSync(path.join(directory, "old.log"), `${JSON.stringify({ seq: 1, at: "2026-10-17T10:00:01.000Z", stream: "out", text: "Deploying…" })}\n`);
    const jobs = new JobManager({ directory, emit: () => {} });
    try {
      const old = jobs.get("old");
      assert.equal(old?.status, "interrupted");
      assert.match(old?.summary ?? "", /Studio stopped while this ran/);
      assert.deepEqual(jobs.log("old").lines.map((line) => line.text), ["Deploying…"]);
      assert.equal(jobs.list()[0]?.id, "old");
    } finally { await jobs.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("in-process steps share the job's log and can skip with a reason", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const job = jobs.start({
      kind: "deploy-plan", title: "Plan", params: {}, locks: [],
      steps: [
        { label: "Check", run: async (context) => { context.log("checked", "info"); context.setPlanId("p1"); } },
        { label: "Apply", run: async () => "Review needed: production" },
      ],
    });
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.planId, "p1");
    assert.deepEqual(done.steps?.map((step) => step.status), ["done", "skipped"]);
    assert.ok(jobs.log(job.id).lines.some((line) => line.text === "Apply skipped: Review needed: production"));
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
