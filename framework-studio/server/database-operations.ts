import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseOperationRecord } from "../shared/database-application";

/** Redacted effects survive process loss. Running records are never replayed. */
export class DatabaseOperationStore {
  private readonly directory: string;
  constructor(root: string) {
    this.directory = path.join(process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ?? path.join(root, ".cache/framework-studio"), "database-operations");
    for (const record of this.list()) if (record.status === "running" && !this.alive(record.ownerPid)) this.write({ ...record, status: "interrupted", stage: "interrupted", updatedAt: new Date().toISOString() });
  }
  private alive(pid?: number): boolean { if (!pid || !Number.isSafeInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
  /** Atomic checkout-wide exclusion. Stale/unknown locks require deliberate
   * operator recovery after inspection; never race another owner by auto-unlinking.
   * Prisma additionally owns its database-side migration transaction lock.
   */
  lock(): (() => void) | undefined {
    mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, "active.lock");
    try {
      if (existsSync(file)) return undefined;
      const descriptor = openSync(file, "wx", 0o600);
      const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
      try { writeFileSync(descriptor, contents); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      this.syncDirectory();
      return () => { try { if (readFileSync(file, "utf8") === contents) unlinkSync(file); } catch { /* Preserve an unrecognized/concurrently changed lock. */ } };
    } catch { return undefined; }
  }
  list(): DatabaseOperationRecord[] {
    if (!existsSync(this.directory)) return [];
    const records = readdirSync(this.directory).filter(name => /^[a-f0-9-]+\.json$/.test(name)).flatMap(name => {
      try {
        const record = JSON.parse(readFileSync(path.join(this.directory, name), "utf8")) as DatabaseOperationRecord;
        if (!record.id || !record.targetLabel || !record.startedAt || !["running", "reviewed", "applied", "unchanged", "failed", "unconfirmed", "interrupted"].includes(record.status)) throw new Error("Invalid operation record");
        return [record];
      } catch {
        return [{ id: name.slice(0, -5), kind: "migrate", targetLabel: "Unconfirmed local database operation", targetIdentity: "unknown", sourceHash: "unknown", startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), status: "interrupted", stage: "interrupted", migrations: [], result: { status: "unconfirmed", database: "unconfirmed", source: "unchanged", artifacts: "unchanged", targetId: "local:postgres", applied: [], message: "An operation record is unreadable. Database effects cannot be established from this history; inspect the target and ledger before retrying.", diagnostic: { code: "JOURNAL_UNREADABLE", action: "Preserve the journal file and investigate the selected database. Do not infer that an unreadable record means no previous writes." } } } satisfies DatabaseOperationRecord];
      }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    // New inspections must never hide older unknown write outcomes.
    return records.filter((record, index) => index < 50 || ["running", "unconfirmed", "interrupted"].includes(record.status));
  }
  write(record: DatabaseOperationRecord): void {
    if (!/^[a-f0-9-]+$/.test(record.id)) throw new Error("Invalid database operation identity");
    mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, `${record.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(record)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, file);
    this.syncDirectory();
  }
  private syncDirectory(): void {
    let descriptor: number | undefined;
    try { descriptor = openSync(this.directory, "r"); fsyncSync(descriptor); }
    catch (error) { if (!["EINVAL", "ENOTSUP", ...(process.platform === "win32" ? ["EPERM", "EACCES", "EISDIR", "EBADF"] : [])].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
}
