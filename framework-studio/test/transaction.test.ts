import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { EditError, EditService, writeAtomically } from "../server/edits/transaction";
import { SnapshotBuilder } from "../server/snapshot";

/**
 * Writes, against a disposable copy of the repository's configuration.
 *
 * The copy lives under .cache/framework-studio/ inside the repository, so it
 * resolves @repo/framework and tsx exactly as the real config does, while
 * nothing a test writes can reach framework-config/ or wake Compose Watch.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");
const fixture = path.join(repositoryRoot, ".cache", "framework-studio", `fixture-${randomUUID()}`);
const serviceFile = path.join(fixture, "framework-config", "services", "example.ts");
const taskFile = path.join(fixture, "framework-config", "tasks", "invocation-tests.ts");
let builder: SnapshotBuilder;
let edits: EditService;

before(async () => {
  mkdirSync(path.join(fixture, "cdk-app", "lambda_functions"), { recursive: true });
  cpSync(path.join(repositoryRoot, "framework-config"), path.join(fixture, "framework-config"), { recursive: true });
  cpSync(path.join(repositoryRoot, "framework.config.ts"), path.join(fixture, "framework.config.ts"));
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
});

after(async () => {
  await builder.dispose();
  rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function revision(): string {
  return builder.current!.snapshot.revision;
}

async function rejects(promise: Promise<unknown>, status: number, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof EditError, String(error));
    assert.equal(error.status, status, error.message);
    assert.match(error.message, message);
    return true;
  });
}

test("a valid edit is written, reflected in the next snapshot, and undone to the byte", async () => {
  const original = readFileSync(serviceFile, "utf8");
  const plan = await edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, revision());
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.ok(plan.impact.includes("Runs in local → local, prod AWS."), plan.impact.join(" | "));
  assert.equal(readFileSync(serviceFile, "utf8"), original, "planning writes nothing");

  const applied = await edits.apply(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  assert.equal(readFileSync(serviceFile, "utf8"), original.replace('deploy: "local-only"', 'deploy: "both"'));
  const service = builder.current!.snapshot.models.dev.targets.find((target) => target.ref === "service:example-service")!;
  assert.equal(service.lanes.deploy, "both");
  assert.deepEqual(edits.history(), { undo: 'service:example-service Deploy: "local-only" → "both"' });

  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(serviceFile, "utf8"), original);
  assert.equal((await edits.redo()).status, "applied");
  assert.equal(readFileSync(serviceFile, "utf8"), original.replace('deploy: "local-only"', 'deploy: "both"'));
  await edits.undo();
  assert.equal(readFileSync(serviceFile, "utf8"), original);
});

test("a change the framework refuses is previewed with its reason and cannot be applied", async () => {
  const original = readFileSync(taskFile, "utf8");
  const plan = await edits.plan({ target: "task:invocation-test-task", field: "deploy", value: "local-only" }, revision());
  assert.equal(plan.ok, false);
  assert.match(plan.preflight.dev.diagnostics[0]!.message, /removes from the cloud lane the caller still runs in/);
  await rejects(edits.apply(plan.planId), 422, /refuses/);
  assert.equal(readFileSync(taskFile, "utf8"), original);
});

test("a file edited after the preview is never overwritten", async () => {
  const plan = await edits.plan({ target: "service:example-service", field: "container.subnet", value: "private" }, revision());
  const theirs = readFileSync(serviceFile, "utf8").replace("cpu: 256", "cpu: 512");
  writeFileSync(serviceFile, theirs);
  await rejects(edits.apply(plan.planId), 409, /changed since this preview/);
  assert.equal(readFileSync(serviceFile, "utf8"), theirs);
  writeFileSync(serviceFile, theirs.replace("cpu: 512", "cpu: 256"));
  await builder.refresh();
});

test("a preview from an older snapshot is refused, and a refresh expires outstanding previews", async () => {
  await rejects(edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, "0-stale"), 409, /changed since this view/);
  const plan = await edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, revision());
  await builder.refresh();
  edits.expirePlans();
  await rejects(edits.apply(plan.planId), 410, /expired/);
});

test("a config that stops loading keeps its last good model, refuses edits, and recovers", async () => {
  const original = readFileSync(taskFile, "utf8");
  writeFileSync(taskFile, original.replace('deploy: "both",', 'deploy: "both",,,'));
  try {
    const broken = (await builder.refresh()).snapshot;
    assert.equal(broken.models.dev.stale, true);
    assert.equal(broken.models.dev.diagnostics[0]?.stage, "load");
    assert.match(broken.models.dev.diagnostics[0]!.message, /invocation-tests\.ts:\d+:\d+/);
    assert.ok(broken.models.dev.targets.some((target) => target.ref === "task:invocation-test-task"), "the last good targets are still shown");
    await rejects(
      edits.plan({ target: "service:example-service", field: "deploy", value: "both" }, broken.revision),
      422,
      /does not load right now/,
    );
  } finally {
    writeFileSync(taskFile, original);
  }
  const recovered = (await builder.refresh()).snapshot;
  assert.equal(recovered.models.dev.stale, undefined);
  assert.equal(recovered.models.dev.status, "ok");
});

test("an atomic write leaves no temporary file behind", () => {
  const target = path.join(fixture, "atomic.txt");
  writeFileSync(target, "before");
  writeAtomically(fixture, target, "after");
  assert.equal(readFileSync(target, "utf8"), "after");
  assert.deepEqual(readdirSync(path.join(fixture, ".cache", "framework-studio", "tmp")), []);
});
