import assert from "./support/assert";
import test from "node:test";
import { createStudioEventHub } from "../src/events";

test("snapshot and deploy subscriptions share a stream without stealing listeners on navigation", () => {
  const streams: (EventTarget & { close(): void; closed: boolean })[] = [];
  const connect = createStudioEventHub(() => {
    const source = Object.assign(new EventTarget(), { closed: false, close() { this.closed = true; } });
    streams.push(source); return source;
  });
  const snapshot = connect("session"), deploy = connect("session");
  let snapshots = 0, jobs = 0;
  snapshot.addEventListener("snapshot", () => snapshots++);
  deploy.addEventListener("deploy-job", () => jobs++);
  assert.equal(streams.length, 1, "Deploy must not consume another HTTP/1 connection");
  streams[0]!.dispatchEvent(new Event("snapshot"));
  streams[0]!.dispatchEvent(new Event("deploy-job"));
  assert.deepEqual([snapshots, jobs], [1, 1]);
  deploy.close(); deploy.close();
  assert.equal(streams[0]!.closed, false, "leaving Deploy keeps snapshot updates alive");
  streams[0]!.dispatchEvent(new Event("deploy-job"));
  streams[0]!.dispatchEvent(new Event("snapshot"));
  assert.deepEqual([snapshots, jobs], [2, 1], "unmounted consumers cannot receive stale callbacks");
  snapshot.close();
  assert.equal(streams[0]!.closed, true);
  connect("session").close();
  assert.equal(streams.length, 2, "a new mounted session gets a fresh stream");
});

test("different server tokens never share a connection", () => {
  const urls: string[] = [];
  const connect = createStudioEventHub(url => { urls.push(url); return { addEventListener() {}, removeEventListener() {}, close() {} }; });
  const first = connect("first"), second = connect("second");
  assert.equal(urls.length, 2);
  first.close(); second.close();
});
