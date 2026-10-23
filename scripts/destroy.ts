#!/usr/bin/env node
/**
 * npm run destroy:resources — tears down one deployment, as AWS records it.
 *
 *   npm run destroy:resources -- --deployment <NAME> [-c prodDeployment=true] --profile <PROFILE> --plan
 *   npm run destroy:resources -- --deployment <NAME> [-c prodDeployment=true] --profile <PROFILE> --plan --save-plan <file>
 *   npm run destroy:resources -- --apply <file> --profile <PROFILE> --confirm <NAME>
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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { discoverDeployments, modeFromContext, type ClassifiedStack, type ObservedStack } from "@repo/framework/deploy";
import { contextFromArgs, readCdkContext, resolveRepositoryTarget } from "@repo/framework/deploy/node";
import { AwsCliError, runAwsSync, type AwsTarget } from "./aws-cli";
import { profileRegion } from "./aws-profiles";
import { RECORD_PATH, stackImporters } from "./deployment-review";
import { writeDeploymentRecordAtomic } from "./deployment-artifact";
import { acquireDeploymentLock } from "./deployment-workspace";
import { statefulTeardownConsequences } from "./stateful-teardown";
import { recordRetainedResources, type RetainedResourceEvidence } from "./retained-resources";

const root = path.resolve(__dirname, "..");
const POLL_MS = Number(process.env.FRAMEWORK_POLL_MS ?? 5000);
const WAIT_MS = 60 * 60 * 1000;

interface Options { deployment?: string; profile?: string; region?: string; confirm?: string; plan: boolean; json: boolean; retainFailed: boolean; context: Record<string, string>; apply?: string; savePlan?: string; allowDisableProtection: boolean }

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
    allowDisableProtection: args.includes("--allow-disable-protection"), context: contextFromArgs(args), apply: value("apply"), savePlan: value("save-plan"),
  };
}

interface Remains extends RetainedResourceEvidence {}

function failedResources(aws: AwsTarget, stackId: string): string[] {
  const resources = runAwsSync(["cloudformation", "list-stack-resources", "--stack-name", stackId], aws).StackResourceSummaries;
  if (!Array.isArray(resources)) throw new Error("Current stack resource inventory is incomplete.");
  return [...new Set<string>(resources.filter((resource: any) => resource.ResourceStatus === "DELETE_FAILED" && resource.ResourceType !== "AWS::CloudFormation::Stack").map((resource: any) => String(resource.LogicalResourceId)))].sort();
}

export interface TeardownPlan {
  readonly version: 1;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly digest: string;
  readonly policy: { readonly retainFailed: boolean; readonly disableProtection: boolean };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly deployment: string;
  readonly mode: "dev" | "prod";
  readonly account: string;
  readonly region: string;
  /** Deletion order: importers before the stacks they import from. */
  readonly stacks: readonly { name: string; id: string; status: string; updated?: string; templateDigest: string; failedResources: readonly string[]; terminationProtection: boolean; importedBy: readonly string[] }[];
  readonly leftInPlace: readonly { name: string; reason: string }[];
  readonly remains: readonly Remains[];
  readonly secrets: readonly string[];
  readonly record: boolean;
}

function teardownPlan(aws: AwsTarget, account: string, region: string, name: string, statedMode: "dev" | "prod" | undefined, policy: TeardownPlan["policy"]): TeardownPlan {
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
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!policy.disableProtection && owned.some((stack) => described.get(stack.name)?.EnableTerminationProtection)) blockers.push("Termination protection is enabled. Explicitly review disabling it before deleting protected stacks.");
  const templates = new Map<string, string>();
  const failures = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  for (const stack of owned) {
    const importers = new Set<string>();
    for (const output of described.get(stack.name)?.Outputs ?? []) {
      const exportName = (output as { ExportName?: string }).ExportName;
      if (!exportName) continue;
      try { for (const importer of stackImporters(aws, exportName)) importers.add(importer); }
      catch (error) { blockers.push("Cannot read importers of " + exportName + ": " + (error instanceof Error ? error.message : String(error))); }
    }
    importedBy.set(stack.name, [...importers].sort());
    for (const importer of importers) if (!owned.some((entry) => entry.name === importer)) blockers.push(stack.name + " is imported by external stack " + importer + ". Remove that dependency separately before deleting.");
  }
  const ordered: string[] = [];
  const visit = (stackName: string, trail: Set<string>) => {
    if (ordered.includes(stackName)) return;
    if (trail.has(stackName)) { blockers.push("Cyclic deployed stack imports at " + stackName + ". Resolve dependencies before deleting."); return; }
    trail.add(stackName);
    for (const importer of importedBy.get(stackName) ?? []) if (owned.some((stack) => stack.name === importer)) visit(importer, trail);
    trail.delete(stackName);
    ordered.push(stackName);
  };
  for (const stack of owned) visit(stack.name, new Set());
  const remains: Remains[] = [];
  const deployedTemplates = new Map<string, any>();
  for (const stackName of ordered) {
    try {
      const raw = runAwsSync(["cloudformation", "get-template", "--stack-name", stackName, "--template-stage", "Original"], aws).TemplateBody;
      const template = typeof raw === "string" ? JSON.parse(raw) : raw;
      deployedTemplates.set(stackName, template);
      templates.set(stackName, digest(template));
      const candidates = Object.entries<any>(template?.Resources ?? {}).filter(([, resource]) => ["Retain", "RetainExceptOnCreate", "Snapshot"].includes(resource.DeletionPolicy));
      const physicalIds = new Map<string, string>();
      if (candidates.length) {
        let token: string | undefined;
        const seen = new Set<string>();
        do {
          const page = runAwsSync(["cloudformation", "list-stack-resources", "--stack-name", described.get(stackName)!.StackId!, "--no-paginate", ...(token ? ["--next-token", token] : [])], aws);
          for (const resource of page.StackResourceSummaries ?? []) if (resource.PhysicalResourceId) physicalIds.set(resource.LogicalResourceId, resource.PhysicalResourceId);
          token = page.NextToken;
          if (token && seen.has(token)) throw new Error("Stack resource inventory repeated a pagination token.");
          if (token) seen.add(token);
        } while (token);
      }
      for (const [logicalId, resource] of Object.entries<any>(template?.Resources ?? {})) {
        if (["Retain", "RetainExceptOnCreate", "Snapshot"].includes(resource.DeletionPolicy)) {
          const physicalId = physicalIds.get(logicalId);
          const dependencyPhysicalIds = new Set<string>();
          const scan = (value: any): void => {
            if (!value || typeof value !== "object") return;
            const ref = value.Ref ?? (typeof value["Fn::GetAtt"] === "string" ? value["Fn::GetAtt"].split(".")[0] : value["Fn::GetAtt"]?.[0]);
            if (typeof ref === "string" && physicalIds.has(ref)) dependencyPhysicalIds.add(physicalIds.get(ref)!);
            const sub = typeof value["Fn::Sub"] === "string" ? value["Fn::Sub"] : value["Fn::Sub"]?.[0];
            if (typeof sub === "string") for (const match of sub.matchAll(/\$\{([^!}][^}.]*)(?:\.[^}]*)?\}/g)) if (physicalIds.has(match[1]!)) dependencyPhysicalIds.add(physicalIds.get(match[1]!)!);
            Object.values(value).forEach(scan);
          };
          scan(resource.Properties);
          remains.push({ stack: stackName, stackId: described.get(stackName)!.StackId!, logicalId, type: resource.Type, policy: resource.DeletionPolicy, ...(physicalId ? { physicalId } : {}), templateDigest: digest(template), ...(dependencyPhysicalIds.size ? { dependencyPhysicalIds: [...dependencyPhysicalIds].sort() } : {}) });
          if (!physicalId) warnings.push(`Retained resource ${stackName}/${logicalId} has no physical identity in the deployed inventory. Its availability/recovery will remain uncertain.`);
        }
      }
    } catch (error) { blockers.push("Cannot read deletion policies for " + stackName + ": " + (error instanceof Error ? error.message : String(error))); }
    if (described.get(stackName)?.StackStatus === "DELETE_FAILED") {
      try { failures.set(stackName, failedResources(aws, described.get(stackName)!.StackId!)); }
      catch (error) { blockers.push("Cannot identify failed resources for " + stackName + ": " + (error instanceof Error ? error.message : String(error))); }
    }
  }
  const consequences = statefulTeardownConsequences(deployedTemplates);
  blockers.push(...consequences.blockers);
  warnings.push(...consequences.warnings);
  let secrets: string[] = [];
  try {
    secrets = (runAwsSync(["secretsmanager", "list-secrets", "--filters", "Key=tag-key,Values=framework:deployment", `Key=tag-value,Values=${name}`], aws).SecretList ?? []).map((secret: any) => String(secret.Name));
  } catch (error) { blockers.push("Managed secret inventory is unreadable; deletion cannot establish the retained scope. " + (error instanceof Error ? error.message : String(error))); }
  let record = false;
  try { record = (runAwsSync(["ssm", "get-parameters-by-path", "--path", RECORD_PATH], aws).Parameters ?? []).some((parameter: any) => parameter.Name === `${RECORD_PATH}${name}`); } catch (error) { warnings.push("Deployment record inventory is unreadable. " + (error instanceof Error ? error.message : String(error))); }
  const scope = {
    deployment: name, mode, account, region, policy,
    stacks: ordered.map((stackName) => ({ name: stackName, id: described.get(stackName)?.StackId ?? "", updated: described.get(stackName)?.LastUpdatedTime ?? described.get(stackName)?.CreationTime, templateDigest: templates.get(stackName) ?? "unknown", failedResources: failures.get(stackName) ?? [], status: described.get(stackName)?.StackStatus ?? "UNKNOWN", terminationProtection: described.get(stackName)?.EnableTerminationProtection === true, importedBy: importedBy.get(stackName) ?? [] })),
    leftInPlace, remains, secrets: secrets.sort(), record,
  };
  return { version: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), digest: digest(scope), blockers, warnings, ...scope };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, inner) => inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner)).digest("hex");
}

function printPlan(plan: TeardownPlan): void {
  for (const message of plan.blockers) console.error("Blocked: " + message);
  for (const message of plan.warnings) console.warn(message);
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
      return { deleted: false, failures: failedResources(aws, stackName) };
    }
    await delay(POLL_MS);
  }
  return { deleted: false, failures: [] };
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const saved: TeardownPlan | undefined = opts.apply ? JSON.parse(readFileSync(path.resolve(opts.apply), "utf8")) : undefined;
  if (saved && (saved.version !== 1 || !saved.digest || Date.parse(saved.expiresAt) < Date.now())) throw new Error("This teardown review is invalid or expired. Review deletion again. Nothing was deleted.");
  // An explicit deployed identity must remain recoverable with broken/removed source.
  const project = opts.deployment || saved ? {} : readCdkContext(root);
  const get = (key: string) => opts.context[key] ?? project[key];
  const suppliedMode = modeFromContext(get).mode;
  if (saved && suppliedMode && suppliedMode !== saved.mode) throw new Error("The requested mode differs from the reviewed teardown. Nothing was deleted.");
  const statedMode = saved?.mode ?? suppliedMode;
  const target = opts.deployment || saved ? undefined : resolveRepositoryTarget({ root, get, env: process.env, requireInputs: false });
  const name = saved?.deployment ?? opts.deployment ?? target!.target.name;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error("Invalid deployment name.");
  const region = saved?.region ?? opts.region ?? target?.target.region ?? profileRegion(opts.profile);
  if (!region) throw new Error("No region: pass --region or configure the selected profile.");
  if (saved && (opts.deployment && opts.deployment !== name || opts.region && opts.region !== region)) throw new Error("The requested destination differs from the reviewed teardown. Nothing was deleted.");
  const aws: AwsTarget = { region, ...(opts.profile ? { profile: opts.profile } : {}) };
  const account = String(runAwsSync(["sts", "get-caller-identity"], aws).Account);
  if (saved && account !== saved.account) throw new Error("The selected profile reaches another account than the reviewed teardown. Nothing was deleted.");
  const release = saved && opts.confirm ? acquireDeploymentLock(path.join(root, ".cache/deploy"), name) : () => {};
  try {
  if (saved && (opts.retainFailed && !saved.policy?.retainFailed || opts.allowDisableProtection && !saved.policy?.disableProtection)) throw new Error("Deletion policy differs from the saved review. Review again. Nothing was deleted.");
  const plan = teardownPlan(aws, account, region, name, statedMode, saved?.policy ?? { retainFailed: opts.retainFailed, disableProtection: opts.allowDisableProtection });
  if (opts.plan || opts.confirm === undefined) {
    if (opts.savePlan) { mkdirSync(path.dirname(path.resolve(opts.savePlan)), { recursive: true }); writeFileSync(path.resolve(opts.savePlan), JSON.stringify(plan, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
    if (opts.json) process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    else { printPlan(plan); console.log("Nothing was deleted. Save this review with --plan --save-plan <file>, then --apply <file> --confirm " + name + "."); }
    return;
  }
  if (opts.confirm !== name) throw new Error("--confirm " + opts.confirm + " does not name " + name + ". Nothing was deleted.");
  if (!saved) throw new Error("Deletion requires a saved review. Run --plan --save-plan <file>, then --apply <file> --confirm " + name + ". Nothing was deleted.");
  if (plan.blockers.length || saved.blockers.length) throw new Error("Deletion is blocked: " + [...new Set([...saved.blockers, ...plan.blockers])].join("; ") + " Nothing was deleted.");
  if (saved.digest !== plan.digest) throw new Error("Deployed stack identities, dependencies or data policies changed since review. Review deletion again. Nothing was deleted.");
  printPlan(plan);
  const completed: string[] = [];
  let pending: string | undefined;
  const journal = (state: string, problem?: string) => writeDeploymentRecordAtomic(path.resolve(opts.apply!) + ".result.json", { digest: saved.digest, deployment: name, account, region, state, completed, pending, ...(problem ? { problem } : {}), updatedAt: new Date().toISOString() });
  const retainedEvidence = (phase: "before-teardown" | "teardown-completed" | "teardown-failed", problem?: string) => recordRetainedResources(root, { account, region, deployment: name, mode: plan.mode }, { reviewDigest: saved.digest, createdAt: new Date().toISOString(), phase, resources: plan.remains, completedStackIds: [...completed], ...(problem ? { problem } : {}) });
  // Persist physical identities before the first destructive request. Failure to
  // preserve this evidence prevents teardown; no write is silently best effort.
  retainedEvidence("before-teardown");
  journal("running");
  try {
  for (const stack of plan.stacks) {
    pending = stack.id;
    journal("checking stack");
    // Recheck the exact stack identity and template immediately before each destructive phase.
    const current = runAwsSync(["cloudformation", "describe-stacks", "--stack-name", stack.id || stack.name], aws).Stacks?.[0];
    if (!current || current.StackId !== stack.id || current.StackStatus !== stack.status || (current.LastUpdatedTime ?? current.CreationTime) !== stack.updated) throw new Error("Stack changed during teardown: " + stack.name + ". Completed: " + (completed.join(", ") || "none") + ". Review remaining deletion again.");
    const raw = runAwsSync(["cloudformation", "get-template", "--stack-name", stack.id, "--template-stage", "Original"], aws).TemplateBody;
    if (digest(typeof raw === "string" ? JSON.parse(raw) : raw) !== stack.templateDigest) throw new Error("Deletion policies changed during teardown: " + stack.name + ". Review again.");
    for (const output of current.Outputs ?? []) if (output.ExportName && stackImporters(aws, output.ExportName).length) throw new Error("Stack still has importers: " + stack.name + ". Completed: " + (completed.join(", ") || "none") + ". Review remaining dependencies.");
    journal("deleting stack");
    if (stack.terminationProtection) runAwsSync(["cloudformation", "update-termination-protection", "--stack-name", stack.id, "--no-enable-termination-protection"], aws);
    const retain = plan.policy.retainFailed ? stack.failedResources : [];
    runAwsSync(["cloudformation", "delete-stack", "--stack-name", stack.id, ...(retain.length ? ["--retain-resources", ...retain] : [])], aws);
    console.log("Deleting " + stack.name + "…");
    const outcome = await waitForDeletion(aws, stack.id);
    if (!outcome.deleted) {
      journal("failed", "CloudFormation could not delete the reviewed stack.");
      throw new Error(stack.name + " could not be deleted: " + (outcome.failures.join(", ") || "timed out") + ". Completed: " + (completed.join(", ") || "none") + ". Stacks after it were not deleted. Review deletion again; --retain-failed keeps the specifically reviewed failed resources.");
    }
    completed.push(stack.id);
    pending = undefined;
    journal("running");
    console.log("✔ " + stack.name + " deleted.");
  }
  journal("succeeded");
  retainedEvidence("teardown-completed");
  } catch (error) { const message = error instanceof Error ? error.message : String(error); journal("failed", message); retainedEvidence("teardown-failed", message); throw error; }
  if (plan.record) {
    try { runAwsSync(["ssm", "delete-parameter", "--name", `${RECORD_PATH}${name}`], aws); } catch { console.warn(`The deployment record ${RECORD_PATH}${name} could not be removed.`); }
  }
  let leftovers: string[] = [];
  try {
    leftovers = (runAwsSync(["resourcegroupstaggingapi", "get-resources", "--tag-filters", `Key=framework:deployment,Values=${name}`], aws).ResourceTagMappingList ?? []).map((entry: any) => String(entry.ResourceARN));
  } catch (error) { console.warn("Retained-resource inventory could not be read; cleanup remains unverified. " + (error instanceof Error ? error.message : String(error))); }
  console.log(`${name}: all reviewed stacks are deleted from ${account}/${region}. Retained resources and managed secrets are separate.`);
  if (leftovers.length) console.log(`Still tagged as ${name}'s (retained on purpose, or awaiting cleanup): ${leftovers.join(", ")}`);
  } finally { release(); }
}

main().catch((error) => {
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ error: { kind: error instanceof AwsCliError ? error.kind : "failed", message: error instanceof Error ? error.message : String(error) } })}\n`);
  console.error(error instanceof Error ? error.message : "Teardown failed.");
  process.exitCode = 1;
});
