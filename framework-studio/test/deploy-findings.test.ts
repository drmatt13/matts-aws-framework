import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentFindings, nextAction, type FindingsInput } from "../shared/deploy-findings";
import type { DiscoveredDeploymentView, LocalRunView, StackView } from "../shared/deploy";

/**
 * What Deploy & Run says and offers for a deployment, from the three states it
 * reconciles: the repository's intent, what AWS holds, and this machine.
 */

const context = { profile: "dev", account: "734849394764", region: "us-east-1", arn: "arn:aws:sts::734849394764:assumed-role/Dev/me" };
const stack = (name: string, status = "UPDATE_COMPLETE", health: StackView["health"] = "complete"): StackView => ({ name, status, health, evidence: "tags", identity: { deployment: "my-aws-app", mode: "dev", contract: 2 } });

function deployed(overrides: Partial<DiscoveredDeploymentView> = {}): DiscoveredDeploymentView {
  const stacks = [stack("my-aws-app-CognitoStack"), stack("my-aws-app-DevLambdaReplayStack")];
  return { name: "my-aws-app", mode: "dev", account: context.account, region: context.region, contracts: [2], state: { kind: "ready", stacks }, stacks, ...overrides };
}

function local(overrides: Partial<LocalRunView> = {}): LocalRunView {
  return {
    project: "matts-aws-framework-new",
    docker: { engine: "running", desktop: true },
    services: [], watch: { running: false }, client: { running: false },
    exported: { client: false }, startedBy: "none", restartNeeded: [],
    ...overrides,
  };
}

function input(overrides: Partial<FindingsInput> = {}): FindingsInput {
  return {
    name: "my-aws-app",
    target: { name: "my-aws-app", mode: "dev", origin: "personal" },
    context, profileKind: "sso",
    local: local(), jobs: [],
    ...overrides,
    plans: (overrides.plans ?? []).map((plan) => ({ account: context.account, region: context.region, ...plan })),
  };
}

const codes = (value: FindingsInput) => deploymentFindings(value).map((finding) => finding.code);

test("an expired session is the one thing to fix, and Sign in is offered", () => {
  const value = input({ problem: { kind: "expired", message: "The selected profile's session has expired." } });
  assert.deepEqual(codes(value), ["SIGNED_OUT"]);
  assert.deepEqual(nextAction(deploymentFindings(value))?.id, "sign-in");
  const keys = input({ problem: { kind: "expired", message: "expired" }, profileKind: "static" });
  assert.equal(nextAction(deploymentFindings(keys))?.id, "refresh", "static keys do not sign in through a browser");
});

test("both development and production prepare explicit reviews", () => {
  assert.deepEqual(nextAction(deploymentFindings(input()))?.label, "Compare AWS templates");
  const production = input({ name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account } });
  const action = nextAction(deploymentFindings(production));
  assert.deepEqual([action?.id, action?.label], ["plan", "Compare AWS templates"]);
});

test("a deployed development target whose outputs this machine lacks offers to export and start", () => {
  const value = input({ deployment: deployed(), detail: { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } } });
  assert.ok(codes(value).includes("EXPORT_OTHER"));
  assert.equal(nextAction(deploymentFindings(value))?.id, "start-exported");
});

test("with current settings, Docker is started before development is", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const stopped = input({ deployment: deployed(), detail: ready, local: local({ docker: { engine: "stopped", desktop: true }, exported: { deployment: "my-aws-app", client: true } }) });
  assert.equal(nextAction(deploymentFindings(stopped))?.id, "start-docker");
  const running = input({ deployment: deployed(), detail: ready, local: local({ exported: { deployment: "my-aws-app", client: true } }) });
  assert.deepEqual([nextAction(deploymentFindings(running))?.id, nextAction(deploymentFindings(running))?.label], ["start", "Start development"]);
});

test("a running stack started before the latest export asks for its changes to be applied, then for the watch", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const stale = input({ deployment: deployed(), detail: ready, local: local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, restartNeeded: ["api-dev-server"], watch: { running: true }, client: { running: true } }) });
  assert.equal(nextAction(deploymentFindings(stale))?.id, "apply-changes");
  const detached = input({ deployment: deployed(), detail: ready, local: local({ startedBy: "outside", exported: { deployment: "my-aws-app", client: true } }) });
  assert.ok(codes(detached).includes("WATCH_DETACHED"));
  assert.equal(nextAction(deploymentFindings(detached))?.id, "resume-watch");
});

test("a reviewed plan waiting to be applied comes first", () => {
  const value = input({ deployment: deployed(), plans: [{ key: "my-aws-app-abc123", deployment: "my-aws-app", mode: "dev", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false }] });
  const action = nextAction(deploymentFindings(value));
  assert.deepEqual([action?.id, action?.plan], ["review-plan", "my-aws-app-abc123"]);
});

test("stacks owned by another mode or nobody are a conflict, never something to deploy over", () => {
  const conflict = deployed({ state: { kind: "conflict", reason: "mode", stacks: [], message: "my-aws-app is a prod deployment in 734849394764/us-east-1, not dev." } });
  const findings = deploymentFindings(input({ deployment: conflict }));
  assert.equal(findings[0]?.severity, "blocking");
  assert.match(findings[0]?.detail ?? "", /prod deployment/);
  assert.equal(findings.flatMap((finding) => finding.actions).some((action) => action.id === "deploy" || action.id === "plan"), false);
});

test("a target pinned to another account is refused for this profile", () => {
  const value = input({ name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: "111122223333" } });
  assert.deepEqual(codes(value), ["ACCOUNT_CONFLICT"]);
  assert.match(deploymentFindings(value)[0]!.detail ?? "", /111122223333/);
});

test("this machine pointing at a deployment AWS no longer holds is called out, with deploying as the remedy", () => {
  const value = input({ local: local({ exported: { deployment: "my-aws-app", client: false } }) });
  assert.ok(codes(value).includes("EXPORT_ORPHAN"));
  assert.equal(nextAction(deploymentFindings(value))?.id, "deploy");
});

test("while an operation runs on the deployment, its other cloud actions wait", () => {
  const value = input({ jobs: [{ id: "j1", kind: "deploy-apply", title: "Apply plan to my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 3, deployment: "my-aws-app" }] });
  assert.equal(codes(value)[0], "OPERATION_RUNNING");
  assert.equal(nextAction(deploymentFindings(value)), undefined);
  assert.ok(deploymentFindings(value).flatMap((finding) => finding.actions).filter((action) => action.id === "deploy").every((action) => action.disabled));
});

test("failed stacks CloudFormation can recover are redeployed; a stuck rollback is not offered a deploy", () => {
  const failed = deployed({ state: { kind: "failed", deployable: true, stacks: [stack("my-aws-app-CognitoStack", "ROLLBACK_COMPLETE", "failed-create")] } });
  assert.equal(nextAction(deploymentFindings(input({ deployment: failed })))?.id, "deploy");
  const stuck = deployed({ state: { kind: "failed", deployable: false, stacks: [stack("my-aws-app-CognitoStack", "UPDATE_ROLLBACK_FAILED", "failed")] } });
  const findings = deploymentFindings(input({ deployment: stuck }));
  assert.equal(findings[0]?.severity, "blocking");
  assert.equal(findings.flatMap((finding) => finding.actions).some((action) => action.id === "deploy"), false);
});

test("a deployment discovered in the account but not declared here is read-only", () => {
  const value = input({ name: "alex-dev", target: undefined, deployment: deployed({ name: "alex-dev" }) });
  assert.ok(codes(value).includes("NOT_DECLARED"));
  assert.equal(deploymentFindings(value).flatMap((finding) => finding.actions).some((action) => ["deploy", "plan", "start", "export"].includes(action.id)), false);
});

test("a plan being applied is not also offered for review", () => {
  const plan = { key: "my-aws-app-abc123", deployment: "my-aws-app", mode: "dev" as const, status: "ready" as const, createdAt: "2026-10-17T10:00:00Z", expired: false };
  const value = input({ deployment: deployed(), plans: [plan], jobs: [{ id: "j2", kind: "deploy-apply", title: "Apply plan to my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:01:00Z", lastSeq: 1, deployment: "my-aws-app", planId: plan.key }] });
  assert.equal(codes(value).includes("PLAN_WAITING"), false);
});

test("stacks created only to hold a plan's change sets await review; they are not CloudFormation at work", () => {
  const review = [stack("my-aws-app-CognitoStack", "REVIEW_IN_PROGRESS", "review")];
  const value = input({
    deployment: deployed({ stacks: review, state: { kind: "in-progress", deployable: false, stacks: review } }),
    plans: [{ key: "my-aws-app-abc123", deployment: "my-aws-app", mode: "dev", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false }],
  });
  assert.ok(codes(value).includes("AWAITING_REVIEW"));
  assert.equal(codes(value).includes("IN_PROGRESS"), false);
  assert.equal(nextAction(deploymentFindings(value))?.id, "review-plan");
});

test("after a partial apply, the stacks still to plan are offered next", () => {
  const value = input({
    name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account },
    deployment: deployed({ name: "my-aws-app-prod", mode: "prod" }),
    plans: [{ key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false, applied: "partial", deferred: ["my-aws-app-prod-RdsStack", "my-aws-app-prod-CognitoStack"] }],
  });
  const partial = deploymentFindings(value).find((finding) => finding.code === "PLAN_PARTIAL");
  assert.match(partial?.detail ?? "", /RdsStack, CognitoStack/);
  assert.deepEqual([nextAction(deploymentFindings(value))?.id, nextAction(deploymentFindings(value))?.label], ["plan", "Plan the remaining stacks"]);
});

test("while a local operation runs, local actions wait for it", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const value = input({ deployment: deployed(), detail: ready, local: local({ exported: { deployment: "my-aws-app", client: true } }), jobs: [{ id: "j3", kind: "local-start", title: "Start development against my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 1 }] });
  const start = deploymentFindings(value).flatMap((finding) => finding.actions).find((action) => action.id === "start");
  assert.match(start?.disabled ?? "", /Start development against my-aws-app is running/);
  assert.equal(nextAction(deploymentFindings(value))?.id, undefined);
});

test("when the watch has stopped on its own, the finding says why", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const value = input({ deployment: deployed(), detail: ready, local: local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, watch: { running: false, exitCode: 1, summary: "no such service: api" }, client: { running: true } }) });
  assert.match(deploymentFindings(value).find((finding) => finding.code === "WATCH_DETACHED")?.detail ?? "", /The watch stopped: no such service: api/);
});

test("a plan that stopped after preparing change sets is offered for discarding", () => {
  const value = input({
    name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account },
    plans: [{ key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "unfinished", createdAt: "2026-10-17T10:00:00Z", expired: false }],
  });
  const unfinished = deploymentFindings(value).find((finding) => finding.code === "PLAN_UNFINISHED");
  assert.deepEqual(unfinished?.actions.map((action) => [action.id, action.plan]), [["discard-plan", "my-aws-app-prod-abc123"]]);
  assert.equal(codes(value).includes("PLAN_WAITING"), false, "there is nothing to review");
});

test("a deployment read from another region than its pin offers nothing to do there", () => {
  const value = input({
    target: { name: "my-aws-app", mode: "dev", origin: "personal", region: "us-west-2" },
    match: { name: "my-aws-app", mode: "dev", origin: "personal", region: "us-west-2", status: "elsewhere", detail: "Pinned to 734849394764/us-west-2; the selected profile is 734849394764/us-east-1." },
  });
  assert.equal(codes(value).includes("TARGET_ABSENT"), false, "absence in this region says nothing about the pinned one");
  assert.equal(deploymentFindings(value).flatMap((finding) => finding.actions).some((action) => action.id === "deploy" || action.id === "delete"), false);
});

test("a failed verification is persistent recovery evidence, while another account's plan is excluded", () => {
  const plan = { key: "saved-review-abc123", deployment: "my-aws-app", mode: "dev" as const, account: context.account, region: context.region, status: "ready" as const, createdAt: "2026-10-22T10:00:00Z", expired: false, applied: "unverified" as const };
  const ours = input({ deployment: deployed(), plans: [plan] });
  const recovery = deploymentFindings(ours).find((finding) => finding.code === "OPERATION_UNVERIFIED");
  assert.equal(recovery?.severity, "blocking");
  assert.equal(nextAction(deploymentFindings(ours))?.plan, plan.key);
  assert.equal(deploymentFindings(ours).some((finding) => /^Deployed ·/.test(finding.title)), false);
  const foreign = input({ deployment: deployed(), plans: [{ ...plan, account: "111122223333" }] });
  assert.equal(codes(foreign).includes("OPERATION_UNVERIFIED"), false);
});
