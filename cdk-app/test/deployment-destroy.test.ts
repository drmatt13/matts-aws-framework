import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fakeAccount, frameworkStack, READ_VERB, REGION } from "./support/fake-aws-state";

const root = path.resolve(__dirname, "../..");

function destroy(env: NodeJS.ProcessEnv, ...args: string[]) {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/destroy.ts", ...args], { cwd: root, env: { ...env, FRAMEWORK_POLL_MS: "5" }, encoding: "utf8", timeout: 120_000 });
  return { status: run.status, output: `${run.stdout}${run.stderr}`, json: (() => { try { return JSON.parse(run.stdout); } catch { return undefined; } })() };
}

function productionAccount(extra: Record<string, unknown> = {}) {
  const cognito = frameworkStack("my-aws-app-prod", "CognitoStack", "prod", {
    outputs: [{ OutputKey: "UserPoolId", OutputValue: "pool", ExportName: "my-aws-app-prod-CognitoStack:UserPoolId" }],
    template: { Resources: { Pool: { Type: "AWS::Cognito::UserPool", DeletionPolicy: "Retain" } } },
  });
  const api = frameworkStack("my-aws-app-prod", "HttpApiGatewayStack", "prod");
  const rds = frameworkStack("my-aws-app-prod", "RdsStack", "prod", { template: { Resources: { Database: { Type: "AWS::RDS::DBInstance", DeletionPolicy: "Snapshot" } } } });
  return fakeAccount({
    allowWrites: true,
    regions: { [REGION]: {
      stacks: [{ ...cognito, EnableTerminationProtection: true }, api, rds, frameworkStack("my-aws-app", "CognitoStack", "dev")],
      imports: { "my-aws-app-prod-CognitoStack:UserPoolId": ["my-aws-app-prod-HttpApiGatewayStack"] },
      secrets: [{ Name: "my-aws-app-prod/secret/OPENAI_API_KEY", ARN: "arn:aws:secretsmanager:us-east-1:734849394764:secret:x-AbCdEf", SecretString: "sentinel" }],
      parameters: [{ Name: "/framework/deployments/my-aws-app-prod", Value: "{}" }],
    } },
    ...extra,
  });
}

test("a teardown plan lists stacks importers first, and what deletion leaves behind, reading only", () => {
  const account = productionAccount();
  try {
    const result = destroy(account.env, "--deployment", "my-aws-app-prod", "-c", "prodDeployment=true", "--profile", "dev", "--plan", "--json");
    assert.equal(result.status, 0, result.output);
    const plan = result.json;
    const order = plan.stacks.map((stack: any) => stack.name);
    assert.ok(order.indexOf("my-aws-app-prod-HttpApiGatewayStack") < order.indexOf("my-aws-app-prod-CognitoStack"), "the importer goes first");
    assert.ok(!order.includes("my-aws-app-CognitoStack"), "another deployment's stacks are never included");
    assert.deepEqual(plan.remains.map((item: any) => [item.logicalId, item.policy]).sort(), [["Database", "Snapshot"], ["Pool", "Retain"]]);
    assert.deepEqual(plan.secrets, ["my-aws-app-prod/secret/OPENAI_API_KEY"]);
    assert.equal(plan.stacks.find((stack: any) => stack.name === "my-aws-app-prod-CognitoStack").terminationProtection, true);
    assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), []);
    assert.doesNotMatch(result.output, /sentinel/);
  } finally { account.dispose(); }
});

test("production is never deleted without stating it, and never without the typed name", () => {
  const account = productionAccount();
  try {
    assert.match(destroy(account.env, "--deployment", "my-aws-app-prod", "--profile", "dev", "--confirm", "my-aws-app-prod").output, /production deployment. State it explicitly with -c prodDeployment=true/);
    assert.match(destroy(account.env, "--deployment", "my-aws-app-prod", "-c", "prodDeployment=true", "--profile", "dev", "--confirm", "my-aws-app").output, /does not name my-aws-app-prod/);
    const unconfirmed = destroy(account.env, "--deployment", "my-aws-app-prod", "-c", "prodDeployment=true", "--profile", "dev");
    assert.equal(unconfirmed.status, 0);
    assert.match(unconfirmed.output, /Nothing was deleted. To delete it, run again with --confirm my-aws-app-prod/);
    assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), []);
  } finally { account.dispose(); }
});

test("a confirmed teardown deletes in order, lifts termination protection, removes the record and verifies", () => {
  const account = productionAccount();
  try {
    const result = destroy(account.env, "--deployment", "my-aws-app-prod", "-c", "prodDeployment=true", "--profile", "dev", "--confirm", "my-aws-app-prod");
    assert.equal(result.status, 0, result.output);
    const writes = account.calls().filter((call) => !READ_VERB.test(call.key));
    const deletes = writes.filter((call) => call.key === "cloudformation delete-stack").map((call) => call.options["stack-name"]);
    assert.ok(deletes.indexOf("my-aws-app-prod-HttpApiGatewayStack") < deletes.indexOf("my-aws-app-prod-CognitoStack"));
    assert.ok(writes.findIndex((call) => call.key === "cloudformation update-termination-protection") < writes.findIndex((call) => call.options["stack-name"] === "my-aws-app-prod-CognitoStack" && call.key === "cloudformation delete-stack"));
    assert.ok(writes.some((call) => call.key === "ssm delete-parameter"));
    const remaining = account.read().regions[REGION].stacks.filter((stack: any) => stack.StackStatus !== "DELETE_COMPLETE").map((stack: any) => stack.StackName);
    assert.deepEqual(remaining, ["my-aws-app-CognitoStack"], "only the other deployment remains");
    assert.match(result.output, /my-aws-app-prod is deleted/);
  } finally { account.dispose(); }
});

test("a stack that fails to delete stops the teardown and names what CloudFormation could not remove", () => {
  const account = productionAccount();
  try {
    const state = account.read();
    const api = state.regions[REGION].stacks.find((stack: any) => stack.StackName === "my-aws-app-prod-HttpApiGatewayStack");
    api.failDelete = true;
    api.Events = [{ EventId: "f1", Timestamp: "2026-10-18T00:00:00Z", LogicalResourceId: "Api", ResourceType: "AWS::ApiGatewayV2::Api", ResourceStatus: "DELETE_FAILED", ResourceStatusReason: "in use" }];
    account.write(state);
    const result = destroy(account.env, "--deployment", "my-aws-app-prod", "-c", "prodDeployment=true", "--profile", "dev", "--confirm", "my-aws-app-prod");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /could not be deleted: CloudFormation could not delete Api.*--retain-failed/s);
    assert.equal(account.calls().filter((call) => call.key === "cloudformation delete-stack").length, 1, "nothing after it was deleted");
  } finally { account.dispose(); }
});
