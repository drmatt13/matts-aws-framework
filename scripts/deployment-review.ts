import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stackEvidence, type DeploymentIdentity, type ObservedStack } from "@repo/framework/deploy";
import { AwsCliError, runAwsSync, type AwsTarget } from "./aws-cli";
import { readAssemblyStacks } from "./cloud-assembly";
import type { Replacement, ResourceAction, ResourceChange, StackFingerprint } from "./deployment-plan";
import { STATEFUL_TYPES } from "./deployment-plan";

/**
 * The AWS reads (and the few writes) a reviewed deployment needs around the CDK
 * CLI: what each stack is now, what its change set says, whether what was
 * deployed is what was reviewed, and the advisory deployment record.
 */

export function describeStack(aws: AwsTarget, name: string): ObservedStack & { EnableTerminationProtection?: boolean } | undefined {
  try {
    return runAwsSync(["cloudformation", "describe-stacks", "--stack-name", name], aws).Stacks?.[0];
  } catch (error) {
    if (error instanceof AwsCliError && (error.kind === "not-found" || /does not exist/.test(error.detail))) return undefined;
    throw error;
  }
}

export function fingerprintOf(stack: ObservedStack | undefined): StackFingerprint {
  return stack && stack.StackStatus !== "DELETE_COMPLETE"
    ? { exists: true, status: stack.StackStatus, updated: stack.LastUpdatedTime ?? stack.CreationTime }
    : { exists: false };
}

export function deployedTemplate(aws: AwsTarget, name: string): any {
  return runAwsSync(["cloudformation", "get-template", "--stack-name", name, "--template-stage", "Original"], aws).TemplateBody;
}

export interface AssemblyStackEntry { readonly id: string; readonly name: string; readonly template: any; readonly dependencies: readonly string[] }

/** The selected stacks, dependencies first. */
export function stackOrder(assembly: string, selected: readonly string[]): AssemblyStackEntry[] {
  const stacks = readAssemblyStacks(assembly);
  const byId = new Map(stacks.map((stack) => [stack.id, stack]));
  const ordered: AssemblyStackEntry[] = [];
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id) || !selected.includes(id)) return;
    done.add(id);
    const stack = byId.get(id)!;
    for (const dependency of stack.dependencies) visit(dependency);
    ordered.push({ id, name: stack.artifact.properties?.stackName ?? id, template: stack.template, dependencies: stack.dependencies.filter((dependency) => selected.includes(dependency)) });
  };
  for (const id of selected) visit(id);
  return ordered;
}

/** The container images an assembly publishes: Docker is needed to build any that ECR lacks. */
export function dockerImages(assembly: string): { stack: string; asset: string; directory?: string }[] {
  const manifest = JSON.parse(readFileSync(path.join(assembly, "manifest.json"), "utf8"));
  const images: { stack: string; asset: string; directory?: string }[] = [];
  for (const [id, artifact] of Object.entries<any>(manifest.artifacts ?? {})) {
    if (artifact.type !== "cdk:asset-manifest" || !artifact.properties?.file) continue;
    const assets = JSON.parse(readFileSync(path.join(assembly, artifact.properties.file), "utf8"));
    for (const [asset, entry] of Object.entries<any>(assets.dockerImages ?? {})) {
      images.push({ stack: id.replace(/\.assets$/, ""), asset, ...(entry.source?.directory ? { directory: entry.source.directory } : {}) });
    }
  }
  return images;
}

export interface ChangeSetReview {
  readonly name: string;
  readonly id?: string;
  readonly status?: string;
  readonly executionStatus?: string;
  readonly statusReason?: string;
  readonly noChanges: boolean;
  readonly changes: readonly ResourceChange[];
}

/** CloudFormation's own account of a change set: per resource, the action and whether it replaces. */
export function describeChangeSet(aws: AwsTarget, stack: string, name: string): ChangeSetReview {
  const set = runAwsSync(["cloudformation", "describe-change-set", "--stack-name", stack, "--change-set-name", name], aws);
  const noChanges = set.Status === "FAILED" && /didn't contain changes|No updates are to be performed/i.test(String(set.StatusReason ?? ""));
  const changes: ResourceChange[] = (set.Changes ?? []).flatMap((entry: any) => {
    const change = entry.ResourceChange;
    if (!change) return [];
    const action = String(change.Action ?? "Modify").toLowerCase() as ResourceAction;
    const type = String(change.ResourceType ?? "Unknown");
    return [{
      logicalId: String(change.LogicalResourceId), type,
      action: (["add", "modify", "remove"].includes(action) ? action : "modify") as ResourceAction,
      replacement: (["True", "False", "Conditional"].includes(change.Replacement) ? change.Replacement : "Unknown") as Replacement,
      stateful: STATEFUL_TYPES.has(type),
      details: (change.Details ?? []).map((detail: any) => detail.Target?.Name ?? detail.Target?.Attribute).filter(Boolean),
    }];
  });
  return { name, id: set.ChangeSetId, status: set.Status, executionStatus: set.ExecutionStatus, statusReason: set.StatusReason, noChanges, changes };
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, inner) =>
  inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);

export interface Verification {
  readonly verified: boolean;
  readonly stacks: readonly { name: string; status?: string; identity: boolean; template: boolean; problem?: string }[];
}

/** Success is what AWS holds afterwards: a completed status, this deployment's identity, and the reviewed template. */
export function verifyDeployment(aws: AwsTarget, identity: DeploymentIdentity, stacks: readonly AssemblyStackEntry[]): Verification {
  const results = stacks.map((entry) => {
    const stack = describeStack(aws, entry.name);
    if (!stack) return { name: entry.name, identity: false, template: false, problem: "not found after the deployment" };
    const status = stack.StackStatus;
    const complete = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(String(status));
    const found = stackEvidence(stack).identity;
    const identityMatches = !!found && found.deployment === identity.deployment && found.mode === identity.mode && found.account === identity.account && found.region === identity.region;
    let template = false;
    try { template = stable(deployedTemplate(aws, entry.name)) === stable(entry.template); } catch { template = false; }
    const problem = !complete ? `ended ${status}` : !identityMatches ? "its deployment identity does not match" : !template ? "its deployed template differs from the reviewed one" : undefined;
    return { name: entry.name, status, identity: identityMatches, template, ...(problem ? { problem } : {}) };
  });
  return { verified: results.every((result) => !result.problem), stacks: results };
}

export const RECORD_PATH = "/framework/deployments/";

function git(args: string[]): string | undefined {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return undefined; }
}

/** Advisory: which revision was deployed, by whom and how. Never used for a safety decision; a failure is a warning. */
export function writeDeploymentRecord(aws: AwsTarget, record: { identity: DeploymentIdentity; deployedBy: string; planId?: string; stacks: readonly string[]; assemblyDigest: string }): string | undefined {
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = (git(["status", "--porcelain"]) ?? "").length > 0;
  const name = `${RECORD_PATH}${record.identity.deployment}`;
  const value = JSON.stringify({
    contract: 2, ...record.identity,
    revision: { commit, dirty }, assemblyDigest: record.assemblyDigest, planId: record.planId,
    deployedAt: new Date().toISOString(), deployedBy: record.deployedBy,
    via: process.env.FRAMEWORK_DEPLOY_VIA === "studio" ? "studio" : "cli",
    stacks: record.stacks,
  });
  try {
    runAwsSync(["ssm", "put-parameter", "--name", name, "--type", "String", "--overwrite", "--value", value], aws);
    runAwsSync(["ssm", "add-tags-to-resource", "--resource-type", "Parameter", "--resource-id", name, "--tags",
      `Key=framework:deployment,Value=${record.identity.deployment}`, `Key=framework:mode,Value=${record.identity.mode}`, "Key=framework:owner,Value=matts-aws-framework"], aws);
    return undefined;
  } catch (error) {
    return `The deployment record ${name} was not written (${error instanceof Error ? error.message : String(error)}). It is advisory; the deployment itself is unaffected.`;
  }
}

/**
 * A Secrets Manager client over the AWS CLI, used only when FRAMEWORK_AWS_CLI
 * points the scripts at a simulated account (the tests). Real deployments use
 * the SDK, which never puts a value on a command line.
 */
export function cliSecretsClient(aws: AwsTarget): { send(command: any): Promise<any> } {
  return {
    async send(command: any) {
      const input = command.input ?? {};
      const name = command.constructor?.name ?? "";
      try {
        if (name === "DescribeSecretCommand") return runAwsSync(["secretsmanager", "describe-secret", "--secret-id", input.SecretId], aws);
        if (name === "GetSecretValueCommand") return runAwsSync(["secretsmanager", "get-secret-value", "--secret-id", input.SecretId], aws);
        if (name === "CreateSecretCommand") return runAwsSync(["secretsmanager", "create-secret", "--name", input.Name, "--secret-string", input.SecretString ?? ""], aws);
        if (name === "PutSecretValueCommand") return runAwsSync(["secretsmanager", "put-secret-value", "--secret-id", input.SecretId, "--secret-string", input.SecretString ?? ""], aws);
      } catch (error) {
        if (error instanceof AwsCliError && error.kind === "not-found") throw Object.assign(new Error("absent"), { name: "ResourceNotFoundException" });
        throw error;
      }
      throw new Error(`Unsupported secrets call ${name}.`);
    },
  };
}
