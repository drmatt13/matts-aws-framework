import assert from "node:assert/strict";
import test from "node:test";
import { DEPLOYMENT_OUTPUT_DESCRIPTION, discoverDeployments, matchTargets, parseTargets, type ObservedStack } from "@repo/framework/deploy";

const context = { account: "734849394764", region: "us-east-1" };
const arn = (name: string) => `arn:aws:cloudformation:${context.region}:${context.account}:stack/${name}/1`;
function v1(name: string, deployment: string, mode: "dev" | "prod", extra: Partial<ObservedStack> = {}): ObservedStack {
  return {
    StackName: name, StackId: arn(name), StackStatus: "UPDATE_COMPLETE", LastUpdatedTime: "2026-10-12T15:10:00.000Z",
    Outputs: [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: JSON.stringify({ version: 1, deployment, mode, ...context }) }],
    ...extra,
  };
}
function v2(name: string, deployment: string, mode: "dev" | "prod", extra: Partial<ObservedStack> = {}): ObservedStack {
  return {
    StackName: name, StackId: arn(name), StackStatus: "CREATE_COMPLETE", CreationTime: "2026-10-17T10:00:00.000Z",
    Tags: [{ Key: "framework:owner", Value: "matts-aws-framework" }, { Key: "framework:deployment", Value: deployment }, { Key: "framework:mode", Value: mode }, { Key: "framework:contract", Value: "2" }],
    ...extra,
  };
}

test("framework deployments are found by their own records, whatever their names", () => {
  const stacks = [
    v1("my-aws-app-CognitoStack", "my-aws-app", "dev"),
    v1("my-aws-app-DevLambdaReplayStack", "my-aws-app", "dev", { LastUpdatedTime: "2026-10-12T16:00:00.000Z" }),
    v2("my-aws-app-prod-CognitoStack", "my-aws-app-prod", "prod"),
    v2("alex-dev-CognitoStack", "alex-dev", "dev", { StackStatus: "UPDATE_IN_PROGRESS" }),
    { StackName: "CDKToolkit", StackId: arn("CDKToolkit"), StackStatus: "UPDATE_COMPLETE" },
    { StackName: "unrelated-app", StackId: arn("unrelated-app"), StackStatus: "CREATE_COMPLETE" },
  ];
  const found = discoverDeployments(stacks, context);
  assert.deepEqual(found.deployments.map((deployment) => [deployment.name, deployment.mode, deployment.state.kind, deployment.contracts]), [
    ["alex-dev", "dev", "in-progress", [2]],
    ["my-aws-app", "dev", "ready", [1]],
    ["my-aws-app-prod", "prod", "ready", [2]],
  ]);
  assert.equal(found.deployments.find((deployment) => deployment.name === "my-aws-app")?.lastUpdated, "2026-10-12T16:00:00.000Z");
  assert.deepEqual(found.unrecognized, []);
});

test("a lookalike without identity is attached to the deployment it imitates, and refused there", () => {
  const found = discoverDeployments([v1("my-aws-app-CognitoStack", "my-aws-app", "dev"), { StackName: "my-aws-app-OldStack", StackId: arn("my-aws-app-OldStack"), StackStatus: "UPDATE_COMPLETE" }], context);
  const deployment = found.deployments[0]!;
  assert.equal(deployment.state.kind, "conflict");
  assert.equal(deployment.state.kind === "conflict" && deployment.state.reason, "unmarked");
});

test("lookalikes of a declared target with nothing deployed are listed as unrecognized, never adopted", () => {
  const legacy: ObservedStack = { StackName: "my-aws-app-prod-CognitoStack", StackId: arn("my-aws-app-prod-CognitoStack"), StackStatus: "ROLLBACK_COMPLETE" };
  const found = discoverDeployments([legacy], context, new Map(), ["my-aws-app-prod"]);
  assert.deepEqual(found.deployments, []);
  assert.deepEqual(found.unrecognized.map((stack) => [stack.name, stack.status]), [["my-aws-app-prod-CognitoStack", "ROLLBACK_COMPLETE"]]);
  assert.match(found.unrecognized[0]!.reason, /my-aws-app-prod.*no framework deployment identity/);
  // Its template can still identify it (a failed first create keeps its template).
  const template = { Outputs: { FrameworkDeployment: { Description: DEPLOYMENT_OUTPUT_DESCRIPTION, Value: JSON.stringify({ version: 1, deployment: "my-aws-app-prod", mode: "prod", ...context }) } } };
  const recovered = discoverDeployments([legacy], context, new Map([["my-aws-app-prod-CognitoStack", template]]), ["my-aws-app-prod"]);
  assert.deepEqual(recovered.deployments.map((deployment) => [deployment.name, deployment.state.kind]), [["my-aws-app-prod", "failed"]]);
  assert.equal(recovered.deployments[0]!.stacks[0]!.evidence, "template");
});

test("repository targets are matched against what is deployed in this account and region", () => {
  const targets = [
    ...parseTargets({ "my-aws-app-prod": { mode: "prod", account: context.account, region: context.region }, "other-prod": { mode: "prod", account: "111122223333" } }),
    { name: "my-aws-app", mode: "dev" as const, origin: "personal" as const },
    { name: "ghost-dev", mode: "dev" as const, origin: "personal" as const },
  ];
  const found = discoverDeployments([v1("my-aws-app-CognitoStack", "my-aws-app", "prod"), v2("my-aws-app-prod-CognitoStack", "my-aws-app-prod", "prod")], context);
  const matched = matchTargets(targets, found, context);
  assert.deepEqual(matched.map((target) => [target.name, target.status]), [
    ["my-aws-app-prod", "deployed"], ["other-prod", "elsewhere"], ["my-aws-app", "conflict"], ["ghost-dev", "absent"],
  ]);
  assert.match(matched.find((target) => target.name === "my-aws-app")!.detail ?? "", /deployed as prod/);
  assert.match(matched.find((target) => target.name === "other-prod")!.detail ?? "", /Pinned to 111122223333/);
});
