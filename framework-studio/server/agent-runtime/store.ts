import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodingEvent, CodingTask, CodingTaskRequest, CodingTaskStatus } from "../../shared/agent-runtime";
import { ACTIVE_CODING_STATUSES } from "../../shared/agent-runtime";
import type { ExecutionIdentity } from "../../shared/operations";
import { identityAlive } from "../operations/identity";
import { redactText } from "../operations/redaction";
import { assertAgentSourcePath } from "./workspace";

export class AgentRuntimeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface StoredTask {
  readonly request: CodingTaskRequest;
  readonly view: CodingTask;
  readonly workspaceDirectory?: string;
  readonly proposalDirectory?: string;
  readonly execution?: ExecutionIdentity;
  /** Every tether in the active phase; legacy execution remains readable. */
  readonly executions?: readonly ExecutionIdentity[];
  readonly structuredSource?: string;
}

const NEXT: Record<CodingTaskStatus, readonly CodingTaskStatus[]> = {
  queued: ["preparing", "cancelled", "interrupted"],
  preparing: ["running", "failed", "cancelled", "interrupted"],
  running: ["validating", "waiting_for_permission", "failed", "cancelled", "interrupted"],
  waiting_for_permission: ["running", "failed", "cancelled", "interrupted"],
  validating: ["running", "awaiting_review", "completed", "conflicted", "failed", "cancelled", "interrupted"],
  awaiting_review: ["integrating", "conflicted", "rejected", "running", "validating", "failed"],
  conflicted: ["running", "validating", "rejected", "failed"],
  integrating: ["completed", "conflicted", "failed", "recovery_required"],
  completed: [], interrupted: ["queued", "rejected"], failed: ["queued", "rejected"],
  cancelled: ["queued", "rejected"], rejected: [], recovery_required: ["completed", "failed", "rejected"],
};
const EVENT_BYTES = 64 * 1024;
const TASK_LOG_BYTES = 32 * 1024 * 1024;

function redactData(data: unknown): unknown {
  if (typeof data === "string") return redactText(data, []);
  if (Array.isArray(data)) return data.map(redactData);
  if (data && typeof data === "object") return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, /^(?:password|passwd|access_token|refresh_token|client_secret|authorization)$/i.test(key) ? "[redacted]" : redactData(value)]));
  return data;
}

function safeDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  let ancestor = path.parse(absolute).root;
  for (const part of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new AgentRuntimeError(422, "Agent state cannot use symbolic-link directories.");
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new AgentRuntimeError(422, "Agent state must belong to the current user.");
  chmodSync(absolute, 0o700);
  return realpathSync(absolute);
}

export function validateTaskRequest(input: unknown): CodingTaskRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentRuntimeError(400, "Enter a coding task.");
  const item = input as Record<string, unknown>;
  if (Object.keys(item).some(key => !["requestKey", "provider", "prompt", "model", "context", "validation"].includes(key))) throw new AgentRuntimeError(400, "Unexpected coding-task fields.");
  if (typeof item.requestKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(item.requestKey)) throw new AgentRuntimeError(400, "A stable request key is required.");
  if (item.provider !== "codex" && item.provider !== "claude") throw new AgentRuntimeError(400, "Select Codex or Claude.");
  if (typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 16000 || item.prompt.includes("\0")) throw new AgentRuntimeError(400, "Enter a prompt of 1–16000 characters.");
  if (item.model !== undefined && (typeof item.model !== "string" || !item.model || item.model.length > 200 || /^-|[\s\u0000-\u001f]/.test(item.model))) throw new AgentRuntimeError(400, "Select a valid provider model.");
  if (item.context !== undefined && (typeof item.context !== "string" || item.context.length > 16000 || item.context.includes("\0"))) throw new AgentRuntimeError(400, "Coding context exceeds its safe envelope.");
  let validation: CodingTaskRequest["validation"];
  if (item.validation !== undefined) {
    const value = item.validation as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || !["project", "framework", "tests"].includes(String(value.kind)) || Object.keys(value).some(key => !["kind", ...(value.kind === "tests" ? ["paths"] : [])].includes(key))) throw new AgentRuntimeError(400, "Choose a supported final validation plan.");
    if (value.kind === "tests") {
      if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 20 || value.paths.some(name => typeof name !== "string" || name.length > 1000)) throw new AgentRuntimeError(400, "Choose 1–20 source test paths.");
      for (const name of value.paths) assertAgentSourcePath(name);
      validation = { kind: "tests", paths: [...new Set(value.paths)] };
    } else validation = { kind: value.kind as "project" | "framework" };
  }
  return { requestKey: item.requestKey, provider: item.provider, prompt: item.prompt.trim(), ...(item.model ? { model: item.model as string } : {}), ...(item.context ? { context: item.context as string } : {}), ...(validation ? { validation } : {}) };
}

/** Durable task ownership. Provider history supplements this record; it never authorizes an import. */
export class AgentTaskStore {
  private readonly db: DatabaseSync;
  readonly directory: string;
  constructor(directory: string, readonly root: string, private readonly now: () => number = Date.now) {
    if (path.resolve(directory) === realpathSync(root) || path.resolve(directory).startsWith(realpathSync(root) + path.sep)) throw new AgentRuntimeError(422, "Agent task state must live outside the authoritative checkout.");
    this.directory = safeDirectory(directory);
    const file = path.join(this.directory, "tasks.sqlite");
    if (!existsSync(file)) closeSync(openSync(file, "wx", 0o600));
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new AgentRuntimeError(422, "Agent database must be a private regular file.");
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, intent_hash TEXT NOT NULL, record TEXT NOT NULL, log_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,seq));
      CREATE TABLE IF NOT EXISTS approvals (task_id TEXT NOT NULL REFERENCES tasks(id), digest TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(task_id,digest));`);
    try { this.atomic(() => {
      const existing = this.meta("root");
      if (existing && existing !== realpathSync(root)) throw new AgentRuntimeError(409, "Agent state belongs to another checkout.");
      const version = this.meta("version");
      if (version && version !== "1") throw new AgentRuntimeError(409, "Agent state requires a compatible runtime.");
      this.setMeta("root", realpathSync(root)); this.setMeta("version", "1");
    }); } catch (error) { this.db.close(); throw error; }
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private meta(key: string): string | undefined { return (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined)?.value; }
  private setMeta(key: string, value: string): void { this.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  private atomic<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private write(record: StoredTask): void { this.db.prepare("UPDATE tasks SET record=? WHERE id=?").run(JSON.stringify(record), record.view.id); }
  private require(id: string): StoredTask { const task = this.get(id); if (!task) throw new AgentRuntimeError(404, "Coding task not found."); return task; }
  get(id: string): StoredTask | undefined {
    const row = this.db.prepare("SELECT record FROM tasks WHERE id=?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as StoredTask : undefined;
  }
  list(): CodingTask[] { return (this.db.prepare("SELECT record FROM tasks ORDER BY rowid DESC LIMIT 200").all() as { record: string }[]).map(row => (JSON.parse(row.record) as StoredTask).view); }
  retainedExecutions(): StoredTask[] { return (this.db.prepare("SELECT record FROM tasks WHERE json_type(record,'$.execution') IS NOT NULL OR json_type(record,'$.executions') IS NOT NULL").all() as { record: string }[]).map(row => JSON.parse(row.record) as StoredTask); }
  pendingActivations(): CodingTask[] { return (this.db.prepare("SELECT record FROM tasks WHERE json_extract(record,'$.view.runtimeActivation.status')='starting'").all() as { record: string }[]).map(row => (JSON.parse(row.record) as StoredTask).view); }
  active(): CodingTask[] { return (this.db.prepare("SELECT record FROM tasks WHERE json_extract(record,'$.view.status') IN ('queued','preparing','running','validating','waiting_for_permission','integrating') ORDER BY rowid").all() as { record: string }[]).map(row => (JSON.parse(row.record) as StoredTask).view); }
  needingRecovery(): CodingTask[] { return (this.db.prepare("SELECT record FROM tasks WHERE json_extract(record,'$.view.status')='recovery_required' ORDER BY rowid").all() as { record: string }[]).map(row => (JSON.parse(row.record) as StoredTask).view); }
  accept(input: unknown, structuredSource?: string): CodingTask {
    const request = validateTaskRequest(input);
    const intent = createHash("sha256").update(JSON.stringify(structuredSource ? { request, structuredSource } : request)).digest("hex");
    return this.atomic(() => {
      const prior = this.db.prepare("SELECT record,intent_hash FROM tasks WHERE request_key=?").get(request.requestKey) as { record: string; intent_hash: string } | undefined;
      if (prior) {
        if (prior.intent_hash !== intent) throw new AgentRuntimeError(409, "This request key already belongs to a different coding task.");
        return (JSON.parse(prior.record) as StoredTask).view;
      }
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE json_extract(record,'$.view.status') IN ('queued','preparing','running','validating','waiting_for_permission')").get() as { count: number };
      if (count.count >= 20) throw new AgentRuntimeError(429, "The coding queue is full. Finish or cancel a retained task before submitting another.");
      const at = this.timestamp();
      const view: CodingTask = { id: randomUUID(), provider: request.provider, prompt: request.prompt, ...(request.model ? { model: request.model } : {}), status: "queued", createdAt: at, updatedAt: at, lastSeq: 0, cancelRequested: false };
      this.db.prepare("INSERT INTO tasks(id,request_key,intent_hash,record) VALUES (?,?,?,?)").run(view.id, request.requestKey, intent, JSON.stringify({ request, view, ...(structuredSource ? { structuredSource } : {}) }));
      this.appendInTransaction(view.id, "state", { status: "queued" });
      return this.require(view.id).view;
    });
  }
  patch(id: string, patch: Partial<Pick<StoredTask, "workspaceDirectory" | "proposalDirectory" | "execution" | "executions">>, view: Partial<Pick<CodingTask, "sessionId" | "proposalDigest" | "summary" | "activation" | "sourceOutcome" | "workspaceDisposition" | "runtimeActivation" | "canResumeValidation">> = {}): CodingTask {
    return this.atomic(() => { const task = this.require(id); const next = { ...task, ...patch, view: { ...task.view, ...view, updatedAt: this.timestamp() } }; this.write(next); return next.view; });
  }
  transition(id: string, status: CodingTaskStatus, summary?: string): CodingTask {
    return this.atomic(() => {
      const task = this.require(id);
      if (status !== task.view.status && !NEXT[task.view.status].includes(status)) throw new AgentRuntimeError(409, `Cannot change a ${task.view.status} task to ${status}.`);
      this.write({ ...task, view: { ...task.view, status, ...(summary !== undefined ? { summary: redactText(summary, []).slice(0,4000) } : {}), updatedAt: this.timestamp() } });
      this.appendInTransaction(id, "state", { status, ...(summary ? { summary } : {}) });
      return this.require(id).view;
    });
  }
  private appendInTransaction(id: string, type: CodingEvent["type"], data: CodingEvent["data"]): CodingEvent {
    const task = this.require(id);
    const safe = JSON.stringify(redactData(data));
    if (Buffer.byteLength(safe) > EVENT_BYTES) throw new AgentRuntimeError(413, "A provider event exceeded the durable event limit.");
    const row = this.db.prepare("SELECT log_bytes FROM tasks WHERE id=?").get(id) as { log_bytes: number };
    if (row.log_bytes + Buffer.byteLength(safe) > TASK_LOG_BYTES + (type === "state" ? EVENT_BYTES : 0)) throw new AgentRuntimeError(507, "Task log capacity reached. Work stopped to preserve recovery evidence.");
    const event: CodingEvent = { taskId: id, seq: task.view.lastSeq + 1, at: this.timestamp(), type, data: JSON.parse(safe) };
    this.db.prepare("INSERT INTO events(task_id,seq,body) VALUES (?,?,?)").run(id, event.seq, JSON.stringify(event));
    this.db.prepare("UPDATE tasks SET record=?,log_bytes=log_bytes+? WHERE id=?").run(JSON.stringify({ ...task, view: { ...task.view, lastSeq: event.seq, updatedAt: event.at } }), Buffer.byteLength(safe), id);
    return event;
  }
  append(id: string, type: CodingEvent["type"], data: CodingEvent["data"]): CodingEvent { return this.atomic(() => this.appendInTransaction(id, type, data)); }
  events(id: string, after = 0): { task: CodingTask; events: CodingEvent[] } {
    const task = this.require(id).view;
    if (!Number.isSafeInteger(after) || after < 0) throw new AgentRuntimeError(400, "Invalid event cursor.");
    const rows = this.db.prepare("SELECT body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 200").all(id, after) as { body: string }[];
    // A cursor page must also fit the IPC response limit when every event is
    // large. The caller advances using the last returned seq, never lastSeq.
    let bytes = 0;
    const events: CodingEvent[] = [];
    for (const row of rows) {
      if (bytes + Buffer.byteLength(row.body) > 2 * 1024 * 1024) break;
      bytes += Buffer.byteLength(row.body); events.push(JSON.parse(row.body) as CodingEvent);
    }
    return { task, events };
  }
  cancel(id: string): CodingTask {
    return this.atomic(() => {
      const task = this.require(id);
      if (task.view.status === "integrating") throw new AgentRuntimeError(409, "Source integration must reach a recoverable boundary before cancellation.");
      if (!ACTIVE_CODING_STATUSES.includes(task.view.status)) return task.view;
      this.write({ ...task, view: { ...task.view, cancelRequested: true, updatedAt: this.timestamp() } });
      this.appendInTransaction(id, "diagnostic", { message: "Cancellation requested; partial work will be retained." });
      return this.require(id).view;
    });
  }
  resume(id: string): CodingTask {
    return this.atomic(() => {
      const task = this.require(id);
      if (!["interrupted", "failed", "cancelled"].includes(task.view.status) && !(task.view.status === "awaiting_review" && task.view.canResumeValidation)) throw new AgentRuntimeError(409, "Only an interrupted, failed, cancelled or validation-failed task can be explicitly resumed.");
      this.write({ ...task, proposalDirectory: undefined, view: { ...task.view, status: "queued", cancelRequested: false, proposalDigest: undefined, canResumeValidation: undefined, activation: undefined, sourceOutcome: undefined, summary: "Explicit resume requested for the retained workspace.", updatedAt: this.timestamp() } });
      this.appendInTransaction(id, "state", { status: "queued", resumed: true });
      return this.require(id).view;
    });
  }
  approve(id: string, digest: string): CodingTask {
    return this.atomic(() => {
      const task = this.require(id);
      if (task.view.status !== "awaiting_review" || !digest || digest !== task.view.proposalDigest) throw new AgentRuntimeError(409, "Review the current immutable proposal before approving.");
      this.db.prepare("INSERT INTO approvals(task_id,digest,at) VALUES (?,?,?)").run(id, digest, this.timestamp());
      this.write({ ...task, view: { ...task.view, status: "integrating", updatedAt: this.timestamp() } });
      this.appendInTransaction(id, "state", { status: "integrating", digest });
      return this.require(id).view;
    });
  }
  approved(id: string, digest: string): boolean { return !!this.db.prepare("SELECT 1 FROM approvals WHERE task_id=? AND digest=?").get(id, digest); }
  claimHost(owner: ExecutionIdentity, alive: (identity: ExecutionIdentity) => boolean | undefined = identityAlive): boolean {
    return this.atomic(() => {
      const prior = this.meta("host");
      if (prior) { const identity = JSON.parse(prior) as ExecutionIdentity; if (identity.token !== owner.token && alive(identity) !== false) return false; }
      this.setMeta("host", JSON.stringify(owner)); return true;
    });
  }
  releaseHost(owner: ExecutionIdentity): void {
    this.atomic(() => { const prior = this.meta("host"); if (prior && (JSON.parse(prior) as ExecutionIdentity).token === owner.token) this.db.prepare("DELETE FROM metadata WHERE key='host'").run(); });
  }
  /** Only after host ownership has been reconciled. Never replay uncertain commands. */
  recoverInterrupted(): void {
    for (const task of this.active()) {
      if (task.status === "integrating") this.transition(task.id, "recovery_required", "The source importer was interrupted. Inspect its journal before any further import.");
      else if (ACTIVE_CODING_STATUSES.includes(task.status) && task.status !== "queued") this.transition(task.id, "interrupted", "The agent host stopped. Workspace and events were retained; explicitly resume after reconciliation.");
    }
  }
  close(): void { this.db.close(); }
}
