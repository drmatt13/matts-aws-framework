import assert from "./support/assert";
import { test } from "node:test";
import type { JobLogLine } from "../shared/deploy";
import { LogStore } from "../src/deploy/log-store";

/**
 * A job's log as the page holds it: lines arrive live (from line N, for a page
 * opened mid-job) and from a replay of what was missed; it must end up whole.
 */

const line = (seq: number): JobLogLine => ({ seq, at: "2026-10-17T12:00:00Z", stream: "out", text: `line ${seq}` });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => line(from + index));

test("a replay of earlier lines fills in before the live ones", () => {
  const store = new LogStore();
  store.add("job", [line(500), line(501)]);
  assert.equal(store.resumeAfter("job"), 0, "nothing before 500 is held, so the replay starts at the beginning");
  store.add("job", range(1, 501));
  assert.deepEqual(store.get("job").map((entry) => entry.seq), range(1, 501).map((entry) => entry.seq));
});

test("a gap left by a dropped connection is found and filled", () => {
  const store = new LogStore();
  store.add("job", [line(1), line(2), line(5)]);
  assert.equal(store.resumeAfter("job"), 2);
  store.add("job", [line(3), line(4), line(5), line(6)]);
  assert.deepEqual(store.get("job").map((entry) => entry.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(store.resumeAfter("job"), 6);
});

test("lines seen twice are kept once", () => {
  const store = new LogStore();
  store.add("job", range(1, 3));
  store.add("job", range(2, 4));
  assert.deepEqual(store.get("job").map((entry) => entry.seq), [1, 2, 3, 4]);
});

test("a log trimmed to its last lines is whole, not missing its start", () => {
  const store = new LogStore();
  store.add("job", range(1, 6000));
  assert.equal(store.get("job").length, 5000);
  assert.equal(store.incomplete("job"), false, "trimmed lines are not asked for again");
  assert.equal(store.resumeAfter("job"), 6000);
});
