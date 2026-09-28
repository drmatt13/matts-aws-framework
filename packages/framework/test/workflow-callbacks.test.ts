import assert from "node:assert/strict";
import test from "node:test";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import {
  attempt,
  defineResources,
  resource,
  compileWorkflowToAsl,
  completesCallback,
  dynamodb,
  normalizeWorkflow,
  retry,
  runTask,
  sequence,
  sqs,
  succeed,
  WORKFLOW_ERROR_NAMES,
  workflow,
  type AslResolver,
  type WorkflowDefinition,
} from "@repo/framework/config";
import {
  CallbackCompletionError,
  LocalCallbackBroker,
  newExecution,
  redactCallbackHandles,
  runWorkflow,
  type WorkflowStepRunner,
} from "@repo/framework/local";
import {
  CALLBACK_HANDLE_VERSION,
  completeCallback,
  failCallback,
  heartbeatCallback,
  isCallbackHandle,
  parseCallbackRequest,
  taskCallback,
  TASK_CALLBACK_ENVIRONMENT,
  type CallbackHandle,
} from "@repo/framework/runtime/callbacks";

/**
 * Callbacks: what the compiled graph asks for, and what the local broker
 * actually guarantees.
 *
 * The interesting cases are all about *time* — a worker that answers twice, one
 * that answers the attempt that was replaced, one that goes quiet, one that
 * answers a runner which has since restarted. Each of those is a way an
 * execution could be resumed when it should not be.
 */

interface ApprovalRequest {
  readonly orderId: string;
}
interface ApprovalResult {
  readonly approved: boolean;
}

const catalog = defineResources({
  approvals: resource.cdk<IQueue>(),
  orders: resource.cdk<ITable>(),
});
const approvals = catalog.approvals;

const resolver: AslResolver = {
  lambdaArn: (id) => `arn:aws:lambda:eu-west-2:111122223333:function:${id}`,
  integrationTarget: () => ({
    target: "https://sqs.eu-west-2.amazonaws.com/111122223333/approvals",
  }),
  taskLaunch: () => ({
    cluster: "arn:aws:ecs:eu-west-2:111122223333:cluster/app",
    taskDefinitionArn: "arn:aws:ecs:eu-west-2:111122223333:task-definition/worker:7",
    containerName: "worker",
    platformVersion: "1.4.0",
    subnets: ["subnet-1"],
    securityGroups: ["sg-1"],
    assignPublicIp: false,
  }),
};

type Json = Record<string, unknown>;

function statesOf(definition: WorkflowDefinition): Json {
  return compileWorkflowToAsl(
    normalizeWorkflow("example", definition, 'workflows["example"]'),
    resolver,
  ).States as Json;
}

function onlyTask(states: Json): Json {
  const tasks = Object.values(states).filter((state) => (state as Json).Type === "Task");
  assert.equal(tasks.length, 1);
  return tasks[0] as Json;
}

// ---------------------------------------------------------------------------
// The compiled graph
// ---------------------------------------------------------------------------

test("a request compiles to the callback integration with its deadline", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        sqs.request(approvals, { orderId: input.orderId }, {
          timeoutSeconds: 3600,
          heartbeatSeconds: 300,
        }),
      { timeoutSeconds: 7200 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::sqs:sendMessage.waitForTaskToken");
  assert.equal(state.TimeoutSeconds, 3600);
  assert.equal(state.HeartbeatSeconds, 300);
});

test("a request sends the worker a payload and a handle, and no URL", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 60 }),
      { timeoutSeconds: 120 }),
    ),
  );
  const body = (state.Arguments as Json).MessageBody as string;
  assert.match(body, /"payload":/);
  assert.match(body, /"callback":/);
  assert.match(body, /"token": \$states\.context\.Task\.Token/);
  assert.match(body, /"delivery": "aws"/);
  assert.doesNotMatch(body, /http/);
});

test("the request's result is the worker's answer, not an acknowledgment", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 60 }),
      { timeoutSeconds: 120 }),
    ),
  );
  assert.equal(state.Output, "{% $states.result %}");
});

test("a callback task compiles to the waiting ECS integration and carries its handle", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        runTask<{ pages: number }>("worker", {
          payload: { orderId: input.orderId },
          completion: "callback",
          timeoutSeconds: 600,
        }),
      { timeoutSeconds: 1200 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::ecs:runTask.waitForTaskToken");
  const overrides = (state.Arguments as Json).Overrides as Json;
  const containers = overrides.ContainerOverrides as readonly Json[];
  const names = ((containers[0] as Json).Environment as readonly Json[]).map(
    (variable) => variable.Name,
  );
  assert.deepEqual(names, ["FRAMEWORK_TASK_INPUT", "FRAMEWORK_TASK_CALLBACK"]);
  // The step's result is the container's, not the ECS task metadata.
  assert.equal(state.Output, "{% $states.result %}");
});

test("an ordinary runTask still waits for the process and answers with the summary", () => {
  const state = onlyTask(
    statesOf(workflow(() => runTask("worker"), { timeoutSeconds: 600 })),
  );
  assert.equal(state.Resource, "arn:aws:states:::ecs:runTask.sync");
  assert.match(JSON.stringify(state.Output), /exitCode/);
});

test("a callback step needs a deadline", () => {
  assert.throws(
    () =>
      workflow<{ orderId: string }>(
        ({ input }) =>
          sqs.request(approvals, { orderId: input.orderId }, {} as never),
        { timeoutSeconds: 120 },
      ),
    /timeoutSeconds must be a positive integer/,
  );
  assert.throws(
    () =>
      workflow(
        () => runTask<unknown>("worker", { completion: "callback" } as never),
        { timeoutSeconds: 120 },
      ),
    /needs timeoutSeconds/,
  );
});

test("a heartbeat interval beyond the deadline is refused", () => {
  assert.throws(
    () =>
      workflow<{ orderId: string }>(
        ({ input }) =>
          sqs.request(approvals, { orderId: input.orderId }, {
            timeoutSeconds: 60,
            heartbeatSeconds: 60,
          }),
        { timeoutSeconds: 120 },
      ),
    /never fires before it/,
  );
});

test("express execution cannot wait for a callback", () => {
  assert.throws(
    () =>
      normalizeWorkflow(
        "example",
        workflow<{ orderId: string }>(
          ({ input }) =>
            sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 60 }),
          { timeoutSeconds: 120, type: "express" },
        ),
        'workflows["example"]',
      ),
    /standard-workflow pattern/,
  );
});

test("a worker declares which callbacks it answers", () => {
  assert.deepEqual(completesCallback(approvals), {
    capability: "completesCallback",
    integration: "queue:approvals",
  });
  assert.throws(
    () => completesCallback({ kind: "queue" } as never),
    /takes the catalog queue/,
  );
});

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

const handle: CallbackHandle = {
  version: CALLBACK_HANDLE_VERSION,
  delivery: "local",
  token: "wf-test-token",
};

test("a handle from an unknown version is not accepted", () => {
  assert.equal(isCallbackHandle(handle), true);
  assert.equal(isCallbackHandle({ ...handle, version: 99 }), false);
  assert.equal(isCallbackHandle({ ...handle, token: "" }), false);
  assert.equal(isCallbackHandle({ ...handle, delivery: "elsewhere" }), false);
});

test("a message is read as payload and handle, and a missing handle is named", () => {
  const request = parseCallbackRequest<ApprovalRequest>({
    payload: { orderId: "A-1" },
    callback: handle,
  });
  assert.deepEqual(request.payload, { orderId: "A-1" });
  assert.equal(request.callback.token, "wf-test-token");
  assert.throws(
    () => parseCallbackRequest({ payload: {} }),
    /callback handle the framework sent/,
  );
});

test("a container reads its own handle, and says so when it has none", () => {
  assert.deepEqual(
    taskCallback({ [TASK_CALLBACK_ENVIRONMENT]: JSON.stringify(handle) }),
    handle,
  );
  assert.throws(() => taskCallback({}), /not started in callback mode/);
});

test("a local completion is posted to the runner the environment names", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) as unknown });
    return { ok: true, status: 202, text: async () => "" } as Response;
  }) as typeof globalThis.fetch;
  try {
    const environment = { LOCAL_INVOCATION_RUNNER_URL: "http://runner:8090/" };
    await completeCallback(handle, { approved: true }, environment);
    await failCallback(handle, { error: "Rejected", cause: "no" }, environment);
    await heartbeatCallback(handle, environment);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://runner:8090/callbacks/wf-test-token/succeeded",
      "http://runner:8090/callbacks/wf-test-token/failed",
      "http://runner:8090/callbacks/wf-test-token/heartbeat",
    ],
  );
  assert.deepEqual(calls[0]?.body, { result: { approved: true } });
  assert.deepEqual(calls[1]?.body, { error: { error: "Rejected", cause: "no" } });
});

test("a worker with neither a runner nor a replay bucket says what is missing", async () => {
  await assert.rejects(
    completeCallback(handle, {}, {}),
    /LOCAL_INVOCATION_RUNNER_URL nor DEV_LAMBDA_REPLAY_BUCKET_NAME/,
  );
});

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

function dispatchCapturing(
  captured: CallbackHandle[],
): (handle: CallbackHandle) => Promise<void> {
  return async (given) => {
    captured.push(given);
  };
}

test("a callback is registered before the work is dispatched", async () => {
  const broker = new LocalCallbackBroker();
  let registeredDuringDispatch = false;

  const answer = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      dispatch: async (given) => {
        // A worker this fast is the race the ordering exists to close.
        registeredDuringDispatch = broker.has(given.token);
        broker.succeed(given.token, { approved: true });
      },
    },
    { signal: new AbortController().signal },
  );

  assert.deepEqual(await answer, { approved: true });
  assert.equal(registeredDuringDispatch, true);
});

test("the first terminal completion wins and a duplicate is told so", async () => {
  const broker = new LocalCallbackBroker();
  const captured: CallbackHandle[] = [];
  const answer = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      dispatch: dispatchCapturing(captured),
    },
    { signal: new AbortController().signal },
  );

  const token = (captured[0] as CallbackHandle).token;
  broker.succeed(token, { approved: true });
  assert.deepEqual(await answer, { approved: true });

  assert.throws(
    () => broker.succeed(token, { approved: false }),
    (error: CallbackCompletionError) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /already been completed/);
      return true;
    },
  );
});

test("a token from a replaced attempt no longer resumes anything", async () => {
  const broker = new LocalCallbackBroker();
  const first: CallbackHandle[] = [];
  const second: CallbackHandle[] = [];

  const firstAttempt = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      dispatch: dispatchCapturing(first),
    },
    { signal: new AbortController().signal },
  );
  firstAttempt.catch(() => undefined);

  const secondAttempt = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      dispatch: dispatchCapturing(second),
    },
    { signal: new AbortController().signal },
  );

  await assert.rejects(firstAttempt, /retried/);
  const stale = (first[0] as CallbackHandle).token;
  const current = (second[0] as CallbackHandle).token;
  assert.notEqual(stale, current);
  assert.throws(() => broker.succeed(stale, {}), CallbackCompletionError);

  broker.succeed(current, { approved: true });
  assert.deepEqual(await secondAttempt, { approved: true });
});

test("a completion for a callback nobody is holding is gone, not retryable", () => {
  const broker = new LocalCallbackBroker();
  assert.throws(
    () => broker.succeed("wf-never-existed", {}),
    (error: CallbackCompletionError) => {
      assert.equal(error.status, 410);
      return true;
    },
  );
});

test("a worker that goes quiet fails the step on its heartbeat", async () => {
  const broker = new LocalCallbackBroker();
  const captured: CallbackHandle[] = [];
  const answer = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      heartbeatSeconds: 0.05 as unknown as number,
      dispatch: dispatchCapturing(captured),
    },
    { signal: new AbortController().signal },
  );
  await assert.rejects(answer, (error: { errorName?: string }) => {
    assert.equal(error.errorName, WORKFLOW_ERROR_NAMES.heartbeatTimeout);
    return true;
  });
});

test("a heartbeat keeps the step alive without extending its deadline", async () => {
  const broker = new LocalCallbackBroker();
  const captured: CallbackHandle[] = [];
  const answer = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      heartbeatSeconds: 0.12 as unknown as number,
      dispatch: dispatchCapturing(captured),
    },
    { signal: new AbortController().signal },
  );
  const token = (captured[0] as CallbackHandle).token;
  for (let beat = 0; beat < 3; beat += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    broker.heartbeat(token);
  }
  broker.succeed(token, { approved: true });
  assert.deepEqual(await answer, { approved: true });
});

test("restarting the runner invalidates every pending callback", async () => {
  const broker = new LocalCallbackBroker();
  const captured: CallbackHandle[] = [];
  const answer = broker.await(
    {
      stepKey: "exec:1",
      state: "AwaitSendMessage_1",
      timeoutSeconds: 60,
      dispatch: dispatchCapturing(captured),
    },
    { signal: new AbortController().signal },
  );
  broker.shutdown();
  await assert.rejects(answer, /not durable/);
  assert.throws(
    () => broker.succeed((captured[0] as CallbackHandle).token, {}),
    CallbackCompletionError,
  );
});

test("a dispatch that fails fails the step, with nothing left waiting", async () => {
  const broker = new LocalCallbackBroker();
  await assert.rejects(
    broker.await(
      {
        stepKey: "exec:1",
        state: "AwaitSendMessage_1",
        timeoutSeconds: 60,
        dispatch: async () => {
          throw new Error("the queue refused the message");
        },
      },
      { signal: new AbortController().signal },
    ),
    /queue refused/,
  );
});

// ---------------------------------------------------------------------------
// Running a graph that waits
// ---------------------------------------------------------------------------

function runnerWith(
  broker: LocalCallbackBroker,
  onDispatch: (request: { operation: string; arguments: Json }) => void,
): WorkflowStepRunner {
  return {
    invokeLambda: async () => null,
    runTask: async () => ({ runId: "run", exitCode: 0 }),
    callIntegration: async (request) => {
      onDispatch({ operation: request.operation, arguments: request.arguments as Json });
      return null;
    },
    awaitCallback: (request, options) => broker.await(request, options),
  };
}

test("a graph suspends on a request and resumes with the worker's answer", async () => {
  const broker = new LocalCallbackBroker();
  const dispatched: Json[] = [];
  const definition = workflow<{ orderId: string }>(({ input }) => {
    const approval = sqs.request(approvals, { orderId: input.orderId }, {
      timeoutSeconds: 60,
    });
    return sequence(approval, succeed(approval.output));
  }, { timeoutSeconds: 120 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const pending = runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: runnerWith(broker, (request) => dispatched.push(request.arguments)),
  });

  // The dispatch carries `{ message, callback }`; the worker answers the token.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sentHandle = dispatched[0]?.callback as CallbackHandle;
  assert.ok(isCallbackHandle(sentHandle), "the worker was sent a handle");
  broker.succeed(sentHandle.token, { approved: true });

  const execution = await pending;
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { approved: true });
});

test("a worker's failure reaches the graph's catch clause under its own name", async () => {
  const broker = new LocalCallbackBroker();
  const dispatched: Json[] = [];
  const definition = workflow<{ orderId: string }>(({ input }) =>
    attempt(
      sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 60 }),
      (error) => succeed({ caught: error.error }),
      { on: ["Rejected"] },
    ),
  { timeoutSeconds: 120 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const pending = runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: runnerWith(broker, (request) => dispatched.push(request.arguments)),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  broker.fail((dispatched[0]?.callback as CallbackHandle).token, {
    error: "Rejected",
    cause: "the approver said no",
  });

  const execution = await pending;
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { caught: "Rejected" });
});

test("a retried request gets a fresh token and the stale one is refused", async () => {
  const broker = new LocalCallbackBroker();
  const dispatched: Json[] = [];
  const definition = workflow<{ orderId: string }>(({ input }) =>
    retry(
      sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 60 }),
      { retries: 1, on: ["Rejected"], intervalSeconds: 0 },
    ),
  { timeoutSeconds: 120 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const pending = runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: runnerWith(broker, (request) => dispatched.push(request.arguments)),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = (dispatched[0]?.callback as CallbackHandle).token;
  broker.fail(first, { error: "Rejected" });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = (dispatched[1]?.callback as CallbackHandle).token;
  assert.notEqual(first, second);
  assert.throws(() => broker.succeed(first, {}), CallbackCompletionError);
  broker.succeed(second, { approved: true });

  const execution = await pending;
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { approved: true });
});

test("a step nobody answers ends when its deadline does", async () => {
  const broker = new LocalCallbackBroker();
  const definition = workflow<{ orderId: string }>(({ input }) =>
    sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 1 }),
  { timeoutSeconds: 300 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: runnerWith(broker, () => undefined),
  });

  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.timeout);
});

test("a graph that waits is refused by a runner that cannot hold a callback", async () => {
  const definition = workflow<{ orderId: string }>(({ input }) =>
    sqs.request(approvals, { orderId: input.orderId }, { timeoutSeconds: 60 }),
  { timeoutSeconds: 120 });
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: {
      invokeLambda: async () => null,
      runTask: async () => ({ runId: "run", exitCode: 0 }),
      callIntegration: async () => null,
    },
  });
  assert.equal(execution.status, "failed");
  assert.match(execution.error?.cause ?? "", /cannot hold/);
});

test("a container in callback mode is launched, and its result is the step's", async () => {
  const broker = new LocalCallbackBroker();
  const launched: { id: string; callback: CallbackHandle }[] = [];
  const definition = workflow<{ orderId: string }>(({ input }) =>
    runTask<{ pages: number }>("worker", {
      payload: { orderId: input.orderId },
      completion: "callback",
      timeoutSeconds: 60,
    }),
  { timeoutSeconds: 120 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const pending = runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: {
      invokeLambda: async () => null,
      runTask: async () => {
        throw new Error("a callback task is not launched through the waiting lane");
      },
      awaitCallback: (request, options) => broker.await(request, options),
      startTaskWithCallback: async (id, _input, callback) => {
        launched.push({ id, callback: callback as CallbackHandle });
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(launched[0]?.id, "worker");
  broker.succeed((launched[0] as { callback: CallbackHandle }).callback.token, {
    pages: 12,
  });

  const execution = await pending;
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { pages: 12 });
});

test("a token never reaches anything a developer is shown", () => {
  const history = {
    executionId: "local-example-1",
    output: { approved: true },
    steps: [
      { state: "AwaitSendMessage_1", arguments: { message: {}, callback: handle } },
      { nested: [{ deep: { callback: { ...handle, token: "wf-another" } } }] },
    ],
  };
  const redacted = redactCallbackHandles(history);
  const serialized = JSON.stringify(redacted);

  assert.ok(!serialized.includes("wf-test-token"));
  assert.ok(!serialized.includes("wf-another"));
  assert.equal(serialized.split("[redacted]").length - 1, 2);
  // Everything else survives: this is a redaction, not a summary.
  assert.equal(redacted.executionId, "local-example-1");
  assert.deepEqual(redacted.output, { approved: true });
  assert.equal(redacted.steps[0]?.arguments?.callback.delivery, "local");
});

test("a callback step must be given a catalog resource", () => {
  // The kind now comes from the operation, so a table passed to sqs.request is
  // a compile error rather than a runtime one: the construct types differ.
  // @ts-expect-error - a table is not a queue
  () => sqs.request(catalog.orders, {} as never, { timeoutSeconds: 60 });

  // What remains checkable at runtime is that it is a catalog resource at all.
  assert.throws(
    () =>
      workflow(
        () => sqs.request({ kind: "queue", id: "approvals" } as never, {} as never, { timeoutSeconds: 60 }),
        { timeoutSeconds: 120 },
      ),
    /takes a catalog resource/,
  );
});
