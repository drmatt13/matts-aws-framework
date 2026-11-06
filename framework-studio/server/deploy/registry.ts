import path from "node:path";
import type { AwsProfileInfo, DeployMode, DockerView, DriftView, JobView, OperationKind, OperationRequest, TargetView } from "../../shared/deploy";
import type { JobManager, JobSpec, JobStep } from "./jobs";
import { LocalRuntimeConflict, type LocalEnvironment } from "./local";
import { AwsObserver } from "./observe";
import type { PlanStore, TeardownStore } from "./plans";
import { clientCommand, composePlugin } from "./local-commands";
import { studioEnvironment, tethered, type CommandSpec, type Runner, type Tools } from "./process";
import { readAwsFiles } from "../../../scripts/aws-connections";

/**
 * The operations Deploy & Run can perform, and no others.
 *
 * Each is a typed request whose parameters are validated here, then turned
 * into fixed argv for a repository script (deploy:resources, destroy:resources,
 * export:cdk-outputs, dev:containers), Docker, npm or the AWS CLI. Nothing from
 * a request reaches a shell, and every safety rule the scripts enforce still
 * applies: Studio adds its own checks in front, never instead.
 */

export class OperationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type RepositoryTarget = Omit<TargetView, "status" | "detail" | "deployedAs">;

/** Replacements for the persistent programs of local development, by kind. */
export type ManagedCommands = Partial<Record<"local-watch" | "local-client", (env: NodeJS.ProcessEnv) => CommandSpec>>;

export interface OperationContext {
  readonly root: string;
  readonly managed: ManagedCommands;
  readonly tools: Tools;
  readonly env: NodeJS.ProcessEnv;
  readonly run: Runner;
  readonly exportDirectory: string;
  readonly jobs: Pick<JobManager, "holder">;
  readonly plans: PlanStore;
  readonly teardowns: TeardownStore;
  readonly local: LocalEnvironment;
  readonly observer: AwsObserver;
  profiles(): Promise<readonly AwsProfileInfo[]>;
  targets(): readonly RepositoryTarget[];
  probeDocker(): Promise<DockerView>;
  /** Starts the source watch or the web client, unless it is already running. */
  startManaged(kind: "local-watch" | "local-client", profile: string): JobView;
  stopManaged(): Promise<void>;
  setDrift(deployment: string, view: DriftView): void;
  /** Follows a deployment's stacks into a job's log, until the returned function is called. */
  followStacks(job: string, profile: string, deployment: string, region: string | undefined): () => void;
  /** After an operation changed AWS or the exported files: forget what was read, tell the page. */
  changed(profile: string | undefined, deployment: string | undefined): void;
}

const DEPLOYMENT = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const SERVICE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

type Params = OperationRequest["params"];

function text(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new OperationError(400, `${key} is text.`);
  return value;
}

function flag(params: Params, key: string): boolean {
  const value = params[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new OperationError(400, `${key} is true or false.`);
  return value;
}

function deploymentName(params: Params): string {
  const value = text(params, "deployment");
  if (!value || !DEPLOYMENT.test(value)) throw new OperationError(400, "Name a deployment: lowercase letters, numbers and hyphens, starting with a letter.");
  return value;
}

function region(params: Params): string | undefined {
  const value = text(params, "region");
  if (value !== undefined && !REGION.test(value)) throw new OperationError(400, `${value} is not an AWS region.`);
  return value;
}

function mode(params: Params): DeployMode {
  const value = text(params, "mode");
  if (value !== "dev" && value !== "prod") throw new OperationError(400, "State the deployment's mode: dev or prod.");
  return value;
}

async function profile(context: OperationContext, params: Params): Promise<AwsProfileInfo> {
  const name = text(params, "profile");
  if (!name) throw new OperationError(400, "Choose an AWS profile.");
  const found = (await context.profiles()).find((entry) => entry.name === name);
  if (!found) throw new OperationError(400, `${name} is not a profile in your AWS configuration.`);
  return found;
}

function target(context: OperationContext, name: string): RepositoryTarget {
  const found = context.targets().find((entry) => entry.name === name);
  if (!found) throw new OperationError(400, `${name} is not a deployment this repository declares. Studio deploys only this repository's targets; another deployment is shown read-only.`);
  return found;
}

const cdkContext = (name: string, deployMode: DeployMode) => ["-c", `deployment=${name}`, "-c", `prodDeployment=${deployMode === "prod"}`];
const awsArguments = (profileName: string, regionName: string | undefined) => ["--profile", profileName, ...(regionName ? ["--region", regionName] : [])];

const CLOUD_CANCEL_NOTE = "Stopped the command. A CloudFormation operation it had already started continues in AWS; Studio keeps showing its stacks.";

/** Read-only synthesis/review is allowed during development; dev mutations require compute off. */
export function changesDevelopmentResources(context: OperationContext, request: OperationRequest): boolean {
  const params = request.params ?? {};
  if (request.kind === "deploy-apply") return typeof params.plan === "string" && context.plans.read(params.plan)?.identity.mode === "dev";
  if (request.kind === "destroy") return params.mode === "dev";
  if (request.kind !== "export" && request.kind !== "deploy-plan") return false;
  const declared = context.targets().find(entry => entry.name === params.deployment);
  if (request.kind === "export") return declared?.mode !== "prod";
  return declared?.mode === "dev" && (params.autoApply === true || params.createSecrets === true || params.review === "change-set");
}

export async function assertDevelopmentRuntimeStopped(context: OperationContext, currentJob?: string): Promise<void> {
  const localOperation = context.jobs.holder("local");
  if (localOperation && localOperation.id !== currentJob) throw new LocalRuntimeConflict("Wait for the local runtime operation to finish, then stop local runtime before changing development resources.");
  const docker = await context.probeDocker();
  await context.local.assertStopped(docker, { watch: { running: Boolean(context.jobs.holder("local-watch")) }, client: { running: Boolean(context.jobs.holder("local-client")) } });
}

export async function buildOperation(context: OperationContext, request: OperationRequest): Promise<JobSpec> {
  const params = request.params ?? {};
  if (typeof params !== "object" || Array.isArray(params)) throw new OperationError(400, "An operation's parameters are named values.");
  const builder = Object.hasOwn(BUILDERS, request.kind) ? BUILDERS[request.kind] : undefined;
  if (!builder) throw new OperationError(404, `${String(request.kind)} is not an operation Studio performs.`);
  if (changesDevelopmentResources(context, request)) await assertDevelopmentRuntimeStopped(context);
  return builder(context, params);
}

type Builder = (context: OperationContext, params: Params) => Promise<JobSpec>;

const BUILDERS: Readonly<Record<OperationKind, Builder>> = {
  async "framework-check"(context) {
    return {
      kind: "framework-check", title: "Check framework", params: {}, locks: ["workspace-tooling"],
      steps: [
        { label: "Check generated contracts", command: () => context.tools.script("packages/framework/scripts/generate-contracts.ts", ["--check"], studioEnvironment(context.env)) },
        { label: "Check local declarations", command: () => context.tools.script("packages/framework/scripts/check-local.ts", [], studioEnvironment(context.env)) },
      ],
    };
  },
  async "deploy-plan"(context, params) {
    const name = deploymentName(params);
    const declared = target(context, name);
    const credentials = await profile(context, params);
    const regionName = region(params) ?? declared.region;
    const review = text(params, "review") ?? (declared.mode === "prod" ? "change-set" : "template");
    if (review !== undefined && review !== "template" && review !== "change-set") throw new OperationError(400, "A review is template or change-set.");
    const createSecrets = flag(params, "createSecrets");
    const autoApply = flag(params, "autoApply");
    if (autoApply && declared.mode !== "dev") throw new OperationError(400, "Production is applied only after its review.");
    const key = context.plans.allocate(name);
    const directory = context.plans.path(key);
    const env = studioEnvironment(context.env, { profile: credentials.name });
    let stopFollowing: (() => void) | undefined;
    let synthesisFingerprint: string | undefined;
    const steps: JobStep[] = [
      {
        label: review === "change-set" ? "Synthesize and prepare change sets in AWS" : "Synthesize and compare AWS templates (read-only)",
        run: async step => {
          if (declared.mode === "dev" && (autoApply || createSecrets || review === "change-set")) await assertDevelopmentRuntimeStopped(context, step.job);
          synthesisFingerprint = context.plans.captureSynthesis(declared.mode, credentials.name, declared.inputs);
        },
        command: () => context.tools.script("scripts/deploy.ts", [
          "--all", ...cdkContext(name, declared.mode), ...awsArguments(credentials.name, regionName),
          "--plan", directory, ...(review ? ["--review", review] : []), ...(createSecrets ? ["--create-secrets"] : []),
        ], env),
        after: (_result, step) => {
          context.plans.recordSynthesis(key, synthesisFingerprint);
          const plan = context.plans.read(key);
          if (!plan) throw new Error("The plan finished without writing plan.json.");
          step.setPlanId(key);
          const changes = plan.stacks.reduce((count, stack) => count + stack.changes.length, 0);
          step.setSummary(plan.synthesis && !plan.synthesis.current ? `Synthesis complete. ${plan.synthesis.reason}` : plan.status === "no-changes" ? "Synthesis complete: no deployment changes." : plan.status === "needs-secrets"
            ? "New secrets must exist before CloudFormation can prepare change sets."
            : ["Synthesis ready: ", changes, ` resource change${changes === 1 ? "" : "s"} to review${plan.confirmation.level === "name" ? `; applying needs the name ${name}` : ""}.`]);
        },
      },
    ];
    if (autoApply) {
      steps.push({
        label: "Apply",
        run: async (step) => {
          const plan = context.plans.read(key);
          if (!plan) return "There is no plan to apply.";
          if (plan.status === "no-changes") return "Nothing to change.";
          if (plan.status !== "ready") return "The plan needs attention first.";
          if (plan.confirmation.level !== "none") return `Review needed: ${plan.confirmation.reasons.join("; ") || "this change needs a confirmation"}.`;
          await assertDevelopmentRuntimeStopped(context, step.job);
          stopFollowing = context.followStacks(step.job, credentials.name, name, regionName);
        },
        command: () => context.tools.script("scripts/deploy.ts", ["--apply", directory, ...awsArguments(credentials.name, undefined)], env),
        after: (_result, step) => {
          const result = context.plans.read(key)?.result;
          step.setSummary(result?.status === "succeeded" ? `${name} is deployed and verified.` : result?.status === "partial" ? `Applied; ${result.deferred.join(", ")} still to plan.` : "Applied, but not every stack verified.");
        },
      });
    }
    return {
      kind: "deploy-plan", title: `${autoApply ? "Deploy" : review === "template" ? "Synthesize" : "Plan"} ${name}`, params: { deployment: name, profile: credentials.name, ...(review ? { review } : {}), ...(createSecrets ? { createSecrets } : {}), ...(autoApply ? { autoApply } : {}) },
      deployment: name, planId: key, locks: [`deployment:${name}`, ...(autoApply ? ["exports"] : []), ...(declared.mode === "dev" && (autoApply || createSecrets || review === "change-set") ? ["local"] : [])], steps,
      cancelNote: "Stopped planning. Change sets it had already prepared stay listed as an unfinished plan: discard it to remove them.",
      onSettled: (job) => {
        stopFollowing?.();
        if (job.status !== "succeeded") context.plans.removeUnfinished(key);
        context.changed(credentials.name, name);
      },
    };
  },

  async "deploy-apply"(context, params) {
    const key = text(params, "plan");
    if (!key) throw new OperationError(400, "Name the plan to apply.");
    const plan = context.plans.read(key);
    if (!plan) throw new OperationError(404, "That plan no longer exists. Plan again.");
    const name = plan.identity.deployment;
    const credentials = await profile(context, { ...params, profile: text(params, "profile") ?? plan.profile });
    if (credentials.name !== plan.profile) throw new OperationError(409, "The selected AWS profile differs from this plan's reviewed connection. Plan again with the selected connection.");
    if (plan.result) throw new OperationError(409, "This plan was already applied. Plan again for further changes.");
    if (plan.expired) throw new OperationError(409, `This plan expired at ${plan.expiresAt}. Plan again.`);
    if (plan.status === "no-changes") throw new OperationError(409, "This plan changes nothing.");
    if (plan.status === "needs-secrets") throw new OperationError(409, "This plan could not prepare change sets until its new secrets exist. Plan again, creating them.");
    if (plan.status === "blocked" || plan.reviewEvidence?.problems.length) throw new OperationError(409, "Analysis is incomplete. Resolve its errors and plan again.");
    const currentSource = flag(params, "currentSource");
    if (currentSource && !plan.synthesis?.current) throw new OperationError(409, plan.synthesis?.reason ?? "The saved assembly does not represent the current deployment sources. Synthesize again.");
    const confirm = text(params, "confirm");
    if (plan.confirmation.level === "name" && confirm !== name) throw new OperationError(428, `Type ${name} to apply this plan: ${plan.confirmation.reasons.join("; ")}.`);
    if (confirm !== undefined && confirm !== name) throw new OperationError(400, `${confirm} does not name ${name}.`);
    const env = studioEnvironment(context.env, { profile: credentials.name });
    let stopFollowing: (() => void) | undefined;
    return {
      kind: "deploy-apply", title: currentSource ? `Deploy ${name}` : `Apply plan to ${name}`, params: { plan: key, deployment: name, profile: credentials.name, ...(currentSource ? { currentSource } : {}) },
      deployment: name, planId: key, locks: [`deployment:${name}`, ...(plan.identity.mode === "dev" ? ["exports", "local"] : [])], cancelNote: CLOUD_CANCEL_NOTE,
      steps: [{
        label: plan.review === "change-set" ? "Execute change sets and verify" : "Deploy and verify",
        run: async (step) => {
          if (plan.identity.mode === "dev") await assertDevelopmentRuntimeStopped(context, step.job);
          stopFollowing = context.followStacks(step.job, credentials.name, name, plan.identity.region);
        },
        command: () => context.tools.script("scripts/deploy.ts", ["--apply", context.plans.path(key), ...awsArguments(credentials.name, undefined), ...(confirm ? ["--confirm", confirm] : [])], env),
        after: (_result, step) => {
          const result = context.plans.read(key)?.result;
          step.setSummary(result?.status === "succeeded" ? `${name} is deployed and verified.` : result?.status === "partial" ? `Applied and verified; ${result.deferred.length} more stack${result.deferred.length === 1 ? "" : "s"} to plan now that their dependencies exist.` : "Applied, but not every stack verified.");
        },
      }],
      onSettled: () => { stopFollowing?.(); context.changed(credentials.name, name); },
    };
  },

  async "deploy-discard"(context, params) {
    const key = text(params, "plan");
    if (!key) throw new OperationError(400, "Name the plan to discard.");
    // A finished plan, or one that stopped after preparing change sets.
    const plan = context.plans.read(key) ?? context.plans.unfinished(key);
    if (!plan) throw new OperationError(404, "That plan no longer exists.");
    const credentials = await profile(context, { ...params, profile: text(params, "profile") ?? plan.profile });
    const name = plan.identity.deployment;
    return {
      kind: "deploy-discard", title: `Discard plan for ${name}`, params: { plan: key, deployment: name, profile: credentials.name },
      deployment: name, planId: key, locks: [`deployment:${name}`],
      steps: [{ label: "Remove change sets and the plan", command: () => context.tools.script("scripts/deploy.ts", ["--discard", context.plans.path(key), ...awsArguments(credentials.name, undefined)], studioEnvironment(context.env, { profile: credentials.name })), after: (_result, step) => step.setSummary("Plan discarded.") }],
      onSettled: () => context.changed(credentials.name, name),
    };
  },

  async "destroy-plan"() {
    throw new OperationError(400, "A teardown plan is read with GET /api/deploy/teardown, not run as an operation.");
  },

  async destroy(context, params) {
    const name = deploymentName(params);
    const deployMode = mode(params);
    const credentials = await profile(context, params);
    const regionName = region(params);
    const confirm = text(params, "confirm");
    if (confirm !== name) throw new OperationError(428, `Type ${name} to delete it.`);
    const review = text(params, "review");
    if (!review) throw new OperationError(428, "Review the exact deployed stack set before deleting it.");
    const reviewed = context.teardowns.read(review);
    if (regionName && regionName !== reviewed.region) throw new OperationError(409, "The selected region differs from the reviewed deletion.");
    if (reviewed.deployment !== name || reviewed.mode !== deployMode || !reviewed.digest || !reviewed.expiresAt || Date.parse(reviewed.expiresAt) < Date.now()) throw new OperationError(409, "This deletion review expired or names another destination. Review deletion again.");
    if (reviewed.blockers?.length) throw new OperationError(409, reviewed.blockers.join("; "));
    const retainFailed = flag(params, "retainFailed");
    if (retainFailed !== Boolean(reviewed.policy?.retainFailed)) throw new OperationError(409, "Retained-resource policy changed. Review deletion again.");
    let stopFollowing: (() => void) | undefined;
    return {
      kind: "destroy", title: `Delete ${name}`, params: { deployment: name, mode: deployMode, profile: credentials.name, ...(retainFailed ? { retainFailed } : {}) },
      deployment: name, locks: [`deployment:${name}`, ...(deployMode === "dev" ? ["local"] : [])], cancelNote: CLOUD_CANCEL_NOTE,
      steps: [{
        label: "Delete stacks, importers first",
        run: async (step) => {
          if (deployMode === "dev") await assertDevelopmentRuntimeStopped(context, step.job);
          stopFollowing = context.followStacks(step.job, credentials.name, name, reviewed.region);
        },
        command: () => context.tools.script("scripts/destroy.ts", [
          "--apply", context.teardowns.path(review), ...awsArguments(credentials.name, reviewed.region),
          "--confirm", name,
        ], studioEnvironment(context.env, { profile: credentials.name })),
        after: (_result, step) => step.setSummary(`${name} is deleted.`),
      }],
      onSettled: () => { stopFollowing?.(); context.changed(credentials.name, name); },
    };
  },

  async export(context, params) {
    const name = deploymentName(params);
    const credentials = await profile(context, params);
    const regionName = region(params) ?? context.targets().find((entry) => entry.name === name)?.region;
    const changesLocal = context.targets().find(entry => entry.name === name)?.mode !== "prod";
    return {
      kind: "export", title: `Export ${name}'s outputs`, params: { deployment: name, profile: credentials.name },
      deployment: name, locks: ["exports", ...(changesLocal ? ["local"] : [])],
      steps: [{
        label: "Write the local settings files",
        run: async step => { if (changesLocal) await assertDevelopmentRuntimeStopped(context, step.job); },
        command: () => context.tools.script("scripts/export-cdk-outputs.mjs", ["--deployment", name, ...awsArguments(credentials.name, regionName)], studioEnvironment(context.env, { profile: credentials.name }), context.exportDirectory),
        after: (_result, step) => step.setSummary(`This machine now points at ${name}.`),
      }],
      onSettled: () => context.changed(credentials.name, name),
    };
  },

  async "local-start"(context, params) {
    const name = deploymentName(params);
    const declared = target(context, name);
    if (declared.mode !== "dev" || text(params, "mode") && text(params, "mode") !== "dev") throw new OperationError(400, "Local development runs against a development deployment.");
    const credentials = await profile(context, params);
    const selectedAccount = text(params, "account") ?? declared.account;
    if (selectedAccount && !/^\d{12}$/.test(selectedAccount)) throw new OperationError(400, "Choose a valid AWS account for local development.");
    let selectedRegion = region(params) ?? declared.region;
    if (declared.account && selectedAccount !== declared.account || declared.region && selectedRegion !== declared.region) throw new OperationError(409, "The local runtime destination differs from the declared development target.");
    let account = selectedAccount;
    flag(params, "export"); // Preserve validation of legacy callers; startup always regenerates settings.
    let connectionRevision: string | undefined;
    const env = studioEnvironment(context.env, { profile: credentials.name });
    // Starting compute never opts into migration or identity setup profiles.
    env.COMPOSE_PROFILES = "";
    const assertConnection = () => {
      if (connectionRevision && readAwsFiles(context.env).revision !== connectionRevision) throw new Error("The AWS connection changed during startup. Start local runtime again to verify its destination.");
    };
    const assertExports = () => {
      const exported = context.local.exported();
      if (exported.deployment !== name || exported.account !== account || exported.region !== selectedRegion || !exported.client) throw new Error("This machine's exported settings do not match the verified development destination. Export its outputs again before starting local runtime.");
    };
    const steps: JobStep[] = [{
      label: "Verify the development deployment and Docker",
      run: async step => {
        const docker = await context.probeDocker();
        if (docker.engine !== "running") throw new Error(docker.engine === "missing" ? "Docker is not installed." : "Docker is not running. Start Docker Desktop, then start development again.");
        connectionRevision = readAwsFiles(context.env).revision;
        const observation = await context.observer.status(credentials.name, name, selectedRegion, true);
        assertConnection();
        if (!observation.ok) throw new Error(observation.problem.message);
        const { context: observed, detail } = observation.value;
        if (observed.profile !== credentials.name || account && observed.account !== account || selectedRegion && observed.region !== selectedRegion) throw new Error("The selected AWS identity or destination changed. Refresh deployment status before starting local runtime.");
        account = observed.account;
        selectedRegion = observed.region;
        if (!detail || detail.name !== name || detail.mode !== "dev" || detail.account !== account || detail.region !== selectedRegion || detail.state.kind !== "ready" || !Array.isArray(detail.stacks) || !detail.stacks.length || !detail.stacks.every(stack => stack.health === "complete" && ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(stack.status) && stack.evidence !== "none" && stack.identity?.deployment === name && stack.identity.mode === "dev")) throw new Error("Fully deploy the development resources successfully before starting local runtime.");
        if (declared.appId && detail.appId && declared.appId !== detail.appId || declared.stage && detail.stage && declared.stage !== detail.stage) throw new Error("The deployed resources belong to another application stage.");
        if (!detail.local?.compatible) throw new Error(detail.local?.problem ?? "The deployed development resources are not compatible with the current declarations. Synthesize and deploy the required changes first.");
        const active = (await context.local.activeContainers()).length || context.jobs.holder("local-watch") || context.jobs.holder("local-client");
        const record = context.local.runRecord();
        const exported = context.local.exported();
        if (active && (!record || record.profile !== credentials.name || record.deployment !== name || (record.account ?? exported.account) !== account || (record.region ?? exported.region) !== selectedRegion)) throw new Error("This checkout already has local services using another or unverified destination. Stop local runtime before starting this development deployment.");
        step.setSummary(`Development resources for ${name} are verified. Preparing local runtime.`);
      },
    }, {
        label: `Export ${name}'s outputs`,
        run: async () => { assertConnection(); },
        command: () => context.tools.script("scripts/export-cdk-outputs.mjs", ["--deployment", name, "--expected-mode", "dev", ...awsArguments(credentials.name, selectedRegion)], env, context.exportDirectory),
        after: () => { assertExports(); },
    }];
    steps.push(
      {
        label: "Generate source projections, verify database and start containers",
        run: async () => {
          assertConnection();
          assertExports();
          context.local.writeRunRecord({ profile: credentials.name, deployment: name, account, region: selectedRegion, startedAt: new Date().toISOString() });
        },
        command: () => context.tools.node("scripts/dev.mjs", ["--detach", "--profile", credentials.name], env),
      },
      {
        label: "Watch source and start the web client",
        run: async (step) => {
          assertConnection();
          context.startManaged("local-watch", credentials.name);
          context.startManaged("local-client", credentials.name);
          step.log("Starting local compute. Database migrations, orphan cleanup and test identity setup are separate actions; no startup data writes are authorized.");
          await context.local.waitUntilReady(step.signal, () => ({ watch: { running: !!context.jobs.holder("local-watch") }, client: { running: !!context.jobs.holder("local-client") } }), Number(context.env.FRAMEWORK_LOCAL_READY_TIMEOUT_MS ?? 60_000));
          step.setSummary(`Local services for ${name} are ready; the web client answers HTTP requests.`);
        },
      },
    );
    return {
      kind: "local-start", title: `Start development against ${name}`, params: { deployment: name, profile: credentials.name, mode: "dev", ...(selectedAccount ? { account: selectedAccount } : {}), ...(selectedRegion ? { region: selectedRegion } : {}), export: true },
      deployment: name, locks: ["local", "exports"], steps,
      cancelNote: "Stopped starting. Containers already started keep running; stop development to stop them. Their data is preserved.",
      onSettled: () => context.changed(undefined, undefined),
    };
  },

  async "local-stop"(context) {
    return {
      kind: "local-stop", title: "Stop development", params: {}, locks: ["local"],
      steps: [
        { label: "Stop the watch and the web client", run: async () => { await context.stopManaged(); } },
        {
          label: "Stop containers",
          run: async (step) => {
            const containers = await context.local.activeContainers();
            const ids = containers.map(container => container.id);
            if (!ids.length) { context.local.clearRunRecord(); return "No containers are running."; }
            const paused = containers.filter(container => container.state === "paused").map(container => container.id);
            if (paused.length) {
              const resumed = await context.run(context.tools.docker(["unpause", ...paused], studioEnvironment(context.env)), { timeoutMs: 30_000 });
              if (resumed.code !== 0) throw new Error("Paused local containers could not be resumed for a graceful stop. Check Docker and stop local runtime again.");
            }
            const result = await context.run(context.tools.docker(["stop", ...ids], studioEnvironment(context.env)), { timeoutMs: 120_000 });
            if (result.code !== 0) throw new Error(result.stderr.trim().split(/\r?\n/).pop() || "docker stop failed.");
            step.log(`Stopped ${ids.length} container${ids.length === 1 ? "" : "s"}.`);
            context.local.clearRunRecord();
            step.setSummary("Development is stopped. Its containers and data are kept for the next start.");
          },
        },
      ],
      onSettled: () => context.changed(undefined, undefined),
    };
  },

  async "local-restart"(context, params) {
    const name = text(params, "deployment") ?? context.local.exported().deployment;
    if (!name) throw new OperationError(400, "Choose a development deployment before restarting local runtime.");
    const spec = await BUILDERS["local-start"]!(context, { ...params, deployment: name });
    return { ...spec, kind: "local-restart", title: `Restart development against ${name}` };
  },

  async "local-attach-watch"(context, params) {
    const name = text(params, "deployment") ?? context.local.exported().deployment;
    if (!name) throw new OperationError(400, "Choose a development deployment before resuming local runtime.");
    const spec = await BUILDERS["local-start"]!(context, { ...params, deployment: name });
    return { ...spec, kind: "local-attach-watch", title: `Resume development against ${name}` };
  },

  async "deps-install"(context) {
    const command = context.tools.npm(["install", "--no-audit", "--no-fund"], studioEnvironment(context.env));
    if (!command) throw new OperationError(500, "npm was not found beside Node.");
    return {
      kind: "deps-install", title: "Install dependencies", params: {}, locks: ["deps", "local"], exclusive: true,
      steps: [{ label: "npm install", command: () => command, after: (_result, step) => step.setSummary("Dependencies installed.") }],
      onSettled: () => context.changed(undefined, undefined),
    };
  },

  async "docker-start"(context) {
    return {
      kind: "docker-start", title: "Start Docker Desktop", params: {}, locks: ["docker"],
      steps: [
        { label: "Start Docker Desktop", run: async () => {
          if ((await context.probeDocker()).engine === "running") return "Docker is already running; no startup is needed.";
        }, command: () => context.tools.docker(["desktop", "start"], studioEnvironment(context.env)) },
        {
          label: "Wait for the engine",
          run: async (step) => {
            for (let attempt = 0; attempt < 60; attempt++) {
              if (step.signal.aborted) throw new Error("Cancelled.");
              if ((await context.probeDocker()).engine === "running") { step.setSummary("Docker startup completed."); return; }
              await new Promise((resolve) => setTimeout(resolve, Number(context.env.FRAMEWORK_POLL_MS ?? 2000)));
            }
            throw new Error("Docker did not start within two minutes. Open Docker Desktop to see why.");
          },
        },
      ],
      onSettled: () => context.changed(undefined, undefined),
    };
  },

  async "aws-login"(context, params) {
    throw new OperationError(400, "Authentication is managed by AWS connections and cannot run as a logged deployment job.");
  },

  async drift(context, params) {
    const name = deploymentName(params);
    const credentials = await profile(context, params);
    const regionName = region(params) ?? context.targets().find((entry) => entry.name === name)?.region;
    return {
      kind: "drift", title: `Check ${name} for drift`, params: { deployment: name, profile: credentials.name }, deployment: name, locks: [`deployment:${name}`],
      steps: [{
        label: "Detect drift (changes no resource)",
        command: () => context.tools.script("scripts/deployment-status.ts", ["drift", "--deployment", name, ...awsArguments(credentials.name, regionName), "--json"], studioEnvironment(context.env, { profile: credentials.name })),
        after: (result, step) => {
          const view = AwsObserver.drift(result.stdout);
          if (!view) throw new Error("Drift detection returned no report.");
          context.setDrift(name, view);
          const drifted = view.stacks.filter((stack) => stack.status === "DRIFTED");
          step.setSummary(drifted.length ? `${drifted.length} stack${drifted.length === 1 ? "" : "s"} drifted.` : "No drift detected.");
        },
      }],
    };
  },
};

/** The persistent processes of local development: the source watch and the web client. */
export function managedSpec(context: OperationContext, kind: "local-watch" | "local-client", profileName: string): JobSpec {
  const env = { ...studioEnvironment(context.env, { profile: profileName }), LOCAL_AWS_PROFILE: profileName };
  const replacement = context.managed[kind];
  if (kind === "local-watch") {
    return {
      kind, title: "Source watch", params: { profile: profileName }, locks: ["local-watch"],
      steps: [{ label: "docker compose watch", command: () => tethered(replacement?.(env) ?? watchCommand(context, env)) }],
    };
  }
  // The dev script's program run directly (see local-commands.ts), or npm when a shell is needed.
  const command = replacement?.(env) ?? clientCommand(context.root, env) ?? context.tools.npm(["--workspace", "client-app", "run", "dev"], env);
  if (!command) throw new OperationError(500, "npm was not found beside Node.");
  return {
    kind, title: "Web client", params: { profile: profileName }, locks: ["local-client"],
    steps: [{ label: "Vite", command: () => tethered(command) }],
  };
}

/** docker compose watch for this repository, run as the Compose plugin itself where it can be found. */
function watchCommand(context: OperationContext, env: NodeJS.ProcessEnv): CommandSpec {
  const args = ["--project-directory", context.root, "watch", "--no-up"];
  const plugin = context.env.FRAMEWORK_DOCKER_CLI ? undefined : composePlugin(context.env);
  return plugin
    ? { file: plugin, args, cwd: context.root, env, display: "docker compose watch --no-up" }
    : context.tools.docker(["compose", ...args], env);
}

export function exportDirectory(root: string, env: NodeJS.ProcessEnv): string {
  return env.FRAMEWORK_EXPORT_DIRECTORY ? path.resolve(env.FRAMEWORK_EXPORT_DIRECTORY) : root;
}

export function validService(name: unknown): string {
  if (typeof name !== "string" || !SERVICE.test(name)) throw new OperationError(400, "Name a service.");
  return name;
}
