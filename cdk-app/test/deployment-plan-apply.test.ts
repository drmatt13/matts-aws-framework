import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeAccount, frameworkStack, READ_VERB, REGION } from "./support/fake-aws-state";

/**
 * deploy:resources --plan / --apply / --discard, end to end on a simulated
 * account: the real CDK app synthesizes (offline), a fake CDK CLI deploys into
 * the account fake-aws serves, and the files an export writes land in a scratch
 * directory, never the repository's.
 */

const root = path.resolve(__dirname, "../..");
const FAKE_CDK = path.join(__dirname, "support", "fake-cdk.mjs");
const DEV_OUTPUTS = {
  UserPoolId: "us-east-1_fakepool", UserPoolClientId: "fakeclient", UserPoolDomainUrl: "https://my-aws-app-dev.auth.us-east-1.amazoncognito.com",
  ReplayBucketName: "fake-replay-bucket", ReplayQueueUrl: "https://sqs.us-east-1.amazonaws.com/734849394764/fake-replay", ReplayQueueArn: "arn:aws:sqs:us-east-1:734849394764:fake-replay",
};

function setup(state: Record<string, unknown> = {}) {
  const account = fakeAccount({ allowWrites: true, outputValues: DEV_OUTPUTS, ...state });
  const exportDirectory = path.join(account.directory, "export");
  mkdirSync(path.join(exportDirectory, "client-app"), { recursive: true });
  const inputs = path.join(account.directory, "dev.env");
  writeFileSync(inputs, [
    "CDK_APP_NAME=my-aws-app", "LOCAL_DEV_URL=http://localhost:3000", "LOCAL_AWS_REGION=us-east-1",
    "LOCAL_API_DEV_SERVER_HOST_PORT=8080", "LOCAL_WS_DEV_SERVER_HOST_PORT=8081", "LOCAL_INVOCATION_RUNNER_HOST_PORT=8090",
    "WS_TESTER_HOST_PORT=3001", "POSTGRES_HOST_PORT=5432", "PGADMIN_HOST_PORT=5050", "",
  ].join("\n"));
  const prodInputs = path.join(account.directory, "prod.env");
  writeFileSync(prodInputs, "USE_FRONTEND_CUSTOM_DOMAIN=false\nUSE_COGNITO_CUSTOM_DOMAIN=false\n");
  const env = { ...account.env, FRAMEWORK_CDK_CLI: FAKE_CDK, FRAMEWORK_EXPORT_DIRECTORY: exportDirectory, FRAMEWORK_INPUTS_FILE: inputs };
  const deploy = (extra: NodeJS.ProcessEnv, ...args: string[]) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy.ts", ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 240_000 });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  return { account, exportDirectory, inputs, prodInputs, deploy };
}

test("a development plan deploys only when applied, then verifies, records and exports", () => {
  const { account, exportDirectory, deploy } = setup();
  const planDirectory = path.join(account.directory, "plan");
  try {
    const planned = deploy({}, "--all", "--profile", "dev", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    const plan = JSON.parse(readFileSync(path.join(planDirectory, "plan.json"), "utf8"));
    assert.deepEqual([plan.status, plan.review, plan.identity.deployment, plan.identity.mode, plan.guard], ["ready", "template", "my-aws-app", "dev", "absent"]);
    assert.equal(plan.confirmation.level, "none", "a first development deployment continues on its own");
    assert.ok(plan.stacks.length >= 3 && plan.stacks.every((stack: any) => stack.changes.every((change: any) => change.action === "add")));
    assert.equal(account.read().regions?.[REGION]?.stacks?.length ?? 0, 0, "planning deploys nothing");
    assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), [], "planning writes nothing to AWS");

    const applied = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.equal(applied.status, 0, applied.output);
    assert.match(applied.output, /✔ my-aws-app-CognitoStack verified/);
    const result = JSON.parse(readFileSync(path.join(planDirectory, "result.json"), "utf8"));
    assert.equal(result.status, "succeeded");
    const state = account.read();
    assert.ok(state.regions[REGION].stacks.every((stack: any) => stack.Tags.some((tag: any) => tag.Key === "framework:contract" && tag.Value === "2")), "deployed stacks carry the contract-2 tags");
    const record = state.regions[REGION].parameters.find((parameter: any) => parameter.Name === "/framework/deployments/my-aws-app");
    assert.equal(JSON.parse(record.Value).planId, plan.planId);
    assert.ok(existsSync(path.join(exportDirectory, "client-app", ".env.development.local")), "export wrote the client settings");
    assert.match(readFileSync(path.join(exportDirectory, ".env"), "utf8"), /LOCAL_FRAMEWORK_DEPLOYMENT=my-aws-app/);
  } finally { account.dispose(); }
});

test("a production change-set review needs the typed name, and a stale plan is refused", () => {
  const { account, prodInputs, deploy } = setup();
  const planDirectory = path.join(account.directory, "prod-plan");
  try {
    const planned = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    const plan = JSON.parse(readFileSync(path.join(planDirectory, "plan.json"), "utf8"));
    assert.deepEqual([plan.review, plan.identity.deployment, plan.identity.mode, plan.confirmation.level], ["change-set", "my-aws-app-prod", "prod", "name"]);
    assert.match(plan.confirmation.reasons.join(), /first deployment/);
    const prepared = plan.stacks.filter((stack: any) => stack.changeSet);
    assert.ok(prepared.length > 0 && prepared.every((stack: any) => stack.changeSet.status === "CREATE_COMPLETE"));
    assert.ok(plan.stacks.some((stack: any) => stack.deferred), "stacks importing from stacks this plan creates wait for them");

    const unconfirmed = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.output, /needs --confirm my-aws-app-prod/);

    const state = account.read();
    const touched = state.regions[REGION].stacks.find((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS");
    touched.CreationTime = "2030-01-01T00:00:00.000Z";
    account.write(state);
    const stale = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", planDirectory, "--confirm", "my-aws-app-prod", "--profile", "dev");
    assert.notEqual(stale.status, 0);
    assert.match(stale.output, /changed since the review/);
  } finally { account.dispose(); }
});

test("discarding a change-set plan removes its change sets and the empty stacks it created", () => {
  const { account, prodInputs, deploy } = setup();
  const planDirectory = path.join(account.directory, "discard-plan");
  try {
    assert.equal(deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", planDirectory).status, 0);
    assert.ok(account.read().regions[REGION].stacks.some((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS"));
    const discarded = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--discard", planDirectory, "--profile", "dev");
    assert.equal(discarded.status, 0, discarded.output);
    assert.ok(account.read().regions[REGION].stacks.every((stack: any) => stack.StackStatus === "DELETE_COMPLETE"));
    assert.equal(existsSync(planDirectory), false);
  } finally { account.dispose(); }
});

test("planning a development deployment over a production one is refused before anything is read or written", () => {
  const { account, deploy } = setup({ regions: { [REGION]: { stacks: [frameworkStack("my-aws-app", "CognitoStack", "prod")] } } });
  try {
    const planned = deploy({}, "--all", "--profile", "dev", "--plan", path.join(account.directory, "plan"));
    assert.notEqual(planned.status, 0);
    assert.match(planned.output, /my-aws-app is a prod deployment/);
    assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), []);
    assert.equal(account.calls().some((call) => call.key.startsWith("secretsmanager")), false, "no secret is read either");
  } finally { account.dispose(); }
});

test("a confirmed production apply executes the reviewed change sets, verifies them, and reports deferred stacks", () => {
  const { account, prodInputs, deploy } = setup();
  const planDirectory = path.join(account.directory, "confirmed-plan");
  try {
    assert.equal(deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", planDirectory).status, 0);
    const plan = JSON.parse(readFileSync(path.join(planDirectory, "plan.json"), "utf8"));
    const applied = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", planDirectory, "--confirm", "my-aws-app-prod", "--profile", "dev");
    assert.equal(applied.status, 0, applied.output);
    const result = JSON.parse(readFileSync(path.join(planDirectory, "result.json"), "utf8"));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.deferred, plan.stacks.filter((stack: any) => stack.deferred).map((stack: any) => stack.name));
    assert.ok(result.verification.verified);
    const executed = account.read().cdkCalls.filter((call: string[]) => call.includes("execute-change-set"));
    assert.equal(executed.length, 1);
    for (const stack of plan.stacks.filter((entry: any) => entry.changeSet && !entry.changeSet.noChanges)) assert.ok(executed[0].includes(stack.name));
  } finally { account.dispose(); }
});
