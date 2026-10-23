import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assemblyDigest } from "../../scripts/deployment-integrity";
import { ACCOUNT, fakeAccount, frameworkStack, READ_VERB, REGION } from "./support/fake-aws-state";

const root = path.resolve(__dirname, "../..");
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "deployment-recovery-"));
  cpSync(path.join(root, "scripts"), path.join(directory, "scripts"), { recursive: true });
  mkdirSync(path.join(directory, "cdk-app"));
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
  writeFileSync(path.join(directory, "package.json"), '{"private":true}');
  writeFileSync(path.join(directory, "cdk-app/cdk.json"), '{"context":{}}');
  writeFileSync(path.join(directory, "framework.config.ts"), "import { defaults } from " + JSON.stringify(path.join(root, "framework-config/defaults.ts")) + "; export default { defaults, http:{}, webSocket:{}, events:{}, services:{} };");
  return { directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
function run(directory: string, env: NodeJS.ProcessEnv, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/" + script, ...args], { cwd: directory, env, encoding: "utf8", timeout: 30_000 });
  return { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
}

test("teardown survives invalid current source/targets and refuses changed reviewed identities or unreadable policies before writes", () => {
  const copy = fixture();
  const account = fakeAccount({ allowWrites: true, regions: { [REGION]: { stacks: [frameworkStack("retired-prod", "Data", "prod", { template: { Resources: { Data: { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain" } } } })] } } });
  const review = path.join(copy.directory, "delete.json");
  const args = ["--deployment", "retired-prod", "-c", "prodDeployment=true", "--profile", "dev", "--region", REGION, "--plan", "--json"];
  try {
    writeFileSync(path.join(copy.directory, "framework.config.ts"), 'throw new Error("BROKEN_CURRENT_SOURCE");');
    writeFileSync(path.join(copy.directory, "cdk-app/cdk.json"), "invalid JSON");
    const planned = run(copy.directory, account.env, "destroy.ts", ...args, "--save-plan", review);
    assert.equal(planned.code, 0, planned.output);
    const plan = JSON.parse(planned.stdout);
    assert.ok(plan.stacks[0].id && plan.digest && plan.expiresAt);
    const changed = account.read();
    changed.regions[REGION].stacks.push(frameworkStack("retired-prod", "AddedAfterReview", "prod"));
    account.write(changed);
    const apply = run(copy.directory, account.env, "destroy.ts", "--apply", review, "--profile", "dev", "--confirm", "retired-prod");
    assert.notEqual(apply.code, 0);
    assert.match(apply.output, /changed since review/);
    assert.deepEqual(account.calls().filter((call) => !READ_VERB.test(call.key)), []);
    account.write({ ...account.read(), failures: { "cloudformation get-template": "denied", "secretsmanager list-secrets": "denied" } });
    const denied = run(copy.directory, account.env, "destroy.ts", ...args);
    assert.equal(denied.code, 0, denied.output);
    const unreadable = JSON.parse(denied.stdout);
    assert.ok(unreadable.blockers.some((message: string) => /deletion policies/.test(message)));
    assert.ok(unreadable.blockers.some((message: string) => /secret inventory/.test(message)));
  } finally { account.dispose(); copy.dispose(); }
});

test("deployed stacks absent from the saved assembly stay visible; broken current source cannot prevent discard", () => {
  const copy = fixture();
  const stack = frameworkStack("my-aws-app", "Current", "dev", { template: { Resources: { CurrentBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "reviewed-bucket" } } } } });
  const account = fakeAccount({ allowWrites: true, regions: { [REGION]: { stacks: [{ ...stack, Template: JSON.stringify(stack.Template) }, frameworkStack("my-aws-app", "Retired", "dev")] } } });
  const mini = path.join(copy.directory, "mini-cdk.mjs");
  const manifest = { artifacts: { Current: { type: "aws:cloudformation:stack", environment: "aws://" + ACCOUNT + "/" + REGION, properties: { stackName: stack.StackName, templateFile: "Current.template.json" } } } };
  writeFileSync(mini, "import{mkdirSync,writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';const a=process.argv.slice(2);if(a[0]==='synth'){const d=a[a.indexOf('--output')+1];mkdirSync(d,{recursive:true});writeFileSync(d+'/manifest.json'," + JSON.stringify(JSON.stringify(manifest)) + ");writeFileSync(d+'/Current.template.json'," + JSON.stringify(JSON.stringify(stack.Template)) + ");writeFileSync(d+'/asset.txt','reviewed');}else{const r=spawnSync(process.execPath,[" + JSON.stringify(path.join(root, "cdk-app/test/support/fake-cdk.mjs")) + ",...a],{env:process.env,stdio:'inherit'});process.exit(r.status??1);}");
  const env = { ...account.env, FRAMEWORK_CDK_CLI: mini };
  const directory = path.join(copy.directory, "plan");
  try {
    const planned = run(copy.directory, env, "deploy.ts", "--all", "--profile", "dev", "--plan", directory);
    assert.equal(planned.code, 0, planned.output);
    const plan = JSON.parse(readFileSync(path.join(directory, "plan.json"), "utf8"));
    assert.equal(plan.status, "no-changes", "string-valued deployed templates are parsed before comparison");
    assert.deepEqual(plan.retainedStacks.map((entry: any) => entry.name), ["my-aws-app-Retired"]);
    assert.ok(plan.reviewEvidence.security && plan.reviewEvidence.templates);
    account.write({ ...account.read(), fakeCdk: { securityFailure: true } });
    const blockedDirectory = path.join(copy.directory, "blocked-plan");
    const incomplete = run(copy.directory, env, "deploy.ts", "--all", "--profile", "dev", "--plan", blockedDirectory);
    assert.equal(incomplete.code, 0, incomplete.output);
    const blocked = JSON.parse(readFileSync(path.join(blockedDirectory, "plan.json"), "utf8"));
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.iamBroadening, false, "a failed analyzer is not proof of broadening");
    assert.ok(blocked.reviewEvidence.problems.length);
    assert.notEqual(run(copy.directory, env, "deploy.ts", "--apply", blockedDirectory, "--profile", "dev").code, 0);
    account.write({ ...account.read(), fakeCdk: {} });
    const state = account.read();
    state.regions[REGION].stacks[0].Template = { ...stack.Template as object, Resources: { CurrentBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "old-bucket" } } } };
    account.write(state);
    const applicable = path.join(copy.directory, "saved-release");
    const reviewedRelease = run(copy.directory, env, "deploy.ts", "--all", "--profile", "dev", "--plan", applicable);
    assert.equal(reviewedRelease.code, 0, reviewedRelease.output);
    writeFileSync(path.join(copy.directory, "framework.config.ts"), 'throw new Error("SOURCE_CHANGED_AFTER_REVIEW");');
    const discarded = run(copy.directory, env, "deploy.ts", "--discard", directory, "--profile", "dev");
    assert.equal(discarded.code, 0, discarded.output);
    assert.deepEqual(account.calls().filter((call) => !READ_VERB.test(call.key)), []);
    const applied = run(copy.directory, env, "deploy.ts", "--apply", applicable, "--profile", "dev");
    assert.equal(applied.code, 2, applied.output);
    const result = JSON.parse(readFileSync(path.join(applicable, "result.json"), "utf8"));
    assert.equal(result.status, "export-failed", "saved infrastructure applies despite current source errors; local export remains a separate outcome");
    assert.equal(result.verification.verified, true);
  } finally { account.dispose(); copy.dispose(); }
});

test("saved assembly integrity covers staged bytes and refuses links outside the release", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "release-integrity-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "release-outside-"));
  try {
    writeFileSync(path.join(directory, "asset.txt"), "reviewed");
    const before = assemblyDigest(directory);
    writeFileSync(path.join(directory, "asset.txt"), "changed");
    assert.notEqual(assemblyDigest(directory), before);
    if (process.platform !== "win32") {
      const changedBytes = assemblyDigest(directory);
      chmodSync(path.join(directory, "asset.txt"), 0o755);
      assert.notEqual(assemblyDigest(directory), changedBytes, "executable permissions are reviewed release inputs");
    }
    writeFileSync(path.join(directory, "same-a.txt"), "identical bytes");
    writeFileSync(path.join(directory, "same-b.txt"), "identical bytes");
    symlinkSync("same-a.txt", path.join(directory, "internal"));
    const beforeLinkChange = assemblyDigest(directory);
    unlinkSync(path.join(directory, "internal")); symlinkSync("same-b.txt", path.join(directory, "internal"));
    assert.notEqual(assemblyDigest(directory), beforeLinkChange, "link destination is part of the staged archive even when target bytes match");
    writeFileSync(path.join(outside, "secret.txt"), "private");
    symlinkSync(path.join(outside, "secret.txt"), path.join(directory, "external"));
    assert.throws(() => assemblyDigest(directory), /outside its saved assembly/);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("termination protection and retain-failed choices cannot widen a saved deletion review", () => {
  const copy = fixture();
  const owned = { ...frameworkStack("protected-prod", "Data", "prod"), EnableTerminationProtection: true };
  const account = fakeAccount({ allowWrites: true, regions: { [REGION]: { stacks: [owned] } } });
  const review = path.join(copy.directory, "protected.json");
  try {
    const planned = run(copy.directory, account.env, "destroy.ts", "--deployment", "protected-prod", "-c", "prodDeployment=true", "--profile", "dev", "--region", REGION, "--plan", "--allow-disable-protection", "--save-plan", review);
    assert.equal(planned.code, 0, planned.output);
    assert.equal(JSON.parse(readFileSync(review, "utf8")).policy.disableProtection, true);
    const changedPolicy = run(copy.directory, account.env, "destroy.ts", "--apply", review, "--profile", "dev", "--confirm", "protected-prod", "--retain-failed");
    assert.notEqual(changedPolicy.code, 0);
    assert.match(changedPolicy.output, /policy differs/);
    const state = account.read();
    state.regions[REGION].stacks[0].StackId += "-replacement";
    account.write(state);
    const replaced = run(copy.directory, account.env, "destroy.ts", "--apply", review, "--profile", "dev", "--confirm", "protected-prod");
    assert.notEqual(replaced.code, 0);
    assert.match(replaced.output, /changed since review/);
    assert.deepEqual(account.calls().filter((call) => !READ_VERB.test(call.key)), []);
    assert.equal(account.read().regions[REGION].stacks[0].EnableTerminationProtection, true);
  } finally { account.dispose(); copy.dispose(); }
});
