import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityAlive, processIdentity } from "../operations/identity";
import type { ExecutionIdentity } from "../../shared/operations";

/** One durable checkout authority for source writers, tooling and publication. */
interface Lease { readonly id: string; readonly identity: ExecutionIdentity; readonly kind: "write" | "read" | "recovery"; }
interface State { epoch: string; lease: Lease | null; recovery: string | null; }
interface Context { readonly root: string; readonly lease: Lease; readonly entryEpoch: string; active: boolean; }
const context = new AsyncLocalStorage<Context>();
const relative = ".cache/framework-studio/source-gate";
let identity: Omit<ExecutionIdentity, "token"> | undefined;

export interface SourceCoordinationState {
  readonly status: "ready" | "busy" | "recovery_required" | "unavailable";
  readonly epoch: string;
  readonly mode?: Lease["kind"];
  readonly recoveryId?: string;
  readonly ownerPid?: number;
  readonly message?: string;
}
export class SourceGateError extends Error { readonly status = 409; }
export class SourcePublicationChanged extends SourceGateError {}

function folder(rootInput: string, create = false): string {
  let current = realpathSync(rootInput);
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SourceGateError("Source coordination storage must be a real directory inside this checkout.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) {
        try { mkdirSync(current, { mode: 0o700 }); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST" || lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw failure; }
      }
    }
  }
  return current;
}
function open(root: string, create = false): DatabaseSync | undefined {
  const directory = folder(root, create), file = path.join(directory, "coordination.sqlite");
  if (existsSync(path.join(directory, "write.lock")) || existsSync(path.join(directory, "recovery-required"))) throw new SourceGateError("An older source coordination record needs inspection before upgrading its storage.");
  if (!existsSync(file)) {
    if (!create) return;
    try { closeSync(openSync(file, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new SourceGateError("Source coordination database must be a private regular file owned by this user.");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    if (create) {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS coordination (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL, epoch TEXT NOT NULL, lease TEXT, recovery TEXT)");
      db.prepare("INSERT OR IGNORE INTO coordination(singleton,root,epoch,lease,recovery) VALUES (1, ?, 'initial', NULL, NULL)").run(realpathSync(root));
      if (!db.prepare("PRAGMA table_info(coordination)").all().some(row => row.name === "restricted_evaluation")) db.exec("ALTER TABLE coordination ADD COLUMN restricted_evaluation INTEGER NOT NULL DEFAULT 0");
    }
    const row = db.prepare("SELECT root FROM coordination WHERE singleton=1").get();
    if (row?.root !== realpathSync(root)) throw new SourceGateError("Source coordination belongs to another checkout or needs inspection.");
    return db;
  } catch (error) { db.close(); throw error; }
}
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* Preserve original storage failure. */ } throw error; }
}
function read(db?: DatabaseSync): State {
  if (!db) return { epoch: "initial", lease: null, recovery: null };
  const row = db.prepare("SELECT epoch,lease,recovery FROM coordination WHERE singleton=1").get()!;
  const state: State = { epoch: String(row.epoch), lease: row.lease === null ? null : JSON.parse(String(row.lease)) as Lease, recovery: row.recovery === null ? null : String(row.recovery) };
  if (state.lease && (!/^[a-f0-9-]{36}$/.test(state.lease.id) || !["write", "read", "recovery"].includes(state.lease.kind) || !Number.isSafeInteger(state.lease.identity?.pid) || state.lease.identity.pid < 1 || state.lease.identity.token !== state.lease.id)) throw new SourceGateError("Source coordination ownership is unreadable; preserve it for inspection.");
  return state;
}
function own(root: string): Context | undefined {
  const owner = context.getStore();
  return owner?.active && owner.root === realpathSync(root) ? owner : undefined;
}
export function ownsSourceGate(root: string): boolean { return !!own(root); }
/** The complete source generation the owner reserved before its own writes. */
export function sourceOwnedEntryEpoch(root: string): string | undefined { return own(root)?.entryEpoch; }
function alive(lease: Lease): boolean | undefined {
  try { process.kill(lease.identity.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  // On unsupported process-inspection platforms, fail closed on PID reuse.
  return lease.identity.started ? identityAlive(lease.identity) : true;
}
function owner(id: string): ExecutionIdentity {
  if (!identity) {
    try {
      if (process.platform === "win32") throw new Error("No portable process start-time inspector.");
      const current = processIdentity(id); identity = { pid: current.pid, uid: current.uid, started: current.started };
    } catch {
      // Inspection may be restricted even for ourselves. Such leases remain
      // unrecoverable while their PID exists, so PID reuse cannot steal ownership.
      identity = { pid: process.pid, uid: process.getuid?.() ?? -1, started: "" };
    }
  }
  return { ...identity, token: id };
}
/** Older Studio versions retain their bounded domain journal and lock files. */
function legacyProblem(root: string): string | undefined {
  const directory = path.join(root, ".cache/framework-studio/transactions");
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "Legacy source recovery storage needs inspection.";
  for (const name of readdirSync(directory)) {
    if (name === "source.lock" || name === "recovery.lock") return "A source transaction is active or needs recovery.";
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    if (lstatSync(file).isSymbolicLink()) return "Legacy source recovery metadata needs inspection.";
    try { const record = JSON.parse(readFileSync(file, "utf8")) as { status?: string }; if (!["complete", "restored"].includes(record.status ?? "")) return "A source transaction needs recovery."; }
    catch { return "Legacy source recovery metadata is unreadable."; }
  }
}
function pendingImport(root: string): string | undefined {
  const directory = path.join(root, ".cache/framework-studio/agent-integrations");
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return "Agent integration storage needs inspection.";
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    if (lstatSync(file).isSymbolicLink()) return "Agent integration metadata needs inspection.";
    try { const record = JSON.parse(readFileSync(file, "utf8")) as { status?: string }; if (!["applied", "restored", "kept"].includes(record.status ?? "")) return "An agent source integration needs recovery."; }
    catch { return "Agent integration metadata is unreadable."; }
  }
}
export function sourceCoordinationState(root: string): SourceCoordinationState {
  let db: DatabaseSync | undefined;
  try {
    db = open(root); const state = read(db);
    if (state.lease) {
      const active = alive(state.lease);
      return { status: active === false ? "recovery_required" : "busy", epoch: state.epoch, mode: state.lease.kind, ownerPid: state.lease.identity.pid, ...(state.recovery ? { recoveryId: state.recovery } : {}),
        message: active === false ? "The source owner stopped. Review source recovery; no operation will be replayed." : "Source is reserved by an active or unverifiable Studio operation." };
    }
    const problem = state.recovery ? "An interrupted agent source import needs recovery." : legacyProblem(root) ?? pendingImport(root);
    return { status: problem ? "recovery_required" : "ready", epoch: state.epoch, ...(state.recovery ? { recoveryId: state.recovery } : {}), ...(problem ? { message: problem } : {}) };
  } catch { return { status: "unavailable", epoch: "unknown", message: "Source coordination evidence is unreadable. Preserve its records for inspection." }; }
  finally { db?.close(); }
}
function available(root: string, state: State, readOnly = false): void {
  const current = own(root);
  if (current && current.lease.id === state.lease?.id) {
    if (!readOnly && current.lease.kind === "read") throw new SourceGateError("A source reader cannot upgrade to source write ownership.");
    return;
  }
  if (state.lease && !(readOnly && state.lease.kind === "read" && alive(state.lease) === true)) throw new SourceGateError("Source integration or tooling is active or interrupted. Wait for completion or open source recovery.");
  if (state.recovery) throw new SourceGateError("An interrupted source import needs recovery before publishing or writing source.");
  const problem = legacyProblem(root) ?? pendingImport(root); if (problem) throw new SourceGateError(problem);
}
export function assertSourceGateAvailable(root: string): void {
  const db = open(root);
  try { available(root, read(db)); } finally { db?.close(); }
}
export function sourcePublicationEpoch(root: string): string {
  const db = open(root);
  try { const state = read(db); available(root, state, true); return state.epoch; } finally { db?.close(); }
}
export function assertSourcePublicationEpoch(root: string, expected: string): void {
  try { if (sourcePublicationEpoch(root) !== expected) throw new Error(); }
  catch { throw new SourcePublicationChanged("Source changed during evaluation. The incomplete snapshot was discarded; refresh after integration completes."); }
}
/** The source writer cannot acquire its lease between this check and publication. */
export function publishSourceSnapshot<T>(root: string, expected: string, publish: () => T): T {
  const db = open(root, true)!;
  try {
    return transaction(db, () => {
      const state = read(db);
      try { available(root, state, true); if (state.epoch !== expected) throw new Error(); }
      catch { throw new SourcePublicationChanged("Source changed during evaluation. The incomplete snapshot was discarded; refresh after integration completes."); }
      return publish();
    });
  } finally { db.close(); }
}
function acquire(rootInput: string, kind: Lease["kind"], recoverAbandoned = false): { context: Context; release(): void } {
  const root = realpathSync(rootInput), db = open(root, true)!, id = randomUUID();
  const lease: Lease = { id, kind, identity: owner(id) };
  let entryEpoch = "";
  try {
    transaction(db, () => {
      const state = read(db);
      entryEpoch = state.epoch;
      if (state.lease && !(recoverAbandoned && alive(state.lease) === false)) throw new SourceGateError("Another Studio source writer is active or interrupted. Wait or open source recovery.");
      if (kind !== "recovery") available(root, { ...state, lease: null });
      const nextEpoch = kind === "read" ? state.epoch : randomUUID();
      db.prepare("UPDATE coordination SET epoch=?,lease=? WHERE singleton=1").run(nextEpoch, JSON.stringify(lease));
    });
  } finally { db.close(); }
  const ownerContext: Context = { root, lease, entryEpoch, active: true };
  return { context: ownerContext, release() {
    ownerContext.active = false; const connection = open(root, true)!;
    try { transaction(connection, () => {
      if (read(connection).lease?.id !== id) throw new SourceGateError("Source ownership changed. Preserve coordination evidence.");
      connection.prepare("UPDATE coordination SET lease=NULL WHERE singleton=1").run();
    }); } finally { connection.close(); }
  } };
}
function scopedSync<T>(root: string, kind: Lease["kind"], action: () => T, recoverAbandoned = false): T {
  const current = own(root);
  if (current) { if (current.lease.kind === "read" && kind !== "read") throw new SourceGateError("A source reader cannot upgrade to source write ownership."); return action(); }
  const lease = acquire(root, kind, recoverAbandoned);
  try { return context.run(lease.context, action); } finally { lease.release(); }
}
async function scoped<T>(root: string, kind: Lease["kind"], action: () => Promise<T>, recoverAbandoned = false): Promise<T> {
  const current = own(root);
  if (current) { if (current.lease.kind === "read" && kind !== "read") throw new SourceGateError("A source reader cannot upgrade to source write ownership."); return action(); }
  const lease = acquire(root, kind, recoverAbandoned);
  try { return await context.run(lease.context, action); } finally { lease.release(); }
}
export function withSourceWriteSync<T>(root: string, action: () => T): T { return scopedSync(root, "write", action); }
export function withSourceWrite<T>(root: string, action: () => Promise<T>): Promise<T> { return scoped(root, "write", action); }
export function withSourceRead<T>(root: string, action: () => Promise<T>): Promise<T> { return scoped(root, "read", action); }
/** Caller validates explicit recovery approval first; takeover and claim are one SQL transaction. */
export function withSourceRecovery<T>(root: string, action: () => Promise<T>): Promise<T> { return scoped(root, "recovery", action, true); }
export function withSourceRecoverySync<T>(root: string, action: () => T): T { return scopedSync(root, "recovery", action, true); }
export function markSourceRecoveryRequired(root: string, id: string): void {
  if (!own(root)) throw new SourceGateError("Source recovery records require source ownership.");
  const db = open(root, true)!;
  try { transaction(db, () => {
    const state = read(db);
    if (state.recovery && state.recovery !== id) throw new SourceGateError("Another source recovery record remains unresolved.");
    db.prepare("UPDATE coordination SET recovery=? WHERE singleton=1").run(id);
  }); } finally { db.close(); }
}
export function clearSourceRecoveryRequired(root: string, id: string): void {
  if (!own(root)) throw new SourceGateError("Source recovery records require source ownership.");
  const db = open(root, true)!;
  try { transaction(db, () => {
    const state = read(db);
    if (state.recovery && state.recovery !== id) throw new SourceGateError("Another source recovery record remains unresolved.");
    db.prepare("UPDATE coordination SET recovery=NULL WHERE singleton=1").run();
  }); } finally { db.close(); }
}
/** Only an abandoned lease with no pending source record can be cleared independently. */
export function recoverSourceGate(root: string, approval: string): void {
  if (approval !== "RECOVER SOURCE WRITES") throw new SourceGateError("Type RECOVER SOURCE WRITES after inspecting the interrupted source operation.");
  withSourceRecoverySync(root, () => {
    const db = open(root)!;
    try { if (read(db).recovery || legacyProblem(root) || pendingImport(root)) throw new SourceGateError("Recover the recorded source transaction through its recovery action; its lease cannot be cleared separately."); }
    finally { db.close(); }
  });
}

/** Once agent-authored code reaches disk it must never regain privileged evaluation implicitly. */
export function requireRestrictedSourceEvaluation(root: string): void {
  const current = own(root);
  if (!current || current.lease.kind === "read") throw new SourceGateError("Changing source evaluation policy requires source write ownership.");
  const db = open(root, true)!;
  try { transaction(db, () => { db.prepare("UPDATE coordination SET restricted_evaluation=1 WHERE singleton=1").run(); }); }
  finally { db.close(); }
}
export function restrictedSourceEvaluationRequired(root: string): boolean {
  const db = open(root);
  try {
    if (!db || !db.prepare("PRAGMA table_info(coordination)").all().some(row => row.name === "restricted_evaluation")) return false;
    return db.prepare("SELECT restricted_evaluation FROM coordination WHERE singleton=1").get()?.restricted_evaluation !== 0;
  } finally { db?.close(); }
}
