import assert from "./support/assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AwsObserver } from "../server/deploy/observe";
import { Tools, type CommandResult, type CommandSpec, type Runner } from "../server/deploy/process";

const root = path.resolve(__dirname, "../..");
const success = (value: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "studio-observer-"));
  const config = path.join(directory, "config");
  writeFileSync(config, "[profile dev]\nregion = us-east-1\n[profile prod]\nregion = us-west-2\n");
  const env = { AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: path.join(directory, "credentials") };
  const requests: { spec: CommandSpec; resolve: (value: CommandResult) => void; reject: (error: Error) => void }[] = [];
  const run: Runner = spec => new Promise((resolve, reject) => requests.push({ spec, resolve, reject }));
  const observer = new AwsObserver(new Tools(root, env), run, env);
  t.after(() => { observer.dispose(); rmSync(directory, { recursive: true, force: true }); });
  return { observer, requests, config };
}

test("normal and forced reads share pending work even after the completed-cache TTL would have elapsed", async t => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const { observer, requests } = fixture(t);
  const initial = observer.status("dev", "fixture-dev", undefined);
  now += 30_000;
  assert.equal(observer.status("dev", "fixture-dev", undefined), initial);
  assert.equal(observer.status("dev", "fixture-dev", undefined, true), initial);
  assert.equal(requests.length, 1);
  requests[0]!.resolve(success({ version: 1 }));
  await initial;
  now += 3_999;
  assert.equal(observer.status("dev", "fixture-dev", undefined), initial, "freshness starts when the read completes");
  now++;
  const expired = observer.status("dev", "fixture-dev", undefined);
  assert.equal(requests.length, 2);
  requests[1]!.resolve(success({ version: 2 }));
  await expired;
  const forced = observer.status("dev", "fixture-dev", undefined, true);
  assert.equal(requests.length, 3, "force bypasses a completed observation");
  assert.equal(observer.status("dev", "fixture-dev", undefined, true), forced);
  requests[2]!.resolve(success({ version: 3 }));
  await forced;
});

test("profile invalidation separates pending generations and a late result cannot replace newer evidence", async t => {
  const { observer, requests } = fixture(t);
  const old = observer.status("dev", "fixture-dev", "us-east-1");
  const other = observer.status("prod", "fixture-prod", "us-west-2");
  observer.invalidate("dev");
  const current = observer.status("dev", "fixture-dev", "us-east-1");
  assert.equal(requests.length, 3);
  assert.equal(observer.status("prod", "fixture-prod", "us-west-2", true), other);
  requests[2]!.resolve(success({ version: "current" }));
  await current;
  requests[0]!.resolve(success({ version: "old" }));
  assert.deepEqual(await old, { ok: true, value: { version: "old" } }, "the original caller retains its original evidence");
  assert.equal(observer.status("dev", "fixture-dev", "us-east-1"), current);
  requests[1]!.resolve(success({ version: "other" }));
  await other;
  observer.invalidate();
  const refreshed = observer.status("prod", "fixture-prod", "us-west-2");
  assert.equal(requests.length, 4);
  requests[3]!.resolve(success({ version: "refreshed" }));
  await refreshed;
});

test("profile, deployment, region and AWS file revisions identify independent observations", async t => {
  const { observer, requests, config } = fixture(t);
  const observations = [
    observer.status("dev", "fixture-dev", "us-east-1"),
    observer.status("prod", "fixture-dev", "us-east-1"),
    observer.status("dev", "fixture-prod", "us-east-1"),
    observer.status("dev", "fixture-dev", "us-west-2"),
    observer.discover("dev", "us-east-1"),
  ];
  assert.equal(requests.length, 5);
  writeFileSync(config, "[profile dev]\nregion = eu-west-1\n");
  observations.push(observer.status("dev", "fixture-dev", "us-east-1"));
  assert.equal(requests.length, 6);
  assert.ok(requests[3]!.spec.args.includes("us-west-2"));
  for (const request of requests) request.resolve(success({ observed: true }));
  await Promise.all(observations);
});

test("classified and rejected reads are retryable without remembering failure or removing a newer generation", async t => {
  const { observer, requests } = fixture(t);
  const failed = observer.discover("dev", undefined);
  requests[0]!.resolve({ code: 1, stdout: JSON.stringify({ error: { kind: "expired", message: "Sign in required." } }), stderr: "" });
  assert.deepEqual(await failed, { ok: false, problem: { kind: "expired", message: "Sign in required." } });
  const rejected = observer.discover("dev", undefined);
  assert.equal(requests.length, 2);
  observer.invalidate("dev");
  const recovered = observer.discover("dev", undefined);
  requests[2]!.resolve(success({ recovered: true }));
  await recovered;
  requests[1]!.reject(new Error("Read interrupted."));
  await assert.rejects(rejected, /Read interrupted/);
  assert.equal(observer.discover("dev", undefined), recovered);
  observer.invalidate("dev");
  const retry = observer.discover("dev", undefined);
  requests[3]!.reject(new Error("Transport failed."));
  await assert.rejects(retry, /Transport failed/);
  const afterRejection = observer.discover("dev", undefined);
  assert.equal(requests.length, 5);
  requests[4]!.resolve(success({ recovered: true }));
  await afterRejection;
});

test("explicit teardown reviews remain independent even when requested in the same millisecond", async t => {
  t.mock.method(Date, "now", () => 1_000);
  const { observer, requests } = fixture(t);
  const first = observer.teardown("dev", "fixture-dev", "dev", undefined);
  const second = observer.teardown("dev", "fixture-dev", "dev", undefined);
  assert.equal(requests.length, 2);
  requests[0]!.resolve(success({ review: "first" }));
  requests[1]!.resolve(success({ review: "second" }));
  await Promise.all([first, second]);
});
