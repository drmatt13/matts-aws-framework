import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { APP_ID, fakeAccount, frameworkStack, READ_VERB, REGION, DEV_DEPLOYMENT, PROD_DEPLOYMENT } from "./support/fake-aws-state";

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
    "LOCAL_DEV_URL=http://localhost:3000", "LOCAL_AWS_REGION=us-east-1",
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
    assert.deepEqual([plan.status, plan.review, plan.identity.deployment, plan.identity.mode, plan.guard], ["ready", "template", DEV_DEPLOYMENT, "dev", "absent"]);
    assert.equal(plan.confirmation.level, "click", "a first development deployment waits for review");
    assert.ok(plan.stacks.length >= 3 && plan.stacks.every((stack: any) => stack.changes.every((change: any) => change.action === "add")));
    assert.equal(account.read().regions?.[REGION]?.stacks?.length ?? 0, 0, "planning deploys nothing");
    assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), [], "planning writes nothing to AWS");

    const beforeDifferentProfile = account.calls().length;
    const differentProfile = deploy({}, "--apply", planDirectory, "--profile", "another-profile");
    assert.notEqual(differentProfile.status, 0);
    assert.match(differentProfile.output, /AWS profile differs from this saved review/);
    assert.deepEqual(account.calls().slice(beforeDifferentProfile), [], "another profile is refused before AWS resolution");

    const planFile = path.join(planDirectory, "plan.json");
    const originalPlanText = readFileSync(planFile, "utf8");
    const legacyPlan = { ...plan }; delete legacyPlan.callerArn;
    writeFileSync(planFile, JSON.stringify(legacyPlan));
    const beforeMissingPrincipal = account.calls().length;
    const missingPrincipal = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(missingPrincipal.status, 0);
    assert.match(missingPrincipal.output, /(?:principal|identity|actor)/i);
    assert.deepEqual(account.calls().slice(beforeMissingPrincipal), [], "a review with no actor evidence is refused before AWS resolution");
    writeFileSync(planFile, originalPlanText);

    const originalIdentity = account.read().identity;
    account.write({ ...account.read(), identity: { ...originalIdentity, Arn: originalIdentity.Arn.replace(/\/[^/]+$/, "/another-principal") } });
    const beforeDifferentPrincipal = account.calls().length;
    const differentPrincipal = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(differentPrincipal.status, 0);
    assert.match(differentPrincipal.output, /AWS principal changed after this plan was reviewed/);
    assert.deepEqual(account.calls().slice(beforeDifferentPrincipal).filter(call => !READ_VERB.test(call.key)), [], "changed identity cannot perform reviewed writes");
    assert.equal(account.calls().slice(beforeDifferentPrincipal).some(call => call.key.startsWith("secretsmanager ")), false, "actor verification precedes secret access");
    assert.equal(existsSync(path.join(planDirectory, "operation.json")), false);
    account.write({ ...account.read(), identity: originalIdentity });

    const applied = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.equal(applied.status, 0, applied.output);
    assert.match(applied.output, new RegExp(String.raw`✔ ${DEV_DEPLOYMENT}-CognitoStack verified`));
    const result = JSON.parse(readFileSync(path.join(planDirectory, "result.json"), "utf8"));
    assert.equal(result.status, "succeeded");
    const state = account.read();
    assert.ok(state.regions[REGION].stacks.every((stack: any) => stack.Tags.some((tag: any) => tag.Key === "framework:contract" && tag.Value === "2")), "deployed stacks carry the contract-2 tags");
    const tag = (stack: any, key: string) => stack.Tags.find((entry: any) => entry.Key === key)?.Value;
    assert.ok(state.regions[REGION].stacks.every((stack: any) => tag(stack, "framework:app-id") === APP_ID && tag(stack, "framework:stage") === "dev"), "deployed stacks say which app and stage they are, whatever the deployment is named");
    const record = state.regions[REGION].parameters?.find((parameter: any) => parameter.Name === `/framework/deployments/${DEV_DEPLOYMENT}`);
    assert.ok(record, "The fake deployment must persist its advisory SSM record. Apply output:\n" + applied.output);
    assert.equal(JSON.parse(record.Value).planId, plan.planId);
    assert.ok(existsSync(path.join(exportDirectory, "client-app", ".env.development.local")), "export wrote the client settings");
    assert.match(readFileSync(path.join(exportDirectory, ".env"), "utf8"), new RegExp(String.raw`LOCAL_FRAMEWORK_DEPLOYMENT=${DEV_DEPLOYMENT}`));

    // Status reads the exported files where export wrote them, and finds them current.
    const status = spawnSync(process.execPath, ["--import", "tsx", "scripts/deployment-status.ts", "status", "--deployment", DEV_DEPLOYMENT, "--profile", "dev", "--json"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: { ...account.env, FRAMEWORK_EXPORT_DIRECTORY: exportDirectory },
    });
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.deepEqual(JSON.parse(status.stdout).detail.local.exported, { deployment: DEV_DEPLOYMENT, manifest: DEV_DEPLOYMENT, client: true, fresh: true });
  } finally { account.dispose(); }
});

test("a production change-set review needs the typed name, and a stale plan is refused", () => {
  const { account, prodInputs, deploy } = setup();
  const planDirectory = path.join(account.directory, "prod-plan");
  try {
    const planned = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    const plan = JSON.parse(readFileSync(path.join(planDirectory, "plan.json"), "utf8"));
    assert.deepEqual([plan.review, plan.identity.deployment, plan.identity.mode, plan.confirmation.level], ["change-set", PROD_DEPLOYMENT, "prod", "name"]);
    assert.match(plan.confirmation.reasons.join(), /first deployment/);
    const prepared = plan.stacks.filter((stack: any) => stack.changeSet);
    assert.ok(prepared.length > 0 && prepared.every((stack: any) => stack.changeSet.status === "CREATE_COMPLETE"));
    assert.ok(plan.stacks.some((stack: any) => stack.deferred), "stacks importing from stacks this plan creates wait for them");

    const unconfirmed = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.output, new RegExp(String.raw`needs --confirm ${PROD_DEPLOYMENT}`));

    const state = account.read();
    const touched = state.regions[REGION].stacks.find((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS");
    touched.CreationTime = "2030-01-01T00:00:00.000Z";
    account.write(state);
    const stale = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", planDirectory, "--confirm", PROD_DEPLOYMENT, "--profile", "dev");
    assert.notEqual(stale.status, 0);
    assert.match(stale.output, /changed since the review/);
  } finally { account.dispose(); }
});

test("a change-set plan that fails part-way can still be discarded: what it prepared is recorded as it goes", () => {
  const { account, prodInputs, deploy } = setup({ fakeCdk: { failPrepare: [`${PROD_DEPLOYMENT}-NetworkStack`] } });
  const planDirectory = path.join(account.directory, "failed-plan");
  try {
    const planned = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", planDirectory);
    assert.notEqual(planned.status, 0);
    assert.equal(existsSync(path.join(planDirectory, "plan.json")), false, "no plan was finished");
    const preparing = JSON.parse(readFileSync(path.join(planDirectory, "preparing.json"), "utf8"));
    assert.deepEqual(preparing.stacks.map((stack: any) => stack.name), [`${PROD_DEPLOYMENT}-FrontendWebsiteS3Stack`, `${PROD_DEPLOYMENT}-NetworkStack`]);
    const before = account.read().regions[REGION].stacks;
    assert.ok(before.some((stack: any) => stack.StackName === `${PROD_DEPLOYMENT}-FrontendWebsiteS3Stack` && stack.ChangeSets?.length), "the first stack's change set exists");

    const discarded = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--discard", planDirectory, "--profile", "dev");
    assert.equal(discarded.status, 0, discarded.output);
    assert.ok(account.read().regions[REGION].stacks.every((stack: any) => stack.StackStatus === "DELETE_COMPLETE"), "the empty stacks it created are removed");
    assert.equal(existsSync(planDirectory), false);
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

test("discard cannot remove a same-name replacement review stack", () => {
  const { account, prodInputs, deploy } = setup();
  const planDirectory = path.join(account.directory, "replacement-discard-plan");
  try {
    const planned = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    const state = account.read();
    const review = state.regions[REGION].stacks.find((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS");
    review.StackId += "-replacement";
    account.write(state);
    const before = account.calls().length;
    const discarded = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--discard", planDirectory, "--profile", "dev");
    assert.notEqual(discarded.status, 0);
    assert.match(discarded.output, /exact stack identity/);
    assert.deepEqual(account.calls().slice(before).filter(call => !READ_VERB.test(call.key)), []);
    assert.equal(existsSync(planDirectory), true, "uncertain cleanup preserves the review");
  } finally { account.dispose(); }
});

test("planning a development deployment over a production one is refused before anything is read or written", () => {
  const { account, deploy } = setup({ regions: { [REGION]: { stacks: [frameworkStack(DEV_DEPLOYMENT, "CognitoStack", "prod")] } } });
  try {
    const planned = deploy({}, "--all", "--profile", "dev", "--plan", path.join(account.directory, "plan"));
    assert.notEqual(planned.status, 0);
    assert.match(planned.output, new RegExp(String.raw`${DEV_DEPLOYMENT} is a prod deployment`));
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
    const applied = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", planDirectory, "--confirm", PROD_DEPLOYMENT, "--profile", "dev");
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

// A reviewed secret write is bound to the review: the authored value, and the
// AWS version it replaces. The sentinels must never appear in any output, file or record.
const BINDINGS = path.join(root, ".cache/deploy/secret-bindings");
const REVIEWED_VALUE = "sentinel-reviewed-google-secret";
const EDITED_VALUE = "sentinel-edited-google-secret";
const PREVIOUS_VALUE = "sentinel-previous-google-secret";
const OPENAI_VALUE = "sentinel-openai-key";

function ownedSecret(deployment: string, variable: string, resourcePath: string, value: string) {
  return {
    Name: `${deployment}/secret/${variable}`, ARN: `arn:aws:secretsmanager:${REGION}:734849394764:secret:${deployment}/secret/${variable}-QrStUv`,
    SecretString: value, VersionId: "version-before-review",
    Tags: [{ Key: "framework:deployment", Value: deployment }, { Key: "framework:resource", Value: resourcePath }, { Key: "framework:environment", Value: variable }],
  };
}
const secretOf = (account: { read(): any }, name: string) => account.read().regions[REGION].secrets.find((secret: any) => secret.Name === name);
const writesOf = (account: { calls(): { key: string }[] }) => account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key));
const planIdOf = (directory: string) => JSON.parse(readFileSync(path.join(directory, "plan.json"), "utf8")).planId as string;
function assertNoSentinel(text: string, where: string) {
  for (const value of [REVIEWED_VALUE, EDITED_VALUE, PREVIOUS_VALUE, OPENAI_VALUE]) assert.ok(!text.includes(value), `${where} carries no secret value`);
}

function withGoogle(inputs: string, value: string) {
  const lines = readFileSync(inputs, "utf8").split("\n").filter((line) => line && !line.startsWith("GOOGLE_"));
  writeFileSync(inputs, [...lines, "GOOGLE_CLIENT_ID=fake-google-client", `GOOGLE_CLIENT_SECRET=${value}`, ""].join("\n"));
}

test("a reviewed secret update applies only with the reviewed value, and no value reaches any output or record", () => {
  const google = ownedSecret(DEV_DEPLOYMENT, "GOOGLE_CLIENT_SECRET", "googleClientSecret", PREVIOUS_VALUE);
  const { account, inputs, deploy } = setup({ regions: { [REGION]: { secrets: [google] } } });
  const planDirectory = path.join(account.directory, "secret-plan");
  let planId: string | undefined;
  try {
    withGoogle(inputs, REVIEWED_VALUE);
    const planned = deploy({}, "--all", "--profile", "dev", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    planId = planIdOf(planDirectory);
    const plan = JSON.parse(readFileSync(path.join(planDirectory, "plan.json"), "utf8"));
    assert.deepEqual(plan.secrets, [{ name: google.Name, variable: "GOOGLE_CLIENT_SECRET", action: "update" }]);
    assert.deepEqual(writesOf(account), [], "planning writes nothing, secrets included");
    const bindingFile = path.join(BINDINGS, `${planId}.json`);
    assert.ok(existsSync(bindingFile), "the review's binding is kept outside the plan directory");
    if (process.platform !== "win32") assert.equal(statSync(bindingFile).mode & 0o777, 0o600);
    assertNoSentinel(planned.output + readFileSync(path.join(planDirectory, "plan.json"), "utf8") + readFileSync(bindingFile, "utf8"), "planning");

    // The value is edited after the review: still an "update" by name, but not the reviewed one.
    withGoogle(inputs, EDITED_VALUE);
    const edited = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(edited.status, 0);
    assert.match(edited.output, new RegExp(String.raw`the authored value of GOOGLE_CLIENT_SECRET \(${DEV_DEPLOYMENT}\/secret\/GOOGLE_CLIENT_SECRET\) changed\. Plan again\. Nothing was changed\.`));
    assertNoSentinel(edited.output, "the refusal");
    assert.deepEqual(writesOf(account), []);
    assert.equal((account.read().cdkCalls ?? []).some((call: string[]) => call[0] === "deploy"), false, "no stack deployment started");
    assert.equal(secretOf(account, google.Name).SecretString, PREVIOUS_VALUE);
    assert.equal(existsSync(path.join(planDirectory, "result.json")), false);

    // Restored to the reviewed value, the same plan applies.
    withGoogle(inputs, REVIEWED_VALUE);
    const applied = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.equal(applied.status, 0, applied.output);
    assert.equal(secretOf(account, google.Name).SecretString, REVIEWED_VALUE);
    assert.equal(secretOf(account, google.Name).Tags.find((tag: any) => tag.Key === "area")?.Value, "auth");
    assert.deepEqual(writesOf(account).filter((key) => key.startsWith("secretsmanager")), ["secretsmanager put-secret-value", "secretsmanager tag-resource"]);
    assert.equal(JSON.parse(readFileSync(path.join(planDirectory, "result.json"), "utf8")).status, "succeeded");
    assert.equal(existsSync(bindingFile), false, "an applied plan's binding is removed");
    const record = account.read().regions[REGION].parameters.find((parameter: any) => parameter.Name === `/framework/deployments/${DEV_DEPLOYMENT}`);
    assertNoSentinel(applied.output + readFileSync(path.join(planDirectory, "result.json"), "utf8") + record.Value, "applying");

    const again = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(again.status, 0);
    assert.match(again.output, /was already applied/);
  } finally {
    if (planId) rmSync(path.join(BINDINGS, `${planId}.json`), { force: true });
    account.dispose();
  }
});

test("a secret written in AWS after the review, or a missing binding, refuses the apply", () => {
  const google = ownedSecret(DEV_DEPLOYMENT, "GOOGLE_CLIENT_SECRET", "googleClientSecret", PREVIOUS_VALUE);
  const { account, inputs, deploy } = setup({ regions: { [REGION]: { secrets: [google] } } });
  const planDirectory = path.join(account.directory, "drift-plan");
  let planId: string | undefined;
  try {
    withGoogle(inputs, REVIEWED_VALUE);
    const planned = deploy({}, "--all", "--profile", "dev", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    planId = planIdOf(planDirectory);
    const state = account.read();
    const stored = state.regions[REGION].secrets[0];
    stored.SecretString = "written-by-someone-else";
    stored.VersionId = "version-after-review";
    account.write(state);
    const drifted = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.output, new RegExp(String.raw`${DEV_DEPLOYMENT}\/secret\/GOOGLE_CLIENT_SECRET changed in Secrets Manager`));
    assert.deepEqual(writesOf(account), []);
    assert.equal(secretOf(account, google.Name).SecretString, "written-by-someone-else");

    rmSync(path.join(BINDINGS, `${planId}.json`));
    const callsBefore = account.calls().length;
    const unbound = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(unbound.status, 0);
    assert.match(unbound.output, /has no secret binding/);
    assert.equal(account.calls().length, callsBefore, "refused before any AWS call");
  } finally {
    if (planId) rmSync(path.join(BINDINGS, `${planId}.json`), { force: true });
    account.dispose();
  }
});

test("--create-secrets creates only missing secrets: an existing secret's new value waits for the confirmed apply", () => {
  const google = ownedSecret(PROD_DEPLOYMENT, "GOOGLE_CLIENT_SECRET", "googleClientSecret", PREVIOUS_VALUE);
  const { account, prodInputs, deploy } = setup({ regions: { [REGION]: { secrets: [google] } } });
  writeFileSync(prodInputs, [
    "USE_FRONTEND_CUSTOM_DOMAIN=false", "USE_COGNITO_CUSTOM_DOMAIN=false", "GOOGLE_CLIENT_ID=fake-google-client", `GOOGLE_CLIENT_SECRET=${REVIEWED_VALUE}`,
    "LANGGRAPH_MODEL_PROVIDER=openai", `OPENAI_API_KEY=${OPENAI_VALUE}`, "",
  ].join("\n"));
  const openai = `${PROD_DEPLOYMENT}/secret/OPENAI_API_KEY`;
  const first = path.join(account.directory, "needs-secrets");
  const second = path.join(account.directory, "with-secrets");
  let planId: string | undefined;
  try {
    const waiting = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", first);
    assert.equal(waiting.status, 0, waiting.output);
    const needs = JSON.parse(readFileSync(path.join(first, "plan.json"), "utf8"));
    assert.equal(needs.status, "needs-secrets");
    assert.deepEqual(writesOf(account), [], "without --create-secrets nothing is written");
    assert.equal(existsSync(path.join(BINDINGS, `${needs.planId}.json`)), false, "a plan that cannot be applied binds nothing");

    const planned = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--all", "-c", "prodDeployment=true", "--profile", "dev", "--plan", second, "--create-secrets");
    assert.equal(planned.status, 0, planned.output);
    planId = planIdOf(second);
    const plan = JSON.parse(readFileSync(path.join(second, "plan.json"), "utf8"));
    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.secrets.map((secret: any) => [secret.name, secret.action]), [[google.Name, "update"], [openai, "unchanged"]]);
    assert.match(plan.uncertainties.join("\n"), new RegExp(String.raw`Created before review so the change sets could reference them: ${PROD_DEPLOYMENT}\/secret\/OPENAI_API_KEY\.`));
    assert.doesNotMatch(plan.uncertainties.join("\n"), /GOOGLE_CLIENT_SECRET/);
    const secretWrites = writesOf(account).filter((key) => key.startsWith("secretsmanager"));
    assert.deepEqual(secretWrites, ["secretsmanager create-secret"], "planning creates the missing secret and updates none");
    assert.equal(secretOf(account, google.Name).SecretString, PREVIOUS_VALUE, "the running application still reads the previous value");
    assertNoSentinel(planned.output + readFileSync(path.join(second, "plan.json"), "utf8") + readFileSync(path.join(BINDINGS, `${planId}.json`), "utf8"), "planning with --create-secrets");

    const applied = deploy({ FRAMEWORK_INPUTS_FILE: prodInputs }, "--apply", second, "--confirm", PROD_DEPLOYMENT, "--profile", "dev");
    assert.equal(applied.status, 0, applied.output);
    assert.deepEqual(writesOf(account).filter((key) => key.startsWith("secretsmanager")), ["secretsmanager create-secret", "secretsmanager put-secret-value", "secretsmanager tag-resource"]);
    assert.equal(secretOf(account, google.Name).SecretString, REVIEWED_VALUE);
    assert.equal(secretOf(account, openai).SecretString, OPENAI_VALUE);
    assert.equal(secretOf(account, openai).Tags.find((tag: any) => tag.Key === "area")?.Value, "examples");
    assertNoSentinel(applied.output, "applying");
  } finally {
    if (planId) rmSync(path.join(BINDINGS, `${planId}.json`), { force: true });
    account.dispose();
  }
});

test("a secret write that fails during apply stops before any stack deploys and claims no success", () => {
  const google = ownedSecret(DEV_DEPLOYMENT, "GOOGLE_CLIENT_SECRET", "googleClientSecret", PREVIOUS_VALUE);
  const { account, inputs, deploy } = setup({ regions: { [REGION]: { secrets: [google] } } });
  const planDirectory = path.join(account.directory, "failing-plan");
  let planId: string | undefined;
  try {
    withGoogle(inputs, REVIEWED_VALUE);
    assert.equal(deploy({}, "--all", "--profile", "dev", "--plan", planDirectory).status, 0);
    planId = planIdOf(planDirectory);
    const state = account.read();
    state.failures = { "secretsmanager put-secret-value": "denied" };
    account.write(state);
    const failed = deploy({}, "--apply", planDirectory, "--profile", "dev");
    assert.notEqual(failed.status, 0);
    assert.match(failed.output, new RegExp(String.raw`Secret synchronization failed for ${DEV_DEPLOYMENT}\/secret\/GOOGLE_CLIENT_SECRET\. Secret updates already performed: none\. No infrastructure deployment was started\.`));
    assert.doesNotMatch(failed.output, /Updated managed secret/);
    assertNoSentinel(failed.output, "the failure");
    assert.equal((account.read().cdkCalls ?? []).some((call: string[]) => call[0] === "deploy"), false);
    assert.equal(existsSync(path.join(planDirectory, "result.json")), false, "no result is recorded");
    assert.equal(secretOf(account, google.Name).SecretString, PREVIOUS_VALUE);
  } finally {
    if (planId) rmSync(path.join(BINDINGS, `${planId}.json`), { force: true });
    account.dispose();
  }
});
