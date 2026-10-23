/**
 * npm run deploy:resources — the supported way to change a deployment.
 *
 *   npm run deploy:resources -- --all [-c prodDeployment=true] --profile <PROFILE>
 *   npm run deploy:resources -- --all [...] --plan <dir> [--review template|change-set] [--create-secrets]
 *   npm run deploy:resources -- --apply <dir> [--confirm <deployment>] --profile <PROFILE>
 *   npm run deploy:resources -- --discard <dir> --profile <PROFILE>
 *
 * Every path resolves the target the CDK app builds, checks the synthesized
 * identity against it, takes the deployment's lock, checks the account, and
 * refuses to change stacks it does not own — before any secret is written.
 *
 * --plan reviews without deploying: it synthesizes into <dir>/assembly and writes
 * <dir>/plan.json (what would change, by resource; secrets by name; IAM
 * broadening; exports still in use; Docker images; the confirmation the change
 * needs). A change-set review (production's default) prepares CloudFormation
 * change sets, which modify no resource; --create-secrets first creates the
 * managed secrets that do not exist yet, and writes no existing one. --apply
 * deploys exactly that assembly, refusing a plan that is stale, expired or
 * unconfirmed, or whose secret writes differ from the reviewed ones (see
 * deployment-secrets.ts), and verifies the result in AWS. --discard removes what
 * a plan created.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { contextFromArgs, readCdkContext, resolveRepositoryTarget, type RepositoryTarget } from "@repo/framework/deploy/node";
import { stackEvidence, type DeploymentState } from "@repo/framework/deploy";
import { runAwsSync, type AwsTarget } from "./aws-cli";
import { deploymentArguments, inspectDeploymentAssembly } from "./deployment-assembly";
import { assertDeploymentAllowed, productionDeployArguments } from "./deployment-guard";
import { DeploymentInterrupt } from "./deployment-interrupt";
import {
  changedExports, confirmationLevel, PLAN_LIFETIME_MS, PLAN_UNCERTAINTIES, PLAN_VERSION, staleness, templateChanges,
  type ExportInUse, type ResourceChange, type StackFingerprint,
} from "./deployment-plan";
import {
  cliSecretsClient, deployedTemplate, describeChangeSet, describeStack, dockerImages, fingerprintOf, stackOrder, stackImporters, deploymentSourceRevision,
  verifyDeployment, writeDeploymentRecord, type AssemblyStackEntry, type ChangeSetReview,
} from "./deployment-review";
import { planDeploymentSecrets, type SecretBinding, type SecretPlanEntry } from "./deployment-secrets";
import { acquireDeploymentLock, secretBindings, sweepStaleAssemblies } from "./deployment-workspace";
import { readDeploymentStackPages } from "./resource-export";
import { assemblyDigest } from "./deployment-integrity";
import { writeDeploymentRecordAtomic } from "./deployment-artifact";
import { inspectInfrastructureAssembly } from "./infrastructure-inventory";
import { assertCognitoDomainReview, cognitoDomainChanges, type CognitoDomainChange } from "./deployment-cognito-domains";
import { assertStatefulOwnershipTransitions, validateAssemblyStatefulReferences } from "./stateful-references";
import { acquireStatefulReferenceLocks } from "./stateful-reference-locks";

const root = resolve(__dirname, "..");
const cdk = process.env.FRAMEWORK_CDK_CLI ?? require.resolve("aws-cdk/bin/cdk");
const cdkDirectory = resolve(root, "cdk-app");
/** Where each reviewed plan's secret binding is kept: see deployment-secrets.ts. */
const bindings = resolve(root, ".cache/deploy/secret-bindings");

// Ctrl+C stops the running step and refuses to start another: see deployment-interrupt.ts.
const interrupt = new DeploymentInterrupt();
const cleanups = interrupt.cleanups;
const run = (file: string, args: string[], cwd = root) => interrupt.run(file, args, cwd);

interface Wrapper {
  readonly plan?: string;
  readonly apply?: string;
  readonly discard?: string;
  readonly confirm?: string;
  readonly review?: "template" | "change-set";
  readonly createSecrets: boolean;
  /** The arguments that remain, for the CDK CLI. */
  readonly rest: string[];
}

/** The options this wrapper owns, removed before the rest go to the CDK CLI. */
function wrapperOptions(args: readonly string[]): Wrapper {
  const rest: string[] = [];
  const values: Record<string, string | true> = {};
  const owned = new Set(["plan", "apply", "discard", "confirm", "review", "create-secrets"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!match || !owned.has(match[1]!)) { rest.push(arg); continue; }
    const key = match[1]!;
    if (key === "create-secrets") { values[key] = true; continue; }
    const value = match[2] ?? args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value.`);
    values[key] = value;
  }
  const review = values.review;
  if (review !== undefined && review !== "template" && review !== "change-set") throw new Error("--review is template or change-set.");
  const modes = ["plan", "apply", "discard"].filter((key) => values[key] !== undefined);
  if (modes.length > 1) throw new Error(`--${modes.join(" and --")} cannot be combined.`);
  return {
    plan: values.plan as string | undefined, apply: values.apply as string | undefined, discard: values.discard as string | undefined,
    confirm: values.confirm as string | undefined, review: review as Wrapper["review"], createSecrets: values["create-secrets"] === true, rest,
  };
}

interface PlanStack {
  readonly dependencies?: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly fingerprint: StackFingerprint;
  readonly changes: readonly ResourceChange[];
  readonly exportsInUse: readonly ExportInUse[];
  readonly noChanges: boolean;
  readonly changeSet?: Omit<ChangeSetReview, "changes">;
  readonly deferred?: string;
  readonly createdByPlan?: boolean;
}

export interface DeploymentPlanDocument {
  readonly version: number;
  readonly planId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "ready" | "no-changes" | "needs-secrets" | "blocked";
  readonly review: "template" | "change-set";
  readonly target: { readonly name: string; readonly mode: "dev" | "prod"; readonly inputsFile: string; readonly account?: string; readonly region?: string };
  readonly identity: { readonly deployment: string; readonly mode: "dev" | "prod"; readonly account: string; readonly region: string };
  readonly profile?: string;
  readonly forwarded: readonly string[];
  readonly guard: DeploymentState["kind"];
  readonly stacks: readonly PlanStack[];
  readonly secrets: readonly SecretPlanEntry[];
  readonly dockerImages: readonly { stack: string; asset: string }[];
  readonly iamBroadening: boolean;
  readonly confirmation: { readonly level: "none" | "click" | "name"; readonly reasons: readonly string[] };
  readonly uncertainties: readonly string[];
  readonly assemblyDigest: string;
  readonly retainedStacks?: readonly { name: string; status: string }[];
  readonly reviewEvidence?: { security: string; templates: string; problems: readonly string[] };
  readonly sourceRevision?: { commit?: string; dirty: boolean };
  /** Explicitly reviewed compatibility migration for an existing development custom domain. */
  readonly cognitoDomainChanges?: readonly CognitoDomainChange[];
}

interface Prepared {
  readonly selection: ReturnType<typeof deploymentArguments>;
  readonly target: RepositoryTarget;
  readonly authored: Record<string, string | undefined>;
  readonly profile?: string;
  readonly aws: AwsTarget;
  readonly graph: ReturnType<typeof inspectDeploymentAssembly>;
  readonly assembly: string;
  readonly stacks: readonly AssemblyStackEntry[];
  readonly deployed: DeploymentState;
  readonly callerArn: string;
  readonly release: () => void;
}

/** Everything every path shares, up to (not including) the first secret read or write. */
async function prepare(args: readonly string[], assembly: { directory: string; synthesize: boolean }, overrides: { inputsFile?: string; reviewedTarget?: DeploymentPlanDocument["target"]; plannedReviews?: ReadonlySet<string> } = {}): Promise<Prepared> {
  const selection = deploymentArguments(args);
  // The target the CDK app will build for these arguments, resolved the same way
  // (bin/app.ts): -c prodDeployment / -c deployment and framework:targets. Its
  // inputs file is where secret values come from.
  if (overrides.inputsFile) process.env.FRAMEWORK_INPUTS_FILE = overrides.inputsFile;
  if (!process.env.FRAMEWORK_INPUTS_FILE?.trim()) delete process.env.FRAMEWORK_INPUTS_FILE;
  const argumentContext = contextFromArgs(args);
  const reviewed = overrides.reviewedTarget;
  const projectContext = reviewed ? {} : readCdkContext(root);
  const target: RepositoryTarget = reviewed ? {
    target: { name: reviewed.name, mode: reviewed.mode, origin: "named", ...(reviewed.account ? { account: reviewed.account } : {}), ...(reviewed.region ? { region: reviewed.region } : {}) },
    mode: reviewed.mode, inputsFile: reviewed.inputsFile, warnings: [],
  } : resolveRepositoryTarget({ root, get: (key) => argumentContext[key] ?? projectContext[key], env: process.env });
  target.warnings.forEach((warning) => console.warn(warning));
  // Hand every child the path this process read, absolute: synth runs in cdk-app/
  // and would otherwise resolve the target again from its own working directory.
  process.env.FRAMEWORK_INPUTS_FILE = target.inputsFile;
  const authored = existsSync(target.inputsFile) ? parseEnv(readFileSync(target.inputsFile, "utf8")) : {};
  // An explicit flag or AWS_PROFILE selects named credentials. Otherwise the
  // AWS CLI and SDK use their standard default credential chain.
  const profile = selection.profile ?? process.env.AWS_PROFILE ?? authored.AWS_PROFILE;
  if (profile) process.env.AWS_PROFILE = profile;
  if (selection.region) process.env.AWS_REGION = selection.region;
  if (assembly.synthesize) {
    await run(cdk, ["synth", ...selection.forwarded, ...(selection.app ? ["--app", selection.app] : []), "--quiet", "--output", assembly.directory], cdkDirectory);
  }
  const graph = inspectDeploymentAssembly(assembly.directory, selection);
  if (graph.identity.deployment !== target.target.name || graph.identity.mode !== target.mode) {
    throw new Error(`The synthesized assembly is ${graph.identity.deployment} (${graph.identity.mode}), but these arguments select ${target.target.name} (${target.mode}). Check -c deployment, -c prodDeployment and framework:targets. Nothing was changed.`);
  }
  const region = graph.identity.region;
  if (selection.region && selection.region !== region) throw new Error("--region differs from the synthesized deployment region.");
  const releaseDeployment = acquireDeploymentLock(resolve(root, ".cache/deploy"), graph.identity.deployment);
  let releaseReferences = () => {};
  const release = () => { releaseReferences(); releaseDeployment(); };
  cleanups.add(release);
  try {
    const aws: AwsTarget = { region, ...(profile ? { profile } : {}) };
    let caller: { Account?: string; Arn?: string };
    try { caller = runAwsSync(["sts", "get-caller-identity"], aws); }
    catch (error) { throw new Error(`Unable to verify the selected AWS identity: ${error instanceof Error ? error.message : String(error)} Nothing was changed.`); }
    if (caller.Account !== graph.identity.account) throw new Error("The selected AWS credentials do not match the synthesized deployment account. No secrets were changed.");
    // What AWS already holds under this name decides whether it may be changed:
    // before any secret is read or written, so a refusal changes nothing.
    const deployed = assertDeploymentAllowed(graph.identity, args, {
      readStacks: () => readDeploymentStackPages((token) => runAwsSync(["cloudformation", "describe-stacks", "--no-paginate", ...(token ? ["--next-token", token] : [])], aws)),
      readTemplate: (name) => runAwsSync(["cloudformation", "get-template", "--stack-name", name, "--template-stage", "Original"], aws).TemplateBody,
    }, overrides.plannedReviews);
    if (deployed.kind === "rolled-back") console.log(`The last update of ${graph.identity.deployment} was rolled back; this deployment replaces it.`);
    if (deployed.kind === "failed") console.log(`${graph.identity.deployment} has failed stacks the CDK CLI recovers itself: it recreates a stack whose first create failed, and retries or first rolls back one that --no-rollback paused.`);
    // Users cannot override framework-owned parameters with a hand-authored ARN map.
    if (args.some((arg) => graph.requirements.some((requirement) => arg.includes(requirement.parameter)))) throw new Error("Managed secret parameters are supplied automatically; remove their --parameters overrides.");
    // Revalidate external identities before change-set preparation, secret writes
    // or deployment. Saved plans use descriptors from their immutable templates.
    const stacks = stackOrder(assembly.directory, graph.stacks);
    releaseReferences = acquireStatefulReferenceLocks(resolve(root, ".cache/deploy/references"), stacks, graph.identity);
    validateAssemblyStatefulReferences(stacks, aws, graph.identity);
    if (deployed.kind !== "absent") for (const stack of stacks) if (deployed.stacks.some(existing => existing.name === stack.name)) assertStatefulOwnershipTransitions(deployedTemplate(aws, stack.name), stack.template);
    return { selection, target, authored, profile, aws, graph, assembly: assembly.directory, stacks, deployed, callerArn: String(caller.Arn ?? ""), release };
  } catch (error) {
    release(); cleanups.delete(release);
    throw error;
  }
}

function secretsClient(aws: AwsTarget) {
  if (process.env.FRAMEWORK_AWS_CLI) return { client: cliSecretsClient(aws), close: () => {} };
  const client = new SecretsManagerClient({ region: aws.region });
  return { client, close: () => client.destroy() };
}

/** Read only selected, already-owned stacks. Missing template evidence refuses before secret writes. */
function developmentCognitoDomainChanges(prepared: Prepared): CognitoDomainChange[] {
  if (prepared.graph.identity.mode !== "dev" || prepared.deployed.kind === "absent") return [];
  const existing = new Set(prepared.deployed.stacks.map(stack => stack.name));
  return prepared.stacks.filter(stack => existing.has(stack.name)).flatMap(stack =>
    cognitoDomainChanges(stack.name, deployedTemplate(prepared.aws, stack.name), stack.template));
}

async function exportDevelopment(prepared: Prepared): Promise<void> {
  if (prepared.graph.identity.mode !== "dev" || !prepared.selection.execute) return;
  try {
    // FRAMEWORK_EXPORT_DIRECTORY: where the files are written (the repository root unless a caller, such as a test, says otherwise).
    await run(require.resolve("tsx/cli"), [resolve(root, "scripts/export-cdk-outputs.mjs"), "--deployment", prepared.graph.identity.deployment, "--region", prepared.graph.identity.region, ...(prepared.profile ? ["--profile", prepared.profile] : [])], process.env.FRAMEWORK_EXPORT_DIRECTORY ? resolve(process.env.FRAMEWORK_EXPORT_DIRECTORY) : root);
  } catch {
    if (interrupt.isInterrupted) throw new Error("Interrupted after the infrastructure deployment, before the development export. Run npm run export:cdk-outputs with the same profile and region.");
    console.error("Infrastructure deployment succeeded, but development export failed. Previous local files were preserved. Run npm run export:cdk-outputs with the same profile and region after resolving the export error.");
    process.exitCode = 2;
  }
}

function finishVerified(prepared: Prepared, deployedStacks: readonly AssemblyStackEntry[], planId?: string) {
  const verification = verifyDeployment(prepared.aws, prepared.graph.identity, deployedStacks);
  for (const stack of verification.stacks) console.log(`${stack.problem ? "✖" : "✔"} ${stack.name}${stack.problem ? `: ${stack.problem}` : " verified"}`);
  if (!verification.verified) {
    process.exitCode = 3;
    console.error("The deployment finished, but AWS does not hold what was deployed for every stack. Inspect the stacks above in CloudFormation.");
    return verification;
  }
  const warning = writeDeploymentRecord(prepared.aws, {
    identity: prepared.graph.identity, deployedBy: prepared.callerArn, planId,
    stacks: deployedStacks.map((stack) => stack.name), assemblyDigest: assemblyDigest(prepared.assembly),
  });
  if (warning) console.warn(warning);
  return verification;
}

async function deployDirectly(wrapper: Wrapper): Promise<void> {
  const cache = resolve(root, ".cache/deploy");
  mkdirSync(cache, { recursive: true });
  sweepStaleAssemblies(cache, Date.now());
  const selection = deploymentArguments(wrapper.rest);
  // A caller-named --output assembly is kept; the per-run temporary one is removed.
  const assembly = selection.output ? resolve(root, "cdk-app", selection.output) : mkdtempSync(resolve(cache, "assembly-"));
  const removeAssembly = () => rmSync(assembly, { recursive: true, force: true });
  if (!selection.output) cleanups.add(removeAssembly);
  let prepared: Prepared | undefined;
  try {
    try {
      prepared = await prepare(wrapper.rest, { directory: assembly, synthesize: true });
      const domainChanges = developmentCognitoDomainChanges(prepared);
      if (domainChanges.length) throw new Error(`${domainChanges.map(change => change.consequence).join(" ")} Direct deployment is refused. Create and review a saved deployment plan with --plan <directory>, then apply it with --confirm ${prepared.graph.identity.deployment}. Nothing was changed.`);
      // A Ctrl+C during the synchronous checks above lands here: write nothing.
      interrupt.assertContinuing();
      const secrets = secretsClient(prepared.aws);
      let result;
      try {
        result = await (await planDeploymentSecrets(prepared.graph.requirements, prepared.authored, prepared.graph.identity, secrets.client)).apply((name) => console.log(`Updated managed secret ${name}.`));
      } finally { secrets.close(); }
      try {
        await run(cdk, ["deploy", ...productionDeployArguments(prepared.graph.identity, prepared.selection.forwarded), "--app", assembly, ...result.parameters.flatMap((value) => ["--parameters", value])], cdkDirectory);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : "Infrastructure deployment failed."} Secret updates already performed: ${result.updated.join(", ") || "none"}.`);
      }
      if (prepared.selection.execute) finishVerified(prepared, prepared.stacks);
    } finally {
      if (!selection.output) { removeAssembly(); cleanups.delete(removeAssembly); }
    }
    await exportDevelopment(prepared);
  } finally {
    if (prepared) { prepared.release(); cleanups.delete(prepared.release); }
  }
}

function statusOf(stacks: readonly PlanStack[], secrets: readonly SecretPlanEntry[]): DeploymentPlanDocument["status"] {
  return stacks.every((stack) => stack.noChanges) && secrets.every((secret) => secret.action === "unchanged") ? "no-changes" : "ready";
}

async function plan(wrapper: Wrapper): Promise<void> {
  const directory = resolve(wrapper.plan!);
  if (existsSync(resolve(directory, "plan.json"))) throw new Error(`${directory} already holds a plan. Discard it first, or choose another directory.`);
  mkdirSync(directory, { recursive: true });
  const assembly = resolve(directory, "assembly");
  const planId = `plan-${Date.now().toString(36)}-${createHash("sha256").update(directory).digest("hex").slice(0, 6)}`;
  secretBindings.sweep(bindings, Date.now(), PLAN_LIFETIME_MS + 60 * 60 * 1000);
  const prepared = await prepare(wrapper.rest, { directory: assembly, synthesize: true });
  try {
    const reviewedDigest = assemblyDigest(assembly);
    const { graph, aws } = prepared;
    const inventory = inspectInfrastructureAssembly(assembly);
    const review = wrapper.review ?? (graph.identity.mode === "prod" ? "change-set" : "template");
    const secrets = secretsClient(aws);
    let secretPlan;
    try { secretPlan = await planDeploymentSecrets(graph.requirements, prepared.authored, graph.identity, secrets.client); }
    finally { secrets.close(); }

    // Per stack: what AWS holds now, and the resource-level difference.
    const reviewed = prepared.stacks.map((entry) => {
      const current = describeStack(aws, entry.name);
      const fingerprint = fingerprintOf(current);
      const previous = fingerprint.exists ? deployedTemplate(aws, entry.name) : undefined;
      const changes = templateChanges(previous, entry.template).map((change) => {
        const resource = inventory.resources.find((candidate) => candidate.stack === entry.id && candidate.logicalId === change.logicalId);
        return { ...change, owner: resource?.owners.length ? resource.owners.join(", ") : resource?.constructPath ?? "Ownership not identified in synthesis" };
      });
      const exportsInUse: ExportInUse[] = changedExports(previous, entry.template).flatMap(({ exportName, change }) => {
        let importers: string[] = [];
        try { importers = stackImporters(aws, exportName); }
        catch (error) { throw new Error("Cannot establish importers of " + exportName + ". Resolve CloudFormation list-imports access before planning. " + (error instanceof Error ? error.message : "")); }
        return importers.length ? [{ stack: entry.name, exportName, change, importers }] : [];
      });
      return { entry, fingerprint, changes, exportsInUse, previous };
    });

    // IAM and security broadening, from the CDK CLI's own security diff, and its full text diff for the record.
    const selectors = prepared.stacks.map((stack) => stack.name);
    const security = await interrupt.capture(cdk, ["diff", "--app", assembly, ...selectors, "--security-only", "--fail", "--method", "template"], cdkDirectory);
    const iamBroadening = security.code === 1 && /IAM (Statement|Policy) Changes|Security Group Changes/i.test(security.output) && !/AccessDenied|NoCredentials|Error:|Unable to |Need to perform AWS calls|not authorized/i.test(security.output);
    const templateDiff = await interrupt.capture(cdk, ["diff", "--app", assembly, ...selectors, "--method", "template"], cdkDirectory);
    const problems = [
      ...(security.code !== 0 && !iamBroadening ? ["Security analysis failed; permissions impact is unknown. Resolve the error and plan again."] : []),
      ...(templateDiff.code !== 0 ? ["Template diff failed. Resolve the error and plan again."] : []),
    ];
    const retainedStacks = prepared.deployed.kind === "absent" ? [] : prepared.deployed.stacks.filter((stack) => !prepared.stacks.some((entry) => entry.name === stack.name)).map((stack) => ({ name: stack.name, status: stack.status }));

    const creating = secretPlan.entries.filter((secret) => secret.action === "create");
    let status: DeploymentPlanDocument["status"] = "ready";
    let createdSecrets: readonly string[] = [];
    const stacks: PlanStack[] = [];
    if (problems.length) {
      status = "blocked";
      for (const { entry, fingerprint, changes, exportsInUse } of reviewed) stacks.push({ id: entry.id, name: entry.name, fingerprint, changes, exportsInUse, noChanges: fingerprint.exists && !changes.length });
    } else if (review === "change-set" && creating.length && !wrapper.createSecrets) {
      // A change set can only reference a secret that exists. Creating one is a
      // write, so it waits for an explicit --create-secrets.
      status = "needs-secrets";
      for (const { entry, fingerprint, changes, exportsInUse } of reviewed) {
        stacks.push({ id: entry.id, name: entry.name, fingerprint, changes, exportsInUse, noChanges: fingerprint.exists && !changes.length });
      }
    } else if (review === "change-set") {
      if (creating.length) {
        // Only the missing secrets are created: an existing secret's new value is
        // part of the review, written when the plan is applied.
        const secretsAgain = secretsClient(aws);
        try {
          try {
            createdSecrets = await secretPlan.createMissing((name) => console.log(`Created managed secret ${name} so the change sets can reference it.`));
          } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : "Creating managed secrets failed."} No change set was prepared; planning again reuses the secrets already created.`);
          }
          // The review describes, and binds, what AWS holds now.
          secretPlan = await planDeploymentSecrets(graph.requirements, prepared.authored, graph.identity, secretsAgain.client);
        } finally { secretsAgain.close(); }
      }
      const arns = secretPlan.arns;
      const deferred = new Set<string>();
      const created = new Set(reviewed.filter((item) => !item.fingerprint.exists).map((item) => item.entry.id));
      // Written before each change set is prepared: a plan that stops part-way
      // (a failure, Ctrl+C, a killed process) can still be discarded.
      const preparing = { version: PLAN_VERSION, planId, createdAt: new Date().toISOString(), identity: graph.identity, ...(prepared.profile ? { profile: prepared.profile } : {}), stacks: [] as { name: string; createdByPlan: boolean; stackId?: string }[] };
      const recordPreparing = () => writeDeploymentRecordAtomic(resolve(directory, "preparing.json"), preparing);
      for (const { entry, fingerprint, changes, exportsInUse } of reviewed) {
        // Imports resolve when a change set is created, so a stack that imports
        // from one this plan creates (or defers) can only be planned after it runs.
        const imports = JSON.stringify(entry.template).includes("Fn::ImportValue");
        const waitingOn = entry.dependencies.find((dependency) => deferred.has(dependency) || (imports && created.has(dependency)));
        if (waitingOn) {
          deferred.add(entry.id);
          stacks.push({ id: entry.id, name: entry.name, fingerprint, changes, exportsInUse, noChanges: false, deferred: `Planned after ${waitingOn} runs: it imports what that stack creates.` });
          continue;
        }
        if (fingerprint.exists && !changes.length) {
          stacks.push({ id: entry.id, name: entry.name, fingerprint, changes, exportsInUse, noChanges: true });
          continue;
        }
        const parameters = graph.requirements.filter((requirement) => requirement.stack === entry.name).map((requirement) => `${entry.name}:${requirement.parameter}=${arns[requirement.name]}`);
        preparing.stacks.push({ name: entry.name, createdByPlan: !fingerprint.exists });
        recordPreparing();
        try {
          await run(cdk, ["deploy", "--app", assembly, entry.name, "--exclusively", "--method", "prepare-change-set", "--change-set-name", planId, "--require-approval", "never", ...parameters.flatMap((value) => ["--parameters", value])], cdkDirectory);
        } finally {
          // A failed command can still have created an empty review stack.
          // Preserve its observed immutable identity before propagating failure.
          preparing.stacks[preparing.stacks.length - 1]!.stackId = fingerprintOf(describeStack(aws, entry.name)).stackId;
          recordPreparing();
        }
        const set = describeChangeSet(aws, entry.name, planId);
        if (set.noChanges) {
          try { runAwsSync(["cloudformation", "delete-change-set", "--stack-name", entry.name, "--change-set-name", planId], aws); } catch { /* Reported as no changes either way. */ }
        }
        const { changes: authoritative, ...summary } = set;
        const detailed = authoritative.map((change) => ({ ...changes.find((candidate) => candidate.logicalId === change.logicalId), ...change }));
        // What apply should find: preparing a change set for a new stack creates it, awaiting review.
        const prepared = fingerprintOf(describeStack(aws, entry.name));
        preparing.stacks[preparing.stacks.length - 1]!.stackId = prepared.stackId;
        recordPreparing();
        stacks.push({ id: entry.id, name: entry.name, fingerprint: prepared, changes: set.noChanges ? [] : detailed, exportsInUse, noChanges: set.noChanges, changeSet: summary, ...(!fingerprint.exists ? { createdByPlan: true } : {}) });
      }
      status = statusOf(stacks, secretPlan.entries);
    } else {
      for (const { entry, fingerprint, changes, exportsInUse } of reviewed) {
        stacks.push({ id: entry.id, name: entry.name, fingerprint, changes, exportsInUse, noChanges: fingerprint.exists && !changes.length });
      }
      status = statusOf(stacks, secretPlan.entries);
    }

    const allChanges = stacks.flatMap((stack) => stack.changes);
    const exportsInUse = stacks.flatMap((stack) => stack.exportsInUse);
    const domainChanges = graph.identity.mode === "dev" ? reviewed.flatMap(({ entry, previous }) => cognitoDomainChanges(entry.name, previous, entry.template)) : [];
    const confirmation = confirmationLevel({ mode: graph.identity.mode, firstDeploy: prepared.deployed.kind === "absent", iamBroadening, changes: allChanges, exportsInUse });
    const document: DeploymentPlanDocument = {
      version: PLAN_VERSION, planId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PLAN_LIFETIME_MS).toISOString(),
      status, review,
      target: { name: prepared.target.target.name, mode: prepared.target.mode, inputsFile: prepared.target.inputsFile, ...(prepared.target.target.account ? { account: prepared.target.target.account } : {}), ...(prepared.target.target.region ? { region: prepared.target.target.region } : {}) },
      identity: graph.identity, ...(prepared.profile ? { profile: prepared.profile } : {}),
      forwarded: prepared.selection.forwarded, guard: prepared.deployed.kind,
      stacks: stacks.map((stack) => ({ ...stack, dependencies: prepared.stacks.find((entry) => entry.id === stack.id)?.dependencies.map((id) => prepared.stacks.find((entry) => entry.id === id)?.name ?? id) ?? [] })),
      secrets: secretPlan.entries,
      dockerImages: dockerImages(assembly).map(({ stack, asset }) => ({ stack, asset })),
      iamBroadening,
      confirmation: domainChanges.length ? { level: "name", reasons: [...confirmation.reasons, ...domainChanges.map(change => change.consequence)] } : confirmation,
      ...(domainChanges.length ? { cognitoDomainChanges: domainChanges } : {}),
      uncertainties: [...PLAN_UNCERTAINTIES[review], ...(createdSecrets.length ? [`Created before review so the change sets could reference them: ${createdSecrets.join(", ")}. Nothing reads them until this plan is applied.`] : [])],
      assemblyDigest: reviewedDigest,
      retainedStacks,
      reviewEvidence: { security: security.output, templates: templateDiff.output, problems },
      sourceRevision: deploymentSourceRevision(),
    };
    if (assemblyDigest(assembly) !== reviewedDigest) throw new Error("Staged release changed while preparing review. Discard any prepared change sets and plan again.");
    // The binding is what apply holds the secret writes to; plan.json shows names and actions only.
    if (status !== "needs-secrets" && secretPlan.entries.length) secretBindings.write(bindings, planId, secretPlan.bind(planId));
    writeDeploymentRecordAtomic(resolve(directory, "plan.json"), document);
    rmSync(resolve(directory, "preparing.json"), { force: true });
    console.log(`Plan ${planId} for ${graph.identity.deployment} (${graph.identity.mode}, ${graph.identity.account}/${graph.identity.region}): ${status}.`);
    for (const stack of stacks) {
      const counts = ["add", "modify", "remove"].map((action) => `${stack.changes.filter((change) => change.action === action).length} ${action}`).join(", ");
      console.log(`  ${stack.name}: ${stack.deferred ? `deferred — ${stack.deferred}` : stack.noChanges ? "no changes" : counts}`);
    }
    for (const secret of document.secrets.filter((entry) => entry.action !== "unchanged")) console.log(`  secret ${secret.name}: ${secret.action}`);
    if (iamBroadening) console.log("  IAM or security permissions broaden: review the security diff.");
    if (document.confirmation.level === "name") console.log(`  Applying needs --confirm ${graph.identity.deployment}: ${document.confirmation.reasons.join("; ")}.`);
    if (status === "needs-secrets") console.log(`  Creating ${creating.map((secret) => secret.name).join(", ")} is needed before a change set can be prepared. Plan again with --create-secrets.`);
    console.log(`Apply with: npm run deploy:resources -- --apply ${wrapper.plan}${document.confirmation.level === "name" ? ` --confirm ${graph.identity.deployment}` : ""}${prepared.profile ? ` --profile ${prepared.profile}` : ""}`);
  } finally {
    prepared.release(); cleanups.delete(prepared.release);
  }
}

function readPlan(directory: string): DeploymentPlanDocument {
  const file = resolve(directory, "plan.json");
  if (!existsSync(file)) throw new Error(`${directory} holds no plan.`);
  const document = JSON.parse(readFileSync(file, "utf8")) as DeploymentPlanDocument;
  if (document.version !== PLAN_VERSION) throw new Error(`${directory} holds a plan from another version of this tool. Plan again.`);
  return document;
}

/** The forwarded CDK arguments a plan was made with, and the profile this run selects. */
function planArguments(document: DeploymentPlanDocument, rest: readonly string[]): string[] {
  const profile = deploymentArguments(rest).profile ?? document.profile;
  return [...document.forwarded.filter((arg, index, all) => arg !== "--profile" && all[index - 1] !== "--profile" && !arg.startsWith("--profile=")), ...(profile ? ["--profile", profile] : [])];
}

async function apply(wrapper: Wrapper): Promise<void> {
  const directory = resolve(wrapper.apply!);
  const document = readPlan(directory);
  if (existsSync(resolve(directory, "result.json"))) throw new Error(`Plan ${document.planId} was already applied. Plan again for further changes.`);
  if (existsSync(resolve(directory, "operation.json"))) throw new Error("An application attempt already started for this review. Inspect its recorded progress and AWS, then create a new plan; never retry uncertain writes blindly.");
  if (Date.parse(document.expiresAt) < Date.now()) throw new Error(`Plan ${document.planId} expired at ${document.expiresAt}. Plan again.`);
  if (document.status === "needs-secrets") throw new Error(`Plan ${document.planId} could not prepare change sets until its new secrets exist. Plan again with --create-secrets.`);
  if (document.status === "blocked" || document.reviewEvidence?.problems.length) throw new Error("The review has incomplete analysis. Resolve its errors and plan again. Nothing was changed.");
  if (document.status === "no-changes") { console.log(`Plan ${document.planId} has nothing to change.`); return; }
  if (document.confirmation.level === "name" && wrapper.confirm !== document.identity.deployment) {
    throw new Error(`Plan ${document.planId} needs --confirm ${document.identity.deployment} (${document.confirmation.reasons.join("; ")}). Nothing was changed.`);
  }
  const binding = document.secrets.length ? secretBindings.read(bindings, document.planId) as SecretBinding | undefined : undefined;
  if (document.secrets.length && binding?.planId !== document.planId) {
    throw new Error(`Plan ${document.planId} has no secret binding in ${bindings}: it was planned in another checkout, or the binding was removed. Plan again. Nothing was changed.`);
  }
  const plannedReviews = new Set(document.stacks.filter((stack) => stack.createdByPlan).map((stack) => stack.name));
  const prepared = await prepare(planArguments(document, wrapper.rest), { directory: resolve(directory, "assembly"), synthesize: false }, { inputsFile: document.target.inputsFile, reviewedTarget: document.target, plannedReviews });
  try {
    const { graph, aws } = prepared;
    if (graph.identity.deployment !== document.identity.deployment || graph.identity.mode !== document.identity.mode || graph.identity.account !== document.identity.account || graph.identity.region !== document.identity.region) {
      throw new Error("The plan's assembly no longer resolves to the identity it was reviewed for. Plan again.");
    }
    if (assemblyDigest(prepared.assembly) !== document.assemblyDigest) throw new Error("The plan's templates, manifests or staged assets changed after review. Plan again. Nothing was changed.");
    assertCognitoDomainReview(developmentCognitoDomainChanges(prepared), document, graph.identity.deployment, wrapper.confirm);
    const stale = staleness(Object.fromEntries(document.stacks.map((stack) => [stack.name, stack.fingerprint])), Object.fromEntries(document.stacks.map((stack) => [stack.name, fingerprintOf(describeStack(aws, stack.name))])));
    if (stale) throw new Error(`${stale} Plan again: the review no longer describes what AWS holds. Nothing was changed.`);
    const changing = document.stacks.filter((stack) => !stack.noChanges && !stack.deferred);
    if (document.review === "change-set") {
      for (const stack of changing) {
        const set = describeChangeSet(aws, stack.name, document.planId);
        if (set.status !== "CREATE_COMPLETE" || set.executionStatus !== "AVAILABLE") {
          throw new Error(`The change set for ${stack.name} is ${set.status}/${set.executionStatus}${set.statusReason ? ` (${set.statusReason})` : ""}, not available to execute. Plan again. Nothing was changed.`);
        }
      }
    }
    // The secret writes must be the ones reviewed: the same names and actions,
    // the same authored values, and the same AWS versions they replace.
    interrupt.assertContinuing();
    const journal = (stage: string, secretUpdates: readonly string[] = []) => writeDeploymentRecordAtomic(resolve(directory, "operation.json"), { planId: document.planId, pid: process.pid, identity: document.identity, stage, secretUpdates, updatedAt: new Date().toISOString() });
    const secrets = secretsClient(aws);
    let result;
    try {
      const again = await planDeploymentSecrets(graph.requirements, prepared.authored, graph.identity, secrets.client);
      const mismatch = again.mismatch({ entries: document.secrets, binding });
      if (mismatch) throw new Error(mismatch + " Plan again. Nothing was changed.");
      // Refuses, before any write, unless every write is the reviewed one.
      journal("writing reviewed secrets");
      const updated: string[] = [];
      result = await again.apply((name) => { updated.push(name); journal("writing reviewed secrets", updated); console.log(`Updated managed secret ${name}.`); }, { entries: document.secrets, binding });
    } finally { secrets.close(); }
    journal("applying infrastructure", result.updated);
    const deploying = prepared.stacks.filter((stack) => changing.some((entry) => entry.id === stack.id));
    try {
      if (document.review === "change-set") {
        if (deploying.length) await run(cdk, ["deploy", "--app", prepared.assembly, ...deploying.map((stack) => stack.name), "--exclusively", "--method", "execute-change-set", "--change-set-name", document.planId, "--require-approval", "never", "--progress", "events"], cdkDirectory);
      } else {
        // The review was the approval: what was shown is what is deployed.
        await run(cdk, ["deploy", ...prepared.selection.forwarded, "--app", prepared.assembly, "--require-approval", "never", "--progress", "events", ...result.parameters.flatMap((value) => ["--parameters", value])], cdkDirectory);
      }
    } catch (error) {
      const observed = verifyDeployment(aws, graph.identity, deploying);
      writeDeploymentRecordAtomic(resolve(directory, "result.json"), {
        planId: document.planId, finishedAt: new Date().toISOString(), status: interrupt.isInterrupted ? "interrupted" : "failed", problem: error instanceof Error ? error.message : "Infrastructure deployment failed.", secretUpdates: result.updated,
        verification: observed, deferred: document.stacks.filter((stack) => stack.deferred).map((stack) => stack.name),
      });
      throw new Error(`${error instanceof Error ? error.message : "Infrastructure deployment failed."} Secret updates already performed: ${result.updated.join(", ") || "none"}.`);
    }
    const verification = finishVerified(prepared, document.review === "change-set" ? deploying : prepared.stacks, document.planId);
    journal("infrastructure verification finished", result.updated);
    const deferred = document.stacks.filter((stack) => stack.deferred).map((stack) => stack.name);
    const resultDocument = {
      planId: document.planId, finishedAt: new Date().toISOString(),
      status: !verification.verified ? "unverified" : deferred.length ? "partial" : "succeeded",
      verification, deferred, secretUpdates: result.updated,
    };
    writeDeploymentRecordAtomic(resolve(directory, "result.json"), resultDocument);
    secretBindings.remove(bindings, document.planId);
    if (deferred.length) console.log(`Applied. Still to plan, now that the stacks they depend on exist: ${deferred.join(", ")}.`);
    if (verification.verified) {
      await exportDevelopment(prepared);
      if (process.exitCode === 2) writeDeploymentRecordAtomic(resolve(directory, "result.json"), { ...resultDocument, status: "export-failed", problem: "Infrastructure verified, but development settings export failed. Retry export separately." });
    }
  } finally {
    prepared.release(); cleanups.delete(prepared.release);
  }
}

/** What a plan directory prepared in AWS: from plan.json, or from the record of a plan that stopped part-way. */
function preparedByPlan(directory: string): { planId: string; identity: DeploymentPlanDocument["identity"]; region: string; profile?: string; stacks: { name: string; createdByPlan: boolean; stackId?: string }[] } {
  if (existsSync(resolve(directory, "plan.json"))) {
    const document = readPlan(directory);
    return {
      planId: document.planId, identity: document.identity, region: document.identity.region, ...(document.profile ? { profile: document.profile } : {}),
      stacks: document.stacks.filter((entry) => entry.changeSet && !entry.changeSet.noChanges).map((entry) => ({ name: entry.name, createdByPlan: Boolean(entry.createdByPlan), stackId: entry.fingerprint.stackId })),
    };
  }
  const file = resolve(directory, "preparing.json");
  if (!existsSync(file)) throw new Error(`${directory} holds no plan.`);
  const unfinished = JSON.parse(readFileSync(file, "utf8"));
  if (unfinished.version !== PLAN_VERSION) throw new Error(`${directory} holds a plan from another version of this tool.`);
  return { planId: unfinished.planId, identity: unfinished.identity, region: unfinished.identity.region, ...(unfinished.profile ? { profile: unfinished.profile } : {}), stacks: unfinished.stacks };
}

async function discard(wrapper: Wrapper): Promise<void> {
  const directory = resolve(wrapper.discard!);
  const document = preparedByPlan(directory);
  const release = acquireDeploymentLock(resolve(root, ".cache/deploy"), document.identity.deployment);
  try {
  const profile = deploymentArguments(wrapper.rest).profile ?? document.profile;
  const aws: AwsTarget = { region: document.region, ...(profile ? { profile } : {}) };
  if (document.stacks.length && String(runAwsSync(["sts", "get-caller-identity"], aws).Account) !== document.identity.account) throw new Error("The selected profile reaches another account than the saved review. Nothing was discarded.");
  for (const stack of document.stacks) {
    const current = describeStack(aws, stack.name);
    const identity = current ? stackEvidence(current).identity : undefined;
    if (current && (!identity || identity.deployment !== document.identity.deployment || identity.mode !== document.identity.mode)) throw new Error("The reviewed stack identity changed: " + stack.name + ". Nothing else was discarded.");
    let stackId = stack.stackId;
    if (current && !stackId) stackId = describeChangeSet(aws, current.StackId!, document.planId).stackId;
    if (current && (!stackId || stackId !== current.StackId)) throw new Error("The saved review cannot confirm this exact stack identity: " + stack.name + ". Preserve the review and inspect its change set before cleanup.");
    try { runAwsSync(["cloudformation", "delete-change-set", "--stack-name", stackId ?? stack.name, "--change-set-name", document.planId], aws); console.log(`Deleted change set ${document.planId} on ${stack.name}.`); }
    catch (error) { if (current) throw error; }
    if (stack.createdByPlan && stackId && describeStack(aws, stackId)?.StackStatus === "REVIEW_IN_PROGRESS") {
      // Created only to hold the change set: it has no resources.
      runAwsSync(["cloudformation", "delete-stack", "--stack-name", stackId], aws);
      console.log(`Removed ${stack.name}, which the plan created and which holds no resources.`);
    }
  }
  secretBindings.remove(bindings, document.planId);
  rmSync(directory, { recursive: true, force: true });
  console.log(`Discarded plan ${document.planId}.`);
  } finally { release(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { await run(cdk, ["deploy", "--help"]); return; }
  process.on("SIGINT", (signal) => interrupt.handle(signal));
  process.on("SIGTERM", (signal) => interrupt.handle(signal));
  const wrapper = wrapperOptions(args);
  // Recovery consumes reviewed artifacts, never the current declarations.
  if (wrapper.discard) return discard(wrapper);
  if (wrapper.apply) return apply(wrapper);
  // Validate inside main so declaration errors name their owners cleanly,
  // before synth, identity checks, secret synchronization or AWS deployment.
  const { default: framework } = await import("../framework.config");
  const { validateFrameworkConfig } = await import("@repo/framework/config");
  validateFrameworkConfig(framework);
  if (wrapper.plan) return plan(wrapper);
  return deployDirectly(wrapper);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Deployment failed."); process.exitCode = 1; });
