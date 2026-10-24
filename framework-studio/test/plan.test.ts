import { applicationVpc as fixtureVpc } from "../../framework-config/networks/application";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Snapshot } from "../shared/model";
import { fieldById } from "../server/edits/fields";
import { planEdit, type EditIntent, type PlanOutcome } from "../server/edits/plan";
import { SourceFiles } from "../server/source";
import { SnapshotBuilder } from "../server/snapshot";
import { defineFrameworkConfig, wait, workflow, type FrameworkConfig } from "@repo/framework/config";
import { projectModel } from "../server/model/project";
import { defaults } from "../../framework-config/defaults";

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
  assert.equal(edit.relativeFile, "framework-config/workloads/services.ts");
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
  const at = edit.before.indexOf("    timeoutSeconds: 30,\n", edit.before.indexOf('"/graphql":')) + "    timeoutSeconds: 30,\n".length;
  assert.equal(
    edit.after,
    edit.before.slice(0, at) + '    deploy: "local-only",\n' + edit.before.slice(at),
  );
  assert.deepEqual(edit.inverse, { origin: 'http["/graphql"]', path: ["deploy"], remove: true });
});

test("a nested field goes into the object that already holds its siblings", () => {
  const edit = planned(plan({ target: "service:example-service", field: "container.subnet", value: "private" }));
  assert.equal(edit.after, edit.before.replace("      desiredCount: 1,\n", '      desiredCount: 1,\n      subnet: "private",\n'));
  const created = planned(plan({ target: "task:db-migrate", field: "container.subnet", value: "private" }));
  assert.match(created.after, /cloud: \{ vpc: applicationVpc, subnet: "private" \},/);
  assert.deepEqual(created.inverse, { origin: 'tasks["db-migrate"]', path: ["cloud", "subnet"], remove: true });
});

test("Lambda architecture, packaging and typed build options produce ordinary source edits", () => {
  const architecture = planned(plan({ target: "lambda:graphql-api", field: "lambda.architecture", value: "x86_64" }));
  assert.match(architecture.after, /architecture: "x86_64"/);
  assert.deepEqual(architecture.forward.path, ["architecture"]);
  const packaging = planned(plan({ target: "lambda:python-example", field: "lambda.packaging", value: "zip" }));
  assert.equal(packaging.after, packaging.before.replace('packaging: "container"', 'packaging: "zip"'));
  const retention = planned(plan({ target: "lambda:graphql-api", field: "lambda.logRetentionDays", value: 14 }));
  assert.match(retention.after, /logRetentionDays: 14/);
  assert.equal(retention.forward.value, 14);
  const minify = planned(plan({ target: "lambda:graphql-api", field: "lambda.bundling.minify", value: false }));
  assert.match(minify.after, /minify: false/);
  assert.match(minify.after, /sourceMap: false/);
  assert.deepEqual(minify.inverse, { origin: 'http["/graphql"]', path: ["bundling", "minify"], remove: true });
  assert.equal(minify.forward.value, false);
  for (const [field, value] of [["lambda.architecture", "amd64"], ["lambda.logRetentionDays", "14"], ["lambda.logRetentionDays", 2], ["lambda.bundling.minify", "false"]] as const) {
    assert.ok("refused" in plan({ target: "lambda:graphql-api", field, value }), `${field} rejects ${JSON.stringify(value)}`);
  }
});

test("a workflow's fields are its options object", () => {
  const root = path.join(repositoryRoot, ".cache/framework-studio", `workflow-plan-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const source = 'export default defineFrameworkConfig({ workflows: [{ process: workflow(() => wait({ seconds: 1 }), { deploy: "local-only", timeoutSeconds: 120 }) }] });\n';
  writeFileSync(path.join(root, "framework.config.ts"), source);
  try {
    const config = defineFrameworkConfig({ networks: [fixtureVpc], defaults, http: [], webSocket: [], events: [], services: [], workflows: [{ process: workflow(() => wait({ seconds: 1 }), { deploy: "local-only", timeoutSeconds: 120 }) }] });
    const model = projectModel(config as unknown as FrameworkConfig, { mode: "dev", });
    const fact = model.fields["workflow:process"]!.find((fact) => fact.field === "deploy")!;
    const edit = planned(planEdit({ repositoryRoot: root, origin: 'workflows["process"]', field: fieldById("deploy")!, fact, intent: { target: "workflow:process", field: "deploy", value: "both" } }));
    assert.equal(edit.relativeFile, "framework.config.ts");
    assert.equal(edit.after, source.replace('deploy: "local-only"', 'deploy: "both"'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inherit removes the property, unless the author commented it", () => {
  const removed = planned(plan({ target: "lambda:graphql-api", field: "lambda.timeoutSeconds", inherit: true }));
  const at = removed.before.indexOf("    timeoutSeconds: 30,", removed.before.indexOf('"/graphql":'));
  const line = removed.before.slice(0, at).split("\n").length;
  assert.deepEqual(
    removed.diff.lines.filter((line) => line.kind !== "context").map((line) => [line.kind, line.text, line.oldLine]),
    [["remove", "    timeoutSeconds: 30,", line]],
  );
  assert.equal(removed.before.split("\n").length - 1, removed.after.split("\n").length);
  const file = path.join(repositoryRoot, "framework-config/workloads/http.ts");
  const text = readFileSync(file, "utf8");
  const memory = text.indexOf("    memorySize: 512,", text.indexOf('"/graphql":'));
  const overlay = text.slice(0, memory) + "    // Keep the GraphQL memory allocation.\n" + text.slice(memory);
  const commented = plan({ target: "lambda:graphql-api", field: "lambda.memorySize", inherit: true }, new SourceFiles(new Map([[file, overlay]])));
  assert.ok("refused" in commented && /comment/.test(commented.refused));
});

test("a value outside the field's domain is refused before any text is touched", () => {
  const outcome = plan({ target: "service:example-service", field: "deploy", value: "sometimes" });
  assert.ok("refused" in outcome && /one of both, cloud-only, local-only, none/.test(outcome.refused));
  const memory = plan({ target: "lambda:graphql-api", field: "lambda.memorySize", value: 64 });
  assert.ok("refused" in memory && /128 to 10240/.test(memory.refused));
});

test("a value an expression computes is shown, never rewritten", () => {
  const file = path.join(repositoryRoot, "framework-config", "workloads", "tasks.ts");
  const overlay = readFileSync(file, "utf8").replace('deploy: "cloud-only"', "deploy: DATABASE_DEPLOY");
  const outcome = plan(
    { target: "task:db-migrate", field: "deploy", value: "both" },
    new SourceFiles(new Map([[path.resolve(file), overlay]])),
  );
  assert.ok("refused" in outcome && /computed by `DATABASE_DEPLOY`/.test(outcome.refused));
});
