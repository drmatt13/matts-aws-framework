import assert from "./support/assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { LocalEnvironment, LocalRuntimeConflict, persistedLocalHolder } from "../server/deploy/local";
import { assertDevelopmentRuntimeStopped, buildOperation, changesDevelopmentResources, type OperationContext } from "../server/deploy/registry";
import { Tools } from "../server/deploy/process";
import type { JobView, OperationRequest } from "../shared/deploy";
import type { StepContext } from "../server/deploy/jobs";

const checkout = path.resolve(__dirname, "../..");
const step = { job: "current-job", signal: new AbortController().signal, log() {}, setSummary() {} } as unknown as StepContext;
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-dev-lifecycle-"));
  const env = { ...process.env };
  const tools = new Tools(checkout, env);
  const calls: readonly string[][] = [];
  let containers: { ID: string; State: string }[] = [];
  let allocated = 0;
  let localHolder: JobView | undefined;
  const active = new Set<string>();
  const plans: any = { dev: { identity: { deployment: "example-dev", mode: "dev", account: "123456789012", region: "us-east-1" }, profile: "developer", status: "ready", expired: false, confirmation: { level: "click", reasons: [] }, review: "template", synthesis: { current: true }, stacks: [] },
    prod: { identity: { deployment: "example-prod", mode: "prod", account: "123456789012", region: "us-east-1" }, profile: "developer", status: "ready", expired: false, confirmation: { level: "click", reasons: [] }, review: "template", stacks: [] } };
  const run: any = async (spec: any) => {
    (calls as string[][]).push([...spec.args]);
    const selected = spec.args.some((argument: string) => argument.startsWith("label=com.matts-aws-framework.project=")) ? containers.filter(item => item.ID.startsWith("runner")) : containers.filter(item => !item.ID.startsWith("runner"));
    if (spec.args[0] === "ps") return { code: 0, stdout: selected.map(item => JSON.stringify({ ...item, Names: item.ID, Status: "fixture" })).join("\n"), stderr: "" };
    if (spec.args[0] === "stop") containers = containers.map(item => spec.args.includes(item.ID) ? { ...item, State: "exited" } : item);
    if (spec.args[0] === "unpause") containers = containers.map(item => spec.args.includes(item.ID) ? { ...item, State: "running" } : item);
    return { code: 0, stdout: "", stderr: "" };
  };
  const local = new LocalEnvironment(root, tools, run, env, root, root);
  const context = { root, env, tools, run, local, exportDirectory: root,
    jobs: { holder: (lock: string) => lock === "local" ? localHolder : active.has(lock) ? { id: lock, kind: lock, status: "running" } : undefined },
    targets: () => [{ name: "example-dev", mode: "dev", origin: "implicit" }, { name: "example-prod", mode: "prod", origin: "declared" }],
    profiles: async () => [{ name: "developer" }], probeDocker: async () => ({ engine: "running", desktop: true }),
    plans: { read: (key: string) => plans[key], allocate: () => { allocated++; return "next-plan"; }, path: (key: string) => path.join(root, key) },
    teardowns: { read: (key: string) => ({ deployment: `example-${key}`, mode: key, account: "123456789012", region: "us-east-1", digest: "reviewed", expiresAt: new Date(Date.now() + 60_000).toISOString() }), path: (key: string) => path.join(root, key) },
    followStacks: () => () => {}, changed() {}, stopManaged: async () => active.clear(),
  } as unknown as OperationContext;
  return { root, context, local, calls, active, plans, allocated: () => allocated,
    containers: (values: typeof containers) => { containers = values; }, holder: (value?: JobView) => { localHolder = value; },
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("development apply, destroy, export and mutating plans refuse live compute before preparation", async () => {
  const f = fixture();
  try {
    f.containers([{ ID: "runner-orphan", State: "running" }]);
    const requests: OperationRequest[] = [
      { kind: "deploy-apply", params: { plan: "dev", profile: "developer" } },
      { kind: "destroy", params: { deployment: "example-dev", mode: "dev", profile: "developer", confirm: "example-dev", review: "dev" } },
      { kind: "export", params: { deployment: "example-dev", profile: "developer" } },
      ...[{ autoApply: true }, { createSecrets: true }, { review: "change-set" }].map(options => ({ kind: "deploy-plan" as const, params: { deployment: "example-dev", profile: "developer", ...options } })),
    ];
    for (const request of requests) await assert.rejects(() => buildOperation(f.context, request), /Stop local runtime/);
    assert.equal(f.allocated(), 0, "refused planning does not allocate a half-made review");
    assert.ok(f.calls.every(args => args[0] === "ps"), "guard is read-only and never changes cloud or containers");
  } finally { f.close(); }
});

test("template synthesis and production operations stay available during local development", async () => {
  const f = fixture();
  try {
    f.active.add("local-watch"); f.containers([{ ID: "runner-orphan", State: "running" }]);
    const requests: OperationRequest[] = [
      { kind: "deploy-plan", params: { deployment: "example-dev", profile: "developer", review: "template" } },
      { kind: "deploy-apply", params: { plan: "prod", profile: "developer" } },
      { kind: "destroy", params: { deployment: "example-prod", mode: "prod", profile: "developer", confirm: "example-prod", review: "prod" } },
      { kind: "export", params: { deployment: "example-prod", profile: "developer" } },
    ];
    for (const request of requests) { assert.equal(changesDevelopmentResources(f.context, request), false); assert.equal((await buildOperation(f.context, request)).kind, request.kind); }
    assert.equal(f.calls.length, 0, "unrelated production and read-only synthesis do not add Docker probes");
  } finally { f.close(); }
});

test("an accepted development mutation rechecks local state at its command boundary", async () => {
  const f = fixture();
  try {
    const spec = await buildOperation(f.context, { kind: "deploy-apply", params: { plan: "dev", profile: "developer", currentSource: true } });
    assert.ok(spec.locks.includes("local"));
    f.holder({ id: step.job, kind: "deploy-apply", title: "current", params: {}, status: "running", startedAt: "", lastSeq: 0 });
    await spec.steps[0]!.run!(step); // Its own resource claim never blocks its preflight.
    f.active.add("local-client");
    await assert.rejects(() => spec.steps[0]!.run!(step), /Stop local runtime/);
    f.active.clear(); f.holder({ id: "local-start-in-flight", kind: "local-start", title: "starting", params: {}, status: "running", startedAt: "", lastSeq: 0 });
    await assert.rejects(() => assertDevelopmentRuntimeStopped(f.context), /local runtime operation/);
  } finally { f.close(); }
});

test("stopped means no managed process, paused process, partial container or runner container", async () => {
  const f = fixture();
  try {
    for (const state of ["running", "restarting", "paused", "removing"]) {
      f.containers([{ ID: "runner-work", State: state }]);
      await assert.rejects(() => f.local.assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), LocalRuntimeConflict);
    }
    f.containers([{ ID: "not-started", State: "created" }, { ID: "stopped", State: "exited" }]);
    await f.local.assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    await assert.rejects(() => f.local.assertStopped({ engine: "unknown", desktop: true }, { watch: { running: false }, client: { running: false } }), /status is unavailable/);
    await assert.rejects(() => f.local.assertStopped({ engine: "stopped", desktop: true }, { watch: { running: true }, client: { running: false } }), /Stop local runtime/);
  } finally { f.close(); }
});

test("runtime status counts surviving runner work even with no Compose services", async () => {
  const f = fixture();
  try {
    f.containers([{ ID: "runner-orphan", State: "paused" }]);
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.activeContainerCount, 1); assert.equal(view.startedBy, "outside"); assert.equal(view.services.length, 0);
  } finally { f.close(); }
});

test("stop unpauses only this checkout's paused processes before graceful stopping and preserves records on failure", async () => {
  const f = fixture();
  try {
    f.containers([{ ID: "api", State: "paused" }, { ID: "runner-task", State: "running" }, { ID: "never-started", State: "created" }]);
    f.local.writeRunRecord({ deployment: "example-dev", profile: "developer", startedAt: "before" });
    const spec = await buildOperation(f.context, { kind: "local-stop", params: {} });
    await spec.steps[0]!.run!(step); await spec.steps[1]!.run!(step);
    assert.deepEqual(f.calls.filter(args => ["unpause", "stop"].includes(args[0]!)), [["unpause", "api"], ["stop", "api", "runner-task"]]);
    assert.equal(f.local.runRecord(), undefined); assert.deepEqual(await f.local.containerIds(), []);
    assert.equal(f.calls.some(args => ["rm", "down", "volume", "prune"].includes(args[0]!)), false);
    f.containers([{ ID: "api", State: "paused" }]);
    f.local.writeRunRecord({ deployment: "example-dev", profile: "developer", startedAt: "again" });
    (f.context as any).run = async () => ({ code: 1, stdout: "", stderr: "private-provider-output" });
    await assert.rejects(() => spec.steps[1]!.run!(step), /Paused local containers/);
    assert.ok(f.local.runRecord(), "failed cleanup preserves the captured destination for recovery");
  } finally { f.close(); }
});

test("detached workers observe live host runtime journals without returning their private fields", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, "jobs"));
    const file = path.join(f.root, "jobs/watch.json");
    writeFileSync(file, JSON.stringify({ id: "watch", kind: "local-watch", status: "running", params: { private: "sentinel" } }));
    assert.equal(persistedLocalHolder(f.root, "local-watch")?.id, "watch");
    assert.doesNotMatch(JSON.stringify(persistedLocalHolder(f.root, "local-watch")), /sentinel/);
    writeFileSync(file, JSON.stringify({ id: "watch", kind: "local-watch", status: "interrupted" }));
    assert.equal(persistedLocalHolder(f.root, "local-watch"), undefined);
    writeFileSync(file, "unreadable");
    assert.throws(() => persistedLocalHolder(f.root, "local-watch"), /evidence is unreadable/);
  } finally { f.close(); }
});
