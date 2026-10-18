import type { JobLogLine } from "../../shared/deploy";

/**
 * Every job's log lines as the page has them, from two sources that overlap
 * and arrive in any order: the live event stream, and replays of what was
 * missed (opening a job mid-run, a dropped connection). Lines are kept by
 * their number, once each, in order; `resumeAfter` names where a replay must
 * start for the log to be whole.
 */
export class LogStore {
  private readonly lines = new Map<string, Map<number, JobLogLine>>();
  private readonly ordered = new Map<string, JobLogLine[]>();
  /** The last line dropped to keep a long log short: everything up to it counts as had. */
  private readonly floor = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.version;

  get(id: string): readonly JobLogLine[] {
    return this.ordered.get(id) ?? [];
  }

  /** The last line of the unbroken run from line 1: a replay asks for what follows it. */
  resumeAfter(id: string): number {
    const held = this.ordered.get(id) ?? [];
    let expected = (this.floor.get(id) ?? 0) + 1;
    for (const line of held) {
      if (line.seq < expected) continue;
      if (line.seq !== expected) break;
      expected++;
    }
    return expected - 1;
  }

  /** Whether lines are missing: before the first held, or between two held. */
  incomplete(id: string): boolean {
    const held = this.ordered.get(id) ?? [];
    return held.length > 0 && this.resumeAfter(id) < held.at(-1)!.seq;
  }

  add(id: string, incoming: readonly JobLogLine[]): void {
    const byNumber = this.lines.get(id) ?? new Map<number, JobLogLine>();
    let added = false;
    for (const line of incoming) {
      if (byNumber.has(line.seq) || line.seq <= (this.floor.get(id) ?? 0)) continue;
      byNumber.set(line.seq, line);
      added = true;
    }
    if (!added) return;
    this.lines.set(id, byNumber);
    const ordered = [...byNumber.values()].sort((a, b) => a.seq - b.seq);
    // A page keeps the most recent lines of a very long log.
    if (ordered.length > 5000) {
      for (const line of ordered.splice(0, ordered.length - 5000)) {
        byNumber.delete(line.seq);
        this.floor.set(id, Math.max(this.floor.get(id) ?? 0, line.seq));
      }
    }
    this.ordered.set(id, ordered);
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
