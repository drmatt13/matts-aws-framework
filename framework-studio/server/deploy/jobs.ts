import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { JobLogLine, JobStatus, JobView } from "../../shared/deploy";
import { lineSplitter, start, stopTree, type CommandSpec } from "./process";

/**
 * Every operation Deploy & Run performs runs as a job: an attached child
 * process per step, a numbered log a page can resume from, a lock per thing it
 * changes, and a record on disk that survives a Studio restart.
 *
 * A job is never resumed after a restart. One that was running is reported
 * interrupted, with its log, and whatever it started in AWS is observed again.
 */

export interface StepContext {
  readonly job: string;
  readonly signal: AbortSignal;
  log(text: string, stream?: JobLogLine["stream"]): void;
  setSummary(text: string): void;
  setPlanId(id: string): void;
}

export interface JobStep {
  readonly label: string;
  /** A program to run. Resolved when the step starts, so it can use what earlier steps found. */
  readonly command?: (context: StepContext) => CommandSpec | Promise<CommandSpec>;
  /** Work done in this process. A returned string skips the step, with that reason. */
  readonly run?: (context: StepContext) => Promise<void | string>;
  /** Reads a finished command's output; throwing fails the step with that message. */
  readonly after?: (result: { readonly code: number | null; readonly stdout: string }, context: StepContext) => void | Promise<void>;
}

export interface JobSpec {
  readonly kind: JobView["kind"];
  readonly title: string;
  readonly params: JobView["params"];
  readonly deployment?: string;
  readonly planId?: string;
  readonly locks: readonly string[];
  readonly steps: readonly JobStep[];
  /** Runs alone: refused while any job runs, and refuses any job while it runs (npm install replaces programs others use). */
  readonly exclusive?: boolean;
  /** Said in the log when the job is cancelled: what stopping the process does not stop. */
  readonly cancelNote?: string;
  /** Called once the job has ended, whatever the outcome. */
  readonly onSettled?: (job: JobView) => void;
}

interface Job {
  view: JobView;
  readonly spec?: JobSpec;
  lines: JobLogLine[];
  pending: JobLogLine[];
  flush?: NodeJS.Timeout;
  child?: ChildProcess;
  controller: AbortController;
  cancelled: boolean;
  settled: Promise<JobView>;
  settle?: (job: JobView) => void;
}

export class JobError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MEMORY_LINES = 20_000;

/** What a job a previous Studio left running means now, by what it was doing. */
function interruption(kind: JobView["kind"]): string {
  if (kind === "local-watch" || kind === "local-client") return "Stopped with Studio. Resume watching to start it again.";
  if (kind.startsWith("deploy") || kind === "destroy" || kind === "drift") return "Studio stopped while this ran. A CloudFormation operation it started carries on in AWS: refresh to see where it stands.";
  return "Studio stopped while this ran.";
}
const KEPT_RECORDS = 100;

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly locks = new Map<string, string>();
  private readonly directory: string;
  private readonly emit: (event: string, data: unknown) => void;

  constructor(options: { directory: string; emit: (event: string, data: unknown) => void }) {
    this.directory = options.directory;
    this.emit = options.emit;
    mkdirSync(this.directory, { recursive: true });
    this.restore();
  }

  /** Records a previous Studio left: the newest are listed, any still "running" was interrupted. */
  private restore(): void {
    const records = readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, time: statSync(path.join(this.directory, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const { name } of records.slice(KEPT_RECORDS)) {
      rmSync(path.join(this.directory, name), { force: true });
      rmSync(path.join(this.directory, name.replace(/\.json$/, ".log")), { force: true });
    }
    for (const { name } of records.slice(0, 40)) {
      try {
        const view = JSON.parse(readFileSync(path.join(this.directory, name), "utf8")) as JobView;
        if (typeof view.id !== "string") continue;
        const restored: JobView = view.status === "running"
          ? {
            ...view, status: "interrupted", endedAt: view.endedAt ?? new Date().toISOString(),
            summary: interruption(view.kind),
            steps: view.steps?.map((step) => (step.status === "running" || step.status === "pending" ? { ...step, status: "skipped" as const } : step)),
          }
          : view;
        if (restored !== view) writeFileSync(path.join(this.directory, name), JSON.stringify(restored, null, 2));
        this.jobs.set(view.id, { view: restored, lines: [], pending: [], controller: new AbortController(), cancelled: false, settled: Promise.resolve(restored) });
      } catch {
        // A record this version cannot read is left alone.
      }
    }
  }

  list(): JobView[] {
    return [...this.jobs.values()].map((job) => job.view).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }

  get(id: string): JobView | undefined {
    return this.jobs.get(id)?.view;
  }

  /** The running job holding a lock, if any. */
  holder(lock: string): JobView | undefined {
    const id = this.locks.get(lock);
    return id ? this.jobs.get(id)?.view : undefined;
  }

  log(id: string, after = 0): { readonly lines: JobLogLine[]; readonly job: JobView } {
    const job = this.jobs.get(id);
    if (!job) throw new JobError(404, "No such job.");
    if (!job.lines.length || job.lines[0]!.seq > after + 1) this.loadLog(job);
    return { lines: job.lines.filter((line) => line.seq > after), job: job.view };
  }

  private loadLog(job: Job): void {
    const file = path.join(this.directory, `${job.view.id}.log`);
    if (!existsSync(file)) return;
    const lines: JobLogLine[] = [];
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try { lines.push(JSON.parse(raw) as JobLogLine); } catch { /* A torn last line. */ }
    }
    job.lines = lines;
  }

  /** Adds a line to a running job's log from outside its steps: CloudFormation progress. */
  note(id: string, text: string, stream: JobLogLine["stream"] = "info"): void {
    const job = this.jobs.get(id);
    if (job && job.view.status === "running") this.append(job, text, stream);
  }

  wait(id: string): Promise<JobView> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new JobError(404, "No such job."));
    return job.settled;
  }

  /** Every job running now, however many there are. */
  running(): JobView[] {
    return [...this.jobs.values()].filter((job) => job.view.status === "running").map((job) => job.view);
  }

  start(spec: JobSpec): JobView {
    const running = [...this.jobs.values()].filter((job) => job.view.status === "running");
    const exclusive = running.find((job) => job.spec?.exclusive);
    if (exclusive) throw new JobError(409, `${exclusive.view.title} is still running. Wait for it to finish.`);
    if (spec.exclusive && running.length) throw new JobError(409, `${running[0]!.view.title} is still running. Installing replaces programs it uses; wait for it to finish, or stop it.`);
    for (const lock of spec.locks) {
      const holder = this.holder(lock);
      if (holder) throw new JobError(409, `${holder.title} is still running. Wait for it to finish, or cancel it.`);
    }
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const view: JobView = {
      id, kind: spec.kind, title: spec.title, params: spec.params, status: "running", startedAt: new Date().toISOString(), lastSeq: 0,
      ...(spec.deployment ? { deployment: spec.deployment } : {}),
      ...(spec.planId ? { planId: spec.planId } : {}),
      steps: spec.steps.map((step) => ({ label: step.label, status: "pending" as const })),
    };
    let settle: ((job: JobView) => void) | undefined;
    const settled = new Promise<JobView>((resolve) => { settle = resolve; });
    const job: Job = { view, spec, lines: [], pending: [], controller: new AbortController(), cancelled: false, settled, settle };
    this.jobs.set(id, job);
    for (const lock of spec.locks) this.locks.set(lock, id);
    this.persist(job);
    this.emit("deploy-job", view);
    void this.execute(job);
    return view;
  }

  cancel(id: string): JobView {
    const job = this.jobs.get(id);
    if (!job) throw new JobError(404, "No such job.");
    if (job.view.status !== "running") return job.view;
    job.cancelled = true;
    job.controller.abort();
    if (job.child) stopTree(job.child);
    return job.view;
  }

  /** Stops everything still running: Studio is shutting down. */
  async dispose(): Promise<void> {
    const running = [...this.jobs.values()].filter((job) => job.view.status === "running");
    for (const job of running) this.cancel(job.view.id);
    await Promise.race([Promise.all(running.map((job) => job.settled)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  private update(job: Job, patch: Partial<JobView>): void {
    job.view = { ...job.view, ...patch };
    this.persist(job);
    this.emit("deploy-job", job.view);
  }

  private setStep(job: Job, index: number, status: NonNullable<JobView["steps"]>[number]["status"]): void {
    const steps = (job.view.steps ?? []).map((step, position) => (position === index ? { ...step, status } : step));
    this.update(job, { steps });
  }

  private persist(job: Job): void {
    try {
      writeFileSync(path.join(this.directory, `${job.view.id}.json`), JSON.stringify(job.view, null, 2));
    } catch {
      // The record is a convenience; the job carries on.
    }
  }

  private append(job: Job, text: string, stream: JobLogLine["stream"]): void {
    const line: JobLogLine = { seq: job.view.lastSeq + 1, at: new Date().toISOString(), stream, text };
    job.view = { ...job.view, lastSeq: line.seq };
    job.lines.push(line);
    if (job.lines.length > MEMORY_LINES) job.lines.splice(0, job.lines.length - MEMORY_LINES);
    try { appendFileSync(path.join(this.directory, `${job.view.id}.log`), `${JSON.stringify(line)}\n`); } catch { /* Memory still has it. */ }
    job.pending.push(line);
    job.flush ??= setTimeout(() => this.flushLog(job), 80);
  }

  private flushLog(job: Job): void {
    if (job.flush) clearTimeout(job.flush);
    job.flush = undefined;
    if (!job.pending.length) return;
    this.emit("deploy-log", { id: job.view.id, lines: job.pending });
    job.pending = [];
  }

  private context(job: Job): StepContext {
    return {
      job: job.view.id,
      signal: job.controller.signal,
      log: (text, stream = "info") => this.append(job, text, stream),
      setSummary: (text) => this.update(job, { summary: text }),
      setPlanId: (planId) => this.update(job, { planId }),
    };
  }

  private async execute(job: Job): Promise<void> {
    const spec = job.spec!;
    const context = this.context(job);
    let status: JobStatus = "succeeded";
    let exitCode: number | null | undefined;
    let summary: string | undefined;
    for (const [index, step] of spec.steps.entries()) {
      if (job.cancelled) { this.setStep(job, index, "skipped"); continue; }
      if (status !== "succeeded") { this.setStep(job, index, "skipped"); continue; }
      this.setStep(job, index, "running");
      try {
        if (step.run) {
          const skipped = await step.run(context);
          if (typeof skipped === "string") {
            this.append(job, `${step.label} skipped: ${skipped}`, "info");
            this.setStep(job, index, "skipped");
            continue;
          }
        }
        if (step.command) {
          const command = await step.command(context);
          if (job.cancelled) { this.setStep(job, index, "skipped"); continue; }
          this.append(job, `$ ${command.display}`, "info");
          const result = await this.runCommand(job, command);
          exitCode = result.code;
          if (job.cancelled) { status = "cancelled"; this.setStep(job, index, "failed"); continue; }
          if (result.code !== 0) {
            status = "failed";
            summary = result.failure;
            this.setStep(job, index, "failed");
            continue;
          }
          await step.after?.({ code: result.code, stdout: result.stdout }, context);
        }
        this.setStep(job, index, "done");
      } catch (error) {
        status = job.cancelled ? "cancelled" : "failed";
        summary = error instanceof Error ? error.message : String(error);
        this.append(job, summary, "err");
        this.setStep(job, index, "failed");
      }
    }
    if (job.cancelled) {
      status = "cancelled";
      summary = "Cancelled.";
      if (spec.cancelNote) this.append(job, spec.cancelNote, "info");
    }
    this.flushLog(job);
    for (const lock of spec.locks) if (this.locks.get(lock) === job.view.id) this.locks.delete(lock);
    this.update(job, {
      status, endedAt: new Date().toISOString(),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(summary !== undefined ? { summary } : job.view.summary ? {} : status === "succeeded" ? { summary: "Done." } : {}),
    });
    try { spec.onSettled?.(job.view); } catch { /* A listener's failure is not the job's. */ }
    job.settle?.(job.view);
  }

  private runCommand(job: Job, command: CommandSpec): Promise<{ code: number | null; stdout: string; failure: string }> {
    return new Promise((resolve) => {
      let stdout = "";
      let lastError = "";
      let lastOut = "";
      let child: ChildProcess;
      try {
        child = start(command);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.append(job, message, "err");
        resolve({ code: null, stdout: "", failure: message });
        return;
      }
      job.child = child;
      const out = lineSplitter((line) => { lastOut = line; this.append(job, line, "out"); });
      const err = lineSplitter((line) => { if (/\w/.test(line)) lastError = line; this.append(job, line, "err"); });
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); out.push(chunk); });
      child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        const message = error.code === "ENOENT" ? `${command.file} is not installed or not on PATH.` : error.message;
        lastError = message;
        this.append(job, message, "err");
      });
      child.on("close", (code) => {
        out.flush(); err.flush();
        job.child = undefined;
        resolve({ code, stdout, failure: lastError || lastOut || `Exited with code ${String(code)}.` });
      });
    });
  }
}
