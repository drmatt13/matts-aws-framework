import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertCreationFile } from "./creation";
import { EditError, sourceContents, writeSourceChange } from "./io";
import { sha256, toRelative } from "../files";
import type { SourceRecovery } from "../../shared/source-recovery";

interface Change { readonly file: string; readonly before: string | null; readonly after: string | null; readonly authority?: "native" | "resource" }
interface Journal { readonly version: 1; readonly id: string; readonly root: string; readonly ownerPid?: number; readonly authority?: "resource"; readonly label: string; readonly createdAt: string; readonly changes: readonly Change[]; readonly status: "pending" | "complete" | "restored" | "conflicted" }
interface SourceLock { readonly id: string; readonly root: string; readonly ownerPid: number }
/** Shared by edit/recovery service instances in this process. A running apply is never recovery work. */
const active = new Map<string, Set<string>>();

/** Write-ahead source record; recovery always preserves bytes edited after the interruption. */
export class SourceJournal {
  private readonly folder: string;
  constructor(private readonly root: string) { this.folder = path.join(root, ".cache/framework-studio/transactions"); }
  private readLock(name = "source.lock"): SourceLock | undefined {
    this.assertFolder(); const file = path.join(this.folder, name);
    try {
      if (lstatSync(file).isSymbolicLink()) throw new EditError(422, "Source transaction locks cannot be symbolic links.");
      const lock = JSON.parse(readFileSync(file, "utf8")) as SourceLock;
      if (!/^[0-9a-f-]{36}$/.test(lock.id) || lock.root !== realpathSync(this.root) || !Number.isSafeInteger(lock.ownerPid) || lock.ownerPid < 1) throw new EditError(422, "Source transaction lock is invalid. Inspect it without deleting user source.");
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new EditError(422, `.cache/framework-studio/transactions/${name} is incomplete or invalid. Inspect the lock and preserve user source before explicitly resolving it; Studio will not reclaim it automatically.`);
      throw error;
    }
  }
  private lock(id: string, name = "source.lock"): void {
    this.assertFolder(); mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = openSync(path.join(this.folder, name), "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new EditError(409, name === "source.lock" ? "Another source transaction is applying or was interrupted. Wait for it, or open Source recovery. The checkout lock is never automatically reclaimed." : "Source recovery is already running or was interrupted. Inspect .cache/framework-studio/transactions/recovery.lock before explicitly resolving it; user source was preserved and the lock is never automatically reclaimed."); throw error; }
    try { writeFileSync(fd, JSON.stringify({ id, root: realpathSync(this.root), ownerPid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private unlock(id: string, name = "source.lock"): void {
    const lock = this.readLock(name);
    if (lock?.id === id) unlinkSync(path.join(this.folder, name));
  }
  private processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
  private ownsStaleLock(journal: Journal): boolean { const lock = this.readLock(); return lock?.id === journal.id && !this.processAlive(lock.ownerPid); }
  private recover<T>(journal: Journal, action: () => T): T {
    if (this.isActive(journal)) throw new EditError(409, "This source transaction is still applying; recovery cannot change it.");
    const recoveryId = randomUUID(); this.lock(recoveryId, "recovery.lock");
    try { return action(); } finally { this.unlock(recoveryId, "recovery.lock"); }
  }
  private sourceFile(journal: Pick<Journal, "authority">, relative: string, authority?: "native" | "resource"): string {
    if (authority === "native" && !/^cdk-app\/lib\/[A-Za-z0-9._/-]+\.ts$/.test(relative)) throw new EditError(422, "This is not a native stack recovery path.");
    if (journal.authority !== "resource" && authority !== "native" && authority !== "resource") return assertCreationFile(this.root, relative);
    // Resource reference moves have an existing, separate authored-TypeScript authority.
    // Check lexical ownership even if an external editor deleted the file since apply.
    if (!/^[A-Za-z0-9._/-]+\.tsx?$/.test(relative) || relative.split("/").some(part => ["", ".", "..", "node_modules", "generated", ".cache", ".git"].includes(part) || part.startsWith(".env")) || /\.gen\.tsx?$/.test(relative)) throw new EditError(422, "This is not an authored resource recovery path.");
    let current = realpathSync(this.root);
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "Resource recovery cannot read or write through symbolic links."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return current;
  }
  private assertFolder(): void {
    let current = realpathSync(this.root);
    for (const part of [".cache", "framework-studio", "transactions"]) {
      current = path.join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "Source recovery cannot read or write through symbolic links."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (existsSync(this.folder) && !realpathSync(this.folder).startsWith(realpathSync(this.root) + path.sep)) throw new EditError(422, "Source recovery must remain inside this checkout.");
  }
  private save(journal: Journal): void {
    this.assertFolder();
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const file = path.join(this.folder, `${journal.id}.json`), temporary = path.join(this.folder, `${journal.id}-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600, flag: "wx" });
    // Windows FlushFileBuffers requires a handle opened for writing. The file
    // is ours; keep the durable write-ahead flush on every supported platform.
    const fd = openSync(temporary, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    try { const directory = openSync(this.folder, "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
    catch (error) { const code = (error as NodeJS.ErrnoException).code ?? ""; if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(code) && !(process.platform === "win32" && ["EPERM", "EACCES"].includes(code))) throw error; }
  }
  begin(label: string, changes: readonly Change[], authority?: "resource"): string {
    const root = realpathSync(this.root);
    if (active.get(root)?.size) throw new EditError(409, "A source transaction is still applying. Wait for its result before writing more source.");
    this.assertFolder();
    // Serialize before reading records: another owner may have exclusively
    // created its lock but not finished writing that lock's metadata yet.
    const id = randomUUID(); this.lock(id);
    try {
    if (existsSync(this.folder) && readdirSync(this.folder).filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => this.read(file.slice(0, -5))).some(journal => journal.status === "pending" && this.isActive(journal))) throw new EditError(409, "Another Studio process is still applying source in this checkout. Wait for its result before editing.");
    if (this.pending().length) throw new EditError(409, "An interrupted source transaction needs recovery before applying more source changes. Open Source recovery.");
    const reviewed = changes.map(change => ({ ...change, file: toRelative(this.root, change.file) }));
    for (const change of reviewed) this.sourceFile({ authority }, change.file, change.authority);
    this.save({ version: 1, id, root, ownerPid: process.pid, ...(authority ? { authority } : {}), label, createdAt: new Date().toISOString(), status: "pending", changes: reviewed });
    active.set(root, new Set([id]));
    return id;
    } catch (error) { this.unlock(id); throw error; }
  }
  private read(id: string): Journal {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new EditError(400, "Choose a recorded source transaction.");
    this.assertFolder();
    const file = path.join(this.folder, `${id}.json`);
    try { if (lstatSync(file).isSymbolicLink()) throw new EditError(422, "Source recovery records cannot be symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let journal: Journal;
    try { journal = JSON.parse(readFileSync(file, "utf8")) as Journal; }
    catch (error) {
      const lock = this.readLock();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || lock?.id !== id || this.processAlive(lock.ownerPid)) throw error;
      // Crash after exclusive lock creation, before the write-ahead record: no source
      // writes began. Explicit recovery can safely complete this empty transaction.
      return { version: 1, id, root: lock.root, ownerPid: lock.ownerPid, label: "Interrupted source lock before writes", createdAt: "Unknown (before journal creation)", status: "pending", changes: [] };
    }
    if (journal.version !== 1 || journal.id !== id || journal.root !== realpathSync(this.root) || !Array.isArray(journal.changes) || journal.authority !== undefined && journal.authority !== "resource") throw new EditError(422, "This source recovery record does not belong to this checkout.");
    for (const change of journal.changes) {
      if (typeof change.file !== "string" || change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string" || change.authority !== undefined && change.authority !== "native" && change.authority !== "resource") throw new EditError(422, "This source recovery record is invalid.");
      this.sourceFile(journal, change.file, change.authority);
    }
    return journal;
  }
  finish(id: string, status: Journal["status"]): void { try { this.save({ ...this.read(id), status }); this.unlock(id); } finally { active.get(realpathSync(this.root))?.delete(id); } }
  private isActive(journal: Journal): boolean {
    if (active.get(journal.root)?.has(journal.id)) return true;
    if (journal.ownerPid && journal.ownerPid !== process.pid && journal.status === "pending") {
      return this.processAlive(journal.ownerPid);
    }
    return false;
  }
  pending(): readonly SourceRecovery[] {
    this.assertFolder();
    if (!existsSync(this.folder)) return [];
    const ids = readdirSync(this.folder).filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => file.slice(0, -5));
    const lock = this.readLock(); if (lock && !this.processAlive(lock.ownerPid) && !ids.includes(lock.id)) ids.push(lock.id);
    return ids.map(id => this.read(id)).filter(journal => (journal.status === "pending" || journal.status === "conflicted" || this.ownsStaleLock(journal)) && !this.isActive(journal)).map(journal => ({ id: journal.id, label: journal.label, createdAt: journal.createdAt, fingerprint: this.fingerprint(journal), files: journal.changes.map(change => {
      const actual = sourceContents(path.join(this.root, change.file));
      return { file: change.file, state: actual === change.before ? "original" as const : actual === change.after ? "written" as const : "conflicted" as const };
    }) }));
  }
  private fingerprint(journal: Journal): string { return sha256(JSON.stringify(journal.changes.map(change => [change.file, sourceContents(this.sourceFile(journal, change.file, change.authority))]))); }
  keepCurrent(id: string, fingerprint: string, approval: string): readonly SourceRecovery[] {
    const journal = this.read(id);
    return this.recover(journal, () => {
    if (approval !== "KEEP CURRENT SOURCE" || !["pending", "conflicted"].includes(journal.status) && !this.ownsStaleLock(journal)) throw new EditError(422, "Review the current files and type KEEP CURRENT SOURCE to finish recovery without restoring them.");
    if (fingerprint !== this.fingerprint(journal)) throw new EditError(409, "Source changed since recovery review. Refresh and inspect the current file states again.");
    this.finish(id, "complete"); return this.pending();
    });
  }
  restore(id: string, approval: string): readonly SourceRecovery[] {
    if (approval !== "RESTORE SOURCE") throw new EditError(422, "Type RESTORE SOURCE to restore files still matching this interrupted transaction. Later user edits are preserved.");
    const journal = this.read(id);
    return this.recover(journal, () => {
    if (journal.status !== "pending" && journal.status !== "conflicted" && !this.ownsStaleLock(journal)) throw new EditError(409, "This transaction has already completed or been restored.");
    let conflict = false;
    for (const change of [...journal.changes].reverse()) {
      const file = this.sourceFile(journal, change.file, change.authority), actual = sourceContents(file);
      if (actual === change.before) continue;
      if (actual !== change.after) { conflict = true; continue; }
      try { writeSourceChange(this.root, file, change.after, change.before); } catch { conflict = true; }
    }
    this.finish(id, conflict ? "conflicted" : "restored");
    return this.pending();
    });
  }
}
