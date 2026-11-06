import assert from "./support/assert";
import { test } from "node:test";
import type { JobView, LocalRunView, StatusView, StackView } from "../shared/deploy";
import { localRuntimeActive, localRuntimeMatches, mergeLocalRuntime, runtimePresentation, runtimeStartEligibility } from "../src/deploy/local-runtime-state";

const destination = { deployment: "example-dev", profile: "dev", account: "123456789012", region: "us-east-1" };
const local: LocalRunView = {
  project: "example", docker: { engine: "running", desktop: true },
  services: [{ name: "api", container: "example-api", state: "running", health: "healthy", oneShot: false, ports: "" }],
  watch: { running: true }, client: { running: true }, exported: { ...destination, client: true },
  binding: { ...destination, startedAt: "2026-11-05T00:00:00Z" },
  readiness: { state: "ready", observedAt: "2026-11-05T00:00:01Z", message: "Ready" },
  startedBy: "studio", profile: "dev", restartNeeded: [],
};
const job: JobView = { id: "start", kind: "local-start", title: "Start development", params: destination, status: "running", startedAt: "2026-11-05T00:00:00Z", lastSeq: 0 };

test("running means observed readiness for the exact captured and exported destination", () => {
  assert.equal(localRuntimeMatches(local, destination), true);
  for (const changed of [{ profile: "other" }, { account: "999999999999" }, { region: "us-west-2" }, { deployment: "example-prod" }])
    assert.equal(localRuntimeMatches(local, { ...destination, ...changed }), false);
  assert.equal(localRuntimeMatches({ ...local, binding: undefined }, destination), false);
  assert.equal(localRuntimeMatches({ ...local, exported: { ...local.exported, account: "999999999999" } }, destination), false);
  assert.equal(runtimePresentation({ local, matches: true }).label, "Running");
  assert.equal(runtimePresentation({ local, matches: false }).on, true, "another binding still needs an explicit stop");
  assert.equal(runtimePresentation({ local, matches: false }).label, "Running elsewhere");
  assert.equal(runtimePresentation({ local: { ...local, restartNeeded: ["api"] }, matches: true }).label, "Needs attention");
});

test("launch acceptance and partial startup never advertise a running runtime", () => {
  const starting = { ...local, readiness: { ...local.readiness!, state: "starting" as const } };
  assert.deepEqual(runtimePresentation({ local: starting, job, matches: true }), { active: true, ready: false, busy: true, label: "Starting…", on: true });
  const failed = runtimePresentation({ local: starting, job: { ...job, status: "failed" }, matches: true });
  assert.equal(failed.label, "Needs attention"); assert.equal(failed.on, true); assert.equal(failed.active, true);
  const stopping = runtimePresentation({ local, job: { ...job, kind: "local-stop" }, matches: true });
  assert.equal(stopping.label, "Stopping…"); assert.equal(stopping.on, true);
  assert.equal(runtimePresentation({ local, job: { ...job, kind: "local-restart" }, matches: true }).ready, false);
});

test("a failed observation clears live status while retaining evidence for explanation", () => {
  const unavailable = runtimePresentation({ local, problem: "Docker is unavailable", matches: true });
  assert.equal(unavailable.label, "Status unavailable"); assert.equal(unavailable.ready, false); assert.equal(unavailable.on, true); assert.equal(unavailable.active, true);
  assert.equal(runtimePresentation({ matches: false }).label, "Checking…");
  assert.equal(localRuntimeActive({ ...local, services: [{ ...local.services[0]!, oneShot: true, state: "exited", exitCode: 0 }], watch: { running: false }, client: { running: false } }), false);
  assert.equal(localRuntimeActive({ ...local, services: [{ ...local.services[0]!, state: "restarting" }], watch: { running: false }, client: { running: false } }), true);
  assert.equal(localRuntimeActive({ ...local, services: [{ ...local.services[0]!, state: "created" }], watch: { running: false }, client: { running: false } }), false);
  assert.equal(localRuntimeActive({ ...local, services: [], activeContainerCount: 1, watch: { running: false }, client: { running: false } }), true, "surviving runner containers still require stopping");
  const stopped = { ...local, services: [], activeContainerCount: 0, watch: { running: false }, client: { running: false }, readiness: { ...local.readiness!, state: "stopped" as const } };
  const unknown = mergeLocalRuntime(local, { ...stopped, observationProblem: "Could not read Docker." });
  assert.equal(localRuntimeActive(unknown), true, "unknown observations preserve the need to stop");
  assert.equal(runtimePresentation({ local: unknown, problem: unknown.observationProblem, matches: true }).ready, false);
  assert.equal(localRuntimeActive(mergeLocalRuntime(unknown, stopped)), false, "a successful off observation clears retained activity");
});

const stack: StackView = { name: "example-dev-Core", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "example-dev", mode: "dev" } };
const status: StatusView = {
  deployment: "example-dev", context: { ...destination, arn: "arn:aws:iam::123456789012:role/developer" },
  targets: [], deployments: [], unrecognized: [], unreadable: [], records: {}, observedAt: "2026-11-05T00:00:01Z",
  detail: { name: "example-dev", mode: "dev", account: destination.account, region: destination.region, stacks: [stack], contracts: [2],
    state: { kind: "ready", stacks: [stack] }, events: [], changeSets: [], local: { compatible: true, exported: { client: true, fresh: true } } },
};
const eligibility = { scope: { repository: "/fixture", sourceRevision: "one", generation: "one", mode: "dev" as const, ...destination },
  target: { name: "example-dev", mode: "dev" as const, account: destination.account, region: destination.region },
  availability: "available", status, retained: false, fetching: false, local, operationsKnown: true };

test("only a positively verified complete compatible dev deployment enables startup", () => {
  assert.equal(runtimeStartEligibility(eligibility).blocked, false);
  for (const input of [
    { ...eligibility, scope: { ...eligibility.scope, profile: undefined } },
    { ...eligibility, status: undefined }, { ...eligibility, retained: true },
    { ...eligibility, availability: "unavailable-profile" },
    { ...eligibility, status: { ...status, detail: undefined } },
    { ...eligibility, status: { ...status, context: { ...status.context, account: "999999999999" } } },
    ...(["absent", "in-progress", "failed", "rolled-back"] as const).map(kind => ({ ...eligibility,
      status: { ...status, detail: { ...status.detail!, state: { ...status.detail!.state, kind } } } as StatusView })),
    { ...eligibility, status: { ...status, detail: { ...status.detail!, local: { compatible: false, exported: { client: true, fresh: true } } } } },
    { ...eligibility, status: { ...status, detail: { ...status.detail!, stacks: [{ ...stack, health: "in-progress" as StackView["health"] }] } } },
    { ...eligibility, status: { ...status, detail: { ...status.detail!, stacks: [{ ...stack, status: "UPDATE_IN_PROGRESS" }] } } },
  ]) assert.equal(runtimeStartEligibility(input).blocked, true);
});

test("unknown host state and pending or uncertain operations never enable startup", () => {
  for (const input of [{ ...eligibility, local: undefined }, { ...eligibility, localProblem: "Docker is unreadable" },
    { ...eligibility, operationsKnown: false }, { ...eligibility, work: { ...job, kind: "deploy-apply" as const } },
    { ...eligibility, work: { ...job, status: "failed" as const, execution: "lost" as const } }])
    assert.equal(runtimeStartEligibility(input).blocked, true);
  const changed = runtimePresentation({ local, matches: true, attention: "The deployed resources need an update." });
  assert.equal(changed.on, true); assert.equal(changed.ready, false); assert.equal(changed.label, "Needs attention");
});
