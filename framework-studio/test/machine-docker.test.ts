import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockerStatus } from "../server/machine/docker";
import { DeployService } from "../server/deploy/service";
import { probeDockerStatus } from "../server/deploy/prereqs";
import { Tools, type Runner } from "../server/deploy/process";
import type { DockerStatusView } from "../shared/machine";
import type { DockerView } from "../shared/deploy";

const evidence = (engine: DockerView["engine"]): Omit<DockerStatusView, "observedAt"> => ({ docker: { engine, desktop: true }, checks: [] });

test("all forced and ordinary readers share a probe and cache expiry follows completion", async () => {
  let now = 1000, calls = 0;
  let finish!: (result: Omit<DockerStatusView, "observedAt">) => void;
  const events: DockerStatusView[] = [];
  const status = new DockerStatus(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, value => events.push(value), () => now);
  const first = status.read(), forced = status.read(true);
  assert.equal(first, forced); assert.equal(calls, 1);
  now = 10_000; finish(evidence("stopped"));
  assert.equal((await first).docker.engine, "stopped");
  now += 4999; await status.read(); assert.equal(calls, 1);
  now++; const expired = status.read(); assert.equal(calls, 2);
  finish(evidence("running")); await expired;
  const stopped = status.read(true); finish(evidence("stopped")); await stopped;
  assert.deepEqual(events.map(value => value.docker.engine), ["stopped", "running", "stopped"]);
  const unchanged = status.read(true); finish(evidence("stopped")); await unchanged;
  assert.equal(events.length, 3, "unchanged observations do not flood the shared stream");
});

test("a probe from before startup settles cannot publish stale stopped evidence", async () => {
  let calls = 0;
  const finishes: ((value: Omit<DockerStatusView, "observedAt">) => void)[] = [];
  const events: DockerStatusView[] = [];
  const status = new DockerStatus(() => { calls++; return new Promise(resolve => finishes.push(resolve)); }, value => events.push(value));
  const pending = status.read();
  status.invalidate(); finishes[0]!(evidence("stopped"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(events.length, 0);
  assert.equal(status.read(true), status.read());
  finishes[1]!(evidence("running"));
  assert.equal((await pending).docker.engine, "running");
  assert.deepEqual(events.map(value => value.docker.engine), ["running"]);
});

test("failed observation is retryable and unknown engine evidence is never described as stopped", async () => {
  let fail = true;
  const status = new DockerStatus(async () => { if (fail) throw new Error("fixture probe failed"); return evidence("running"); }, () => {});
  await assert.rejects(status.read(), /fixture probe failed/);
  fail = false; assert.equal((await status.read()).docker.engine, "running");
  fail = true; await assert.rejects(status.read(true), /fixture probe failed/);
  await assert.rejects(status.read(), /fixture probe failed/, "a failed forced read cannot resurrect a cached healthy status");
  const unknown = await probeDockerStatus(new Tools(process.cwd(), {}), async () => ({ code: 1, stdout: "", stderr: "permission denied" }), {});
  assert.equal(unknown.docker.engine, "unknown");
  assert.equal(unknown.checks[0]?.status, "unknown");
  assert.doesNotMatch(unknown.checks[0]?.summary ?? "", /not running|stopped/);
});

test("Docker reads avoid deployment discovery and reuse the existing host probe", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "studio-machine-docker-"));
  const calls: string[] = [];
  const run: Runner = async specification => {
    calls.push(specification.display);
    if (!specification.display.startsWith("docker ")) throw new Error("Docker status must not read AWS or other prerequisites.");
    return { code: 0, stderr: "", stdout: specification.display.startsWith("docker version") ? JSON.stringify({ Server: { Version: "fixture" } }) : "fixture" };
  };
  const service = new DeployService(path.resolve(__dirname, "../.."), () => {}, { run, env: {}, stateDirectory: path.join(directory, "state") });
  try {
    const [one, two] = await Promise.all([service.dockerStatus.read(), service.dockerStatus.read(true)]);
    assert.equal(one, two); assert.equal(one.docker.engine, "running");
    assert.equal(calls.filter(command => command.startsWith("docker version")).length, 1);
    assert.ok(calls.every(command => command.startsWith("docker ")));
  } finally { await service.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
