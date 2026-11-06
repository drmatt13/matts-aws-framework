import assert from "./support/assert";
import { test } from "node:test";
import type { JobView } from "../shared/deploy";
import { developmentMutationBlocker, runtimeActionRequiresOff } from "../src/deploy/dev-lifecycle";
import { localRuntimeView } from "./browser/support/local-runtime";

const job: JobView = { id: "start", kind: "local-start", status: "running", title: "Start development", params: {}, startedAt: "2026-11-05T00:00:00Z", lastSeq: 0 };

test("development infrastructure changes require known stopped compute, independent of switch readiness", () => {
  const stopped = localRuntimeView("stopped");
  assert.equal(developmentMutationBlocker({ mode: "dev", local: stopped, operationsKnown: true }), undefined);
  for (const state of ["starting", "ready", "blocked"] as const)
    assert.match(developmentMutationBlocker({ mode: "dev", local: localRuntimeView(state), operationsKnown: true })!, /Stop local runtime/);
  assert.match(developmentMutationBlocker({ mode: "dev", local: stopped, operationsKnown: true, job })!, /finish starting or stopping/);
  assert.match(developmentMutationBlocker({ mode: "dev", local: stopped, operationsKnown: true, submitting: true })!, /finish starting or stopping/);
});

test("unknown local or operation evidence cannot enable dev cloud mutations", () => {
  assert.match(developmentMutationBlocker({ mode: "dev", operationsKnown: true })!, /Check local runtime/);
  const local = localRuntimeView("stopped");
  assert.match(developmentMutationBlocker({ mode: "dev", local, operationsKnown: true, problem: "Connection failed" })!, /Check local runtime/);
  assert.match(developmentMutationBlocker({ mode: "dev", local: { ...local, observationProblem: "Docker unreadable" }, operationsKnown: true })!, /Check local runtime/);
  assert.match(developmentMutationBlocker({ mode: "dev", local: { ...local, docker: { engine: "unknown", desktop: true } }, operationsKnown: true })!, /Check local runtime/);
  assert.match(developmentMutationBlocker({ mode: "dev", local, operationsKnown: false })!, /Check runtime operations/);
});

test("production review is independent of the checkout's development compute gate", () => {
  assert.equal(developmentMutationBlocker({ mode: "prod", operationsKnown: false }), undefined);
  assert.equal(developmentMutationBlocker({ mode: "prod", local: localRuntimeView("ready"), operationsKnown: true, job }), undefined);
});

test("manual exports and fresh starts share the off gate while stop, review and synthesis stay available", () => {
  for (const action of ["delete", "export", "start-exported", "start"] as const) assert.equal(runtimeActionRequiresOff(action), true);
  for (const action of ["stop", "review-plan", "plan", "discard-plan", "refresh"] as const) assert.equal(runtimeActionRequiresOff(action), false);
});
