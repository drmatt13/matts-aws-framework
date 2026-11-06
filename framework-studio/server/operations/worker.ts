import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { JobLogLine, JobView } from "../../shared/operations";
import { summaryText, type StepContext } from "../deploy/jobs";
import { lineSplitter, start, stopTree, tethered, type CommandSpec } from "../deploy/process";
import { domainOutcome, executionSpec, privateValues } from "./adapter";
import { LocalRuntimeConflict } from "../deploy/local";
import { processIdentity } from "./identity";
import { StreamingRedactor } from "./redaction";
import { OperationStore } from "./store";

/** One worker owns one attempt and every output pipe. Coordinator and Studio may disappear. */
export async function runWorker(root: string, state: string, id: string, token: string): Promise<void> {
  const store = new OperationStore(path.join(state, "operations"));
  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let storageFailure = false;
  let claimed = false;
  let closed = false;
  let executing = false;
  let closeAdapter: (() => void) | undefined;
  let poll: NodeJS.Timeout | undefined;
  const stop = () => { abort.abort(); if (child) stopTree(child); };
  const fatalStorage = () => { storageFailure = true; stop(); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  try {
    root = realpathSync(root);
    store.bindWorkspace(root);
    if (!store.claim(id, token, processIdentity(token))) return;
    claimed = true;
    const record = store.get(id)!;
    if (record.view.cancelRequested) {
      store.update(id, { execution: "finished", status: "cancelled", outcome: "confirmed", endedAt: new Date().toISOString(), summary: "Cancelled before execution." });
      return;
    }
    const sanitizer = new StreamingRedactor(privateValues(root, state, record.intent), () => {});
    const write = (text: string, stream: JobLogLine["stream"] = "info") => {
      if (storageFailure || closed) return;
      try { store.append(id, sanitizer.redact(text), stream); } catch { fatalStorage(); }
    };
    const update = (patch: Partial<JobView>) => {
      if (storageFailure) throw new Error("Operation storage is unavailable; inspect execution evidence before recovery.");
      try { store.update(id, patch); } catch { fatalStorage(); throw new Error("Operation storage is unavailable."); }
    };
    poll = setInterval(() => {
      try { if (store.get(id)?.view.cancelRequested) stop(); } catch { fatalStorage(); }
    }, 100);
    const sanitizeData = (data: unknown): unknown => {
      if (typeof data === "string") return sanitizer.redact(data);
      if (Array.isArray(data)) return data.map(sanitizeData);
      if (data && typeof data === "object") return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, sanitizeData(value)]));
      return data;
    };
    const runtime = await executionSpec(root, state, record.intent, write, (event, data) => {
      if (closed || storageFailure) return;
      try { store.event(id, event, sanitizeData(data)); } catch { fatalStorage(); }
    });
    closeAdapter = runtime.close;
    const { spec } = runtime;
    const context: StepContext = {
      job: id, signal: abort.signal, log: write,
      setSummary: summary => update({ summary: summaryText(summary, text => sanitizer.redact(text)) }),
      setPlanId: planId => update({ planId }),
    };
    let steps = spec.steps.map(step => ({ label: step.label, status: "pending" as "pending" | "running" | "done" | "failed" | "skipped" }));
    const stepStatus = (index: number, status: typeof steps[number]["status"]) => {
      steps = steps.map((step, position) => position === index ? { ...step, status } : step);
      update({ steps });
    };
    const command = (specification: CommandSpec): Promise<{ code: number | null; stdout: string }> => new Promise((resolve, reject) => {
      let stdout = "";
      const out = lineSplitter(text => write(text, "out"));
      const err = lineSplitter(text => write(text, "err"));
      const values = privateValues(root, state, record.intent);
      const outRedactor = new StreamingRedactor(values, text => out.push(text));
      const errRedactor = new StreamingRedactor(values, text => err.push(text));
      // Finish fallible redaction setup before launch so every child has owned output pipes.
      // The tether belongs to this worker, so a worker crash cannot leave an unobserved command tree.
      child = start(tethered(specification));
      const timeout = record.intent.request.kind === "framework-check" ? setTimeout(stop, 5 * 60_000) : undefined;
      child.stdout!.on("data", (chunk: Buffer) => {
        if (stdout.length < 32 * 1024 * 1024) stdout += chunk.toString("utf8");
        outRedactor.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => errRedactor.push(chunk));
      child.once("error", () => reject(new Error("The operation command could not start. Check the installed host tools.")));
      child.once("close", code => {
        if (timeout) clearTimeout(timeout);
        outRedactor.flush(); errRedactor.flush(); out.flush(); err.flush(); child = undefined;
        resolve({ code, stdout });
      });
    });
    let status: JobView["status"] = "succeeded";
    let exitCode: number | null | undefined;
    for (const [index, step] of spec.steps.entries()) {
      if (store.get(id)?.view.cancelRequested) stop();
      if (abort.signal.aborted || status !== "succeeded") { stepStatus(index, "skipped"); continue; }
      stepStatus(index, "running");
      try {
        const reason = await step.run?.(context);
        if (typeof reason === "string") { write(reason); stepStatus(index, "skipped"); continue; }
        if (abort.signal.aborted) { stepStatus(index, "skipped"); continue; }
        if (step.command) {
          const specification = await step.command(context);
          if (store.get(id)?.view.cancelRequested) stop();
          if (abort.signal.aborted) { stepStatus(index, "skipped"); continue; }
          write(`$ ${specification.display}`);
          if (storageFailure) throw new Error("Durable logging failed before command execution.");
          executing = true;
          const result = await command(specification);
          exitCode = result.code;
          if (result.code !== 0 || abort.signal.aborted) throw new Error(abort.signal.aborted ? "Command stopped. External effects may continue." : `Command exited with status ${String(result.code)}. Read the recorded output and domain evidence.`);
          await step.after?.(result, context);
        }
        stepStatus(index, "done");
      } catch (error) {
        status = abort.signal.aborted ? "cancelled" : "failed";
        const summary = sanitizer.redact(error instanceof Error ? error.message : "Operation failed.");
        write(summary, "err"); update({ summary }); stepStatus(index, "failed");
      }
    }
    if (abort.signal.aborted) status = "cancelled";
    const mutating = ["deploy-apply", "deploy-discard", "destroy"].includes(record.intent.request.kind)
      || record.intent.request.kind === "deploy-plan" && (record.intent.view.params.review === "change-set" || record.intent.view.params.createSecrets === true || record.intent.view.params.autoApply === true);
    // The deployment registry appends automatic Apply as the second planning step.
    const outcome = status === "succeeded" ? domainOutcome(state, record.intent, { autoApplyStep: steps[1]?.status })
      : executing && mutating ? { outcome: "uncertain" as const, recovery: "Inspect the saved operation and AWS. This attempt will never be automatically replayed." }
      : { outcome: "unverified" as const };
    if (abort.signal.aborted && spec.cancelNote) write(spec.cancelNote);
    const result: Partial<JobView> = { status, execution: "finished", ...outcome, endedAt: new Date().toISOString(), ...(exitCode !== undefined ? { exitCode } : {}) };
    // Result persistence precedes releasing resource claims. Storage failure leaves recoverable uncertainty.
    update(result);
    try { spec.onSettled?.(store.get(id)!.view); } catch { /* Notification failure cannot change durable completion. */ }
  } catch (error) {
    stop();
    // Never persist raw exceptions: SDK/tool errors may contain credential or private input material.
    if (claimed && !storageFailure) {
      try { store.update(id, { status: "interrupted", execution: "finished", outcome: executing ? "uncertain" : "unverified", endedAt: new Date().toISOString(), summary: error instanceof LocalRuntimeConflict ? error.message : "The operation could not finish. Inspect its review, prerequisites and recorded output.", recovery: executing ? "External effects may continue. This attempt will not be replayed." : "Recheck the reviewed inputs and host prerequisites before creating another operation." }); } catch { /* The durable running record becomes uncertain on reconciliation. */ }
    }
  } finally {
    closed = true;
    if (poll) clearInterval(poll);
    closeAdapter?.();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const [root, state, id, token] = process.argv.slice(2);
  if (!root || !state || !id || !token) process.exitCode = 2;
  else void runWorker(root, state, id, token).catch(() => { process.exitCode = 1; });
}
