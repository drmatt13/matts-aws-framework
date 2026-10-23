import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertCognitoDomainReview, cognitoDomainChanges } from "../../scripts/deployment-cognito-domains";
import { fakeAccount, frameworkStack, READ_VERB, REGION } from "./support/fake-aws-state";

const domain = { Type: "AWS::Cognito::UserPoolDomain", Properties: { Domain: "auth.example.com", UserPoolId: { Ref: "Pool" }, CustomDomainConfig: { CertificateArn: "arn:aws:acm:us-east-1:734849394764:certificate/fake" } } };
const before = { Resources: { Domain: domain } };
test("development domain compatibility distinguishes replacement/removal from certificate renewal", () => {
  assert.deepEqual(cognitoDomainChanges("Auth", before, structuredClone(before)), []);
  const renewed = structuredClone(before);
  renewed.Resources.Domain.Properties.CustomDomainConfig.CertificateArn += "-renewed";
  assert.deepEqual(cognitoDomainChanges("Auth", before, renewed), []);
  const alternatives: Parameters<typeof cognitoDomainChanges>[2][] = [
    { Resources: {} },
    { Resources: { Renamed: domain } },
    { Resources: { Domain: { ...domain, Properties: { Domain: "generated-prefix", UserPoolId: { Ref: "Pool" } } } } },
    { Resources: { Domain: { ...domain, Properties: { ...domain.Properties, UserPoolId: { Ref: "AnotherPool" } } } } },
    { Resources: { Domain: { ...domain, Condition: "NewCondition" } } },
  ];
  for (const after of alternatives) assert.equal(cognitoDomainChanges("Auth", before, after).length, 1);
  assert.deepEqual(cognitoDomainChanges("Auth", undefined, before), [], "new domains have no historical resource to protect");
  const conditional = { ...before, Resources: { Domain: { ...domain, Condition: "KeepDomain" } }, Conditions: { KeepDomain: { "Fn::Equals": ["yes", "yes"] } } };
  assert.equal(cognitoDomainChanges("Auth", conditional, { ...conditional, Conditions: { KeepDomain: { "Fn::Equals": ["no", "yes"] } } }).length, 1, "an unchanged condition name cannot hide its changed definition");
  const parameterized = { ...before, Parameters: { Domain: { Type: "String", Default: "auth.example.com" } }, Resources: { Domain: { ...domain, Properties: { ...domain.Properties, Domain: { Ref: "Domain" } } } } };
  assert.equal(cognitoDomainChanges("Auth", parameterized, { ...parameterized, Parameters: { Domain: { Type: "String", Default: "other.example.com" } } }).length, 1, "unchanged references cannot conceal changed parameter defaults");
  const changes = cognitoDomainChanges("Auth", before, { Resources: {} });
  const review = { cognitoDomainChanges: changes, confirmation: { level: "name", reasons: changes.map(change => change.consequence) } };
  assert.match(changes[0]!.consequence, /Hosted sign-in and federation redirect URLs/);
  assert.throws(() => assertCognitoDomainReview(changes, { confirmation: { level: "click", reasons: [] } }, "dev", "dev"), /Create and review a new deployment plan/);
  assert.throws(() => assertCognitoDomainReview(changes, { ...review, confirmation: { level: "name", reasons: [] } }, "dev", "dev"), /authentication consequences/);
  assert.throws(() => assertCognitoDomainReview(changes, review, "dev"), /--confirm dev/);
  assert.doesNotThrow(() => assertCognitoDomainReview(changes, review, "dev", "dev"));
});

test("real deployment wrapper blocks direct dev-domain migration, reviews its consequence, and rechecks saved-plan application before writes", () => {
  const root = path.resolve(__dirname, "../..");
  // Keep this wrapper's deployment locks, secret bindings and scripts apart
  // from concurrently running plan/apply tests. Synthesis still exercises the
  // real application; only its AWS/CDK transports are the offline fixtures.
  const directory = mkdtempSync(path.join(os.tmpdir(), "cognito-domain-guard-"));
  cpSync(path.join(root, "scripts"), path.join(directory, "scripts"), { recursive: true });
  mkdirSync(path.join(directory, "cdk-app"));
  cpSync(path.join(root, "cdk-app/cdk.json"), path.join(directory, "cdk-app/cdk.json"));
  cpSync(path.join(root, "package.json"), path.join(directory, "package.json"));
  cpSync(path.join(root, "framework-config"), path.join(directory, "framework-config"), { recursive: true });
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
  writeFileSync(path.join(directory, "framework.config.ts"), `export { default } from ${JSON.stringify(path.join(root, "framework.config.ts"))};`);
  const cdk = path.join(directory, "offline-cdk.mjs");
  writeFileSync(cdk, `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(__dirname, "support/fake-cdk.mjs"))}, ...args], {
  cwd: args[0] === "synth" ? ${JSON.stringify(path.join(root, "cdk-app"))} : process.cwd(), env: process.env, stdio: "inherit"
});
process.exit(result.status ?? 1);
`);
  const account = fakeAccount({ allowWrites: true, outputValues: {
    UserPoolId: "us-east-1_fakepool", UserPoolClientId: "fakeclient", UserPoolDomainUrl: "https://generated.auth.us-east-1.amazoncognito.com",
    ReplayBucketName: "fake-replay-bucket", ReplayQueueUrl: "https://sqs.us-east-1.amazonaws.com/734849394764/fake-replay", ReplayQueueArn: "arn:aws:sqs:us-east-1:734849394764:fake-replay",
  } });
  const inputs = path.join(account.directory, "dev.env");
  const exportDirectory = path.join(account.directory, "export");
  mkdirSync(path.join(exportDirectory, "client-app"), { recursive: true });
  writeFileSync(inputs, ["CDK_APP_NAME=my-aws-app", "LOCAL_DEV_URL=http://localhost:3000", "LOCAL_AWS_REGION=us-east-1", "LOCAL_API_DEV_SERVER_HOST_PORT=8080", "LOCAL_WS_DEV_SERVER_HOST_PORT=8081", "LOCAL_INVOCATION_RUNNER_HOST_PORT=8090", "WS_TESTER_HOST_PORT=3001", "POSTGRES_HOST_PORT=5432", "PGADMIN_HOST_PORT=5050", ""].join("\n"));
  const deploy = (...args: string[]) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy.ts", ...args, "--profile", "dev"], {
      cwd: directory, encoding: "utf8", timeout: 240_000,
      env: { ...account.env, FRAMEWORK_CDK_CLI: cdk, FRAMEWORK_EXPORT_DIRECTORY: exportDirectory, FRAMEWORK_INPUTS_FILE: inputs },
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  const writesSince = (start: number) => account.calls().slice(start).filter(call => !READ_VERB.test(call.key));
  try {
    // The real entry point supplies the current logical IDs. Only the domain
    // properties are changed to model a previously owned development domain.
    const seed = path.join(account.directory, "seed");
    const seeded = deploy("--all", "--plan", seed);
    assert.equal(seeded.status, 0, seeded.output);
    const manifest = JSON.parse(readFileSync(path.join(seed, "assembly/manifest.json"), "utf8"));
    const artifact = Object.entries<any>(manifest.artifacts).find(([id, entry]) => entry.type === "aws:cloudformation:stack" && (entry.properties.stackName ?? id).endsWith("-CognitoStack"))![1];
    const previous = JSON.parse(readFileSync(path.join(seed, "assembly", artifact.properties.templateFile), "utf8"));
    const id = Object.keys(previous.Resources).find(id => previous.Resources[id].Type === "AWS::Cognito::UserPoolDomain")!;
    previous.Resources[id].Properties = { ...previous.Resources[id].Properties, ...domain.Properties, UserPoolId: previous.Resources[id].Properties.UserPoolId };
    const owned = frameworkStack("my-aws-app", "CognitoStack", "dev", { template: previous });
    account.write({ ...account.read(), regions: { [REGION]: { stacks: [owned] } } });
    let start = account.calls().length;
    const direct = deploy("--all");
    assert.notEqual(direct.status, 0);
    assert.match(direct.output, /Direct deployment is refused/);
    assert.match(direct.output, /Hosted sign-in and federation redirect URLs/);
    assert.deepEqual(writesSince(start), []);
    assert.equal(account.calls().slice(start).some(call => call.key.startsWith("secretsmanager ")), false, "direct refusal precedes all secret reads and writes");

    const planDirectory = path.join(account.directory, "migration");
    start = account.calls().length;
    const planned = deploy("--all", "--plan", planDirectory);
    assert.equal(planned.status, 0, planned.output);
    assert.deepEqual(writesSince(start), [], "template review mutates no AWS resources");
    const planFile = path.join(planDirectory, "plan.json");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    assert.equal(plan.confirmation.level, "name");
    assert.equal(plan.cognitoDomainChanges.length, 1);
    assert.equal(plan.cognitoDomainChanges[0].previousDomain, "auth.example.com");
    assert.match(plan.confirmation.reasons.join(" "), /remove or replace existing development Cognito custom domain auth.example.com/);

    start = account.calls().length;
    const unconfirmed = deploy("--apply", planDirectory);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.output, /needs --confirm my-aws-app/);
    const old = structuredClone(plan);
    delete old.cognitoDomainChanges;
    old.confirmation = { level: "click", reasons: [] };
    writeFileSync(planFile, JSON.stringify(old));
    const oldApply = deploy("--apply", planDirectory, "--confirm", "my-aws-app");
    assert.notEqual(oldApply.status, 0);
    assert.match(oldApply.output, /review does not include.*custom-domain migration/);
    assert.deepEqual(writesSince(start), [], "an older review cannot bypass the migration review by typing a name");

    writeFileSync(planFile, JSON.stringify(plan));
    const changed = account.read();
    changed.regions[REGION].stacks[0].Template.Resources[id].Properties.Domain = "changed.example.com";
    account.write(changed);
    const stale = deploy("--apply", planDirectory, "--confirm", "my-aws-app");
    assert.notEqual(stale.status, 0);
    assert.match(stale.output, /Create and review a new deployment plan/);
    assert.deepEqual(writesSince(start), []);
    account.write({ ...account.read(), regions: { [REGION]: { stacks: [owned] } } });

    const unavailable = account.read();
    unavailable.failures = { "cloudformation get-template": "denied" };
    account.write(unavailable);
    const blocked = deploy("--apply", planDirectory, "--confirm", "my-aws-app");
    assert.notEqual(blocked.status, 0);
    assert.deepEqual(writesSince(start), [], "unreadable deployed templates cannot approve a migration");
    delete unavailable.failures;
    account.write(unavailable);

    const applied = deploy("--apply", planDirectory, "--confirm", "my-aws-app");
    assert.equal(applied.status, 0, applied.output);
    const result = JSON.parse(readFileSync(path.join(planDirectory, "result.json"), "utf8"));
    assert.equal(result.status, "succeeded");
    const current = account.read().regions[REGION].stacks.find((stack: any) => stack.StackName.endsWith("-CognitoStack"));
    assert.equal(current.Template.Resources[id].Properties.CustomDomainConfig, undefined);
  } finally { account.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
