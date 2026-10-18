#!/usr/bin/env node
/**
 * What AWS holds for this repository's deployments. Read-only, except `drift`,
 * which starts CloudFormation drift detection (it changes no resource).
 *
 *   npm run deploy:status -- profiles
 *   npm run deploy:status -- identity --profile <PROFILE> [--region <REGION>]
 *   npm run deploy:status -- discover --profile <PROFILE> [--region <REGION>]
 *   npm run deploy:status -- status [--deployment <NAME>] --profile <PROFILE>
 *   npm run deploy:status -- watch --deployment <NAME> --profile <PROFILE> [--follow]
 *   npm run deploy:status -- drift --deployment <NAME> --profile <PROFILE>
 *
 * --json prints one JSON document (watch prints JSON lines). Studio reads AWS
 * only through this command. A deployment's mode comes from the deployment's
 * own records, never from the profile's name.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import {
  DEPLOYMENT_METADATA_KEY, discoverDeployments, lookalikeStacks, matchTargets, namedDeployment,
  type DiscoveredDeployment, type ObservedStack,
} from "@repo/framework/deploy";
import { repositoryTargets, resolveRepositoryTarget } from "@repo/framework/deploy/node";
import { AwsCliError, readAllPages, runAws, type AwsTarget } from "./aws-cli";
import { listAwsProfiles, profileRegion } from "./aws-profiles";

const root = path.resolve(__dirname, "..");
export { RECORD_PATH } from "./deployment-review";
import { RECORD_PATH } from "./deployment-review";

interface Options { profile?: string; region?: string; deployment?: string; json: boolean; follow: boolean; interval: number }

function parseOptions(args: readonly string[]): Options {
  const value = (name: string) => {
    const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (index < 0) return undefined;
    const arg = args[index]!;
    return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  };
  return {
    profile: value("profile") ?? process.env.AWS_PROFILE,
    region: value("region"),
    deployment: value("deployment"),
    json: args.includes("--json") || args.includes("--jsonl"),
    follow: args.includes("--follow"),
    interval: Number(value("interval") ?? 3000),
  };
}

async function identity(options: Options) {
  const region = profileRegion(options.profile, options.region);
  if (!region) throw new AwsCliError("failed", `No region: the profile ${options.profile ?? "default"} sets none. Pass --region or set one with aws configure.`, "");
  const aws: AwsTarget = { profile: options.profile, region };
  const caller = await runAws(["sts", "get-caller-identity"], aws);
  return { aws, context: { profile: options.profile ?? "default", account: String(caller.Account), region, arn: String(caller.Arn) } };
}

async function listStacks(aws: AwsTarget): Promise<ObservedStack[]> {
  return readAllPages<ObservedStack>((token) => runAws(["cloudformation", "describe-stacks", "--no-paginate", ...(token ? ["--next-token", token] : [])], aws), "Stacks");
}

export async function discover(options: Options) {
  const { aws, context } = await identity(options);
  const stacks = await listStacks(aws);
  const targets = repositoryTargets(root);
  const known = [...new Set([...targets.map((target) => target.name), ...stacks.flatMap((stack) => namedDeployment(stack) ?? [])])];
  const unreadable: string[] = [];
  const templates = new Map<string, unknown>();
  // Stacks with no record of their own that look like a known deployment's:
  // their template may still say whose they are (a failed first create keeps it).
  await Promise.all(lookalikeStacks(stacks, known).slice(0, 25).map(async (stack) => {
    const name = stack.StackName!;
    try {
      const summary = await runAws(["cloudformation", "get-template-summary", "--stack-name", name], aws);
      const metadata = typeof summary.Metadata === "string" ? JSON.parse(summary.Metadata) : undefined;
      if (metadata?.[DEPLOYMENT_METADATA_KEY]) { templates.set(name, { Metadata: metadata }); return; }
      templates.set(name, (await runAws(["cloudformation", "get-template", "--stack-name", name, "--template-stage", "Original"], aws)).TemplateBody);
    } catch {
      unreadable.push(`the template of ${name}`);
    }
  }));
  const discovery = discoverDeployments(stacks, context, templates, known);
  const records: Record<string, unknown> = {};
  try {
    const parameters = await readAllPages<{ Name: string; Value: string }>((token) => runAws(["ssm", "get-parameters-by-path", "--path", RECORD_PATH, "--no-paginate", ...(token ? ["--next-token", token] : [])], aws), "Parameters");
    for (const parameter of parameters) {
      try { records[parameter.Name.slice(RECORD_PATH.length)] = JSON.parse(parameter.Value); } catch { /* Not a record this command wrote. */ }
    }
  } catch {
    unreadable.push("deployment records (ssm:GetParametersByPath)");
  }
  return {
    aws, context, stacks, templates,
    result: {
      context,
      deployments: discovery.deployments,
      unrecognized: discovery.unrecognized,
      targets: matchTargets(targets, discovery, context),
      records, unreadable,
      observedAt: new Date().toISOString(),
    },
  };
}

function deploymentName(options: Options): string {
  return options.deployment ?? resolveRepositoryTarget({ root, get: () => undefined, env: process.env, requireInputs: false }).target.name;
}

async function recentEvents(aws: AwsTarget, deployment: DiscoveredDeployment, limit = 15) {
  const events = await Promise.all(deployment.stacks.map(async (stack) => {
    try {
      const page = await runAws(["cloudformation", "describe-stack-events", "--stack-name", stack.name, "--max-items", String(limit)], aws);
      return (page.StackEvents ?? []).map((event: any) => ({
        stack: stack.name, id: event.EventId, time: event.Timestamp, logicalId: event.LogicalResourceId,
        type: event.ResourceType, status: event.ResourceStatus, reason: event.ResourceStatusReason,
      }));
    } catch {
      return [];
    }
  }));
  return events.flat().sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 60);
}

/** A change set deploy:resources --plan prepared: named by its plan id (plan-<time>-<hash>), or framework-<…>. */
const OUR_CHANGE_SET = /^(framework-|plan-[0-9a-z]+-[0-9a-f]{6}$)/;

async function pendingChangeSets(aws: AwsTarget, deployment: DiscoveredDeployment) {
  const sets = await Promise.all(deployment.stacks.map(async (stack) => {
    try {
      const page = await runAws(["cloudformation", "list-change-sets", "--stack-name", stack.name], aws);
      return (page.Summaries ?? []).map((summary: any) => ({
        stack: stack.name, name: summary.ChangeSetName, status: summary.Status, executionStatus: summary.ExecutionStatus,
        created: summary.CreationTime, ours: OUR_CHANGE_SET.test(String(summary.ChangeSetName ?? "")),
      }));
    } catch {
      return [];
    }
  }));
  return sets.flat();
}

/** Whether local development can run against this deployment, and whether the exported files are its current outputs. */
function localState(deployment: DiscoveredDeployment, stacks: readonly ObservedStack[]) {
  if (deployment.mode !== "dev") return undefined;
  const own = stacks.filter((stack) => deployment.stacks.some((member) => member.name === stack.StackName));
  let compatible = true;
  let problem: string | undefined;
  let manifest: unknown;
  try {
    // Loaded only here: it evaluates the framework configuration.
    const { collectDevelopmentResources } = require("./resource-export") as typeof import("./resource-export");
    const { default: framework } = require("../framework.config") as typeof import("../framework.config");
    manifest = collectDevelopmentResources(own as any, deployment.name, framework).manifest;
  } catch (error) {
    compatible = false;
    problem = error instanceof Error ? error.message : String(error);
  }
  const { RESOURCE_MANIFEST_FILE } = require("@repo/framework/config") as typeof import("@repo/framework/config");
  // Where export writes: the repository root, unless FRAMEWORK_EXPORT_DIRECTORY says otherwise (as for deploy.ts).
  const exported = process.env.FRAMEWORK_EXPORT_DIRECTORY ? path.resolve(process.env.FRAMEWORK_EXPORT_DIRECTORY) : root;
  const manifestFile = path.join(exported, RESOURCE_MANIFEST_FILE);
  const exportedManifest = existsSync(manifestFile) ? (() => { try { return JSON.parse(readFileSync(manifestFile, "utf8")); } catch { return undefined; } })() : undefined;
  const rootEnvFile = path.join(exported, ".env");
  const rootEnv = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, "utf8")) : {};
  const clientFile = path.join(exported, "client-app", ".env.development.local");
  return {
    compatible, ...(problem ? { problem } : {}),
    exported: {
      deployment: rootEnv.LOCAL_FRAMEWORK_DEPLOYMENT || undefined,
      manifest: exportedManifest ? (exportedManifest as { deployment?: string }).deployment : undefined,
      client: existsSync(clientFile),
      fresh: manifest !== undefined && isDeepStrictEqual(exportedManifest, manifest) && rootEnv.LOCAL_FRAMEWORK_DEPLOYMENT === deployment.name && existsSync(clientFile),
    },
  };
}

export async function status(options: Options) {
  const name = deploymentName(options);
  const found = await discover(options);
  const { aws } = found;
  const deployment = found.result.deployments.find((entry) => entry.name === name);
  return {
    ...found.result,
    deployment: name,
    detail: deployment ? {
      ...deployment,
      events: await recentEvents(aws, deployment),
      changeSets: await pendingChangeSets(aws, deployment),
      local: localState(deployment, found.stacks),
    } : undefined,
  };
}

async function watch(options: Options) {
  const name = deploymentName(options);
  const { aws, context } = await identity(options);
  const write = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const seen = new Set<string>();
  let last = "";
  let quiet = 0;
  write({ type: "context", context, deployment: name });
  for (;;) {
    const stacks = (await listStacks(aws)).filter((stack) => {
      const owner = namedDeployment(stack);
      return owner === name || (!owner && new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Za-z0-9]+$`).test(stack.StackName ?? ""));
    });
    const summary = stacks.map((stack) => ({ name: stack.StackName, status: stack.StackStatus, reason: stack.StackStatusReason, updated: stack.LastUpdatedTime ?? stack.CreationTime }));
    const fingerprint = JSON.stringify(summary);
    if (fingerprint !== last) { write({ type: "stacks", at: new Date().toISOString(), stacks: summary }); last = fingerprint; }
    const active = stacks.filter((stack) => /_IN_PROGRESS$/.test(stack.StackStatus ?? "") && stack.StackStatus !== "REVIEW_IN_PROGRESS");
    for (const stack of active.length ? active : stacks.slice(0, 0)) {
      try {
        const page = await runAws(["cloudformation", "describe-stack-events", "--stack-name", stack.StackName!, "--max-items", "50"], aws);
        const fresh = (page.StackEvents ?? []).filter((event: any) => !seen.has(event.EventId)).reverse();
        for (const event of fresh) {
          seen.add(event.EventId);
          write({ type: "event", stack: stack.StackName, event: { id: event.EventId, time: event.Timestamp, logicalId: event.LogicalResourceId, type: event.ResourceType, status: event.ResourceStatus, reason: event.ResourceStatusReason } });
        }
      } catch { /* The stack may have just been deleted. */ }
    }
    quiet = active.length ? 0 : quiet + 1;
    if (!options.follow && quiet >= 2) { write({ type: "idle", at: new Date().toISOString() }); return; }
    await new Promise((resolve) => setTimeout(resolve, options.interval));
  }
}

async function drift(options: Options) {
  const name = deploymentName(options);
  const found = await discover(options);
  const { aws } = found;
  const deployment = found.result.deployments.find((entry) => entry.name === name);
  if (!deployment) throw new Error(`${name} is not deployed in ${found.context.account}/${found.context.region}.`);
  const results = await Promise.all(deployment.stacks.map(async (stack) => {
    const { StackDriftDetectionId: id } = await runAws(["cloudformation", "detect-stack-drift", "--stack-name", stack.name], aws);
    for (let attempt = 0; attempt < 60; attempt++) {
      const detection = await runAws(["cloudformation", "describe-stack-drift-detection-status", "--stack-drift-detection-id", id], aws);
      if (detection.DetectionStatus !== "DETECTION_IN_PROGRESS") {
        const drifts = detection.StackDriftStatus === "DRIFTED"
          ? (await runAws(["cloudformation", "describe-stack-resource-drifts", "--stack-name", stack.name, "--stack-resource-drift-status-filters", "MODIFIED", "DELETED"], aws)).StackResourceDrifts ?? []
          : [];
        return {
          stack: stack.name, status: detection.StackDriftStatus, detection: detection.DetectionStatus, reason: detection.DetectionStatusReason,
          resources: drifts.map((entry: any) => ({ logicalId: entry.LogicalResourceId, type: entry.ResourceType, status: entry.StackResourceDriftStatus })),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { stack: stack.name, status: "UNKNOWN", detection: "TIMED_OUT", resources: [] };
  }));
  return { deployment: name, checkedAt: new Date().toISOString(), note: "Drift detection covers resource types CloudFormation supports, and only properties set in the template.", stacks: results };
}

function printHuman(command: string, value: any): void {
  if (command === "profiles") {
    for (const profile of value) console.log(`${profile.name}\t${profile.region ?? "(no region)"}\t${profile.kind}`);
    return;
  }
  if (command === "identity") { console.log(`${value.context.arn}\n${value.context.account} ${value.context.region} (profile ${value.context.profile})`); return; }
  const result = value;
  console.log(`Account ${result.context.account} · ${result.context.region} · profile ${result.context.profile}`);
  for (const deployment of result.deployments ?? []) {
    console.log(`  ${deployment.name}  ${deployment.mode}  ${deployment.state.kind}  contract ${deployment.contracts.join("+")}  ${deployment.stacks.length} stacks  ${deployment.lastUpdated ?? ""}`);
  }
  for (const target of result.targets ?? []) console.log(`  target ${target.name} (${target.mode}): ${target.status}${target.detail ? ` — ${target.detail}` : ""}`);
  for (const stack of result.unrecognized ?? []) console.log(`  unrecognized ${stack.name} (${stack.status}): ${stack.reason}`);
  for (const item of result.unreadable ?? []) console.log(`  could not read ${item}`);
}

async function main(): Promise<void> {
  const [command = "discover", ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const run: Record<string, () => Promise<unknown> | unknown> = {
    profiles: () => listAwsProfiles(),
    identity: async () => ({ context: (await identity(options)).context }),
    discover: async () => (await discover(options)).result,
    status: () => status(options),
    drift: () => drift(options),
  };
  if (command === "watch") { await watch(options); return; }
  const handler = run[command];
  if (!handler) throw new Error(`Unknown command ${command}. Use profiles, identity, discover, status, watch or drift.`);
  const value = await handler();
  if (options.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else printHuman(command, value);
}

if (require.main === module) {
  main().catch((error) => {
    const kind = error instanceof AwsCliError ? error.kind : "failed";
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json") || process.argv.includes("--jsonl")) process.stdout.write(`${JSON.stringify({ error: { kind, message } })}\n`);
    else console.error(message);
    process.exitCode = 2;
  });
}
