import assert from "./support/assert";
import { test } from "node:test";
import type { JobLogLine, JobView } from "../shared/operations";
import { LogStore } from "../src/operations/log-store";
import { replayOperationLog } from "../src/operations/replay";

const line = (seq: number): JobLogLine => ({ seq, at: "2026-11-04T00:00:00Z", stream: "out", text: `line ${seq}` });
const job: JobView = { id: "operation", kind: "export", title: "Export", params: {}, status: "succeeded", startedAt: "2026-11-04T00:00:00Z", lastSeq: 2501 };

test("shared replay drains bounded pages and deduplicates overlapping live output", async () => {
  const store = new LogStore();
  store.add(job.id, [line(2500), line(2501)]);
  const cursors: number[] = [];
  await replayOperationLog(store, job.id, job.lastSeq, async (_id, after) => {
    cursors.push(after);
    return { job, lines: Array.from({ length: Math.min(1000, job.lastSeq - after) }, (_, i) => line(after + i + 1)) };
  });
  assert.deepEqual(cursors, [0, 1000, 2000]);
  assert.equal(store.resumeAfter(job.id), 2501);
  assert.equal(store.get(job.id).length, 2501);
});

test("large disconnected tails cannot advance the contiguous cursor across missing history", async () => {
  const store = new LogStore();
  store.add(job.id, Array.from({ length: 6000 }, (_, i) => line(i + 5001)));
  assert.equal(store.resumeAfter(job.id), 0);
  const complete = { ...job, lastSeq: 11000 };
  await replayOperationLog(store, job.id, complete.lastSeq, async (_id, after) => ({
    job: complete, lines: Array.from({ length: Math.min(1000, complete.lastSeq - after) }, (_, i) => line(after + i + 1)),
  }));
  assert.equal(store.resumeAfter(job.id), complete.lastSeq);
  assert.equal(store.incomplete(job.id), false);
  assert.equal(store.get(job.id).length, 5000);
  assert.equal(store.get(job.id).at(-1)?.seq, complete.lastSeq);
});

test("missing durable output is surfaced instead of looping or silently accepting a gap", async () => {
  const store = new LogStore();
  store.add(job.id, [line(1)]);
  await assert.rejects(replayOperationLog(store, job.id, 3, async () => ({ job: { ...job, lastSeq: 3 }, lines: [line(3)] })), /log has a gap/);
  assert.equal(store.resumeAfter(job.id), 1);
  await replayOperationLog(store, job.id, 3, async () => ({ job: { ...job, lastSeq: 3 }, lines: [line(2), line(3)] }));
  assert.deepEqual(store.get(job.id).map(entry => entry.seq), [1, 2, 3]);
});
