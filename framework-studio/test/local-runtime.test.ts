import assert from "./support/assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildOperation, type OperationContext } from "../server/deploy/registry";
import type { JobSpec, StepContext } from "../server/deploy/jobs";
import type { OperationRequest } from "../shared/deploy";
import { Tools } from "../server/deploy/process";
import { LocalEnvironment } from "../server/deploy/local";
import { DeployService } from "../server/deploy/service";

const account = "123456789012";
const destination = { deployment: "example-dev", profile: "developer", mode: "dev", account, region: "us-east-1" };
const step = { signal: new AbortController().signal, log() {}, setSummary() {}, setPlanId() {} } as unknown as StepContext;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-runtime-"));
  const env = { ...process.env, AWS_CONFIG_FILE: path.join(root, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials") };
  const exported = { deployment: "example-dev", account, region: "us-east-1", client: true };
  const status: any = { context: { profile: "developer", account, region: "us-east-1", arn: `arn:aws:iam::${account}:role/developer` }, detail: {
    name: "example-dev", mode: "dev", account, region: "us-east-1", state: { kind: "ready" }, stacks: [{ name: "example-dev-CognitoStack", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "example-dev", mode: "dev" } }], local: { compatible: true, exported: { fresh: true } },
  } };
  const target = { name: "example-dev", mode: "dev", origin: "implicit", account, region: "us-east-1" };
  let active = false;
  let record: any;
  let docker: any = { engine: "running" };
  let observed = 0;
  let recorded: any;
  const context = {
    root, env, tools: new Tools(path.resolve(__dirname, "../.."), env), exportDirectory: root,
    profiles: async () => [{ name: "developer", kind: "static" }], targets: () => [target],
    probeDocker: async () => docker,
    jobs: { holder: () => undefined },
    observer: { status: async (profile: string, name: string, region: string, force: boolean) => {
      observed++; assert.deepEqual([profile, name, region, force], ["developer", "example-dev", "us-east-1", true]);
      return { ok: true, value: status };
    } },
    local: { exported: () => exported, services: async () => active ? [{ name: "api", state: "running", oneShot: false }] : [],
      activeContainers: async () => active ? [{ id: "api", state: "running" }] : [],
      runRecord: () => record, writeRunRecord: (value: any) => { recorded = value; } },
  } as unknown as OperationContext;
  return { root, context, status, exported, target, setActive: (value: boolean, binding?: unknown) => { active = value; record = binding; }, setDocker: (value: unknown) => { docker = value; },
    observed: () => observed, recorded: () => recorded, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
const prepare = (f: ReturnType<typeof fixture>, params: OperationRequest["params"] = destination) => buildOperation(f.context, { kind: "local-start", params });
const verify = (spec: JobSpec) => spec.steps[0]!.run!(step);

test("local startup validates fresh exact development destination before exports or containers", async () => {
  const f = fixture(); try {
    const spec = await prepare(f);
    await verify(spec);
    assert.equal(f.observed(), 1);
    assert.deepEqual(spec.locks, ["local", "exports"]);
    assert.equal(await spec.steps[1]!.run!(step), undefined, "every startup regenerates local settings");
    await spec.steps[2]!.run!(step);
    assert.deepEqual({ ...f.recorded(), startedAt: "captured" }, { profile: "developer", deployment: "example-dev", account, region: "us-east-1", startedAt: "captured" });
    const command = await spec.steps[2]!.command!(step);
    assert.equal(command.env.COMPOSE_PROFILES, "", "compute startup never opts into data or identity setup profiles");
    assert.deepEqual(command.args, [path.join(f.context.tools.root, "scripts/dev.mjs"), "--detach", "--profile", "developer"]);
  } finally { f.dispose(); }
});

test("startup exports outputs for both fresh map settings and stale legacy settings", async () => {
  for (const explicit of [true, false]) {
    const f = fixture(); try {
      f.status.detail.local.exported.fresh = explicit;
      const spec = await prepare(f, { ...destination, ...(explicit ? { export: true } : {}) });
      await verify(spec);
      assert.equal(await spec.steps[1]!.run!(step), undefined);
      const command = await spec.steps[1]!.command!(step);
      assert.ok(command.args.includes("--expected-mode"));
      assert.deepEqual(command.args.slice(-4), ["--profile", "developer", "--region", "us-east-1"]);
    } finally { f.dispose(); }
  }
});

test("local startup refuses production, declared pin mismatch and malformed account", async () => {
  const f = fixture(); try {
    await assert.rejects(() => prepare(f, { ...destination, mode: "prod" }), /development deployment/);
    await assert.rejects(() => prepare(f, { ...destination, account: "999999999999" }), /differs/);
    await assert.rejects(() => prepare(f, { ...destination, region: "us-west-2" }), /differs/);
    await assert.rejects(() => prepare(f, { ...destination, account: "invalid" }), /valid AWS account/);
    f.target.mode = "prod";
    await assert.rejects(() => prepare(f), /development deployment/);
    assert.equal(f.observed(), 0);
  } finally { f.dispose(); }
});

test("stopped Docker fails startup before reading AWS", async () => {
  const f = fixture(); try {
    f.setDocker({ engine: "stopped" });
    await assert.rejects(() => prepare(f).then(verify), /Docker is not running/);
    assert.equal(f.observed(), 0);
  } finally { f.dispose(); }
});

test("restart and resume reuse the same verified development startup boundary", async () => {
  const f = fixture(); try {
    for (const kind of ["local-restart", "local-attach-watch"] as const) {
      const spec = await buildOperation(f.context, { kind, params: { profile: "developer" } });
      assert.equal(spec.kind, kind);
      await verify(spec);
      f.status.detail.local.compatible = false;
      await assert.rejects(() => verify(spec), /not compatible/);
      f.status.detail.local.compatible = true;
    }
  } finally { f.dispose(); }
});

test("ready stack status does not bypass compatibility or an unexpected AWS identity", async () => {
  for (const scenario of ["account", "absent", "incompatible", "failed"] as const) {
    const f = fixture(); try {
      if (scenario === "account") f.status.context.account = "999999999999";
      if (scenario === "absent") f.status.detail = undefined;
      if (scenario === "failed") f.status.detail.state.kind = "failed";
      if (scenario === "incompatible") f.status.detail.local = { compatible: false, problem: "The replay queue is missing." };
      await assert.rejects(() => prepare(f).then(verify), /changed|Fully deploy the development|replay queue/);
      assert.equal(f.recorded(), undefined);
    } finally { f.dispose(); }
  }
});

test("startup requires a nonempty owned fully completed stack set and always generates local settings", async () => {
  for (const variant of ["empty", "in-progress", "rolled-back", "unowned", "wrong-mode"]) {
    const f = fixture(); try {
      const stack = f.status.detail.stacks[0];
      if (variant === "empty") f.status.detail.stacks = [];
      if (variant === "in-progress") stack.status = "CREATE_IN_PROGRESS";
      if (variant === "rolled-back") stack.status = "UPDATE_ROLLBACK_COMPLETE";
      if (variant === "unowned") stack.evidence = "none";
      if (variant === "wrong-mode") stack.identity.mode = "prod";
      await assert.rejects(() => prepare(f).then(verify), /Fully deploy/);
      assert.equal(f.recorded(), undefined);
    } finally { f.dispose(); }
  }
  const f = fixture(); try {
    const spec = await prepare(f, { ...destination, export: false });
    await verify(spec);
    assert.equal(await spec.steps[1]!.run!(step), undefined, "a legacy false flag cannot skip automatic local settings generation");
    assert.equal(spec.params.export, true);
  } finally { f.dispose(); }
});

test("active runtime cannot be silently pointed at another or unverified profile", async () => {
  const f = fixture(); try {
    f.setActive(true);
    await assert.rejects(() => prepare(f).then(verify), /Stop local runtime/);
    f.setActive(true, { ...destination, profile: "other", startedAt: "earlier" });
    await assert.rejects(() => prepare(f).then(verify), /Stop local runtime/);
    f.setActive(true, { ...destination, startedAt: "earlier" });
    await prepare(f).then(verify);
  } finally { f.dispose(); }
});

test("profile changes during startup and wrong exported account stop before compute", async () => {
  const f = fixture(); try {
    const changed = await prepare(f); await verify(changed);
    writeFileSync(f.context.env.AWS_CONFIG_FILE!, "[profile changed]\nregion=us-west-2\n");
    await assert.rejects(() => changed.steps[1]!.run!(step), /connection changed/);
    const mismatch = await prepare(f); await verify(mismatch);
    f.exported.account = "999999999999";
    await assert.rejects(() => mismatch.steps[2]!.run!(step), /exported settings/);
    assert.equal(f.recorded(), undefined);
  } finally { f.dispose(); }
});

test("lightweight local status observes Docker and processes without AWS or tooling probes", async () => {
  let forced: boolean | undefined;
  const managed: string[] = [];
  const service = { dockerStatus: { read: async (force: boolean) => { forced = force; return { docker: { engine: "running" } }; } },
    managed: (kind: string) => { managed.push(kind); return { running: false }; },
    local: { view: async (docker: unknown, processes: unknown) => ({ docker, processes }) } };
  const result = await DeployService.prototype.localStatus.call(service as any, true);
  assert.equal(forced, true);
  assert.deepEqual(managed, ["local-watch", "local-client"]);
  assert.deepEqual(result, { docker: { engine: "running" }, processes: { watch: { running: false }, client: { running: false } } });
});

test("container observation failure is retained as an error and cannot clear a stop record", async () => {
  const f = fixture(); try {
    const local = new LocalEnvironment(f.root, f.context.tools, async () => ({ code: 1, stdout: "", stderr: "private-provider-output" }), f.context.env, f.root, f.root);
    local.writeRunRecord({ profile: "developer", deployment: "example-dev", account, region: "us-east-1", startedAt: "earlier" });
    const view = await local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.match(view.observationProblem!, /Could not read/);
    assert.equal(view.readiness?.state, "blocked");
    await assert.rejects(() => local.containerIds(), /Could not inspect/);
    assert.ok(local.runRecord());
    assert.doesNotMatch(JSON.stringify(view), /private-provider/);
  } finally { f.dispose(); }
});

test("unknown Docker engine state never establishes that local runtime stopped", async () => {
  const f = fixture(); try {
    let called = false;
    const local = new LocalEnvironment(f.root, f.context.tools, async () => { called = true; throw new Error("Unexpected Docker command"); }, f.context.env, f.root, f.root);
    const view = await local.view({ engine: "unknown", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.match(view.observationProblem!, /determine whether Docker/);
    assert.equal(view.readiness?.state, "blocked");
    assert.equal(called, false);
  } finally { f.dispose(); }
});
