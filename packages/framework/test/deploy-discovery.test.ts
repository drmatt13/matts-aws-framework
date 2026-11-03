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
    ...parseTargets({ prod: { account: context.account, region: context.region, deployAs: "my-aws-app-prod" }, "other-prod": { mode: "prod", account: "111122223333", deployAs: "other-prod" } }, "acme"),
    { name: "my-aws-app", mode: "dev" as const, origin: "named" as const },
    { name: "ghost-dev", mode: "dev" as const, origin: "implicit" as const },
  ];
  const found = discoverDeployments([v1("my-aws-app-CognitoStack", "my-aws-app", "prod"), v2("my-aws-app-prod-CognitoStack", "my-aws-app-prod", "prod")], context);
  const matched = matchTargets(targets, found, context);
  assert.deepEqual(matched.map((target) => [target.name, target.status]), [
    ["my-aws-app-prod", "deployed"], ["other-prod", "elsewhere"], ["my-aws-app", "conflict"], ["ghost-dev", "absent"],
  ]);
  assert.match(matched.find((target) => target.name === "my-aws-app")!.detail ?? "", /deployed as prod/);
  assert.match(matched.find((target) => target.name === "other-prod")!.detail ?? "", /Pinned to 111122223333/);
});

const APP = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";
const lineageTags = (appId: string, stage: string) => [{ Key: "framework:app-id", Value: appId }, { Key: "framework:stage", Value: stage }];

test("a deployment carries the app and stage its stacks were deployed as, read from tags or template metadata", () => {
  const tagged = (name: string, deployment: string, stage: string, appId = APP) => {
    const stack = v2(name, deployment, "prod");
    return { ...stack, Tags: [...stack.Tags!, ...lineageTags(appId, stage)] };
  };
  const found = discoverDeployments([
    tagged("aws-studio-prod-CognitoStack", "aws-studio-prod", "prod"),
    tagged("aws-studio-prod-DatabaseStack", "aws-studio-prod", "prod"),
    v2("my-aws-app-prod-CognitoStack", "my-aws-app-prod", "prod"),
    tagged("split-CognitoStack", "split", "prod"),
    tagged("split-DatabaseStack", "split", "staging"),
  ], context);
  assert.deepEqual(found.deployments.map((deployment) => [deployment.name, deployment.appId ?? null, deployment.stage ?? null]), [
    ["aws-studio-prod", APP, "prod"],
    ["my-aws-app-prod", null, null],
    ["split", null, null],
  ], "stacks from before lineage, or that disagree, claim no stage");

  // A failed first create has no tags in describe-stacks; its template's metadata still says.
  const failed: ObservedStack = { StackName: "acme-prod-CognitoStack", StackId: arn("acme-prod-CognitoStack"), StackStatus: "ROLLBACK_COMPLETE" };
  const template = { Metadata: { "framework:deployment": { contract: 2, owner: "matts-aws-framework", deployment: "acme-prod", mode: "prod", ...context, stack: "CognitoStack", appId: APP, stage: "prod" } } };
  const recovered = discoverDeployments([failed], context, new Map([["acme-prod-CognitoStack", template]]), ["acme-prod"]);
  assert.deepEqual(recovered.deployments.map((deployment) => [deployment.name, deployment.appId, deployment.stage]), [["acme-prod", APP, "prod"]]);
});

test("a target absent under its own name says which deployment of its stage this account already holds", () => {
  const tagged = (name: string, deployment: string, mode: "dev" | "prod", stage: string, updated: string, appId = APP) => {
    const stack = v2(name, deployment, mode, { CreationTime: updated });
    return { ...stack, Tags: [...stack.Tags!, ...lineageTags(appId, stage)] };
  };
  const discovery = discoverDeployments([
    tagged("aws-studio-prod-CognitoStack", "aws-studio-prod", "prod", "prod", "2026-11-01T00:00:00.000Z"),
    tagged("aws-studio-dev-CognitoStack", "aws-studio-dev", "dev", "dev", "2026-11-01T00:00:00.000Z"),
    tagged("older-dev-CognitoStack", "older-dev", "dev", "dev", "2026-10-01T00:00:00.000Z"),
    tagged("other-app-prod-CognitoStack", "other-app-prod", "prod", "prod", "2026-11-02T00:00:00.000Z", "0f0e0d0c-0b0a-4908-8706-050403020100"),
  ], context);
  const targets = parseTargets({ dev: {}, prod: { account: context.account }, staging: { mode: "prod", account: context.account } }, "acme", APP);
  assert.deepEqual(matchTargets(targets, discovery, context).map((target) => [target.name, target.status, target.deployedAs ?? null]), [
    ["acme-dev", "absent", "aws-studio-dev"],
    ["acme-prod", "absent", "aws-studio-prod"],
    ["acme-staging", "absent", null],
  ], "the most recent deployment of the same stage, never another app's");
  const current = parseTargets({ prod: { account: context.account, deployAs: "aws-studio-prod" } }, "acme", APP);
  assert.deepEqual(matchTargets(current, discovery, context).map((target) => [target.status, target.deployedAs ?? null]), [["deployed", null]]);
  const anonymous = parseTargets({ prod: { account: context.account } }, "acme");
  assert.equal(matchTargets(anonymous, discovery, context)[0]!.deployedAs, undefined, "without an app id nothing is matched by stage");
});
