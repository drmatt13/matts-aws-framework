import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { ACCOUNT, fakeAccount, frameworkStack, READ_VERB, REGION } from "./support/fake-aws-state";

const root = path.resolve(__dirname, "../..");
function status(env: NodeJS.ProcessEnv, ...args: string[]) {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/deployment-status.ts", ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  const text = run.stdout.trim();
  return { status: run.status, stderr: run.stderr, text, lines: text.split(/\r?\n/).filter(Boolean), json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
}

test("discovery finds framework deployments by their own records, reading only", () => {
  const account = fakeAccount({ regions: { [REGION]: { stacks: [
    frameworkStack("my-aws-app", "CognitoStack", "dev", { contract: 1 }),
    frameworkStack("my-aws-app", "DevLambdaReplayStack", "dev", { contract: 1 }),
    frameworkStack("my-aws-app-prod", "CognitoStack", "prod"),
    frameworkStack("alex-dev", "CognitoStack", "dev", { status: "UPDATE_IN_PROGRESS" }),
    { StackName: "my-aws-app-prod-OrphanStack", StackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/my-aws-app-prod-OrphanStack/9`, StackStatus: "CREATE_COMPLETE", Template: { Resources: {} } },
    { StackName: "CDKToolkit", StackId: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/CDKToolkit/1`, StackStatus: "UPDATE_COMPLETE" },
  ] } } });
  try {
    const result = status(account.env, "discover", "--profile", "dev", "--json");
    assert.equal(result.status, 0, result.stderr);
    const { context, deployments, targets, unrecognized } = result.json;
    assert.deepEqual([context.account, context.region, context.profile], [ACCOUNT, REGION, "dev"]);
    assert.deepEqual(deployments.map((deployment: any) => [deployment.name, deployment.mode, deployment.state.kind, deployment.contracts]), [
      ["alex-dev", "dev", "in-progress", [2]],
      ["my-aws-app", "dev", "ready", [1]],
      ["my-aws-app-prod", "prod", "conflict", [2]],
    ]);
    assert.equal(deployments[2].state.reason, "unmarked", "the orphan lookalike is refused, not adopted");
    assert.deepEqual(targets.map((target: any) => [target.name, target.status]), [["my-aws-app", "deployed"], ["my-aws-app-prod", "deployed"]]);
    assert.deepEqual(unrecognized, []);
    const keys = account.calls().map((call) => call.key);
    assert.ok(keys.length > 0);
    assert.deepEqual(keys.filter((key) => !READ_VERB.test(key)), [], "discovery never calls a mutating verb");
  } finally { account.dispose(); }
});

test("an expired session is reported as such, with nothing else attempted", () => {
  const account = fakeAccount({ failures: { "sts get-caller-identity": "expired" } });
  try {
    const result = status(account.env, "discover", "--profile", "dev", "--json");
    assert.equal(result.status, 2);
    assert.equal(result.json.error.kind, "expired");
    assert.match(result.json.error.message, /aws sso login/);
    assert.deepEqual(account.calls().map((call) => call.key), ["sts get-caller-identity"]);
  } finally { account.dispose(); }
});

test("profiles list names, regions and credential kinds, never credentials", () => {
  const account = fakeAccount({});
  try {
    const result = status(account.env, "profiles", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, [{ name: "default", kind: "static", region: "eu-west-2" }, { name: "dev", kind: "sso", region: REGION }]);
    assert.doesNotMatch(result.text, /sentinel|AKIA|awsapps/);
  } finally { account.dispose(); }
});

test("status adds events, pending change sets and whether local development can run", () => {
  const account = fakeAccount({ regions: { [REGION]: { stacks: [frameworkStack("my-aws-app", "CognitoStack", "dev")] } } });
  try {
    const state = account.read();
    state.regions[REGION].stacks[0].ChangeSets = [{ ChangeSetName: "framework-plan-1", Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" }];
    account.write(state);
    const result = status(account.env, "status", "--profile", "dev", "--json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.deployment, "my-aws-app");
    assert.equal(result.json.detail.events[0].stack, "my-aws-app-CognitoStack");
    assert.deepEqual(result.json.detail.changeSets.map((set: any) => [set.name, set.ours]), [["framework-plan-1", true]]);
    assert.equal(typeof result.json.detail.local.compatible, "boolean");
    assert.equal(result.json.detail.local.compatible, false, "a deployment missing required control outputs cannot back local development");
    assert.deepEqual(account.calls().filter((call) => !READ_VERB.test(call.key)), []);
  } finally { account.dispose(); }
});

test("watch reports stack state and stops once nothing is changing", () => {
  const account = fakeAccount({ regions: { [REGION]: { stacks: [frameworkStack("my-aws-app", "CognitoStack", "dev")] } } });
  try {
    const result = status(account.env, "watch", "--deployment", "my-aws-app", "--profile", "dev", "--interval", "10", "--jsonl");
    assert.equal(result.status, 0, result.stderr);
    const types = result.lines.map((line) => JSON.parse(line).type);
    assert.deepEqual([types[0], types[1], types[types.length - 1]], ["context", "stacks", "idle"]);
  } finally { account.dispose(); }
});
