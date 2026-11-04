import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionIdentity, JobLogLine, JobView, OperationIntent, OperationRecord, OperationRequest } from "../../shared/operations";
import { identityAlive } from "./identity";

export class OperationStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function canonicalRequest(request: OperationRequest): string {
  return canonical({ kind: request.kind, params: request.params });
}

interface StoredRow { id: string; intent: string; view: string; dispatch_token: string | null; owner: string | null; changed_at: number; }
export interface OperationEvent { readonly seq: number; readonly event: "deploy-stacks" | "deploy-event"; readonly data: unknown; }
const REPLAY_BYTES = 4 * 1024 * 1024;

/** All acceptance, identity, locks, log cursors and completion writes are transactions. */
export class OperationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly alive: (owner: ExecutionIdentity) => boolean | undefined;
  constructor(readonly directory: string, options: { now?: () => number; alive?: (owner: ExecutionIdentity) => boolean | undefined } = {}) {
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? identityAlive;
    const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Operations storage must be a directory owned by the current user.");
    chmodSync(directory, 0o700);
    const file = path.join(directory, "operations.sqlite");
    if (!existsSync(file)) { try { closeSync(openSync(file, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const fileStat = lstatSync(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || typeof process.getuid === "function" && fileStat.uid !== process.getuid()) throw new Error("Operations database must be a regular file owned by the current user.");
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      // A full journal stops acceptance/execution explicitly; recovery evidence is never
      // silently deleted to make room. SQLite's normal WAL checkpoints bound the sidecar.
      const pageSize = Number(this.db.prepare("PRAGMA page_size").get()!.page_size);
      this.db.exec(`PRAGMA max_page_count = ${Math.floor(256 * 1024 * 1024 / pageSize)}`);
      this.transaction(() => {
        const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if (version !== 0 && version !== 1) throw new Error(`Operations database schema ${version} is unsupported. Preserve the database and use its owning runner version.`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
          intent TEXT NOT NULL, view TEXT NOT NULL, dispatch_token TEXT, owner TEXT, changed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resource_locks (resource TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id));
        CREATE TABLE IF NOT EXISTS workspace_binding (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), workspace TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS consumed_reviews (review TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id));
        CREATE TABLE IF NOT EXISTS recovery_holds (operation_id TEXT PRIMARY KEY REFERENCES operations(id));
        CREATE TABLE IF NOT EXISTS logs (operation_id TEXT NOT NULL REFERENCES operations(id), seq INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY(operation_id, seq));
        CREATE TABLE IF NOT EXISTS event_cursors (operation_id TEXT PRIMARY KEY REFERENCES operations(id), last_seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (operation_id TEXT NOT NULL REFERENCES operations(id), seq INTEGER NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(operation_id, seq));
        PRAGMA user_version = 1;`);
      });
      // Persist new directory entries as well as SQLite's file/WAL commits.
      for (let current = path.resolve(directory); ; current = path.dirname(current)) {
        const descriptor = openSync(current, "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
        if (!firstCreated || current === path.dirname(path.resolve(firstCreated))) break;
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* The original storage failure is authoritative. */ } throw error; }
  }
  private decode(row: StoredRow): OperationRecord {
    try {
      const intent = JSON.parse(row.intent) as OperationIntent, view = JSON.parse(row.view) as JobView;
      if (intent.version !== 1 || !intent.workspace || view.id !== row.id || !Number.isSafeInteger(view.lastSeq) || view.lastSeq < 0) throw new Error("Invalid operation");
      if (!["running", "succeeded", "failed", "cancelled", "interrupted"].includes(view.status) || !["accepted", "dispatching", "running", "finished", "lost"].includes(view.execution ?? "")) throw new Error("Invalid lifecycle");
      const owner = row.owner ? JSON.parse(row.owner) as ExecutionIdentity : undefined;
      if (owner && (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isSafeInteger(owner.uid) || typeof owner.started !== "string" || !owner.started || owner.token !== row.dispatch_token)) throw new Error("Invalid execution identity");
      if (view.execution === "running" && !owner) throw new Error("Missing execution identity");
      return { intent, view, ...(row.dispatch_token ? { dispatchToken: row.dispatch_token } : {}), ...(owner ? { owner } : {}) };
    } catch { throw new OperationStoreError(503, `Operation ${row.id} has unreadable execution evidence. Preserve its database; no uncertain operation will be replayed.`); }
  }
  private row(id: string): StoredRow | undefined { return this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as unknown as StoredRow | undefined; }
  private required(id: string): OperationRecord { const record = this.get(id); if (!record) throw new OperationStoreError(404, "No such operation."); return record; }
  /** A state directory belongs to one canonical checkout, including before its first submission. */
  bindWorkspace(workspace: string): void {
    this.transaction(() => {
      const binding = this.db.prepare("SELECT workspace FROM workspace_binding WHERE singleton = 1").get();
      if (binding && binding.workspace !== workspace) throw new OperationStoreError(409, "Operations storage belongs to another checkout. Use that checkout to inspect its operations, or select a separate state directory.");
      for (const row of this.db.prepare("SELECT * FROM operations").all() as unknown as StoredRow[]) {
        if (this.decode(row).intent.workspace !== workspace) throw new OperationStoreError(409, "Operations storage contains another checkout's execution evidence. Its operations cannot be dispatched here.");
      }
      this.db.prepare("INSERT OR IGNORE INTO workspace_binding VALUES (1, ?)").run(workspace);
    });
  }
  get(id: string): OperationRecord | undefined { const row = this.row(id); return row ? this.decode(row) : undefined; }
  findRequest(key: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE request_key = ?").get(key) as unknown as StoredRow | undefined;
    return row ? this.decode(row) : undefined;
  }
  isConsumed(key: string): boolean { return Boolean(this.db.prepare("SELECT operation_id FROM consumed_reviews WHERE review = ?").get(key)); }
  list(): JobView[] { return (this.db.prepare("SELECT * FROM operations ORDER BY changed_at DESC, id DESC").all() as unknown as StoredRow[]).map(row => this.decode(row).view); }
  accept(intent: OperationIntent, requestKey: string): JobView {
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestKey)) throw new OperationStoreError(400, "Use a nonempty operation request key of at most 160 characters.");
    if (intent.version !== 1 || !intent.workspace || !Array.isArray(intent.locks) || intent.locks.some(lock => typeof lock !== "string" || !lock)) throw new OperationStoreError(400, "Invalid operation intent.");
    const normalized = { ...intent, request: { kind: intent.request.kind, params: intent.request.params } };
    const digest = createHash("sha256").update(canonical(normalized)).digest("hex");
    return this.transaction(() => {
      const binding = this.db.prepare("SELECT workspace FROM workspace_binding WHERE singleton = 1").get();
      if (binding && binding.workspace !== intent.workspace) throw new OperationStoreError(409, "This intent belongs to another checkout.");
      const existing = this.db.prepare("SELECT * FROM operations WHERE request_key = ?").get(requestKey) as unknown as (StoredRow & { digest: string }) | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new OperationStoreError(409, "This request key was already accepted with different operation intent.");
        return this.decode(existing).view;
      }
      if (intent.consumptionKey && this.db.prepare("SELECT operation_id FROM consumed_reviews WHERE review = ?").get(intent.consumptionKey)) throw new OperationStoreError(409, "This review already belongs to an accepted attempt. Inspect its operation and external effects; it cannot be submitted again.");
      for (const lock of new Set(intent.locks)) {
        if (this.db.prepare("SELECT operation_id FROM resource_locks WHERE resource = ?").get(lock)) throw new OperationStoreError(409, `Another operation holds ${lock}. Inspect its outcome before starting conflicting work.`);
      }
      const id = randomUUID();
      const view: JobView = { ...intent.view, id, startedAt: new Date(this.now()).toISOString(), lastSeq: 0, status: "running", execution: "accepted", outcome: "pending" };
      this.db.prepare("INSERT INTO operations (id, request_key, digest, intent, view, changed_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, requestKey, digest, JSON.stringify(normalized), JSON.stringify(view), this.now());
      for (const lock of new Set(intent.locks)) this.db.prepare("INSERT INTO resource_locks VALUES (?, ?)").run(lock, id);
      if (intent.consumptionKey) this.db.prepare("INSERT INTO consumed_reviews VALUES (?, ?)").run(intent.consumptionKey, id);
      return view;
    });
  }
  private write(id: string, view: JobView): void {
    if (view.execution === "finished" || view.execution === "lost") view = { ...view, observationProblem: undefined };
    this.db.prepare("UPDATE operations SET view = ?, changed_at = ? WHERE id = ?").run(JSON.stringify(view), this.now(), id);
    if (view.execution === "finished" && view.outcome !== "uncertain") this.db.prepare("DELETE FROM resource_locks WHERE operation_id = ? AND NOT EXISTS (SELECT 1 FROM recovery_holds WHERE operation_id = ?)").run(id, id);
  }
  dispatch(id: string): string | undefined {
    return this.transaction(() => {
      const record = this.required(id);
      if (record.view.execution !== "accepted") return undefined;
      if (record.view.cancelRequested) { this.write(id, { ...record.view, execution: "finished", status: "cancelled", outcome: "confirmed", endedAt: new Date(this.now()).toISOString() }); return undefined; }
      const token = randomUUID();
      this.db.prepare("UPDATE operations SET dispatch_token = ? WHERE id = ?").run(token, id);
      this.write(id, { ...record.view, execution: "dispatching" });
      return token;
    });
  }
  claim(id: string, token: string, owner: ExecutionIdentity): boolean {
    return this.transaction(() => {
      const record = this.required(id);
      if (record.view.execution !== "dispatching" || record.dispatchToken !== token || owner.token !== token) return false;
      this.db.prepare("UPDATE operations SET owner = ? WHERE id = ?").run(JSON.stringify(owner), id);
      this.write(id, { ...record.view, execution: "running" });
      return true;
    });
  }
  update(id: string, patch: Partial<JobView>): void {
    this.transaction(() => {
      const { view } = this.required(id);
      if (view.execution === "lost" && patch.execution && patch.execution !== "lost") throw new OperationStoreError(409, "Lost execution cannot be resumed or reported complete without domain reconciliation.");
      if (view.execution === "finished" && patch.execution && patch.execution !== "finished") throw new OperationStoreError(409, "A completed execution cannot be resumed.");
      this.write(id, { ...view, ...patch, id: view.id, kind: view.kind, params: view.params, startedAt: view.startedAt, lastSeq: view.lastSeq, cancelRequested: view.cancelRequested || patch.cancelRequested });
    });
  }
  append(id: string, text: string, stream: JobLogLine["stream"] = "info"): JobLogLine {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > 64 * 1024) {
      const marker = "\n[log line truncated]";
      text = bytes.subarray(0, 64 * 1024 - Buffer.byteLength(marker)).toString("utf8") + marker;
    }
    return this.transaction(() => {
      const { view } = this.required(id);
      const line: JobLogLine = { seq: view.lastSeq + 1, at: new Date(this.now()).toISOString(), stream, text };
      this.db.prepare("INSERT INTO logs VALUES (?, ?, ?)").run(id, line.seq, JSON.stringify(line));
      this.write(id, { ...view, lastSeq: line.seq });
      return line;
    });
  }
  log(id: string, after = 0, limit = 1000): { job: JobView; lines: JobLogLine[] } {
    const count = Math.min(2000, Math.max(1, Math.floor(limit)));
    const cursor = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    return this.transaction(() => {
      const { view } = this.required(id);
      try {
        const expected = Math.min(count, Math.max(0, view.lastSeq - cursor));
        const lines: JobLogLine[] = [];
        let bytes = 0, more = false;
        for (const row of this.db.prepare("SELECT seq, line FROM logs WHERE operation_id = ? AND seq > ? ORDER BY seq LIMIT ?").iterate(id, cursor, count)) {
          const line = JSON.parse(String(row.line)) as JobLogLine;
          if (Number(row.seq) !== cursor + lines.length + 1 || line.seq !== Number(row.seq) || line.seq > view.lastSeq || typeof line.text !== "string" || typeof line.at !== "string" || !["out", "err", "info"].includes(line.stream)) throw new Error("Invalid log evidence");
          const size = Buffer.byteLength(JSON.stringify(line)) + 1;
          if (bytes + size > REPLAY_BYTES && lines.length) { more = true; break; }
          lines.push(line); bytes += size;
        }
        if (!more && lines.length !== expected) throw new Error("Missing log evidence");
        return { job: view, lines };
      }
      catch { throw new OperationStoreError(503, "Operation log evidence is unreadable. Preserve the database and inspect the recorded outcome."); }
    });
  }
  requestCancel(id: string): JobView {
    this.transaction(() => {
      const { view } = this.required(id);
      if (view.execution === "finished" || view.execution === "lost") return;
      this.write(id, { ...view, cancelRequested: true });
    });
    return this.required(id).view;
  }
  /** Only adapter-sanitized CloudFormation observation payloads enter this stream. */
  event(id: string, event: OperationEvent["event"], data: unknown): void {
    if (event !== "deploy-stacks" && event !== "deploy-event") throw new OperationStoreError(400, "Unsupported operation event.");
    const encoded = JSON.stringify(data);
    if (encoded === undefined) throw new OperationStoreError(400, "Operation events require structured data.");
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new OperationStoreError(413, "Operation observation exceeds the durable event size limit.");
    this.transaction(() => {
      this.required(id);
      const previous = this.db.prepare("SELECT last_seq FROM event_cursors WHERE operation_id = ?").get(id);
      const seq = previous ? Number(previous.last_seq) + 1 : 1;
      this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)").run(id, seq, event, encoded);
      this.db.prepare("INSERT INTO event_cursors VALUES (?, ?) ON CONFLICT(operation_id) DO UPDATE SET last_seq = excluded.last_seq").run(id, seq);
    });
  }
  events(id: string, after = 0): { events: OperationEvent[]; lastSeq: number } {
    const cursor = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    return this.transaction(() => {
      this.required(id);
      const highWater = this.db.prepare("SELECT last_seq FROM event_cursors WHERE operation_id = ?").get(id);
      const lastSeq = highWater ? Number(highWater.last_seq) : 0;
      try {
        if (!Number.isSafeInteger(lastSeq)) throw new Error("Invalid event cursor");
        const expected = Math.min(1000, Math.max(0, lastSeq - cursor));
        const events: OperationEvent[] = [];
        let bytes = 0, more = false;
        for (const row of this.db.prepare("SELECT seq, event, data FROM events WHERE operation_id = ? AND seq > ? ORDER BY seq LIMIT 1000").iterate(id, cursor)) {
          if (Number(row.seq) !== cursor + events.length + 1 || Number(row.seq) > lastSeq || row.event !== "deploy-stacks" && row.event !== "deploy-event") throw new Error("Invalid event evidence");
          const event: OperationEvent = { seq: Number(row.seq), event: row.event, data: JSON.parse(String(row.data)) as unknown };
          const size = Buffer.byteLength(JSON.stringify(event)) + 1;
          if (bytes + size > REPLAY_BYTES && events.length) { more = true; break; }
          events.push(event); bytes += size;
        }
        if (!more && events.length !== expected) throw new Error("Missing event evidence");
        return { events, lastSeq };
      } catch { throw new OperationStoreError(503, "Operation event evidence is unreadable. Preserve the database and inspect its domain records."); }
    });
  }
  /** Domain evidence does not prove the worker's descendants or local export stopped. */
  reconcileConfirmed(id: string, patch: { outcome: "confirmed" | "unverified"; summary: string; recovery?: string }): void {
    this.transaction(() => {
      const { view } = this.required(id);
      if (view.outcome !== "uncertain" || view.execution !== "lost" && view.execution !== "finished") throw new OperationStoreError(409, "Only lost or uncertain operations need domain reconciliation.");
      this.db.prepare("INSERT OR IGNORE INTO recovery_holds VALUES (?)").run(id);
      const observed = { ...view, outcome: patch.outcome, summary: patch.summary, recovery: patch.recovery };
      this.db.prepare("UPDATE operations SET view = ?, changed_at = ? WHERE id = ?").run(JSON.stringify(observed), this.now(), id);
    });
  }
  reconcile(): void {
    // Probe outside a write transaction; ps must not block logging by healthy workers.
    for (const row of this.db.prepare("SELECT * FROM operations").all() as unknown as StoredRow[]) {
      const record = this.decode(row);
      if (record.view.execution !== "running" && record.view.execution !== "dispatching") continue;
      const alive = record.owner ? this.alive(record.owner) : undefined;
      if (record.owner && alive === undefined) {
        this.transaction(() => {
          const current = this.required(record.view.id);
          if (current.view.execution === "running" && !current.view.observationProblem) this.write(record.view.id, { ...current.view, observationProblem: "Host process identity is temporarily unavailable. Execution cannot be verified; its resource claims remain held and it will not be replayed." });
        });
        continue;
      }
      if (alive && record.view.observationProblem) this.transaction(() => {
        const current = this.required(record.view.id);
        if (current.view.execution === "running") this.write(record.view.id, { ...current.view, observationProblem: undefined });
      });
      const absent = record.owner ? alive === false : record.view.execution === "dispatching" && this.now() - row.changed_at > 15_000;
      if (!absent) continue;
      this.transaction(() => {
        const current = this.required(record.view.id);
        if (current.view.execution !== record.view.execution || JSON.stringify(current.owner) !== JSON.stringify(record.owner)) return;
        this.write(record.view.id, { ...current.view, execution: "lost", status: "interrupted", outcome: "uncertain", observationProblem: undefined, endedAt: new Date(this.now()).toISOString(), summary: "Execution was lost; external effects may continue.", recovery: "Inspect the recorded domain journal and exact external destination. This operation will not be replayed; its resource locks remain held." });
      });
    }
  }
  close(): void { this.db.close(); }
}
