import type { JobLogLine, JobView } from "../../shared/operations";
import type { LogStore } from "./log-store";

/** Drain bounded server pages without treating a live tail as proof that preceding lines arrived. */
export async function replayOperationLog(store: LogStore, id: string, lastSeq: number,
  read: (id: string, after: number) => Promise<{ job: JobView; lines: readonly JobLogLine[] }>,
): Promise<void> {
  let target = lastSeq;
  do {
    const after = store.resumeAfter(id);
    const result = await read(id, after);
    target = Math.max(target, result.job.lastSeq);
    store.add(id, result.lines);
    if (store.resumeAfter(id) >= target && !store.incomplete(id)) return;
    if (store.resumeAfter(id) <= after) throw new Error("The recorded log has a gap. Retry reading the operation log.");
  } while (true);
}
