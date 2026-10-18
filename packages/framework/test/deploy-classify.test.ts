import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeployment,
  DEPLOYMENT_OUTPUT_DESCRIPTION,
  deploymentCandidates,
  stackHealth,
  type DeploymentIdentity,
  type ObservedStack,
} from "@repo/framework/deploy";

const query: DeploymentIdentity = { deployment: "app", mode: "dev", account: "111122223333", region: "eu-west-2" };
const marker = (overrides: Partial<DeploymentIdentity> = {}) => JSON.stringify({ version: 1, ...query, ...overrides });

function stack(name: string, status = "UPDATE_COMPLETE", identity: Partial<DeploymentIdentity> | null = {}, account = query.account): ObservedStack {
  return {
    StackName: name,
    StackId: `arn:aws:cloudformation:${query.region}:${account}:stack/${name}/0f1e`,
    StackStatus: status,
    Outputs: identity === null ? undefined : [{ OutputKey: "FrameworkDeployment", Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: marker(identity) }],
  };
}
const template = (overrides: Partial<DeploymentIdentity> = {}) => ({ Outputs: { FrameworkDeployment: { Description: DEPLOYMENT_OUTPUT_DESCRIPTION, Value: marker(overrides) } } });

test("stackHealth maps every CloudFormation status class", () => {
  const cases: [string | undefined, string][] = [
    ["CREATE_COMPLETE", "complete"], ["UPDATE_COMPLETE", "complete"], ["IMPORT_COMPLETE", "complete"],
    ["UPDATE_ROLLBACK_COMPLETE", "rolled-back"], ["REVIEW_IN_PROGRESS", "review"],
    ["UPDATE_IN_PROGRESS", "in-progress"], ["DELETE_IN_PROGRESS", "in-progress"], ["UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", "in-progress"],
    ["ROLLBACK_COMPLETE", "failed-create"], ["ROLLBACK_FAILED", "failed-create"], ["CREATE_FAILED", "paused"], ["UPDATE_FAILED", "paused"],
    ["IMPORT_ROLLBACK_COMPLETE", "rolled-back"], ["UPDATE_ROLLBACK_FAILED", "failed"], ["DELETE_FAILED", "failed"], ["IMPORT_ROLLBACK_FAILED", "failed"], [undefined, "failed"],
  ];
  for (const [status, health] of cases) assert.equal(stackHealth(status), health, String(status));
});

test("candidates are stacks the identity output names, or that follow the deployment's name pattern", () => {
  const stacks = [
    stack("app-CognitoStack"), stack("weird_name"), stack("app-dev-CognitoStack", undefined, { deployment: "app-dev" }),
    stack("other-CognitoStack", undefined, { deployment: "other" }), stack("app-Legacy", undefined, null),
  ];
  assert.deepEqual(deploymentCandidates(stacks, "app").map((item) => item.StackName), ["app-CognitoStack", "weird_name", "app-Legacy"]);
  assert.deepEqual(deploymentCandidates([stack("appXv2-Stack", undefined, null), stack("app.v2-Stack", undefined, null)], "app.v2").map((item) => item.StackName), ["app.v2-Stack"]);
});

test("a deployment with no stacks is absent", () => {
  assert.deepEqual(classifyDeployment([], query), { kind: "absent" });
  assert.equal(classifyDeployment([stack("other-CognitoStack", undefined, { deployment: "other" })], query).kind, "absent");
});

test("complete stacks are ready, and a rolled-back update is reported", () => {
  const ready = classifyDeployment([stack("app-CognitoStack"), stack("app-EventsStack", "CREATE_COMPLETE")], query);
  assert.equal(ready.kind, "ready");
  assert.equal(ready.kind === "ready" && ready.stacks.every((item) => item.evidence === "output"), true);
  assert.equal(classifyDeployment([stack("app-CognitoStack"), stack("app-EventsStack", "UPDATE_ROLLBACK_COMPLETE")], query).kind, "rolled-back");
});

test("in-progress and review stacks block, including one identified only by its template", () => {
  assert.equal(classifyDeployment([stack("app-CognitoStack", "UPDATE_IN_PROGRESS")], query).kind, "in-progress");
  const review = classifyDeployment([stack("app-CognitoStack", "REVIEW_IN_PROGRESS", null)], query, new Map([["app-CognitoStack", template()]]));
  assert.equal(review.kind, "in-progress");
});

test("a failed first create identified by its template is deployable; a failed rollback is not", () => {
  const created = classifyDeployment([stack("app-CognitoStack", "ROLLBACK_COMPLETE", null)], query, new Map([["app-CognitoStack", template()]]));
  assert.equal(created.kind, "failed");
  assert.equal(created.kind === "failed" && created.deployable, true);
  assert.equal(created.kind === "failed" && created.stacks[0]?.evidence, "template");
  const stuck = classifyDeployment([stack("app-CognitoStack", "UPDATE_ROLLBACK_FAILED")], query);
  assert.equal(stuck.kind === "failed" && stuck.deployable, false);
  // Paused by --no-rollback: CDK retries or rolls back first, so it stays deployable.
  const paused = classifyDeployment([stack("app-CognitoStack", "UPDATE_FAILED")], query);
  assert.equal(paused.kind === "failed" && paused.deployable, true);
});

test("deploying the other mode over an existing deployment is a conflict with a remedy", () => {
  const state = classifyDeployment([stack("app-CognitoStack", undefined, { mode: "prod" })], query);
  assert.equal(state.kind, "conflict");
  assert.equal(state.kind === "conflict" && state.reason, "mode");
  const message = state.kind === "conflict" ? state.message : "";
  assert.match(message, /prod deployment/);
  assert.match(message, /app-CognitoStack/);
  assert.match(message, /111122223333/);
  assert.match(message, /another name/);
  assert.match(message, /prod-mode configuration/);
  assert.doesNotMatch(message, /npm run destroy:resources/);
});

test("stacks that disagree with each other are mixed", () => {
  const state = classifyDeployment([stack("app-CognitoStack"), stack("app-RdsStack", undefined, { mode: "prod" })], query);
  assert.equal(state.kind === "conflict" && state.reason, "mixed");
});

test("a same-name stack without any identity is never adopted", () => {
  const state = classifyDeployment([stack("app-CognitoStack", "UPDATE_COMPLETE", null)], query);
  assert.equal(state.kind === "conflict" && state.reason, "unmarked");
  assert.match(state.kind === "conflict" ? state.message : "", /not adopted automatically/);
  // Unmarked outranks everything else the deployment's other stacks would say.
  assert.equal(classifyDeployment([stack("app-CognitoStack", "UPDATE_IN_PROGRESS"), stack("app-Old", "UPDATE_COMPLETE", null)], query).kind, "conflict");
});

test("identity that contradicts the stack's own ARN, names another deployment, or does not parse is inconsistent", () => {
  assert.equal((classifyDeployment([stack("app-CognitoStack", undefined, {}, "999999999999")], query) as { reason?: string }).reason, "inconsistent");
  assert.equal((classifyDeployment([stack("app-CognitoStack", undefined, { deployment: "someone-else" })], query) as { reason?: string }).reason, "inconsistent");
  const invalid: ObservedStack = { ...stack("app-CognitoStack"), Outputs: [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: "{}" }] };
  const state = classifyDeployment([invalid], query);
  assert.equal(state.kind === "conflict" && state.reason, "inconsistent");
  assert.match(state.kind === "conflict" ? state.message : "", /Invalid deployment metadata in app-CognitoStack/);
});
