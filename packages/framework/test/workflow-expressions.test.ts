import assert from "node:assert/strict";
import test from "node:test";
import jsonata from "jsonata";
import {
  compileWorkflowToAsl,
  eq,
  expr,
  gt,
  invokeLambda,
  normalizeWorkflow,
  sequence,
  succeed,
  transform,
  workflow,
  type AslResolver,
  type WorkflowValue,
} from "@repo/framework/config";
import { newExecution, runWorkflow } from "@repo/framework/local";

/**
 * `expr`, checked in both lanes at once.
 *
 * Each case is built once and then *run twice*: through the local interpreter,
 * and by evaluating the JSONata the compiler emitted for the same expression.
 * A snapshot would only prove the emitted text had not changed; this proves the
 * two lanes answer the same thing, which is the property the whole design
 * exists to hold.
 *
 * The evaluator is the same JSONata implementation Step Functions uses, driven
 * with the variable bindings the compiled graph would have. It is not a Step
 * Functions emulator: what it exercises is expression semantics, which is
 * exactly where the two lanes could silently disagree.
 *
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html
 */

const resolver: AslResolver = {
  lambdaArn: (id) => `arn:aws:lambda:eu-west-2:111122223333:function:${id}`,
  workflowArn: (id) => `arn:aws:states:eu-west-2:111122223333:stateMachine:${id}`,
  taskLaunch: () => {
    throw new Error("no task in these fixtures");
  },
};

const FAILED = Symbol("failed");
type Outcome = unknown | typeof FAILED;

/** What the local lane answers for `transform(build(input))`. */
async function locally(
  build: (input: WorkflowValue<Record<string, unknown>>) => unknown,
  input: unknown,
): Promise<Outcome> {
  const definition = workflow<Record<string, unknown>>(({ input: value }) =>
    transform(build(value)),
  { timeoutSeconds: 60 });
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input,
    runner: {
      invokeLambda: async () => null,
      runTask: async () => ({ runId: "run", exitCode: 0 }),
    },
  });
  return execution.status === "succeeded" ? execution.output : FAILED;
}

/**
 * What the cloud lane answers, by evaluating the compiled expression.
 *
 * AWS refuses an expression whose result is undefined, so an evaluation that
 * produces nothing is the failure the local lane raises rather than a member
 * that quietly disappears.
 */
async function inTheCloud(
  build: (input: WorkflowValue<Record<string, unknown>>) => unknown,
  input: unknown,
): Promise<Outcome> {
  const definition = workflow<Record<string, unknown>>(({ input: value }) =>
    transform(build(value)),
  { timeoutSeconds: 60 });
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const states = compileWorkflowToAsl(compiled, resolver).States as Record<
    string,
    { readonly Type: string; readonly Output?: unknown }
  >;
  const pass = Object.values(states).find((state) => state.Type === "Pass");
  assert.ok(pass, "the transform compiled to a Pass state");
  return evaluateAslValue(pass.Output, input);
}

const EXPRESSION = /^\{%([\s\S]*)%\}$/;

async function evaluateAslValue(value: unknown, input: unknown): Promise<Outcome> {
  if (typeof value === "string") {
    const match = EXPRESSION.exec(value);
    if (match === null) return value;
    try {
      const result = await jsonata(match[1] as string).evaluate(
        {},
        { states: { context: { Execution: { Input: input } } } },
      );
      // Through JSON, because that is how the value actually travels between
      // states — and because JSONata builds objects with a null prototype,
      // which is an artifact of the evaluator rather than of the result.
      return result === undefined ? FAILED : (JSON.parse(JSON.stringify(result)) as unknown);
    } catch {
      return FAILED;
    }
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (const entry of value) {
      const resolved = await evaluateAslValue(entry, input);
      if (resolved === FAILED) return FAILED;
      entries.push(resolved);
    }
    return entries;
  }
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const resolved = await evaluateAslValue(entry, input);
    if (resolved === FAILED) return FAILED;
    result[key] = resolved;
  }
  return result;
}

/** Runs one expression in both lanes and asserts they agree on the answer. */
async function bothLanes(
  build: (input: WorkflowValue<Record<string, unknown>>) => unknown,
  input: unknown,
  expected: Outcome,
): Promise<void> {
  const local = await locally(build, input);
  const cloud = await inTheCloud(build, input);
  assert.deepEqual(local, expected, "local lane");
  assert.deepEqual(cloud, expected, "cloud lane");
}

type Input = WorkflowValue<Record<string, unknown>>;

function field<T>(input: Input, name: string): WorkflowValue<T> {
  return input[name] as unknown as WorkflowValue<T>;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

test("add, subtract, multiply and divide agree in both lanes", async () => {
  await bothLanes((input) => expr.add(field<number>(input, "a"), 2), { a: 5 }, 7);
  await bothLanes((input) => expr.subtract(field<number>(input, "a"), 2), { a: 5 }, 3);
  await bothLanes((input) => expr.multiply(field<number>(input, "a"), 3), { a: 5 }, 15);
  await bothLanes((input) => expr.divide(field<number>(input, "a"), 2), { a: 5 }, 2.5);
});

test("division by zero fails in both lanes rather than answering null", async () => {
  await bothLanes((input) => expr.divide(field<number>(input, "a"), 0), { a: 5 }, FAILED);
});

test("arithmetic on a string fails in both lanes", async () => {
  await bothLanes((input) => expr.add(field<number>(input, "a"), 1), { a: "five" }, FAILED);
});

test("arithmetic over an absent member fails in both lanes", async () => {
  await bothLanes((input) => expr.add(field<number>(input, "missing"), 1), {}, FAILED);
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

test("concat joins strings in both lanes", async () => {
  await bothLanes(
    (input) => expr.concat("order-", field<string>(input, "id")),
    { id: "42" },
    "order-42",
  );
});

test("concat refuses a number rather than coercing it", async () => {
  await bothLanes(
    (input) => expr.concat("order-", field<string>(input, "id")),
    { id: 42 },
    FAILED,
  );
});

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

test("coalesce answers with the fallback for an absent member", async () => {
  await bothLanes(
    (input) => expr.coalesce(field<string>(input, "note"), "none"),
    {},
    "none",
  );
});

test("coalesce answers with the fallback for an explicit null", async () => {
  await bothLanes(
    (input) => expr.coalesce(field<string>(input, "note"), "none"),
    { note: null },
    "none",
  );
});

test("coalesce keeps a present falsy value", async () => {
  await bothLanes((input) => expr.coalesce(field<number>(input, "count"), 99), { count: 0 }, 0);
  await bothLanes((input) => expr.coalesce(field<string>(input, "note"), "none"), { note: "" }, "");
});

test("reading an absent member without coalesce fails in both lanes", async () => {
  await bothLanes((input) => ({ note: field<string>(input, "note") }), {}, FAILED);
});

// ---------------------------------------------------------------------------
// Choice as data
// ---------------------------------------------------------------------------

test("ifElse selects a value in both lanes", async () => {
  const build = (input: Input): unknown =>
    expr.ifElse(gt(field<number>(input, "score"), 50), "high", "low");
  await bothLanes(build, { score: 80 }, "high");
  await bothLanes(build, { score: 10 }, "low");
});

test("ifElse over an absent member takes the false branch, as a Choice rule does", async () => {
  await bothLanes(
    (input) => expr.ifElse(eq(field<string>(input, "status"), "ready"), 1, 0),
    {},
    0,
  );
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

test("length measures a string and an array in both lanes", async () => {
  await bothLanes((input) => expr.length(field<string>(input, "name")), { name: "abcd" }, 4);
  await bothLanes(
    (input) => expr.length(field<readonly number[]>(input, "items")),
    { items: [1, 2, 3] },
    3,
  );
});

test("length of an empty array is zero, not an absent value", async () => {
  await bothLanes(
    (input) => expr.length(field<readonly number[]>(input, "items")),
    { items: [] },
    0,
  );
});

test("length of a number fails in both lanes", async () => {
  await bothLanes((input) => expr.length(field<string>(input, "name")), { name: 7 }, FAILED);
});

test("at reads an element, and a scalar is not treated as a one-element array", async () => {
  await bothLanes(
    (input) => expr.at(field<readonly string[]>(input, "items"), 1),
    { items: ["a", "b", "c"] },
    "b",
  );
  await bothLanes((input) => expr.at(field<readonly string[]>(input, "items"), 0), { items: "a" }, FAILED);
});

test("at past the end is absent in both lanes", async () => {
  await bothLanes(
    (input) => expr.at(field<readonly string[]>(input, "items"), 5),
    { items: ["a"] },
    FAILED,
  );
});

test("at past the end can be given a fallback", async () => {
  await bothLanes(
    (input) => expr.coalesce(expr.at(field<readonly string[]>(input, "items"), 5), "none"),
    { items: ["a"] },
    "none",
  );
});

test("project reshapes every element in both lanes", async () => {
  await bothLanes(
    (input) =>
      expr.project(
        field<readonly { id: string; total: number }[]>(input, "orders"),
        (order) => ({ id: order.id, doubled: expr.multiply(order.total, 2) }),
      ),
    { orders: [{ id: "a", total: 1 }, { id: "b", total: 2 }] },
    [
      { id: "a", doubled: 2 },
      { id: "b", doubled: 4 },
    ],
  );
});

test("project of an empty array stays an empty array", async () => {
  await bothLanes(
    (input) =>
      expr.project(field<readonly { id: string }[]>(input, "orders"), (order) => order.id),
    { orders: [] },
    [],
  );
});

test("project of a single element stays an array of one", async () => {
  await bothLanes(
    (input) =>
      expr.project(field<readonly { id: string }[]>(input, "orders"), (order) => order.id),
    { orders: [{ id: "only" }] },
    ["only"],
  );
});

test("filter keeps the elements its predicate selects, in order", async () => {
  await bothLanes(
    (input) =>
      expr.filter(field<readonly { total: number }[]>(input, "orders"), (order) =>
        gt(order.total, 10),
      ),
    { orders: [{ total: 5 }, { total: 20 }, { total: 30 }] },
    [{ total: 20 }, { total: 30 }],
  );
});

test("filter that keeps nothing answers with an empty array", async () => {
  await bothLanes(
    (input) =>
      expr.filter(field<readonly { total: number }[]>(input, "orders"), (order) =>
        gt(order.total, 100),
      ),
    { orders: [{ total: 5 }] },
    [],
  );
});

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

test("merge combines objects with later operands winning", async () => {
  await bothLanes(
    (input) => expr.merge(field<{ a: number }>(input, "left"), { b: 2, a: 9 }),
    { left: { a: 1 } },
    { a: 9, b: 2 },
  );
});

test("merge refuses a non-object in both lanes", async () => {
  await bothLanes(
    (input) => expr.merge(field<{ a: number }>(input, "left"), { b: 2 }),
    { left: "not an object" },
    FAILED,
  );
});

test("a structure of literals and expressions is built the same way in both lanes", async () => {
  await bothLanes(
    (input) => ({
      orderId: field<string>(input, "id"),
      totals: [expr.add(field<number>(input, "a"), 1), 0],
      nested: { label: expr.concat("#", field<string>(input, "id")) },
      literal: true,
    }),
    { id: "7", a: 4 },
    {
      orderId: "7",
      totals: [5, 0],
      nested: { label: "#7" },
      literal: true,
    },
  );
});

test("property access on an expression result works in both lanes", async () => {
  await bothLanes(
    (input) => expr.merge(field<{ a: number }>(input, "left"), { b: 2 }).b,
    { left: { a: 1 } },
    2,
  );
});

// ---------------------------------------------------------------------------
// transform as a step
// ---------------------------------------------------------------------------

test("a transform's result is readable by the steps after it", async () => {
  const definition = workflow<{ orderId: string }>(({ input }) => {
    const summary = transform({ id: input.orderId, checked: true });
    return sequence(summary, succeed({ summary: summary.output, id: summary.output.id }));
  }, { timeoutSeconds: 60 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: {
      invokeLambda: async () => null,
      runTask: async () => ({ runId: "run", exitCode: 0 }),
    },
  });
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, {
    summary: { id: "A-1", checked: true },
    id: "A-1",
  });
});

test("a transform assigns its own variable, so the compiled graph can read it too", () => {
  const definition = workflow<{ orderId: string }>(({ input }) => {
    const summary = transform({ id: input.orderId });
    return sequence(summary, invokeLambda("alpha", { payload: summary.output }));
  }, { timeoutSeconds: 60 });
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const states = compileWorkflowToAsl(compiled, resolver).States as Record<
    string,
    Record<string, unknown>
  >;
  const pass = Object.values(states).find((state) => state.Type === "Pass");
  assert.ok(pass?.Assign, "the pass assigns its result");
  assert.deepEqual(Object.keys(pass?.Assign as object), ["__wf_1"]);
  const task = Object.values(states).find((state) => state.Type === "Task");
  assert.equal(task?.Arguments, "{% $__wf_1 %}");
});

test("an element binding cannot escape the expression that introduced it", () => {
  assert.throws(
    () =>
      normalizeWorkflow(
        "example",
        workflow<{ orders: readonly { id: string }[] }>(({ input }) => {
          let escaped!: WorkflowValue<string>;
          const ids = expr.project(input.orders, (order) => {
            escaped = order.id;
            return order.id;
          });
          return transform({ ids, leaked: escaped });
        }, { timeoutSeconds: 60 }),
        'workflows["example"]',
      ),
    /exists only inside the callback/,
  );
});
