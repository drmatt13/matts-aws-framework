import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import jsonata from "jsonata";
import {
  AGENT_STEP_MAX_SECONDS,
  AGENTCORE_INVOKE_RUNTIME_RESOURCE,
  attempt,
  compileWorkflowToAsl,
  defineFrameworkConfig,
  getWorkflowStepTargets,
  invokeAgent,
  invokeLambda,
  map,
  normalizeWorkflow,
  parallel,
  retry,
  sequence,
  startsWorkflow,
  workflow,
  WORKFLOW_ERROR_NAMES,
  WORKFLOW_PAYLOAD_CHARACTER_LIMIT,
  WorkflowStateError,
  type AslResolver,
  type Flow,
  type FrameworkConfigInput,
  type InvokeAgentStepOptions,
  type WorkflowCallableAgentIds,
  type WorkflowDefinition,
} from "../src/config/index";
import { invokeAgentStep, newExecution, runWorkflow, type LocalAgentInvoker, type WorkflowStepRunner } from "../src/local/index";
import { agentSessionId } from "../src/runtime/agentcore";
import { defaults } from "../../../framework-config/defaults";

/**
 * `invokeAgent` as a workflow step, in both lanes.
 *
 * The cloud lane is checked by evaluating the compiled JSONata, not by reading
 * it: the session id has to be the digest the agent's adapter recomputes, and
 * only evaluating the expression proves it is. The Step Functions functions it
 * uses are bound as AWS's TestState showed they behave: `$hash` answers
 * lowercase hex, and `Response` is a string — a mocked object is refused with
 * "Field 'Response' must be a string".
 */

// The generated agent union is this repository's agents; these fixtures are
// the test's own, so the step is called through its untyped shape.
const step = invokeAgent as unknown as <Out = unknown>(
  agent: string,
  input: unknown,
  options?: InvokeAgentStepOptions,
) => Flow<Out>;

const RUNTIME_ARN = "arn:aws:bedrock-agentcore:eu-west-2:111122223333:runtime/case_analysis-AbCdEf1234";

const resolver: AslResolver = {
  lambdaArn: (id) => `arn:aws:lambda:eu-west-2:111122223333:function:${id}`,
  agentArn: () => RUNTIME_ARN,
  taskLaunch: () => {
    throw new Error("no task in these fixtures");
  },
};

type Json = Record<string, unknown>;

function agentStates(definition: WorkflowDefinition): Json[] {
  const compiled = normalizeWorkflow("review", definition, 'workflows["review"]');
  const found: Json[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if ((value as Json).Resource === AGENTCORE_INVOKE_RUNTIME_RESOURCE) found.push(value as Json);
    for (const child of Object.values(value as Json)) walk(child);
  };
  walk(compileWorkflowToAsl(compiled, resolver));
  return found;
}

function agentState(definition: WorkflowDefinition): Json {
  const found = agentStates(definition);
  assert.equal(found.length, 1, "exactly one InvokeAgentRuntime state");
  return found[0];
}

/** Evaluates one `{% … %}` field as Step Functions does, with its extra functions. */
async function evaluate(field: unknown, bindings: Json): Promise<unknown> {
  const match = /^\{%([\s\S]*)%\}$/.exec(String(field));
  assert.ok(match, `${String(field)} is an expression`);
  const result = await jsonata(match[1] as string).evaluate({}, bindings);
  return JSON.parse(JSON.stringify(result)) as unknown;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const stepFunctions = (executionId: string, input: unknown, result?: unknown): Json => ({
  states: { context: { Execution: { Id: executionId, Input: input } }, ...(result === undefined ? {} : { result }) },
  hash: (value: string, algorithm: string) => {
    assert.equal(algorithm, "SHA-256");
    return sha256(value);
  },
  parse: (value: string) => JSON.parse(value) as unknown,
});

const EXECUTION = "arn:aws:states:eu-west-2:111122223333:execution:review:6b1d6a0e";

async function cloudRequest(state: Json, executionId = EXECUTION, input: unknown = {}) {
  const args = state.Arguments as Json;
  const bindings = stepFunctions(executionId, input);
  const body = JSON.parse((await evaluate(args.Payload, bindings)) as string) as { conversationId: string; input: unknown };
  return { args, body, sessionId: (await evaluate(args.RuntimeSessionId, bindings)) as string };
}

// ---------------------------------------------------------------------------
// The cloud lane
// ---------------------------------------------------------------------------

test("the cloud lane calls the Runtime through the SDK integration with the adapter's own request", async () => {
  const state = agentState(
    workflow<{ caseId: string }>(({ input }) => step("case-analysis", { caseId: input.caseId, depth: 2 }), {
      timeoutSeconds: 600,
    }),
  );
  const { args, body, sessionId } = await cloudRequest(state, EXECUTION, { caseId: "2024-CV-0012" });
  assert.equal(args.AgentRuntimeArn, RUNTIME_ARN);
  assert.equal(args.Qualifier, "DEFAULT");
  assert.equal(args.ContentType, "application/json");
  assert.equal(args.Accept, "application/json");
  assert.deepEqual(body.input, { caseId: "2024-CV-0012", depth: 2 });
  // The execution's default session: a digest of the execution and no key.
  assert.equal(body.conversationId, sha256(`${EXECUTION}\n`));
  // The session the adapter recomputes for a caller with no user — anything
  // else is refused with 403 before the agent runs.
  assert.equal(sessionId, agentSessionId("service", body.conversationId));
  assert.ok(sessionId.length >= 33 && /^[a-f0-9]+$/.test(sessionId), "inside Runtime's session id pattern");
});

test("sessions belong to one execution, and a named session is a second one within it", async () => {
  const definition = workflow<{ caseId: string }>(
    ({ input }) => sequence(step("case-analysis", { n: 1 }), step("case-analysis", { n: 2 }, { session: input.caseId })),
    { timeoutSeconds: 600 },
  );
  // Found by what they say, not by position: state order is the compiler's.
  const states = agentStates(definition);
  const named = states.find((state) => JSON.stringify(state.Arguments).includes("caseId"))!;
  const plain = states.find((state) => state !== named)!;
  const input = { caseId: "2024-CV-0012" };
  const first = await cloudRequest(plain, EXECUTION, input);
  const again = await cloudRequest(plain, EXECUTION, input);
  const other = await cloudRequest(plain, `${EXECUTION}-other`, input);
  const keyed = await cloudRequest(named, EXECUTION, input);
  assert.equal(first.sessionId, again.sessionId, "a retry or a later step lands in the same session");
  assert.notEqual(first.sessionId, other.sessionId, "another execution never shares it");
  assert.notEqual(first.sessionId, keyed.sessionId, "a named session is its own");
  assert.equal(keyed.body.conversationId, sha256(`${EXECUTION}\n2024-CV-0012`));
});

test("the result is the agent's result, read from Response as Step Functions models it", async () => {
  const state = agentState(workflow(() => step("case-analysis", { caseId: "x" }), { timeoutSeconds: 60 }));
  const answer = { result: { verdict: "settle", confidence: 0.8 } };
  const read = (Response: string) => evaluate(state.Output, stepFunctions(EXECUTION, {}, { Response, StatusCode: 200 }));
  assert.deepEqual(await read(JSON.stringify(answer)), answer.result);
  // A body that is not the adapter's document fails the state, which the local
  // lane reports as States.QueryEvaluationError too.
  await assert.rejects(read("event: status\ndata: {}\n\n"));
  assert.equal(await read(JSON.stringify({ error: "x" })).catch(() => undefined), undefined);
});

test("an agent step waits at most AgentCore's synchronous limit, which is also its default", () => {
  assert.equal(agentState(workflow(() => step("case-analysis", {}), { timeoutSeconds: 1200 })).TimeoutSeconds, AGENT_STEP_MAX_SECONDS);
  assert.equal(agentState(workflow(() => step("case-analysis", {}, { timeoutSeconds: 120 }), { timeoutSeconds: 600 })).TimeoutSeconds, 120);
  assert.throws(() => step("case-analysis", {}, { timeoutSeconds: 901 }), /AgentCore Runtime ends a synchronous request after 900 seconds/);
  assert.throws(() => step("case-analysis", {}, { timeoutSeconds: 0 }), /timeoutSeconds/);
});

// ---------------------------------------------------------------------------
// Sessions and concurrency
// ---------------------------------------------------------------------------

const review = (definition: WorkflowDefinition) => () => normalizeWorkflow("review", definition, 'workflows["review"]');

test("concurrent calls must name their sessions, so none race one session's provisioning", () => {
  assert.throws(
    review(workflow<{ ids: string[] }>(({ input }) => map(input.ids, ({ item }) => step("case-analysis", { id: item })), { timeoutSeconds: 600 })),
    /invokeAgent\("case-analysis"\) runs inside map\(\), whose items run concurrently/,
  );
  assert.throws(
    review(workflow(() => parallel({ a: step("case-analysis", { n: 1 }), b: step("case-analysis", { n: 2 }) }), { timeoutSeconds: 600 })),
    /invokeAgent\("case-analysis"\) runs in 2 branches of one parallel\(\)/,
  );
  // Named per item, one at a time, or different agents: nothing is shared concurrently.
  assert.doesNotThrow(
    review(workflow<{ ids: string[] }>(({ input }) => map(input.ids, ({ item }) => step("case-analysis", { id: item }, { session: item })), { timeoutSeconds: 600 })),
  );
  assert.doesNotThrow(
    review(workflow<{ ids: string[] }>(({ input }) => map(input.ids, ({ item }) => step("case-analysis", { id: item }), { maxConcurrency: 1 }), { timeoutSeconds: 600 })),
  );
  assert.doesNotThrow(
    review(workflow(() => parallel({ a: step("case-analysis", {}), b: step("summarizer", {}) }), { timeoutSeconds: 600 })),
  );
});

test("a session key is a value like any other: it cannot read what its scope cannot see", () => {
  assert.throws(
    review(
      workflow(() => {
        const hidden = invokeLambda<{ id: string }>("gamma");
        return sequence(
          parallel({ x: hidden, y: invokeLambda("delta") }),
          step("case-analysis", {}, { session: hidden.output.id }),
        );
      }, { timeoutSeconds: 600 }),
    ),
    /InvokeAgent_CaseAnalysis_\d+ uses the result of InvokeLambda_Gamma_\d+, which is produced inside Parallel_\d+ branch x/,
  );
});

// ---------------------------------------------------------------------------
// The local lane
// ---------------------------------------------------------------------------

async function runLocally(definition: WorkflowDefinition, invoke: NonNullable<WorkflowStepRunner["invokeAgent"]>, input: unknown = { caseId: "2024-CV-0012" }) {
  const compiled = normalizeWorkflow("review", definition, 'workflows["review"]');
  const lambdaInputs: unknown[] = [];
  const execution = newExecution("review", "#1");
  const finished = await runWorkflow(compiled, execution, {
    input,
    runner: {
      invokeLambda: async (_id, value) => {
        lambdaInputs.push(value);
        return { stored: true };
      },
      runTask: async () => ({ runId: "run", exitCode: 0 }),
      invokeAgent: invoke,
    },
  });
  return { finished, lambdaInputs, executionId: execution.executionId };
}

test("the local lane derives the same sessions, and a later step reads the agent's result", async () => {
  const calls: { conversationId: string; input: unknown }[] = [];
  const { finished, lambdaInputs, executionId } = await runLocally(
    workflow<{ caseId: string }>(
      ({ input }) => {
        const first = step<{ verdict: string }>("case-analysis", { caseId: input.caseId });
        const second = step("case-analysis", { caseId: input.caseId, followUp: true });
        const keyed = step("case-analysis", { caseId: input.caseId }, { session: input.caseId });
        const stored = invokeLambda("store-analysis", { payload: { analysis: first.output.verdict } });
        return sequence(first, second, keyed, stored);
      },
      { timeoutSeconds: 60 },
    ),
    async (_id, request) => {
      calls.push(request);
      return { verdict: "settle" };
    },
  );
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  assert.deepEqual(lambdaInputs, [{ analysis: "settle" }]);
  const shared = sha256(`${executionId}\n`);
  assert.deepEqual(calls.map((call) => call.conversationId), [shared, shared, sha256(`${executionId}\n2024-CV-0012`)]);

  const { executionId: otherExecution } = await runLocally(workflow(() => step("case-analysis", {}), { timeoutSeconds: 60 }), async (_id, request) => {
    calls.push(request);
    return {};
  });
  assert.notEqual(otherExecution, executionId);
  assert.notEqual(calls.at(-1)?.conversationId, shared, "another execution never shares a session");
});

test("a retry reuses the step's session, so it lands where the first attempt ran", async () => {
  const sessions: string[] = [];
  const { finished } = await runLocally(
    workflow(() => retry(step("case-analysis", {}), { retries: 2, intervalSeconds: 0, on: [WORKFLOW_ERROR_NAMES.agentFailed] }), { timeoutSeconds: 60 }),
    async (_id, request) => {
      sessions.push(request.conversationId);
      if (sessions.length < 3) throw new WorkflowStateError(WORKFLOW_ERROR_NAMES.agentFailed, "Received error (500) from runtime.");
      return { ok: true };
    },
  );
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  assert.equal(new Set(sessions).size, 1);
  assert.equal(sessions.length, 3);
});

test("an agent's failure has the name Step Functions gives it, so a catch written for AWS matches locally", async () => {
  const { finished } = await runLocally(
    workflow(
      () =>
        attempt(step("case-analysis", { caseId: "x" }), () => invokeLambda("escalate"), {
          on: [WORKFLOW_ERROR_NAMES.agentFailed],
        }),
      { timeoutSeconds: 60 },
    ),
    async () => {
      throw new WorkflowStateError(WORKFLOW_ERROR_NAMES.agentFailed, "Received error (500) from runtime.");
    },
  );
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  assert.equal(WORKFLOW_ERROR_NAMES.agentFailed, "BedrockAgentCore.RuntimeClientErrorException");
});

/** A supervisor that answers one fixed reply, as the runner's would. */
function answering(status: number, body: string, contentType = "application/json"): LocalAgentInvoker & { requests: { headers: Readonly<Record<string, string>>; body: string }[] } {
  const requests: { headers: Readonly<Record<string, string>>; body: string }[] = [];
  return {
    requests,
    async invoke(_id, request, consume) {
      requests.push(request);
      await consume(new Response(body, { status, headers: { "content-type": contentType } }));
    },
  };
}

test("the local call sends the adapter's request and reads its answer as the compiled step does", async () => {
  const signal = new AbortController().signal;
  const ok = answering(200, JSON.stringify({ result: { verdict: "settle" } }));
  const conversationId = sha256("exec\n");
  assert.deepEqual(await invokeAgentStep(ok, "case-analysis", { conversationId, input: { n: 1 } }, signal), { verdict: "settle" });
  assert.equal(ok.requests[0].headers["x-amzn-bedrock-agentcore-runtime-session-id"], agentSessionId("service", conversationId));
  assert.deepEqual(JSON.parse(ok.requests[0].body), { conversationId, input: { n: 1 } });
  assert.equal(await invokeAgentStep(answering(200, JSON.stringify({ result: null })), "a", { conversationId, input: {} }, signal), null);

  const failure = async (reply: LocalAgentInvoker) =>
    invokeAgentStep(reply, "case-analysis", { conversationId, input: {} }, signal).then(
      () => assert.fail("expected a failure"),
      (error: WorkflowStateError) => error,
    );
  const errors = console.error;
  console.error = () => undefined;
  try {
    // AWS reports the status, never the body; the body stays in the local log.
    const refused = await failure(answering(500, JSON.stringify({ error: "AGENT_EXECUTION_FAILED", secret: "row 42" })));
    assert.equal(refused.errorName, WORKFLOW_ERROR_NAMES.agentFailed);
    assert.match(refused.cause, /^Received error \(500\) from runtime/);
    assert.doesNotMatch(refused.cause, /row 42/);
  } finally {
    console.error = errors;
  }
  for (const reply of [answering(200, "not json"), answering(200, "{}"), answering(200, "event: x\ndata: {}\n\n", "text/event-stream")]) {
    assert.equal((await failure(reply)).errorName, WORKFLOW_ERROR_NAMES.queryEvaluation);
  }
  // Measured as AWS measures the task result: the escaped body, not the parsed value.
  const big = answering(200, JSON.stringify({ result: { text: '"'.repeat(WORKFLOW_PAYLOAD_CHARACTER_LIMIT / 2) } }));
  assert.equal((await failure(big)).errorName, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
});

test("express workflows may invoke an agent: it is a request-response call", () => {
  assert.doesNotThrow(review(workflow(() => step("case-analysis", { caseId: "x" }), { timeoutSeconds: 60, type: "express" })));
});

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

const cognito = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };
const base = {
  defaults,
  http: [],
  webSocket: [],
  events: [{ "store-analysis": {}, escalate: {} }],
  services: [],
} satisfies FrameworkConfigInput;
const agents = {
  "case-analysis": {},
  "support-agent": { auth: true, environment: cognito },
} as const;
const reviewing = (agent: string) => ({
  review: workflow(() => step(agent, { caseId: "x" }), { timeoutSeconds: 600 }),
});

test("an invokeAgent step is an edge to the agent, checked like every other", () => {
  const config = defineFrameworkConfig({ ...base, agents: [agents], workflows: [reviewing("case-analysis")] });
  assert.deepEqual(getWorkflowStepTargets(config, "review"), ["agent:case-analysis"]);

  assert.throws(
    () => defineFrameworkConfig({ ...base, agents: [agents], workflows: [reviewing("missing")] }),
    /workflows\["review"\] invokeAgent\("missing"\) names "agent:missing", which is not declared\. Declared agent ids: case-analysis, support-agent/,
  );
  assert.throws(
    () =>
      defineFrameworkConfig({
        ...base,
        agents: [{ ...agents, "case-analysis": { deploy: "local-only" } }],
        workflows: [reviewing("case-analysis")],
      }),
    /invokeAgent\("case-analysis"\) names "agent:case-analysis", which deploy "local-only" removes from the cloud lane/,
  );
});

test("an agent with users is refused: a workflow has no token to forward", () => {
  assert.throws(
    () => defineFrameworkConfig({ ...base, agents: [agents], workflows: [reviewing("support-agent")] }),
    /invokeAgent\("support-agent"\) calls an agent with auth: true, .* a workflow has none/,
  );
});

test("workflows invoke agents and agents start workflows in one application, while a real cycle is refused", () => {
  const other = { other: workflow(() => invokeLambda("escalate"), { timeoutSeconds: 60 }) };
  // review -> case-analysis -> open-review -> other: a chain, in both directions.
  assert.doesNotThrow(() =>
    defineFrameworkConfig({
      ...base,
      tools: [{ "open-review": { cloud: { bindings: [startsWorkflow("other")] } } }],
      agents: [{ ...agents, "case-analysis": { tools: ["open-review"], cloud: { bindings: [startsWorkflow("other")] } } }],
      workflows: [reviewing("case-analysis"), other],
    }),
  );
  // review -> case-analysis -> open-review -> review: no order can deploy or run it.
  assert.throws(
    () =>
      defineFrameworkConfig({
        ...base,
        tools: [{ "open-review": { cloud: { bindings: [startsWorkflow("review")] } } }],
        agents: [{ ...agents, "case-analysis": { tools: ["open-review"] } }],
        workflows: [reviewing("case-analysis")],
      }),
    /Invocation edges form a cycle: .*(workflow:review|agent:case-analysis|lambda:open-review)/,
  );
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

test("only an agent without users and with a JSON response typechecks as a step", () => {
  // The rule, against a manifest of every combination. Checked by the
  // compiler: an @ts-expect-error that stops erroring fails typecheck.
  type Manifest = {
    readonly service: { readonly auth: false; readonly streaming: false; readonly tools: readonly [] };
    readonly users: { readonly auth: true; readonly streaming: false; readonly tools: readonly [] };
    readonly streams: { readonly auth: false; readonly streaming: true; readonly tools: readonly [] };
  };
  const callable: WorkflowCallableAgentIds<Manifest> = "service";
  // @ts-expect-error an agent with users is not callable from a workflow
  const users: WorkflowCallableAgentIds<Manifest> = "users";
  // @ts-expect-error a streaming agent is not callable from a workflow
  const streams: WorkflowCallableAgentIds<Manifest> = "streams";
  assert.deepEqual([callable, users, streams], ["service", "users", "streams"]);

  // And applied to this repository: its only agent has users and streams.
  const unreachable = () =>
    // @ts-expect-error echo-agent is not a WorkflowAgentId
    invokeAgent("echo-agent", { message: "hi" });
  assert.equal(typeof unreachable, "function");
});
