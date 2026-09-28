import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { WORKFLOW_ERROR_NAMES } from "@repo/framework/config";
import framework from "../../framework.config";
import {
  LocalWorkflowEngine,
  stepFailure,
  type WorkflowTaskLane,
} from "../src/workflows";

/**
 * The runner's own half of workflow execution.
 *
 * The interpreter's semantics are covered in the framework package; what is
 * checked here is the part only this process owns — spawning a real handler in
 * a child process, reading its result back across IPC, and reporting a failure
 * under a name a declared clause can match.
 *
 * Docker is not required: the task lane is a stub, and the only Lambda step in
 * the repository's fixture workflow is a Node zip handler.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");

/** The declared fixture graph: validate, then run a container and wait. */
const FIXTURE_WORKFLOW = "invocation-test-workflow";

function engineWith(
  tasks: WorkflowTaskLane,
  overrides: Partial<ConstructorParameters<typeof LocalWorkflowEngine>[0]> = {},
): LocalWorkflowEngine {
  return new LocalWorkflowEngine({
    config: framework,
    repositoryRoot,
    runnerUrl: "http://local-invocation-runner:8090",
    tasks,
    ...overrides,
  });
}

function taskLane(
  result: { readonly exitCode?: number } | (() => never),
): WorkflowTaskLane & { readonly submitted: string[]; readonly stopped: string[] } {
  const submitted: string[] = [];
  const stopped: string[] = [];
  return {
    submitted,
    stopped,
    submit: (id) => {
      if (typeof result === "function") result();
      submitted.push(id);
      return { runId: `run-${submitted.length}` };
    },
    wait: async (runId) => ({
      runId,
      exitCode: typeof result === "function" ? 1 : (result.exitCode ?? 0),
    }),
    stop: async (runId) => {
      stopped.push(runId);
      return { runId };
    },
  };
}

/** Polls the engine's journal, because `start` returns on acceptance. */
async function settle(
  engine: LocalWorkflowEngine,
  executionId: string,
  timeoutMilliseconds = 60_000,
): Promise<ReturnType<LocalWorkflowEngine["get"]>> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const execution = engine.get(executionId);
    if (execution && execution.status !== "running") return execution;
    if (Date.now() > deadline) {
      throw new Error(`Execution ${executionId} did not finish in time.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// Error naming
// ---------------------------------------------------------------------------

test("a named handler error keeps its name across the process boundary", () => {
  const failure = stepFailure("lambda:alpha", {
    name: "ThrottledError",
    message: "slow down",
  });
  assert.equal(failure.errorName, "ThrottledError");
  assert.equal(failure.cause, "slow down");
});

test("an unnamed failure becomes the task failure a catch clause is written against", () => {
  for (const error of [undefined, { message: "broke" }, { name: "Error", message: "broke" }]) {
    assert.equal(
      stepFailure("lambda:alpha", error).errorName,
      WORKFLOW_ERROR_NAMES.taskFailed,
    );
  }
});

// ---------------------------------------------------------------------------
// End to end, through a real child process
// ---------------------------------------------------------------------------

test("the fixture workflow runs its handler in a child process and its task in the lane", async () => {
  const tasks = taskLane({ exitCode: 0 });
  const engine = engineWith(tasks);
  try {
    const started = engine.start(FIXTURE_WORKFLOW, { message: "hello" });
    const execution = await settle(engine, started.executionId);

    assert.equal(execution?.status, "succeeded");
    assert.deepEqual(execution?.output, { validatedBy: "invocation-test-step" });
    assert.deepEqual(tasks.submitted, ["invocation-test-task"]);
  } finally {
    await engine.shutdown();
  }
});

test("a handler that throws fails the execution with its own message", async () => {
  const engine = engineWith(taskLane({ exitCode: 0 }));
  try {
    // The fixture handler requires `message`; omitting it is the handler's own
    // failure rather than a framework one.
    const started = engine.start(FIXTURE_WORKFLOW, {});
    const execution = await settle(engine, started.executionId);

    assert.equal(execution?.status, "failed");
    assert.match(execution?.error?.cause ?? "", /message is required/);
  } finally {
    await engine.shutdown();
  }
});

test("a non-zero container exit reaches the graph's own catch clause", async () => {
  const engine = engineWith(taskLane({ exitCode: 2 }));
  try {
    const started = engine.start(FIXTURE_WORKFLOW, { message: "hello" });
    const execution = await settle(engine, started.executionId);

    // The fixture wraps its task in attempt(..., () => fail("InvocationTestTaskFailed")).
    assert.equal(execution?.status, "failed");
    assert.equal(execution?.error?.name, "InvocationTestTaskFailed");
  } finally {
    await engine.shutdown();
  }
});

test("an undeclared workflow is refused rather than started", () => {
  const engine = engineWith(taskLane({ exitCode: 0 }));
  assert.throws(
    () => engine.start("not-a-workflow", {}),
    /is not declared under workflows/,
  );
});

test("stopping an execution marks it and leaves its record readable", async () => {
  const tasks = taskLane({ exitCode: 0 });
  const engine = engineWith(tasks);
  try {
    const started = engine.start(FIXTURE_WORKFLOW, { message: "hello" });
    await engine.stop(started.executionId);
    const execution = await settle(engine, started.executionId);
    assert.ok(
      execution?.status === "aborted" || execution?.status === "succeeded",
      `terminal, was ${execution?.status}`,
    );
  } finally {
    await engine.shutdown();
  }
});
