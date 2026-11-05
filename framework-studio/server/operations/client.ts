import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { JobLogLine, JobView, OperationRecord, OperationRequest } from "../../shared/operations";
import { OPERATIONS_VERSION } from "../../shared/operations";
import { callIpc, OperationsError, privateEndpoint, type CoordinatorInfo } from "./ipc";
import { projectSynthesisSummary } from "./summaries";

const loader = createRequire(path.join(__dirname, "../../package.json")).resolve("tsx");
const coordinator = path.join(__dirname, "coordinator.ts");

/** Closing a Studio client closes observation only, never the coordinator or workers. */
export class OperationsClient {
  readonly root: string;
  readonly state: string;
  private starting?: Promise<void>;
  private closed = false;

  constructor(root: string, state: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.root = realpathSync(root);
    mkdirSync(path.resolve(state), { recursive: true, mode: 0o700 });
    this.state = realpathSync(state);
  }

  private endpoint(): string { return privateEndpoint(this.root, this.state).socket; }

  private async connected(): Promise<void> {
    const info = await callIpc<CoordinatorInfo>(this.endpoint(), "/ping", undefined, 1000);
    if (info.version !== OPERATIONS_VERSION || info.root !== this.root || info.state !== this.state) {
      throw new OperationsError(409, "The running operations coordinator belongs to another protocol or workspace. Preserve running operations before upgrading it.");
    }
  }

  private async ensure(): Promise<void> {
    if (this.closed) throw new OperationsError(503, "This operations observer is closed.");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try { await this.connected(); return; } catch (error) {
        if (error instanceof OperationsError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      }
      let launchError: Error | undefined;
      const child = spawn(process.execPath, ["--import", loader, coordinator, this.root, this.state], {
        cwd: this.root, env: this.env, detached: true, stdio: "ignore", windowsHide: true,
      });
      child.once("error", error => { launchError = error; });
      child.unref();
      // Another Studio may launch simultaneously. The SQLite coordinator lease chooses one.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw new OperationsError(503, "The operations coordinator could not be started.");
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await this.connected(); return; } catch (error) {
          if (error instanceof OperationsError && error.status === 409) throw error;
        }
      }
      throw new OperationsError(503, "The independent operations coordinator did not start. Check private state permissions and the installed Node runtime; existing operations were not restarted.");
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async call<T>(route: string, body?: unknown): Promise<T> {
    await this.ensure();
    return callIpc<T>(this.endpoint(), route, body);
  }

  ping(): Promise<CoordinatorInfo> { return this.call("/ping"); }
  list(): Promise<JobView[]> { return this.call<JobView[]>("/operations").then(jobs => jobs.map(job => projectSynthesisSummary(this.state, job))); }
  get(id: string): Promise<OperationRecord | undefined> { return this.call<OperationRecord | null>(`/operations/${encodeURIComponent(id)}`).then(record => record ? { ...record, view: projectSynthesisSummary(this.state, record.view) } : undefined); }
  log(id: string, after = 0): Promise<{ job: JobView; lines: JobLogLine[] }> { return this.call<{ job: JobView; lines: JobLogLine[] }>(`/operations/${encodeURIComponent(id)}/log?after=${Math.max(0, Math.floor(after))}`).then(page => ({ ...page, job: projectSynthesisSummary(this.state, page.job) })); }
  events(id: string, after = 0): Promise<{ events: { seq: number; event: string; data: unknown }[]; lastSeq: number }> { return this.call(`/operations/${encodeURIComponent(id)}/events?after=${Math.max(0, Math.floor(after))}`); }
  cancel(id: string): Promise<JobView> { return this.call(`/operations/${encodeURIComponent(id)}/cancel`, {}); }
  async submit(request: OperationRequest): Promise<JobView> {
    const intent = { ...request, requestKey: request.requestKey ?? randomUUID() };
    try { return await this.call("/submit", intent); } catch (error) {
      // Retry only transport loss, with the identical key. Domain errors are never retried.
      if (error instanceof OperationsError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT"].includes(code ?? "")) throw error;
      return this.call("/submit", intent);
    }
  }
  close(): void { this.closed = true; }
}
