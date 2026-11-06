import assert from "./support/assert";
import { test } from "node:test";
import { RestrictedEvaluator, type RestrictedConnection, type RestrictedEvaluatorDependencies } from "../server/evaluator/restricted";
import { failedModel } from "../server/model/project";
import type { ExecutionPolicy } from "../server/agent-runtime/policy";
import type { PreflightRequest } from "../server/model/preflight";

function fixture(malformed = false) {
  const requests: { method: string; params: any }[] = [], payloads: unknown[] = [];
  let cleaned = false, probes = 0, stopped = 0;
  const dependencies: RestrictedEvaluatorDependencies = {
    prepare: async () => ({ policy: { cwd: "/fixture", profile: "offline", commandEnvironment: {} } as ExecutionPolicy, command: ["/trusted/node", "/trusted/bridge"], requestFile(value) { payloads.push(value); return JSON.stringify(value); }, cleanup() { cleaned = true; } }),
    connect: () => {
      let end!: () => void;
      const connection: RestrictedConnection = {
        initialize: async () => {}, transport: { closed: new Promise<void>(resolve => { end = resolve; }), stop() { stopped++; end(); } },
        request: async (method, params: any) => {
          requests.push({ method, params });
          assert.equal(method, "command/exec", "a finite command has no private condition broker or interactive escalation path");
          const payload = JSON.parse(params.command.at(-1));
          return { exitCode: 0, stdout: malformed ? "not a complete model" : JSON.stringify(payload.preflight ? { type: "preflight", result: { mode: "dev", ok: true, diagnostics: [] } } : { type: "model", model: { ...failedModel("dev", new Error("fixture"), 1), status: "ok" } }) };
        },
      };
      return connection;
    },
    probe: async () => { probes++; },
  };
  return { dependencies, requests, payloads, get cleaned() { return cleaned; }, get probes() { return probes; }, get stopped() { return stopped; } };
}

test("restricted model and preflight run finite bounded commands against one retained source capture", async () => {
  const f = fixture(), evaluator = new RestrictedEvaluator("dev", "/fixture", undefined, { "/fixture/source.ts": "reviewed override" }, undefined, f.dependencies);
  try {
    assert.equal((await evaluator.model).status, "ok");
    assert.equal((await evaluator.preflight({} as PreflightRequest)).ok, true);
    assert.equal(f.probes, 2); assert.equal(f.requests.length, 2);
    for (const { params } of f.requests) {
      assert.equal(params.permissionProfile, "offline"); assert.equal(params.streamStdin, undefined);
      assert.equal(params.outputBytesCap, 8 * 1024 * 1024); assert.equal(params.timeoutMs, 55_000); assert.deepEqual(params.env, {});
    }
    assert.equal(f.stopped, 2, "each native execution closes after its bounded response");
    assert.equal(f.cleaned, false, "the immutable source is retained for preflight");
  } finally { await evaluator.dispose(); }
  assert.equal(f.cleaned, true);
});

test("malformed or incomplete native evidence cannot publish a successful model", async () => {
  const f = fixture(true), evaluator = new RestrictedEvaluator("dev", "/fixture", undefined, {}, undefined, f.dependencies);
  try {
    const result = await evaluator.model;
    assert.equal(result.status, "error"); assert.match(result.diagnostics[0]!.message, /privileged evaluation is disabled/);
    assert.equal((await evaluator.preflight({} as PreflightRequest)).ok, false);
  } finally { await evaluator.dispose(); }
  assert.equal(f.cleaned, true);
});

test("sandbox setup failure yields failed evidence without a privileged fallback", async () => {
  let connected = false;
  const evaluator = new RestrictedEvaluator("dev", "/fixture", undefined, {}, undefined, {
    prepare: async () => { throw new Error("private setup details"); },
    connect: () => { connected = true; throw new Error("must not connect"); },
  });
  try {
    const result = await evaluator.model;
    assert.equal(result.status, "error"); assert.equal(connected, false);
    assert.match(result.diagnostics[0]!.message, /privileged evaluation is disabled/);
    assert.doesNotMatch(JSON.stringify(result), /private setup details/);
    assert.equal((await evaluator.preflight({} as PreflightRequest)).ok, false);
  } finally { await evaluator.dispose(); }
});
