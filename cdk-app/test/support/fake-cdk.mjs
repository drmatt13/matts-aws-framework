#!/usr/bin/env node
/**
 * A simulated CDK CLI for tests: FRAMEWORK_CDK_CLI points deploy.ts here, and
 * FAKE_AWS_STATE names the account fake-aws.mjs also serves.
 *
 *   synth   runs the real app offline (asset bundling skipped) into --output
 *   deploy  creates or updates the account's stacks from an assembly, directly,
 *           or as --method prepare-change-set / execute-change-set
 *   diff    prints a summary; with --security-only --fail exits 1 when
 *           state.fakeCdk.securityBroadening is true
 *
 * Every call is appended to state.cdkCalls.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const statePath = process.env.FAKE_AWS_STATE;
const args = process.argv.slice(2);
const [command] = args;
const value = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const values = (name) => args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : []));
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
/** Replaces the state file whole, so a concurrent reader never sees half of it. */
function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, file); return; } catch (error) {
      if (attempt > 100 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
const save = (state) => writeAtomic(statePath, JSON.stringify(state, null, 2));
{ const state = load(); state.cdkCalls = [...(state.cdkCalls ?? []), args]; save(state); }

if (command === "synth") {
  const state = load();
  const root = path.resolve(process.cwd(), "..");
  const project = JSON.parse(readFileSync(path.join(root, "cdk-app", "cdk.json"), "utf8")).context;
  const cached = existsSync(path.join(root, "cdk-app", "cdk.context.json")) ? JSON.parse(readFileSync(path.join(root, "cdk-app", "cdk.context.json"), "utf8")) : {};
  const context = {};
  const pairs = args.flatMap((arg, index) => (arg === "-c" || arg === "--context" ? [args[index + 1]] : arg.startsWith("--context=") ? [arg.slice(10)] : []));
  for (const pair of pairs) { const at = pair.indexOf("="); if (at > 0) context[pair.slice(0, at)] = pair.slice(at + 1); }
  const env = { ...process.env, CDK_OUTDIR: value("output"), CDK_DEFAULT_ACCOUNT: state.identity?.Account ?? "111122223333", CDK_DEFAULT_REGION: state.defaultRegion ?? "us-east-1",
    CDK_CONTEXT_JSON: JSON.stringify({ ...project, ...cached, ...context, "aws:cdk:bundling-stacks": [] }) };
  delete env.FRAMEWORK_MODE;
  const run = spawnSync(process.execPath, ["--import", "tsx", "bin/main.ts"], { cwd: process.cwd(), env, stdio: "inherit" });
  process.exit(run.status ?? 1);
}

function assemblyStacks(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  return Object.entries(manifest.artifacts).filter(([, artifact]) => artifact.type === "aws:cloudformation:stack").map(([id, artifact]) => ({
    id, name: artifact.properties?.stackName ?? id,
    template: JSON.parse(readFileSync(path.join(directory, artifact.properties.templateFile), "utf8")),
    tags: artifact.properties?.tags ?? {}, dependencies: artifact.dependencies ?? [],
    region: /aws:\/\/\d+\/(.+)/.exec(artifact.environment ?? "")?.[1] ?? "us-east-1",
    account: /aws:\/\/(\d+)\//.exec(artifact.environment ?? "")?.[1],
  }));
}
// A value after an option (--app dir, -c key=value) is not a stack selector.
const selectors = args.slice(1).filter((arg, index, all) => !arg.startsWith("-") && !all[index - 1]?.startsWith("--") && all[index - 1] !== "-c");

function outputsOf(state, stack) {
  return Object.entries(stack.template.Outputs ?? {}).map(([key, output]) => ({
    OutputKey: key, Description: output.Description,
    OutputValue: state.outputValues?.[key] ?? (typeof output.Value === "string" ? output.Value : `fake-${key}`),
    ...(output.Export?.Name ? { ExportName: output.Export.Name } : {}),
  }));
}
const changesOf = (before, after) => {
  const changes = [];
  for (const [id, resource] of Object.entries(after.Resources ?? {})) {
    const old = before?.Resources?.[id];
    if (!old) changes.push({ Type: "Resource", ResourceChange: { Action: "Add", LogicalResourceId: id, ResourceType: resource.Type } });
    else if (JSON.stringify(old) !== JSON.stringify(resource)) changes.push({ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: id, ResourceType: resource.Type, Replacement: "False", Details: [] } });
  }
  for (const [id, resource] of Object.entries(before?.Resources ?? {})) if (!after.Resources?.[id]) changes.push({ Type: "Resource", ResourceChange: { Action: "Remove", LogicalResourceId: id, ResourceType: resource.Type } });
  return changes;
};

if (command === "deploy") {
  const state = load();
  const directory = value("app");
  const method = value("method") ?? "change-set";
  const now = new Date().toISOString();
  for (const stack of assemblyStacks(directory).filter((entry) => !selectors.length || selectors.includes(entry.name) || selectors.includes(entry.id))) {
    const account = (state.regions ??= {})[stack.region] ??= {};
    account.stacks ??= [];
    let existing = account.stacks.find((entry) => entry.StackName === stack.name && entry.StackStatus !== "DELETE_COMPLETE");
    const live = (entry) => {
      entry.Template = stack.template;
      entry.Outputs = outputsOf(state, stack);
      entry.Tags = Object.entries(stack.tags).map(([Key, Value]) => ({ Key, Value }));
      entry.StackStatus = entry.CreationTime && entry.StackStatus !== "REVIEW_IN_PROGRESS" ? "UPDATE_COMPLETE" : "CREATE_COMPLETE";
      if (entry.StackStatus === "UPDATE_COMPLETE") entry.LastUpdatedTime = now; else entry.CreationTime = now;
      entry.Events = [{ EventId: `${stack.name}-${Date.now()}`, Timestamp: now, LogicalResourceId: stack.name, ResourceType: "AWS::CloudFormation::Stack", ResourceStatus: entry.StackStatus }, ...(entry.Events ?? [])];
      entry.ChangeSets = [];
    };
    if (state.fakeCdk?.failDeploy?.includes(stack.name) && method !== "prepare-change-set") {
      if (existing) existing.StackStatus = "UPDATE_ROLLBACK_COMPLETE";
      save(state);
      process.stderr.write(`❌ ${stack.name} failed: Resource handler returned message: "simulated failure"\n`);
      process.exit(1);
    }
    if (method === "prepare-change-set") {
      const name = value("change-set-name");
      if (!existing) {
        // CloudFormation creates the stack to hold the change set, with the stack tags CDK passes.
        existing = { StackName: stack.name, StackId: `arn:aws:cloudformation:${stack.region}:${stack.account}:stack/${stack.name}/${Date.now()}`, StackStatus: "REVIEW_IN_PROGRESS", CreationTime: now, ChangeSets: [], Tags: Object.entries(stack.tags).map(([Key, Value]) => ({ Key, Value })) };
        account.stacks.push(existing);
      }
      const changes = changesOf(existing.Template, stack.template);
      existing.ChangeSets = [...(existing.ChangeSets ?? []).filter((set) => set.ChangeSetName !== name), changes.length
        ? { ChangeSetName: name, ChangeSetId: `arn:changeset/${name}/${stack.name}`, Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Changes: changes, CreationTime: now }
        : { ChangeSetName: name, ChangeSetId: `arn:changeset/${name}/${stack.name}`, Status: "FAILED", ExecutionStatus: "UNAVAILABLE", StatusReason: "The submitted information didn't contain changes.", Changes: [] }];
      console.log(`Changeset ${name} created and waiting in review for manual execution`);
    } else if (method === "execute-change-set") {
      const name = value("change-set-name");
      const set = existing?.ChangeSets?.find((entry) => entry.ChangeSetName === name);
      if (!set || set.ExecutionStatus !== "AVAILABLE") { save(state); process.stderr.write(`No executable change set ${name} on ${stack.name}\n`); process.exit(1); }
      live(existing);
      console.log(`✅ ${stack.name}`);
    } else {
      if (!existing) { existing = { StackName: stack.name, StackId: `arn:aws:cloudformation:${stack.region}:${stack.account}:stack/${stack.name}/${Date.now()}` }; account.stacks.push(existing); }
      live(existing);
      console.log(`✅ ${stack.name}`);
    }
  }
  save(state);
  process.exit(0);
}

if (command === "diff") {
  const state = load();
  if (args.includes("--security-only")) {
    console.log(state.fakeCdk?.securityBroadening ? "IAM Statement Changes\n+ Allow s3:* on *" : "There were no security-related changes");
    process.exit(state.fakeCdk?.securityBroadening && args.includes("--fail") ? 1 : 0);
  }
  console.log(`Stack ${selectors.join(", ")}\nResources\n[~] (simulated diff)`);
  process.exit(0);
}

process.stderr.write(`fake-cdk: ${command} is not simulated\n`);
process.exit(1);
