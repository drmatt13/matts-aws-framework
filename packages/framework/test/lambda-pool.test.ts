import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { findRepositoryRoot } from "@repo/framework/config/source";
import { LambdaWorkerPool } from "../src/local/lambda-process";

const repositoryRoot = findRepositoryRoot(__dirname);
const directory = mkdtempSync(path.join(tmpdir(), "framework-pool-"));
after(() => rmSync(directory, { recursive: true, force: true }));

// Module-level state is the point: a warm process keeps it, a cold one does not.
const handlerFile = path.join(directory, "handler.mjs");
writeFileSync(
  handlerFile,
  `import { writeFileSync } from "node:fs";
let invocations = 0;
export async function lambdaHandler(event, context) {
  invocations += 1;
  if (event.started) writeFileSync(event.started, String(process.pid));
  if (event.fail) throw new Error("handler failed on purpose");
  if (event.sleepMs) await new Promise((resolve) => setTimeout(resolve, event.sleepMs));
  return {
    pid: process.pid,
    invocations,
    marker: process.env.MARKER,
    requestId: context.awsRequestId,
    remaining: context.getRemainingTimeInMillis(),
    memory: context.memoryLimitInMB,
  };
}
`,
);

type Result = {
  pid: number;
  invocations: number;
  marker: string;
  requestId: string;
  remaining: number;
  memory: string;
};

const environment = (marker: string) => ({
  PATH: process.env.PATH ?? "",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  MARKER: marker,
});

const request = (event: Record<string, unknown> = {}, timeoutSeconds = 10) => ({
  entry: pathToFileURL(handlerFile).href,
  handler: "lambdaHandler",
  event,
  lambda: { functionName: "pool-test", memoryLimitInMB: 256, timeoutSeconds },
});

test("a warm process keeps module state and gets a real context", async () => {
  const pool = new LambdaWorkerPool({ repositoryRoot, maxWarm: 2, idleSeconds: 30 });
  try {
    const first = (await pool.invoke("lambda:a", environment("one"), request())) as Result;
    const second = (await pool.invoke("lambda:a", environment("one"), {
      ...request(),
      context: { awsRequestId: "pinned-request" },
    })) as Result;
    assert.equal(second.pid, first.pid);
    assert.equal(second.invocations, 2);
    assert.equal(second.requestId, "pinned-request");
    assert.equal(second.memory, "256");
    assert.ok(second.remaining > 0 && second.remaining <= 10_000);
    assert.equal(pool.size, 1);
  } finally {
    pool.close();
  }
});

test("a changed environment or a busy process starts a fresh one", async () => {
  const pool = new LambdaWorkerPool({ repositoryRoot, maxWarm: 2, idleSeconds: 30 });
  try {
    const warm = (await pool.invoke("lambda:a", environment("one"), request())) as Result;
    const changed = (await pool.invoke("lambda:a", environment("two"), request())) as Result;
    assert.notEqual(changed.pid, warm.pid);
    assert.equal(changed.marker, "two");
    assert.equal(changed.invocations, 1);

    const [slow, concurrent] = (await Promise.all([
      pool.invoke("lambda:a", environment("two"), request({ sleepMs: 300 })),
      new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        pool.invoke("lambda:a", environment("two"), request()),
      ),
    ])) as Result[];
    assert.equal(slow.pid, changed.pid);
    assert.notEqual(concurrent.pid, changed.pid);
    assert.equal(concurrent.invocations, 1);
    assert.equal(pool.size, 1);
  } finally {
    pool.close();
  }
});

test("the pool never grows past its limit", async () => {
  const pool = new LambdaWorkerPool({ repositoryRoot, maxWarm: 1, idleSeconds: 30 });
  try {
    await pool.invoke("lambda:a", environment("one"), request());
    await pool.invoke("lambda:b", environment("one"), request());
    assert.equal(pool.size, 1);
  } finally {
    pool.close();
  }
  assert.equal(pool.size, 0);
});

test("a handler error keeps its own stack; a timeout retires the process", async () => {
  const pool = new LambdaWorkerPool({ repositoryRoot, maxWarm: 2, idleSeconds: 30 });
  try {
    const before = (await pool.invoke("lambda:a", environment("one"), request())) as Result;
    await assert.rejects(pool.invoke("lambda:a", environment("one"), request({ fail: true })), (error: Error) => {
      assert.equal(error.message, "handler failed on purpose");
      assert.match(error.stack ?? "", /handler\.mjs/);
      return true;
    });
    // A thrown error does not reset the environment, as in Lambda.
    const afterError = (await pool.invoke("lambda:a", environment("one"), request())) as Result;
    assert.equal(afterError.pid, before.pid);

    await assert.rejects(
      pool.invoke("lambda:a", environment("one"), request({ sleepMs: 3_000 }, 1)),
      /exceeded its 1-second timeout/,
    );
    const afterTimeout = (await pool.invoke("lambda:a", environment("one"), request())) as Result;
    assert.notEqual(afterTimeout.pid, before.pid);
    assert.equal(afterTimeout.invocations, 1);
  } finally {
    pool.close();
  }
});

test("LOCAL_LAMBDA_WARM=false turns the pool off, and bad limits are refused", () => {
  assert.equal(LambdaWorkerPool.fromEnvironment(repositoryRoot, { LOCAL_LAMBDA_WARM: "false" }), undefined);
  assert.ok(LambdaWorkerPool.fromEnvironment(repositoryRoot, {}));
  assert.throws(
    () => LambdaWorkerPool.fromEnvironment(repositoryRoot, { LOCAL_LAMBDA_WARM_MAX: "0" }),
    /LOCAL_LAMBDA_WARM_MAX must be a whole number/,
  );
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "worker reached its expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("closing the pool cancels both warm and overflow invocations and refuses new work", async () => {
  const pool = new LambdaWorkerPool({ repositoryRoot, maxWarm: 1, idleSeconds: 30 });
  const warmMarker = path.join(directory, "close-warm");
  const coldMarker = path.join(directory, "close-overflow");
  const invocations: Promise<unknown>[] = [];
  try {
    const warm = pool.invoke("lambda:a", environment("one"), request({ started: warmMarker, sleepMs: 30_000 }, 60));
    invocations.push(warm);
    // Attach a rejection handler before close can reject either invocation.
    const warmStopped = assert.rejects(warm, /shutting down|closed|exited before/);
    await waitFor(() => existsSync(warmMarker));
    const overflow = pool.invoke("lambda:a", environment("one"), request({ started: coldMarker, sleepMs: 30_000 }, 60));
    invocations.push(overflow);
    const overflowStopped = assert.rejects(overflow, /shutting down|closed/);
    await waitFor(() => existsSync(coldMarker));
    const pids = [warmMarker, coldMarker].map((file) => Number(readFileSync(file, "utf8")));
    pool.close();
    pool.close();
    await Promise.all([warmStopped, overflowStopped]);
    await waitFor(() => pids.every((pid) => !running(pid)));
    assert.equal(pool.size, 0);
    await assert.rejects(pool.invoke("lambda:a", environment("one"), request()), /shutting down|closed/);
  } finally {
    pool.close();
    await Promise.allSettled(invocations);
  }
});

test("an already cancelled request never starts or replaces a handler", async () => {
  const pool = new LambdaWorkerPool({ repositoryRoot, maxWarm: 1, idleSeconds: 30 });
  const controller = new AbortController();
  controller.abort(new Error("cancelled before invocation"));
  const marker = path.join(directory, "cancelled-before-invocation");
  try {
    await assert.rejects(pool.invoke("lambda:a", environment("one"), request({ started: marker }), controller.signal), /cancelled before invocation/);
    assert.equal(pool.size, 0);
    assert.equal(existsSync(marker), false);
    const before = await pool.invoke("lambda:a", environment("one"), request()) as Result;
    // A different environment would ordinarily replace the current worker.
    await assert.rejects(pool.invoke("lambda:a", environment("two"), request({ started: marker }), controller.signal), /cancelled before invocation/);
    assert.equal(existsSync(marker), false);
    const after = await pool.invoke("lambda:a", environment("one"), request()) as Result;
    assert.equal(after.pid, before.pid);
  } finally { pool.close(); }
});
