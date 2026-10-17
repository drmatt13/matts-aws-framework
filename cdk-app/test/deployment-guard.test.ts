import assert from "node:assert/strict";
import test from "node:test";
import { DEPLOYMENT_OUTPUT_DESCRIPTION, type DeploymentIdentity, type ObservedStack } from "@repo/framework/deploy";
import { assertDeploymentAllowed, unsafeProductionFlags, type GuardReaders } from "../../scripts/deployment-guard";

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
  for (const args of [["--all", "--require-approval", "broadening", "--rollback", "true"], ["--all", "--profile", "yes"], ["--hotswap=false"], ["-c", "rollback=false"]]) {
    assert.deepEqual(unsafeProductionFlags(args), [], args.join(" "));
  }
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
    assert.match(error.message, /destroy:resources/);
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
  assert.throws(() => assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "UPDATE_ROLLBACK_FAILED", dev)]).value), /needs recovery.*app-CognitoStack \(UPDATE_ROLLBACK_FAILED\)/s);
  assert.equal(assertDeploymentAllowed(dev, ["--all"], readers([stack("app-CognitoStack", "UPDATE_ROLLBACK_COMPLETE", dev)]).value).kind, "rolled-back");
});
