import assert from "node:assert/strict";
import test from "node:test";
import {
  attempt,
  compileWorkflowToAsl,
  eq,
  fail,
  invokeLambda,
  map,
  normalizeWorkflow,
  parallel,
  retry,
  runTask,
  runWorkflow,
  sequence,
  succeed,
  variableOf,
  wait,
  when,
  workflow,
  type AslResolver,
  type WorkflowDefinition,
} from "@repo/framework/config";

/**
 * The ASL the compiler emits.
 *
 * Asserted by reading the states rather than by comparing a snapshot: a
 * snapshot proves the output did not change, and what matters here is that it
 * says the specific things the local lane also does — an absent payload is
 * `{}`, a step with no result is `null`, and authored text is data.
 */

const resolver: AslResolver = {
  lambdaArn: (id) => `arn:aws:lambda:eu-west-2:111122223333:function:${id}`,
  workflowArn: (id) => `arn:aws:states:eu-west-2:111122223333:stateMachine:${id}`,
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

function asl(definition: WorkflowDefinition, id = "example"): Json {
  return compileWorkflowToAsl(
    normalizeWorkflow(id, definition, `workflows["${id}"]`),
    resolver,
  );
}

function statesOf(definition: WorkflowDefinition): Json {
  return asl(definition).States as Json;
}

function only(states: Json, type: string): Json {
  const found = Object.values(states).filter(
    (state) => (state as Json).Type === type,
  );
  assert.equal(found.length, 1, `expected exactly one ${type} state`);
  return found[0] as Json;
}

// ---------------------------------------------------------------------------
// The definition envelope
// ---------------------------------------------------------------------------

test("the definition declares JSONata and carries the execution deadline", () => {
  const definition = asl(
    workflow(() => invokeLambda("alpha"), { timeoutSeconds: 900 }),
  );
  assert.equal(definition.QueryLanguage, "JSONata");
  assert.equal(definition.TimeoutSeconds, 900);
  assert.equal(typeof definition.StartAt, "string");
});

// ---------------------------------------------------------------------------
// Payload semantics, shared with the local lane
// ---------------------------------------------------------------------------

test("an absent Lambda payload compiles to an empty document", () => {
  const state = only(statesOf(workflow(() => invokeLambda("alpha"), { timeoutSeconds: 60 })), "Task");
  assert.deepEqual(state.Arguments, {});
});

test("an absent child-workflow payload compiles to an empty document", () => {
  const state = only(
    statesOf(workflow(() => runWorkflow("child"), { timeoutSeconds: 60 })),
    "Task",
  );
  assert.deepEqual((state.Arguments as Json).Input, {});
});

test("a payload keeps its structure, with references as expressions", () => {
  const states = statesOf(
    workflow<{ orderId: string }>(({ input }) => {
      const validated = invokeLambda("alpha", { payload: input });
      return sequence(
        validated,
        invokeLambda("beta", {
          payload: { id: input.orderId, upstream: validated.output, retries: 3 },
        }),
      );
    }, { timeoutSeconds: 60 }),
  );
  const beta = states.InvokeLambda_Beta_2 as Json;
  assert.deepEqual(beta.Arguments, {
    id: "{% $states.context.Execution.Input.orderId %}",
    upstream: `{% $${variableOf("1")} %}`,
    retries: 3,
  });
});

test("authored text that looks like an expression is emitted as data", () => {
  const states = statesOf(
    workflow(
      () => invokeLambda("alpha", { payload: { note: "{% $states.result %}" } }),
      { timeoutSeconds: 60 },
    ),
  );
  const args = (states.InvokeLambda_Alpha_1 as Json).Arguments as Json;
  assert.equal(args.note, '{% "{% $states.result %}" %}');
});

test("an unusual member name is quoted rather than dotted", () => {
  const states = statesOf(
    workflow<{ "content-type": string }>(({ input }) =>
      invokeLambda("alpha", { payload: { kind: input["content-type"] } }),
    { timeoutSeconds: 60 }),
  );
  const args = (states.InvokeLambda_Alpha_1 as Json).Arguments as Json;
  assert.equal(
    args.kind,
    "{% $states.context.Execution.Input.`content-type` %}",
  );
});

test("a step with no result assigns and outputs null", () => {
  const states = statesOf(
    workflow<{ ready: boolean }>(({ input }) =>
      sequence(when(eq(input.ready, true), invokeLambda("alpha")), wait({ seconds: 1 })),
    { timeoutSeconds: 60 }),
  );
  const pass = only(states, "Pass");
  assert.equal(pass.Output, null);
  const waitState = only(states, "Wait");
  assert.equal(waitState.Output, null);
  assert.equal((waitState.Assign as Json)[variableOf("4")], null);
});

test("succeed() with no value ends with null rather than passing data through", () => {
  const state = only(statesOf(workflow(() => succeed(), { timeoutSeconds: 60 })), "Succeed");
  assert.equal(state.Output, null);
});

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

test("a choice condition is coerced to a boolean so an absent member does not raise", () => {
  const states = statesOf(
    workflow<{ ready: boolean }>(({ input }) =>
      when(eq(input.ready, true), succeed("yes"), succeed("no")),
    { timeoutSeconds: 60 }),
  );
  const choice = only(states, "Choice");
  const [rule] = choice.Choices as readonly Json[];
  assert.match(rule?.Condition as string, /^\{% \$boolean\(/);
  assert.equal(typeof choice.Default, "string");
});

test("named parallel branches are reassembled into the authored object", () => {
  const states = statesOf(
    workflow(() =>
      parallel({ user: invokeLambda("alpha"), account: invokeLambda("beta") }),
    { timeoutSeconds: 60 }),
  );
  const state = only(states, "Parallel");
  assert.equal(
    state.Output,
    '{% {"user": $states.result[0], "account": $states.result[1]} %}',
  );
  assert.equal((state.Branches as readonly unknown[]).length, 2);
});

test("a map binds its item once and carries the concurrency both lanes use", () => {
  const states = statesOf(
    workflow<{ files: readonly string[] }>(({ input }) =>
      map(input.files, ({ item }) => invokeLambda("alpha", { payload: { item } }), {
        maxConcurrency: 4,
      }),
    { timeoutSeconds: 60 }),
  );
  const state = only(states, "Map");
  assert.equal(state.MaxConcurrency, 4);
  assert.deepEqual(state.ItemSelector, {
    item: "{% $states.context.Map.Item.Value %}",
    index: "{% $states.context.Map.Item.Index %}",
  });
  const processor = state.ItemProcessor as Json;
  assert.equal((processor.ProcessorConfig as Json).Mode, "INLINE");
  assert.match(processor.StartAt as string, /^MapBind_/);
});

test("a retry policy lands on the single state its step became", () => {
  const states = statesOf(
    workflow(
      () => retry(invokeLambda("alpha"), { retries: 3, intervalSeconds: 2, jitter: "full" }),
      { timeoutSeconds: 60 },
    ),
  );
  const state = only(states, "Task");
  assert.deepEqual(state.Retry, [
    {
      ErrorEquals: ["States.ALL"],
      MaxAttempts: 3,
      IntervalSeconds: 2,
      JitterStrategy: "FULL",
    },
  ]);
});

test("attempt attaches a catch to the fallible states its block produced", () => {
  const states = statesOf(
    workflow(
      () =>
        attempt(
          invokeLambda("alpha"),
          (error) => fail({ error: "Handled", cause: "caught" }),
          { on: ["CustomError"] },
        ),
      { timeoutSeconds: 60 },
    ),
  );
  const guarded = states.InvokeLambda_Alpha_1 as Json;
  const [clause] = guarded.Catch as readonly Json[];
  assert.deepEqual(clause?.ErrorEquals, ["CustomError"]);
  assert.ok((clause?.Assign as Json)["wf_err_2"]);
});

test("a task step launches the revision-pinned definition with the framework input", () => {
  const states = statesOf(
    workflow<{ orderId: string }>(({ input }) =>
      runTask("worker", { payload: { orderId: input.orderId }, timeoutSeconds: 120 }),
    { timeoutSeconds: 600 }),
  );
  const state = only(states, "Task");
  assert.equal(state.Resource, "arn:aws:states:::ecs:runTask.sync");
  assert.equal(state.TimeoutSeconds, 120);
  const args = state.Arguments as Json;
  assert.equal(
    args.TaskDefinition,
    "arn:aws:ecs:eu-west-2:111122223333:task-definition/worker:7",
  );
  const overrides = (args.Overrides as Json).ContainerOverrides as readonly Json[];
  const [variable] = (overrides[0] as Json).Environment as readonly Json[];
  assert.equal(variable?.Name, "FRAMEWORK_TASK_INPUT");
  assert.match(variable?.Value as string, /^\{% \$string\(\{/);
});

test("a task step with no payload stringifies an empty document", () => {
  const states = statesOf(workflow(() => runTask("worker"), { timeoutSeconds: 600 }));
  const state = only(states, "Task");
  const overrides = (state.Arguments as Json).Overrides as Json;
  const containers = overrides.ContainerOverrides as readonly Json[];
  const [variable] = (containers[0] as Json).Environment as readonly Json[];
  assert.equal(variable?.Value, "{% $string({}) %}");
});

test("every state either continues or ends", () => {
  const states = statesOf(
    workflow<{ ready: boolean }>(({ input }) =>
      sequence(
        invokeLambda("alpha"),
        when(eq(input.ready, true), invokeLambda("beta"), invokeLambda("gamma")),
        succeed(),
      ),
    { timeoutSeconds: 60 }),
  );
  for (const [name, state] of Object.entries(states)) {
    const entry = state as Json;
    if (entry.Type === "Succeed" || entry.Type === "Fail") continue;
    if (entry.Type === "Choice") {
      assert.ok(entry.Default, `${name} has a default`);
      continue;
    }
    assert.ok(entry.Next !== undefined || entry.End === true, `${name} continues or ends`);
  }
});

test("every variable the compiler assigns has a name Step Functions accepts", () => {
  // Step Functions refuses a variable name that starts with an underscore
  // ("the variable name contains invalid characters"), as AWS's own
  // ValidateStateMachineDefinition reported for the framework's old `__wf_`
  // prefix. Every kind of name is exercised: step results, map bindings, the
  // error an attempt catches, and a variable a later state reads.
  const definition = asl(
    workflow<{ ids: string[] }>(({ input }) => {
      const first = invokeLambda<{ ok: boolean }>("alpha");
      return sequence(
        first,
        map(input.ids, ({ item }) => invokeLambda("beta", { payload: { id: item } })),
        attempt(invokeLambda("gamma"), (error) => succeed({ caught: error.error }), { on: ["CustomError"] }),
        parallel({ a: invokeLambda("delta", { payload: first.output }), b: wait({ seconds: 1 }) }),
      );
    }, { timeoutSeconds: 600 }),
  );
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const assign = (value as Json).Assign;
    if (assign && typeof assign === "object") names.push(...Object.keys(assign));
    for (const child of Object.values(value as Json)) walk(child);
  };
  walk(definition);
  assert.ok(names.length >= 4, `found ${names.join(", ")}`);
  for (const name of names) assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/, `${name} is a valid Step Functions variable name`);
});
