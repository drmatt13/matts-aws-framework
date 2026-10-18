#!/usr/bin/env node
/**
 * npm run destroy:resources — tears down one deployment, as AWS records it.
 *
 *   npm run destroy:resources -- --deployment <NAME> [-c prodDeployment=true] --profile <PROFILE> --plan
 *   npm run destroy:resources -- --deployment <NAME> [-c prodDeployment=true] --profile <PROFILE> --confirm <NAME>
 *
 * The stacks are the ones whose own records name the deployment — never a
 * synth of the current source, so a renamed or removed stack is still found and
 * no Docker is needed. The mode must be stated and must match what is deployed.
 * Stacks are deleted importers first; what deletion leaves behind (retained or
 * snapshotted resources, managed secrets) is reported before anything happens.
 * Termination protection is switched off only after the typed confirmation.
 * AWS is the authority for the result: each deletion is waited for and checked.
 */
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { discoverDeployments, modeFromContext, type ClassifiedStack, type ObservedStack } from "@repo/framework/deploy";
import { contextFromArgs, readCdkContext, resolveRepositoryTarget } from "@repo/framework/deploy/node";
import { AwsCliError, runAwsSync, type AwsTarget } from "./aws-cli";
import { profileRegion } from "./aws-profiles";
import { RECORD_PATH } from "./deployment-review";

const root = path.resolve(__dirname, "..");
const POLL_MS = Number(process.env.FRAMEWORK_POLL_MS ?? 5000);
const WAIT_MS = 60 * 60 * 1000;

interface Options { deployment?: string; profile?: string; region?: string; confirm?: string; plan: boolean; json: boolean; retainFailed: boolean; context: Record<string, string> }

function options(args: readonly string[]): Options {
  const value = (name: string) => {
    const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (index < 0) return undefined;
    const arg = args[index]!;
    return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  };
  return {
    deployment: value("deployment") ?? value("cdk-app-name"), profile: value("profile") ?? process.env.AWS_PROFILE, region: value("region"),
    confirm: value("confirm"), plan: args.includes("--plan"), json: args.includes("--json"), retainFailed: args.includes("--retain-failed"),
    context: contextFromArgs(args),
  };
}

interface Remains { stack: string; logicalId: string; type: string; policy: string }

export interface TeardownPlan {
  readonly deployment: string;
  readonly mode: "dev" | "prod";
  readonly account: string;
  readonly region: string;
  /** Deletion order: importers before the stacks they import from. */
  readonly stacks: readonly { name: string; status: string; terminationProtection: boolean; importedBy: readonly string[] }[];
  readonly leftInPlace: readonly { name: string; reason: string }[];
  readonly remains: readonly Remains[];
  readonly secrets: readonly string[];
  readonly record: boolean;
}

function teardownPlan(aws: AwsTarget, account: string, region: string, name: string, statedMode: "dev" | "prod" | undefined): TeardownPlan {
  const stacks = (() => {
    const all: ObservedStack[] = [];
    let token: string | undefined;
    do {
      const page = runAwsSync(["cloudformation", "describe-stacks", "--no-paginate", ...(token ? ["--next-token", token] : [])], aws);
      all.push(...(page.Stacks ?? []));
      token = page.NextToken;
    } while (token);
    return all;
  })();
  const deployment = discoverDeployments(stacks, { account, region }, new Map(), [name]).deployments.find((entry) => entry.name === name);
  if (!deployment) throw new Error(`${name} has no stacks in ${account}/${region}. Nothing to delete.`);
  if (statedMode === undefined && deployment.mode === "prod") throw new Error(`${name} is a production deployment. State it explicitly with -c prodDeployment=true to delete it.`);
  const mode = statedMode ?? "dev";
  if (deployment.mode !== mode) throw new Error(`${name} is a ${deployment.mode} deployment in ${account}/${region}, not ${mode}. Nothing was deleted.`);
  const { state } = deployment;
  if (state.kind === "conflict" && state.reason !== "unmarked") throw new Error(`${state.message} Nothing was deleted.`);
  if (state.kind === "in-progress" && deployment.stacks.some((stack) => stack.health === "in-progress")) {
    throw new Error(`${name} has a CloudFormation operation in progress: ${deployment.stacks.filter((stack) => stack.health === "in-progress").map((stack) => `${stack.name} (${stack.status})`).join(", ")}. Wait for it to finish. Nothing was deleted.`);
  }
  // Only stacks whose own records say they are this deployment's are deleted.
  const owned = deployment.stacks.filter((stack): stack is ClassifiedStack & { identity: NonNullable<ClassifiedStack["identity"]> } => stack.identity?.deployment === name);
  const leftInPlace = deployment.stacks.filter((stack) => !stack.identity).map((stack) => ({ name: stack.name, reason: "named like this deployment's stacks, but carries no framework identity" }));
  const described = new Map(stacks.map((stack) => [stack.StackName, stack as ObservedStack & { EnableTerminationProtection?: boolean }]));
  const importedBy = new Map<string, string[]>();
  for (const stack of owned) {
    const importers = new Set<string>();
    for (const output of described.get(stack.name)?.Outputs ?? []) {
      const exportName = (output as { ExportName?: string }).ExportName;
      if (!exportName) continue;
      try { for (const importer of runAwsSync(["cloudformation", "list-imports", "--export-name", exportName], aws).Imports ?? []) importers.add(importer); }
      catch { /* An export nobody imports reads as not found. */ }
    }
    importedBy.set(stack.name, [...importers]);
  }
  const ordered: string[] = [];
  const visit = (stackName: string, trail: Set<string>) => {
    if (ordered.includes(stackName) || trail.has(stackName)) return;
    trail.add(stackName);
    for (const importer of importedBy.get(stackName) ?? []) if (owned.some((stack) => stack.name === importer)) visit(importer, trail);
    ordered.push(stackName);
  };
  for (const stack of owned) visit(stack.name, new Set());
  const remains: Remains[] = [];
  for (const stackName of ordered) {
    try {
      const template = runAwsSync(["cloudformation", "get-template", "--stack-name", stackName, "--template-stage", "Original"], aws).TemplateBody;
      for (const [logicalId, resource] of Object.entries<any>(template?.Resources ?? {})) {
        if (["Retain", "RetainExceptOnCreate", "Snapshot"].includes(resource.DeletionPolicy)) remains.push({ stack: stackName, logicalId, type: resource.Type, policy: resource.DeletionPolicy });
      }
    } catch { /* A failed create has nothing to retain. */ }
  }
  let secrets: string[] = [];
  try {
    secrets = (runAwsSync(["secretsmanager", "list-secrets", "--filters", "Key=tag-key,Values=framework:deployment", `Key=tag-value,Values=${name}`], aws).SecretList ?? []).map((secret: any) => String(secret.Name));
  } catch { secrets = []; }
  let record = false;
  try { record = (runAwsSync(["ssm", "get-parameters-by-path", "--path", RECORD_PATH], aws).Parameters ?? []).some((parameter: any) => parameter.Name === `${RECORD_PATH}${name}`); } catch { record = false; }
  return {
    deployment: name, mode, account, region,
    stacks: ordered.map((stackName) => ({ name: stackName, status: described.get(stackName)?.StackStatus ?? "UNKNOWN", terminationProtection: described.get(stackName)?.EnableTerminationProtection === true, importedBy: importedBy.get(stackName) ?? [] })),
    leftInPlace, remains, secrets, record,
  };
}

function printPlan(plan: TeardownPlan): void {
  console.log(`Deleting ${plan.deployment} (${plan.mode}) in ${plan.account}/${plan.region} removes, in this order:`);
  for (const stack of plan.stacks) console.log(`  ${stack.name} (${stack.status})${stack.terminationProtection ? " — termination protection on" : ""}`);
  if (plan.remains.length) {
    console.log("What deletion leaves behind:");
    for (const item of plan.remains) console.log(`  ${item.stack}/${item.logicalId} (${item.type}): ${item.policy === "Snapshot" ? "a final snapshot is kept" : "retained"}`);
  }
  if (plan.secrets.length) console.log(`Managed secrets are kept, and reused if the deployment returns: ${plan.secrets.join(", ")}.`);
  for (const stack of plan.leftInPlace) console.log(`Left in place: ${stack.name} (${stack.reason}).`);
}

async function waitForDeletion(aws: AwsTarget, stackName: string): Promise<{ deleted: boolean; failures: string[] }> {
  const started = Date.now();
  const seen = new Set<string>();
  while (Date.now() - started < WAIT_MS) {
    let stack: (ObservedStack & { StackStatus?: string }) | undefined;
    try { stack = runAwsSync(["cloudformation", "describe-stacks", "--stack-name", stackName], aws).Stacks?.[0]; }
    catch (error) {
      if (error instanceof AwsCliError && (error.kind === "not-found" || /does not exist/.test(error.detail))) return { deleted: true, failures: [] };
      throw error;
    }
    if (!stack || stack.StackStatus === "DELETE_COMPLETE") return { deleted: true, failures: [] };
    try {
      for (const event of (runAwsSync(["cloudformation", "describe-stack-events", "--stack-name", stackName, "--max-items", "30"], aws).StackEvents ?? []).reverse()) {
        if (seen.has(event.EventId)) continue;
        seen.add(event.EventId);
        console.log(`  ${stackName} ${event.LogicalResourceId} ${event.ResourceStatus}${event.ResourceStatusReason ? `: ${event.ResourceStatusReason}` : ""}`);
      }
    } catch { /* Events are a convenience. */ }
    if (stack.StackStatus === "DELETE_FAILED") {
      const events = runAwsSync(["cloudformation", "describe-stack-events", "--stack-name", stackName, "--max-items", "100"], aws).StackEvents ?? [];
      const failures = [...new Set(events.filter((event: any) => event.ResourceStatus === "DELETE_FAILED" && event.LogicalResourceId !== stackName).map((event: any) => String(event.LogicalResourceId)))] as string[];
      return { deleted: false, failures };
    }
    await delay(POLL_MS);
  }
  return { deleted: false, failures: [] };
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const project = readCdkContext(root);
  const get = (key: string) => opts.context[key] ?? project[key];
  const statedMode = modeFromContext(get).mode;
  const target = resolveRepositoryTarget({ root, get, env: process.env, requireInputs: false });
  const name = opts.deployment ?? target.target.name;
  const region = opts.region ?? (target.target.name === name ? target.target.region : undefined) ?? profileRegion(opts.profile);
  if (!region) throw new Error(`No region: pass --region, or set one for the profile ${opts.profile ?? "default"}.`);
  const aws: AwsTarget = { region, ...(opts.profile ? { profile: opts.profile } : {}) };
  const caller = runAwsSync(["sts", "get-caller-identity"], aws);
  const account = String(caller.Account);
  const plan = teardownPlan(aws, account, region, name, statedMode);
  if (opts.plan || opts.confirm === undefined) {
    if (opts.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else {
      printPlan(plan);
      if (!opts.plan) console.log(`\nNothing was deleted. To delete it, run again with --confirm ${name}.`);
    }
    return;
  }
  if (opts.confirm !== name) throw new Error(`--confirm ${opts.confirm} does not name ${name}. Nothing was deleted.`);
  printPlan(plan);
  for (const stack of plan.stacks) {
    if (stack.terminationProtection) {
      runAwsSync(["cloudformation", "update-termination-protection", "--stack-name", stack.name, "--no-enable-termination-protection"], aws);
      console.log(`Turned off termination protection on ${stack.name}, as confirmed.`);
    }
    const retain = opts.retainFailed && stack.status === "DELETE_FAILED"
      ? (runAwsSync(["cloudformation", "describe-stack-events", "--stack-name", stack.name, "--max-items", "100"], aws).StackEvents ?? [])
        .filter((event: any) => event.ResourceStatus === "DELETE_FAILED" && event.LogicalResourceId !== stack.name).map((event: any) => String(event.LogicalResourceId))
      : [];
    runAwsSync(["cloudformation", "delete-stack", "--stack-name", stack.name, ...(retain.length ? ["--retain-resources", ...new Set(retain)] : [])], aws);
    console.log(`Deleting ${stack.name}…`);
    const outcome = await waitForDeletion(aws, stack.name);
    if (!outcome.deleted) {
      throw new Error(`${stack.name} could not be deleted${outcome.failures.length ? `: CloudFormation could not delete ${outcome.failures.join(", ")}` : " in time"}. Remove those resources, or run again with --retain-failed to keep them and delete the rest. Stacks after it were not deleted.`);
    }
    console.log(`✔ ${stack.name} deleted.`);
  }
  if (plan.record) {
    try { runAwsSync(["ssm", "delete-parameter", "--name", `${RECORD_PATH}${name}`], aws); } catch { console.warn(`The deployment record ${RECORD_PATH}${name} could not be removed.`); }
  }
  let leftovers: string[] = [];
  try {
    leftovers = (runAwsSync(["resourcegroupstaggingapi", "get-resources", "--tag-filters", `Key=framework:deployment,Values=${name}`], aws).ResourceTagMappingList ?? []).map((entry: any) => String(entry.ResourceARN));
  } catch { leftovers = []; }
  console.log(`${name} is deleted from ${account}/${region}.`);
  if (leftovers.length) console.log(`Still tagged as ${name}'s (retained on purpose, or awaiting cleanup): ${leftovers.join(", ")}`);
}

main().catch((error) => {
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ error: { kind: error instanceof AwsCliError ? error.kind : "failed", message: error instanceof Error ? error.message : String(error) } })}\n`);
  console.error(error instanceof Error ? error.message : "Teardown failed.");
  process.exitCode = 1;
});
