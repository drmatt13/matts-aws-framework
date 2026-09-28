import assert from "node:assert/strict";
import test from "node:test";
import {
  and,
  attempt,
  choose,
  eq,
  exists,
  fail,
  gt,
  invokeLambda,
  isNull,
  label,
  map,
  normalizeWorkflow,
  not,
  otherwise,
  parallel,
  retry,
  runTask,
  runWorkflow,
  sequence,
  succeed,
  unsafe,
  wait,
  when,
  workflow,
  INLINE_MAP_CONCURRENCY_LIMIT,
  type WorkflowDefinition,
} from "@repo/framework/config";

/**
 * The authored language and the graph it produces.
 *
 * These are behavior tests rather than snapshots: what matters is that a graph
 * which cannot work is refused where the author can see it, and that one which
 * can work keeps the shape both backends read.
 */

function compile(definition: WorkflowDefinition, id = "example") {
  return normalizeWorkflow(id, definition, `workflows["${id}"]`);
}

function refuses(build: () => WorkflowDefinition, expected: RegExp): void {
  assert.throws(build, expected);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("a step constructed outside workflow() names the mistake", () => {
  assert.throws(
    () => invokeLambda("validate"),
    /constructed outside workflow\(\)/,
  );
});

test("node ids are allocated in construction order and are graph-unique", () => {
  const compiled = compile(
    workflow(({ input }) => {
      const first = invokeLambda("alpha", { payload: input });
      const second = invokeLambda("beta", { payload: first.output });
      return sequence(first, second);
    }, { timeoutSeconds: 60 }),
  );

  const names = [...compiled.names.values()];
  assert.deepEqual(new Set(names).size, names.length);
  assert.ok(names.includes("InvokeLambda_Alpha_1"));
  assert.ok(names.includes("InvokeLambda_Beta_2"));
});

test("a label renames the state without changing the wiring", () => {
  const compiled = compile(
    workflow(() => label("Check the document", invokeLambda("alpha")), {
      timeoutSeconds: 60,
    }),
  );
  assert.deepEqual([...compiled.names.values()], ["CheckTheDocument_1"]);
  assert.deepEqual(compiled.targets, ["lambda:alpha"]);
});

test("nested sequences flatten and a single step needs no wrapper", () => {
  const compiled = compile(
    workflow(() => {
      const a = invokeLambda("alpha");
      const b = invokeLambda("beta");
      const c = invokeLambda("gamma");
      return sequence(sequence(a, b), c);
    }, { timeoutSeconds: 60 }),
  );
  assert.equal(compiled.root.kind, "sequence");
  assert.equal(
    (compiled.root as { steps: readonly unknown[] }).steps.length,
    3,
  );
});

test("targets are distinct and in first-use order", () => {
  const compiled = compile(
    workflow(() =>
      sequence(
        invokeLambda("alpha"),
        runTask("beta"),
        invokeLambda("alpha"),
        runWorkflow("gamma"),
      ),
    { timeoutSeconds: 60 }),
  );
  assert.deepEqual(compiled.targets, [
    "lambda:alpha",
    "task:beta",
    "workflow:gamma",
  ]);
});

test("a workflow needs a positive integer timeout", () => {
  refuses(
    () => workflow(() => invokeLambda("alpha"), { timeoutSeconds: 0 }),
    /timeoutSeconds must be a positive integer/,
  );
});

test("an empty sequence, an empty parallel and a choose without a default are refused", () => {
  refuses(() => workflow(() => sequence(), { timeoutSeconds: 60 }), /at least one step/);
  refuses(() => workflow(() => parallel(), { timeoutSeconds: 60 }), /at least one branch/);
  refuses(
    () => workflow(() => choose(otherwise(invokeLambda("beta"))), { timeoutSeconds: 60 }),
    /at least one rule/,
  );
});

test("choose reports a malformed rule instead of crashing on it", () => {
  refuses(
    () =>
      workflow(
        () =>
          choose(
            otherwise(invokeLambda("alpha")) as never,
            otherwise(invokeLambda("beta")),
          ),
        { timeoutSeconds: 60 },
      ),
    /is not a rule/,
  );
});

test("choose keeps its rules in order and requires an otherwise", () => {
  const compiled = compile(
    workflow<{ score: number }>(({ input }) =>
      choose(
        [gt(input.score, 90), succeed("high")],
        [gt(input.score, 50), succeed("middle")],
        otherwise(succeed("low")),
      ),
    { timeoutSeconds: 60 }),
  );
  const node = compiled.root as { kind: string; rules: readonly unknown[] };
  assert.equal(node.kind, "choice");
  assert.equal(node.rules.length, 2);
});

test("wait takes exactly one of seconds and until", () => {
  refuses(() => workflow(() => wait({}), { timeoutSeconds: 60 }), /exactly one/);
  refuses(
    () => workflow(() => wait({ seconds: 1, until: "2030-01-01T00:00:00Z" }), { timeoutSeconds: 60 }),
    /exactly one/,
  );
});

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

test("map binds one iteration object and defaults to AWS's inline ceiling", () => {
  const compiled = compile(
    workflow<{ files: readonly string[] }>(({ input }) =>
      map(input.files, ({ item, index }) =>
        invokeLambda("alpha", { payload: { name: item, position: index } }),
      ),
    { timeoutSeconds: 60 }),
  );
  const node = compiled.root as { kind: string; maxConcurrency: number };
  assert.equal(node.kind, "map");
  assert.equal(node.maxConcurrency, INLINE_MAP_CONCURRENCY_LIMIT);
});

test("an inline map cannot ask for more concurrency than AWS runs", () => {
  refuses(
    () =>
      workflow<{ files: readonly string[] }>(({ input }) =>
        map(input.files, ({ item }) => invokeLambda("alpha", { payload: { item } }), {
          maxConcurrency: INLINE_MAP_CONCURRENCY_LIMIT + 1,
        }),
      { timeoutSeconds: 60 }),
    /at most 40 iterations at once/,
  );
});

test("map iterates a workflow value rather than an array literal", () => {
  refuses(
    () =>
      workflow(() => map([1, 2, 3] as never, ({ item }) => invokeLambda("alpha", { payload: { item } })), {
        timeoutSeconds: 60,
      }),
    /iterates a workflow value/,
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("a value produced inside a parallel branch does not survive the join", () => {
  const definition = workflow(() => {
    let inner!: ReturnType<typeof invokeLambda>;
    const fan = parallel({
      left: (() => {
        inner = invokeLambda("alpha");
        return inner;
      })(),
      right: invokeLambda("beta"),
    });
    return sequence(fan, invokeLambda("gamma", { payload: inner.output }));
  }, { timeoutSeconds: 60 });

  assert.throws(
    () => compile(definition),
    /do not survive it/,
  );
});

test("a map item is not readable outside the iteration", () => {
  assert.throws(
    () =>
      compile(
        workflow<{ files: readonly string[] }>(({ input }) => {
          let item!: ReturnType<typeof map> extends never ? never : never;
          const iterated = map(input.files, (iteration) => {
            item = iteration.item as never;
            return invokeLambda("alpha", { payload: { item: iteration.item } });
          });
          return sequence(iterated, invokeLambda("beta", { payload: { item } }));
        }, { timeoutSeconds: 60 }),
      ),
    /exists only inside the iteration/,
  );
});

test("a caught error is not readable outside its handler", () => {
  assert.throws(
    () =>
      compile(
        workflow(() => {
          let caught!: never;
          const guarded = attempt(invokeLambda("alpha"), (error) => {
            caught = error as never;
            return invokeLambda("beta", { payload: { error } });
          });
          return sequence(guarded, invokeLambda("gamma", { payload: { caught } }));
        }, { timeoutSeconds: 60 }),
      ),
    /exists only inside the handler/,
  );
});

test("retry wraps one retryable step, not a sequence", () => {
  assert.throws(
    () =>
      compile(
        workflow(
          () => retry(sequence(invokeLambda("alpha"), invokeLambda("beta")), { retries: 2 }),
          { timeoutSeconds: 60 },
        ),
      ),
    /not one retryable step/,
  );
});

test("retry accepts an invocation, a map and a parallel", () => {
  for (const build of [
    () => retry(invokeLambda("alpha"), { retries: 1 }),
    () => retry(parallel(invokeLambda("alpha"), invokeLambda("beta")), { retries: 1 }),
  ]) {
    assert.doesNotThrow(() => compile(workflow(build, { timeoutSeconds: 60 })));
  }
});

test("express execution refuses the steps it cannot wait for", () => {
  assert.throws(
    () =>
      compile(
        workflow(() => runTask("beta"), { timeoutSeconds: 60, type: "express" }),
      ),
    /express execution/,
  );
});

test("distributed map is refused with a reason rather than compiled", () => {
  assert.throws(
    () =>
      compile(
        workflow<{ files: readonly string[] }>(({ input }) =>
          map(input.files, ({ item }) => invokeLambda("alpha", { payload: { item } }), {
            mode: "distributed",
          }),
        { timeoutSeconds: 60 }),
      ),
    /does not support yet/,
  );
});

test("a step target must be a declared kebab-case id", () => {
  assert.throws(
    () => compile(workflow(() => invokeLambda("Not A Target"), { timeoutSeconds: 60 })),
    /kebab-case id/,
  );
});

test("a raw state stays available and stays visible in the graph", () => {
  const compiled = compile(
    workflow(() => unsafe.rawState({ Type: "Pass" }), { timeoutSeconds: 60 }),
  );
  assert.equal(compiled.root.kind, "rawState");
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

test("conditions build an expression tree rather than evaluating", () => {
  const definition = workflow<{ score: number; note: string | null }>(({ input }) =>
    when(
      and(gt(input.score, 10), not(isNull(input.note)), exists(input.note)),
      succeed("high"),
      succeed("low"),
    ),
  { timeoutSeconds: 60 });
  const compiled = compile(definition);
  assert.equal(compiled.root.kind, "choice");
});

test("a one-armed when records that the false arm was omitted", () => {
  const compiled = compile(
    workflow<{ ready: boolean }>(({ input }) =>
      when(eq(input.ready, true), invokeLambda("alpha")),
    { timeoutSeconds: 60 }),
  );
  const node = compiled.root as { optional?: true; otherwise: { kind: string } };
  assert.equal(node.optional, true);
  assert.equal(node.otherwise.kind, "pass");
});

test("fail needs an error name", () => {
  refuses(() => workflow(() => fail(""), { timeoutSeconds: 60 }), /needs an error name/);
});
