import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Snapshot } from "../shared/model";
import { fieldById } from "../server/edits/fields";
import { planEdit, type EditIntent, type PlanOutcome } from "../server/edits/plan";
import { SourceFiles } from "../server/source";
import { SnapshotBuilder } from "../server/snapshot";

/**
 * Planning against the real repository, in memory. Nothing here writes a file:
 * a plan is text plus proof, and these tests check both.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");
let builder: SnapshotBuilder;
let snapshot: Snapshot;

before(async () => {
  builder = new SnapshotBuilder(repositoryRoot);
  snapshot = (await builder.refresh()).snapshot;
});
after(() => builder.dispose());

function plan(intent: EditIntent, files?: SourceFiles): PlanOutcome {
  const model = snapshot.models.dev;
  const target = model.targets.find((candidate) => candidate.ref === intent.target)!;
  const fact = model.fields[intent.target]!.find((candidate) => candidate.field === intent.field)!;
  return planEdit({ repositoryRoot, origin: target.origins[0]!, field: fieldById(intent.field)!, fact, intent, ...(files ? { files } : {}) });
}

function planned(outcome: PlanOutcome) {
  assert.ok("planned" in outcome, "refused" in outcome ? outcome.refused : "");
  return outcome.planned;
}

test("writing back every editable literal's own value changes no byte", () => {
  let checked = 0;
  for (const target of snapshot.models.dev.targets) {
    for (const fact of snapshot.models.dev.fields[target.ref] ?? []) {
      const editability = snapshot.source.editability[target.ref]?.[fact.field];
      if (editability?.kind !== "literal") continue;
      const outcome = plan({ target: target.ref, field: fact.field, value: fact.authored as string | number });
      assert.ok("refused" in outcome && /already reads/.test(outcome.refused), `${target.ref} ${fact.field}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `checked ${checked} literals`);
});

test("replacing a literal is a one-line diff in the module that declares it", () => {
  const edit = planned(plan({ target: "service:example-service", field: "deploy", value: "both" }));
  assert.equal(edit.relativeFile, "framework-config/services/example.ts");
  assert.equal(edit.after, edit.before.replace('deploy: "local-only",', 'deploy: "both",'));
  assert.deepEqual(edit.diff.lines.filter((line) => line.kind !== "context").map((line) => `${line.kind} ${line.text.trim()}`), [
    'remove deploy: "local-only",',
    'add deploy: "both",',
  ]);
  assert.deepEqual(edit.forward, { origin: 'services["/example-service/*"]', path: ["deploy"], value: "both" });
  assert.deepEqual(edit.inverse, { origin: 'services["/example-service/*"]', path: ["deploy"], value: "local-only" });
});

test("an absent field is inserted beside its neighbours, and its inverse removes it", () => {
  const edit = planned(plan({ target: "lambda:graphql-api", field: "deploy", value: "local-only" }));
  assert.equal(
    edit.after,
    edit.before.replace("    timeoutSeconds: 30,\n", '    timeoutSeconds: 30,\n    deploy: "local-only",\n'),
  );
  assert.deepEqual(edit.inverse, { origin: 'http["/graphql"]', path: ["deploy"], remove: true });
});

test("a nested field goes into the object that already holds its siblings", () => {
  const edit = planned(plan({ target: "service:example-service", field: "container.subnet", value: "private" }));
  assert.equal(edit.after, edit.before.replace("      desiredCount: 1,\n", '      desiredCount: 1,\n      subnet: "private",\n'));
  const created = planned(plan({ target: "task:db-migrate", field: "container.subnet", value: "private" }));
  assert.match(created.after, /cloud: \{ subnet: "private" \},/);
  assert.deepEqual(created.inverse, { origin: 'tasks["db-migrate"]', path: ["cloud"], remove: true });
});

test("a workflow's fields are its options object", () => {
  const edit = planned(plan({ target: "workflow:capability-child", field: "deploy", value: "both" }));
  assert.equal(edit.relativeFile, "framework-config/workflows/capabilities.ts");
  assert.equal(edit.after, edit.before.replace('{ deploy: "local-only", timeoutSeconds: 120 }', '{ deploy: "both", timeoutSeconds: 120 }'));
});

test("inherit removes the property, unless the author commented it", () => {
  const removed = planned(plan({ target: "lambda:test-start-workflow", field: "lambda.timeoutSeconds", inherit: true }));
  assert.deepEqual(
    removed.diff.lines.filter((line) => line.kind !== "context").map((line) => [line.kind, line.text, line.oldLine]),
    [["remove", "    timeoutSeconds: 15,", 44]],
  );
  assert.equal(removed.before.split("\n").length - 1, removed.after.split("\n").length);
  const commented = plan({ target: "lambda:test-run-task", field: "lambda.memorySize", inherit: true });
  assert.ok("refused" in commented && /comment/.test(commented.refused));
});

test("a value outside the field's domain is refused before any text is touched", () => {
  const outcome = plan({ target: "service:example-service", field: "deploy", value: "sometimes" });
  assert.ok("refused" in outcome && /one of both, cloud-only, local-only, none/.test(outcome.refused));
  const memory = plan({ target: "lambda:graphql-api", field: "lambda.memorySize", value: 64 });
  assert.ok("refused" in memory && /128 to 10240/.test(memory.refused));
});

test("a value an expression computes is shown, never rewritten", () => {
  const file = path.join(repositoryRoot, "framework-config", "tasks", "database.ts");
  const overlay = readFileSync(file, "utf8").replace('deploy: "cloud-only"', "deploy: DATABASE_DEPLOY");
  const outcome = plan(
    { target: "task:db-migrate", field: "deploy", value: "both" },
    new SourceFiles(new Map([[path.resolve(file), overlay]])),
  );
  assert.ok("refused" in outcome && /computed by `DATABASE_DEPLOY`/.test(outcome.refused));
});
