import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWorkflowAuthoring } from "../scripts/check-workflow-authoring";

/**
 * The authoring check, exercised on declarations rather than on strings.
 *
 * Each fixture is a plausible mistake — the kind that typechecks, builds a
 * graph, deploys, and then quietly does the wrong thing forever — written to a
 * temporary config directory and checked the way `framework:check` checks the
 * real one.
 */

function problemsIn(source: string): readonly string[] {
  const directory = mkdtempSync(path.join(tmpdir(), "workflow-authoring-"));
  try {
    writeFileSync(path.join(directory, "section.ts"), source, "utf8");
    return checkWorkflowAuthoring(directory).map((problem) => problem.message);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function declaration(body: string): string {
  return `
import { invokeLambda, sequence, succeed, transform, workflow } from "@repo/framework/config";

export const section = {
  "example-workflow": workflow(({ input }) => {
${body}
  }, { timeoutSeconds: 60 }),
};
`;
}

test("a ternary on a step result is refused, with the supported expression named", () => {
  const problems = problemsIn(
    declaration(`
    const approval = invokeLambda("approve", { payload: input });
    return sequence(approval, succeed(approval.output.approved ? "approved" : "rejected"));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /always selects the first branch/);
  assert.match(problems[0] as string, /expr\.ifElse/);
});

test("an if statement on a workflow value is refused", () => {
  const problems = problemsIn(
    declaration(`
    const checked = invokeLambda("check", { payload: input });
    if (checked.output.ok) {
      return sequence(checked, succeed("ok"));
    }
    return sequence(checked, succeed("not ok"));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /always truthy/);
});

test("a template literal over a workflow value is refused", () => {
  const problems = problemsIn(
    declaration(`
    const order = invokeLambda("load", { payload: input });
    return sequence(order, succeed(\`order-\${order.output.id}\`));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /expr\.concat/);
});

test("arithmetic on a workflow value is refused", () => {
  const problems = problemsIn(
    declaration(`
    const order = invokeLambda("load", { payload: input });
    return sequence(order, succeed({ total: order.output.total + 1 }));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /expr\.add/);
});

test("a spread of a workflow value is refused", () => {
  const problems = problemsIn(
    declaration(`
    const order = invokeLambda("load", { payload: input });
    return sequence(order, succeed({ ...order.output, checked: true }));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /expr\.merge/);
});

test("awaiting a step is refused", () => {
  const problems = problemsIn(`
import { invokeLambda, sequence, succeed, workflow } from "@repo/framework/config";

export const section = {
  "example-workflow": workflow(async ({ input }) => {
    const order = invokeLambda("load", { payload: input });
    const loaded = await order;
    return sequence(order, succeed(loaded));
  }, { timeoutSeconds: 60 }),
};
`);
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /not a promise/);
});

test("coercing a workflow value is refused", () => {
  const problems = problemsIn(
    declaration(`
    const order = invokeLambda("load", { payload: input });
    return sequence(order, succeed(String(order.output.id)));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /String\(\)/);
});

test("a nullish default on a workflow value is refused", () => {
  const problems = problemsIn(
    declaration(`
    const order = invokeLambda("load", { payload: input });
    return sequence(order, succeed(order.output.note ?? "none"));
  `),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /expr\.coalesce/);
});

test("the mistake is named with the workflow it is in", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "workflow-authoring-"));
  try {
    writeFileSync(
      path.join(directory, "section.ts"),
      declaration(`
    const order = invokeLambda("load", { payload: input });
    return sequence(order, succeed(order.output.ok ? 1 : 0));
  `),
      "utf8",
    );
    const [problem] = checkWorkflowAuthoring(directory);
    assert.equal(problem?.workflow, "example-workflow");
    assert.ok((problem?.line ?? 0) > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary declarations pass, including the supported expressions", () => {
  const problems = problemsIn(`
import {
  and,
  eq,
  expr,
  gt,
  invokeLambda,
  sequence,
  succeed,
  transform,
  when,
  workflow,
} from "@repo/framework/config";

export const section = {
  "example-workflow": workflow(({ input }) => {
    const order = invokeLambda("load", { payload: input });
    const summary = transform({
      id: order.output.id,
      label: expr.concat("order-", order.output.id),
      total: expr.add(order.output.total, 1),
      status: expr.ifElse(eq(order.output.ok, true), "ok", "not ok"),
      note: expr.coalesce(order.output.note, "none"),
    });
    return sequence(
      order,
      summary,
      when(and(gt(order.output.total, 10), eq(order.output.ok, true)), succeed(summary.output)),
      succeed(summary.output),
    );
  }, { timeoutSeconds: 60 }),
};
`);
  assert.deepEqual(problems, []);
});

test("JavaScript over ordinary data is left alone", () => {
  const problems = problemsIn(`
import { invokeLambda, sequence, succeed, workflow } from "@repo/framework/config";

const TARGETS = ["alpha", "beta"];

export const section = {
  "example-workflow": workflow(({ input }) => {
    const steps = TARGETS.map((target) => invokeLambda(target, { payload: input }));
    const label = \`built \${TARGETS.length} steps\`;
    return sequence(...steps, succeed(label));
  }, { timeoutSeconds: 60 }),
};
`);
  assert.deepEqual(problems, []);
});
