import assert from "node:assert/strict";
import test from "node:test";
import { DEPLOYMENT_OUTPUT_DESCRIPTION, type DeploymentIdentity, type ObservedStack } from "@repo/framework/deploy";
import { assertDeploymentAllowed, productionDeployArguments, unsafeProductionFlags, type GuardReaders } from "../../scripts/deployment-guard";

const dev: DeploymentIdentity = { deployment: "app", mode: "dev", account: "111122223333", region: "eu-west-2" };
const prod: DeploymentIdentity = { ...dev, mode: "prod" };
const sentinel = "sentinel-output-value-never-printed";

function stack(name: string, status: string, identity: DeploymentIdentity | null): ObservedStack {
  return {
    StackName: name, StackStatus: status,
    StackId: `arn:aws:cloudformation:${dev.region}:${dev.account}:stack/${name}/id`,
    Outputs: [
      { OutputKey: "Other", OutputValue: sentinel },
      ...(identity ? [{ Description: DEPLOYMENT_OUTPUT_DESCRIPTION, OutputValue: JSON.stringify({ version: 1, ...identity }) }] : []),
    ],
  };
}
function readers(stacks: ObservedStack[], templates: Record<string, unknown> = {}) {
  const calls = { stacks: 0, templates: [] as string[] };
  const value: GuardReaders = {
    readStacks: () => { calls.stacks += 1; return stacks; },
    readTemplate: (name) => { calls.templates.push(name); return templates[name]; },
  };
  return { value, calls };
}

test("unsafe production flags are recognised however they are written", () => {
  for (const args of [["--hotswap"], ["--hotswap-fallback"], ["--no-rollback"], ["--rollback=false"], ["--rollback", "false"], ["-R"], ["--express"], ["--yes"], ["-y"], ["--require-approval", "never"], ["--require-approval=never"], ["--hotswap=true"]]) {
    assert.notDeepEqual(unsafeProductionFlags(args), [], args.join(" "));
  }
  for (const args of [["--all", "--require-approval", "broadening", "--rollback", "true"], ["--all", "--profile", "yes"], ["--hotswap=false"], ["-c", "rollback=false"], ["-v"]]) {
    assert.deepEqual(unsafeProductionFlags(args), [], args.join(" "));
  }
});

test("the CLI's camelCase and grouped spellings are recognised too", () => {
  for (const args of [["--requireApproval", "never"], ["--requireApproval=never"], ["--hotswapFallback"], ["--noRollback"], ["-Ry"], ["-vy"]]) {
    assert.notDeepEqual(unsafeProductionFlags(args), [], args.join(" "));
  }
});

test("production deploys always ask for broadening approval, whatever cdk.json says", () => {
  assert.deepEqual(productionDeployArguments(prod, ["--all"]), ["--all", "--require-approval", "broadening"]);
  assert.deepEqual(productionDeployArguments(dev, ["--all", "--yes"]), ["--all", "--yes"]);
});

test("production refuses unsafe flags before reading anything", () => {
  const { value, calls } = readers([]);
  assert.throws(() => assertDeploymentAllowed(prod, ["--all", "--yes"], value), /Production deployments refuse --yes/);
  assert.equal(calls.stacks, 0);
});

test("development keeps --yes and deploys a new deployment", () => {
  const { value } = readers([]);
  assert.equal(assertDeploymentAllowed(dev, ["--all", "--yes"], value).kind, "absent");
});

test("a development deploy over a production deployment is refused with its remedy", () => {
  const { value } = readers([stack("app-CognitoStack", "UPDATE_COMPLETE", prod)]);
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], value), (error: Error) => {
    assert.match(error.message, /prod deployment/);
    assert.match(error.message, /another name/);
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    return true;
  });
});

test("an unreadable account fails closed", () => {
  const value: GuardReaders = { readStacks: () => { throw new Error("ExpiredToken"); }, readTemplate: () => undefined };
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], value), /Unable to read deployed stacks.*Nothing was changed/s);
});

test("a failed first create is identified from its template only, and may be deployed again", () => {
  const failed: ObservedStack = { ...stack("app-CognitoStack", "ROLLBACK_COMPLETE", null), Outputs: undefined };
  const template = { Outputs: { FrameworkDeployment: { Description: DEPLOYMENT_OUTPUT_DESCRIPTION, Value: JSON.stringify({ version: 1, ...dev }) } } };
  const { value, calls } = readers([failed, stack("app-EventsStack", "UPDATE_COMPLETE", dev)], { "app-CognitoStack": template });
  assert.equal(assertDeploymentAllowed(dev, ["--all"], value).kind, "failed");
  assert.deepEqual(calls.templates, ["app-CognitoStack"]);
});

test("an unreadable template counts as no identity", () => {
  const legacy: ObservedStack = { ...stack("app-CognitoStack", "UPDATE_COMPLETE", null), Outputs: undefined };
  const value: GuardReaders = { readStacks: () => [legacy], readTemplate: () => { throw new Error("AccessDenied"); } };
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], value), /not adopted automatically/);
});

test("a deployment that is changing, or stuck, is not deployed over", () => {
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "UPDATE_IN_PROGRESS", dev)]).value), /in progress.*app-CognitoStack \(UPDATE_IN_PROGRESS\)/s);
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "UPDATE_ROLLBACK_FAILED", dev)]).value), /needs recovery.*app-CognitoStack \(UPDATE_ROLLBACK_FAILED\).*cdk rollback/s);
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "DELETE_FAILED", dev)]).value), /app-CognitoStack \(DELETE_FAILED\).*retry the delete/s);
  const review: ObservedStack = { ...stack("app-CognitoStack", "REVIEW_IN_PROGRESS", null), Outputs: undefined };
  const reviewTemplate = { Outputs: { FrameworkDeployment: { Description: DEPLOYMENT_OUTPUT_DESCRIPTION, Value: JSON.stringify({ version: 1, ...dev }) } } };
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], readers([review], { "app-CognitoStack": reviewTemplate }).value), /app-CognitoStack \(REVIEW_IN_PROGRESS\).*holds no resources/s);
  // Paused by --no-rollback: CDK retries or rolls back first.
  assert.equal(assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "UPDATE_FAILED", dev)]).value).kind, "failed");
  assert.equal(assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "UPDATE_ROLLBACK_COMPLETE", dev)]).value).kind, "rolled-back");
});

const APP = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";
function tagged(name: string, deployment: string, mode: "dev" | "prod", stage: string, appId = APP): ObservedStack {
  return {
    StackName: name, StackStatus: "UPDATE_COMPLETE", StackId: `arn:aws:cloudformation:${dev.region}:${dev.account}:stack/${name}/id`,
    Tags: [
      { Key: "framework:owner", Value: "matts-aws-framework" }, { Key: "framework:deployment", Value: deployment },
      { Key: "framework:mode", Value: mode }, { Key: "framework:contract", Value: "2" },
      { Key: "framework:app-id", Value: appId }, { Key: "framework:stage", Value: stage },
    ],
  };
}

test("a new production deployment is refused while the same app's stage is deployed under another name", () => {
  const acme: DeploymentIdentity = { ...prod, deployment: "acme-prod" };
  const live = readers([tagged("aws-studio-prod-CognitoStack", "aws-studio-prod", "prod", "prod")]).value;
  assert.throws(() => assertDeploymentAllowed(acme, ["--all"], live, new Set(), { lineage: { appId: APP, stage: "prod" } }), (error: Error) => {
    assert.match(error.message, /^aws-studio-prod already deploys this app's prod stage in 111122223333\/eu-west-2, with its own users, database and secrets\. Deploying acme-prod would start a second production beside it, so nothing was changed\./);
    assert.match(error.message, /set "deployAs": "aws-studio-prod" in framework:targets\.prod \(cdk-app\/cdk\.json\).*For a second production, declare another stage\./);
    return true;
  });
  // Another app's production, another stage, or no lineage at all: nothing to protect.
  assert.equal(assertDeploymentAllowed(acme, ["--all"], readers([tagged("other-prod-CognitoStack", "other-prod", "prod", "prod", "0f0e0d0c-0b0a-4908-8706-050403020100")]).value, new Set(), { lineage: { appId: APP, stage: "prod" } }).kind, "absent");
  assert.equal(assertDeploymentAllowed(acme, ["--all"], live, new Set(), { lineage: { appId: APP, stage: "staging" } }).kind, "absent");
  assert.equal(assertDeploymentAllowed(acme, ["--all"], live).kind, "absent");
  // Updating the deployment that holds the stage is what deployAs is for.
  const kept: DeploymentIdentity = { ...prod, deployment: "aws-studio-prod" };
  assert.equal(assertDeploymentAllowed(kept, ["--all"], live, new Set(), { lineage: { appId: APP, stage: "prod" } }).kind, "ready");
});

test("a new development deployment proceeds, noting the earlier one of its stage still running", () => {
  const notes: string[] = [];
  const acme: DeploymentIdentity = { ...dev, deployment: "acme-dev" };
  const state = assertDeploymentAllowed(acme, ["--all"], readers([tagged("aws-studio-dev-CognitoStack", "aws-studio-dev", "dev", "dev")]).value, new Set(), { lineage: { appId: APP, stage: "dev" }, note: (message) => notes.push(message) });
  assert.equal(state.kind, "absent");
  assert.deepEqual(notes, [`aws-studio-dev, an earlier deployment of this app's dev stage, is still in 111122223333/eu-west-2 and keeps billing until you delete it. To keep deploying to it instead of acme-dev, set "deployAs": "aws-studio-dev" in framework:targets.dev (cdk-app/cdk.json); AWS Studio's Deploy page does this in one reviewed step.`]);
});
