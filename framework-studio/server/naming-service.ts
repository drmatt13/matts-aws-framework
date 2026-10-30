import { fork, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../shared/model";
import type { CommentReviewOptions, SourceCommentReview } from "../shared/api";
import type { StudioState } from "./snapshot";
import type { ResourceRenameResult } from "./naming-source";
import { absorbReviewedComments, continueCommentPositions, currentCommentOptions, removedCommentPositions } from "./edits/comments";

export type NamingOperation =
  | { readonly kind: "rename"; readonly entity: string; readonly name: string }
  | { readonly kind: "move"; readonly entity: string; readonly nextPath: readonly string[] }
  | { readonly kind: "references"; readonly entity: string };
export interface NamingWorkerRequest { readonly root: string; readonly snapshot: Snapshot; readonly operation: NamingOperation; readonly overrides: Readonly<Record<string, string>>; readonly commentOptions?: CommentReviewOptions; readonly removedPositions: readonly string[] }
export interface NamingWorkerReply { readonly result: ResourceRenameResult; readonly overrides: Readonly<Record<string, string>>; readonly comments: readonly SourceCommentReview[]; readonly removedPositions: readonly string[] }

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "naming-worker.ts");
const TIMEOUT_MS = 120_000;
const MAX_WORKERS = 2;
interface Job { readonly root: string; start(): void; cancel(): Promise<void> }
const waiting: Job[] = [];
const active = new Set<Job>();
const closing = new Set<string>();
function drain(): void { while (active.size < MAX_WORKERS && waiting.length) { const next = waiting.shift()!; active.add(next); next.start(); } }

function failure(request: NamingWorkerRequest, message: string): ResourceRenameResult {
  const source = request.snapshot.source.entities[request.operation.entity]?.value ?? { file: "framework-config/resources.ts", line: 1, column: 1, start: 0, end: 0 };
  return { entityRemap: {}, issues: [{ message: `${message} No source files were changed. Your draft is preserved; review again.`, source }], referenceCount: 0, sourceFiles: [], sourceHashes: {}, sourceFingerprint: "" };
}

/** CPU-heavy symbol indexing stays out of the HTTP server's event loop. */
export function planResourceNaming(root: string, state: StudioState, operation: NamingOperation, overrides: Map<string, string>): Promise<ResourceRenameResult> {
  root = path.resolve(root);
  // Only the value-free snapshot and authored candidate source cross IPC. Runtime
  // evaluators, functions, ASTs, and their module graphs never leave their owner.
  const request: NamingWorkerRequest = { root, snapshot: state.snapshot, operation, overrides: Object.fromEntries(overrides), commentOptions: currentCommentOptions(), removedPositions: removedCommentPositions() };
  if (closing.has(root)) return Promise.resolve(failure(request, "Resource reference review is closing."));
  return new Promise(resolve => {
    const inOwner = AsyncLocalStorage.snapshot();
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let force: NodeJS.Timeout | undefined;
    let reply: NamingWorkerReply | undefined;
    let failed: ResourceRenameResult | undefined;
    let finished = false;
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>(done => { resolveExit = done; });
    const finish = () => inOwner(() => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (force) clearTimeout(force);
      active.delete(job);
      if (reply && !failed) {
        try {
          absorbReviewedComments(reply.comments);
          continueCommentPositions(reply.removedPositions);
          for (const [file, text] of Object.entries(reply.overrides)) overrides.set(file, text);
        } catch (error) { failed = failure(request, error instanceof Error ? error.message : "Source comments changed during review."); }
      }
      resolve(failed ?? reply?.result ?? failure(request, "The resource reference worker exited before completing."));
      resolveExit();
      drain();
    });
    const stop = (message: string) => {
      if (finished) return;
      failed ??= failure(request, message);
      if (timer) clearTimeout(timer);
      if (!child || child.exitCode !== null || child.signalCode !== null) { finish(); return; }
      if (child.connected) child.disconnect();
      child.kill("SIGTERM");
      force = setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000);
      force.unref();
    };
    const job: Job = {
      root,
      start: () => inOwner(() => {
        if (closing.has(root)) { stop("Resource reference review was cancelled during shutdown."); return; }
        try {
          child = fork(WORKER, [], { cwd: root, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
          child.once("close", finish);
          // Disconnecting during a backpressured startup IPC write can delay
          // close after the OS process exits. A cancelled job has no reply to
          // drain, so confirmed process exit completes disposal immediately.
          child.once("exit", () => { if (failed) finish(); });
          child.once("error", () => stop("The resource reference worker could not start."));
          child.on("message", (value: NamingWorkerReply) => {
            if (value?.result && value?.overrides && !reply && !failed) reply = value;
          });
          timer = setTimeout(() => stop(`Resource reference review exceeded ${TIMEOUT_MS / 1_000} seconds.`), TIMEOUT_MS);
          child.send(request, error => { if (error) stop("The resource reference worker could not receive this review."); });
        } catch { stop("The resource reference worker could not start."); }
      }),
      cancel: async () => {
        const queued = waiting.indexOf(job);
        if (queued >= 0) waiting.splice(queued, 1);
        stop("Resource reference review was cancelled during shutdown.");
        await exited;
      },
    };
    waiting.push(job);
    drain();
  });
}

/** Await this alongside evaluator disposal when the Studio owner closes. */
export async function disposeNamingWorkers(root?: string): Promise<void> {
  const selected = root && path.resolve(root);
  const jobs = [...active, ...waiting].filter(job => !selected || job.root === selected);
  const roots = new Set(jobs.map(job => job.root));
  if (selected) roots.add(selected);
  for (const owner of roots) closing.add(owner);
  try { await Promise.all(jobs.map(job => job.cancel())); }
  finally { for (const owner of roots) closing.delete(owner); }
}
