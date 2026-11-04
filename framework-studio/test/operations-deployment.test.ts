import assert from "./support/assert";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { OperationsClient } from "../server/operations/client";
import { privateEndpoint } from "../server/operations/ipc";
import { PlanStore } from "../server/deploy/plans";
import { ACCOUNT, fakeAccount, frameworkStack, READ_VERB, REGION } from "../../cdk-app/test/support/fake-aws-state";
import type { JobView } from "../shared/operations";

const repository = path.resolve(__dirname, "../..");
const deployment = "runner-fixture-prod";

async function finish(client: OperationsClient, id: string): Promise<JobView> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const record = await client.get(id);
    if (record && record.view.status !== "running") return record.view;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Fixture deployment did not finish.");
}

test("independent deployment uses the real reviewed CLI, preserves approvals and consumes its review", { timeout: 90_000, skip: process.platform === "win32" }, async () => {
  const account = fakeAccount({ allowWrites: true });
  const root = path.join(account.directory, "checkout"), state = path.join(account.directory, "studio");
  cpSync(path.join(repository, "scripts"), path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "cdk-app"));
  symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "junction");
  writeFileSync(path.join(root, "package.json"), '{"private":true}');
  writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ context: {
    "framework:app": "runner-fixture", "framework:appId": "0f9c2d1e-7b3a-4c5d-9e8f-1a2b3c4d5e6f",
    "framework:targets": { prod: { mode: "prod", account: ACCOUNT, region: REGION } },
  } }));
  writeFileSync(path.join(root, "framework.config.ts"), `import { defaults } from ${JSON.stringify(path.join(repository, "framework-config/defaults.ts"))}; export default { defaults, http:{}, webSocket:{}, events:{}, services:{} };`);
  const stack = frameworkStack(deployment, "Current", "prod", { template: { Resources: { CurrentBucket: { Type: "AWS::S3::Bucket" } } } });
  const manifest = { artifacts: { Current: { type: "aws:cloudformation:stack", environment: `aws://${ACCOUNT}/${REGION}`, properties: { stackName: stack.StackName, templateFile: "Current.template.json" } } } };
  const mini = path.join(root, "mini-cdk.mjs");
  writeFileSync(mini, `import {mkdirSync,writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='synth') { const directory=args[args.indexOf('--output')+1]; mkdirSync(directory,{recursive:true});
writeFileSync(directory+'/manifest.json',${JSON.stringify(JSON.stringify(manifest))});
writeFileSync(directory+'/Current.template.json',${JSON.stringify(JSON.stringify(stack.Template))});
} else { const result=spawnSync(process.execPath,[${JSON.stringify(path.join(repository, "cdk-app/test/support/fake-cdk.mjs"))},...args],{env:process.env,stdio:'inherit'}); process.exit(result.status??1); }
`);
  const env = { ...account.env, FRAMEWORK_CDK_CLI: mini, FRAMEWORK_POLL_MS: "20" };
  const client = new OperationsClient(root, state, env);
  try {
    const planned = await client.submit({ kind: "deploy-plan", params: { deployment, profile: "dev", review: "template" }, requestKey: "real-cli-plan-request" });
    const done = await finish(client, planned.id);
    const planLog = (await client.log(done.id)).lines.map(line => line.text).join("\n");
    assert.equal(done.status, "succeeded", planLog);
    const plans = new PlanStore(state);
    const reviewed = plans.read(done.planId!)!;
    assert.equal(reviewed.confirmation.level, "name");
    assert.equal(reviewed.result, undefined);
    assert.deepEqual(account.calls().filter(call => !READ_VERB.test(call.key)), [], "template planning makes no cloud mutation, even in the fake account");
    await assert.rejects(client.submit({ kind: "deploy-apply", params: { plan: done.planId, profile: "dev" }, requestKey: "missing-approval-request" }), /Type runner-fixture-prod/);
    const applyRequest = { kind: "deploy-apply" as const, params: { plan: done.planId, profile: "dev", confirm: deployment }, requestKey: "real-cli-apply-request" };
    const applying = await client.submit(applyRequest);
    const applied = await finish(client, applying.id);
    assert.equal(applied.status, "succeeded", (await client.log(applied.id)).lines.map(line => line.text).join("\n"));
    assert.equal(applied.outcome, "confirmed");
    const directory = plans.path(done.planId!);
    assert.ok(existsSync(path.join(directory, "operation.json")), "the CLI's own operation journal remains authoritative");
    assert.equal(JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8")).verification.verified, true);
    assert.equal((await client.submit(applyRequest)).id, applying.id);
    await assert.rejects(client.submit({ ...applyRequest, requestKey: "second-apply-request" }), /already|attempt/);
    assert.ok(account.read().regions[REGION].stacks.some((entry: { StackName: string }) => entry.StackName === stack.StackName));
    assert.doesNotMatch(JSON.stringify(await client.log(applying.id)), /sentinel-secret-never-print|AKIASENTINELNEVERPRINT/);
    assert.equal(existsSync(path.join(root, ".cache/deploy", `${deployment}.lock`)), false, "successful CLI cleanup releases its deployment lock");
    const lock = path.join(root, ".cache/deploy", `${deployment}.lock`);
    const externalOwner = JSON.stringify({ pid: process.pid, token: "external-cli-owner", startedAt: new Date().toISOString() });
    writeFileSync(lock, externalOwner);
    const writes = account.calls().filter(call => !READ_VERB.test(call.key)).length;
    const blocked = await client.submit({ kind: "deploy-plan", params: { deployment, profile: "dev", review: "template" }, requestKey: "cli-lock-refusal-request" });
    assert.equal((await finish(client, blocked.id)).status, "failed");
    assert.match((await client.log(blocked.id)).lines.map(line => line.text).join("\n"), /deployment.*running|deployment lock/i);
    assert.equal(readFileSync(lock, "utf8"), externalOwner, "runner never reclaims another CLI owner's lock");
    assert.equal(account.calls().filter(call => !READ_VERB.test(call.key)).length, writes, "existing CLI lock prevents new external effects");
  } finally {
    try {
      for (const job of await client.list()) if (job.status === "running") { await client.cancel(job.id); await finish(client, job.id); }
      const coordinator = await client.ping(); process.kill(coordinator.pid, "SIGTERM");
      for (let attempt = 0; attempt < 100; attempt++) { try { process.kill(coordinator.pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch { break; } }
    } finally { client.close(); rmSync(privateEndpoint(root, state).directory, { recursive: true, force: true }); account.dispose(); }
  }
});
