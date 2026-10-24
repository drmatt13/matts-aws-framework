import path from "node:path";
import { DEFAULT_DEPLOYMENT_NAME } from "@repo/framework/deploy";
import { repositoryTargets } from "@repo/framework/deploy/node";
import type { DeployOverview, DockerView, DriftView, JobView, ManagedProcessView, OperationRequest, PrerequisiteView } from "../../shared/deploy";
import { JobManager } from "./jobs";
import { LocalEnvironment } from "./local";
import { AwsObserver, type Observation } from "./observe";
import { PlanStore, TeardownStore } from "./plans";
import { Preferences } from "./preferences";
import { probeDocker, probePrerequisites } from "./prereqs";
import { runCommand, Tools, type Runner } from "./process";
import { buildOperation, exportDirectory, managedSpec, OperationError, type ManagedCommands, type OperationContext, type RepositoryTarget } from "./registry";

/**
 * Deploy & Run's server side: the observers, the operation registry and the
 * jobs, behind one object the routes call.
 */

export interface DeployServiceOptions {
  readonly disabledLocalServices?: () => ReadonlySet<string>;
  readonly run?: Runner;
  readonly env?: NodeJS.ProcessEnv;
  /** Where jobs, plans, preferences and the local run record live (default .cache/framework-studio). */
  readonly stateDirectory?: string;
  /** The programs behind the source watch and the web client, replaced in tests. */
  readonly managed?: ManagedCommands;
}

export class DeployService {
  readonly tools: Tools;
  readonly jobs: JobManager;
  readonly plans: PlanStore;
  readonly teardowns: TeardownStore;
  readonly local: LocalEnvironment;
  readonly observer: AwsObserver;
  readonly preferences: Preferences;
  private readonly run: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly drift = new Map<string, DriftView>();
  private prerequisites?: { at: number; promise: Promise<{ prerequisites: PrerequisiteView[]; docker: DockerView }> };
  private docker?: { at: number; promise: Promise<DockerView> };
  private readonly context: OperationContext;

  constructor(readonly root: string, private readonly broadcast: (event: string, data: unknown) => void, options: DeployServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? runCommand;
    this.tools = new Tools(root, this.env);
    // FRAMEWORK_STUDIO_STATE_DIRECTORY keeps a test run's jobs and plans apart from yours.
    const state = options.stateDirectory ?? (this.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ? path.resolve(this.env.FRAMEWORK_STUDIO_STATE_DIRECTORY) : path.join(root, ".cache", "framework-studio"));
    this.jobs = new JobManager({ directory: path.join(state, "jobs"), emit: broadcast });
    this.plans = new PlanStore(state);
    this.teardowns = new TeardownStore(state);
    this.local = new LocalEnvironment(root, this.tools, this.run, this.env, exportDirectory(root, this.env), state, options.disabledLocalServices);
    this.observer = new AwsObserver(this.tools, this.run, this.env);
    this.preferences = new Preferences(state);
    this.context = {
      root, tools: this.tools, env: this.env, run: this.run, exportDirectory: this.local.exportDirectory,
      jobs: this.jobs, plans: this.plans, teardowns: this.teardowns, local: this.local, observer: this.observer,
      profiles: () => this.observer.profiles(),
      targets: () => this.targets(),
      probeDocker: () => this.probeDocker(true),
      managed: options.managed ?? {},
      startManaged: (kind, profile) => this.jobs.holder(kind) ?? this.jobs.start(managedSpec(this.context, kind, profile)),
      stopManaged: async () => {
        const running = (["local-watch", "local-client"] as const).map((lock) => this.jobs.holder(lock)).filter((job): job is JobView => Boolean(job));
        for (const job of running) this.jobs.cancel(job.id);
        await Promise.all(running.map((job) => this.jobs.wait(job.id)));
      },
      setDrift: (deployment, view) => { this.drift.set([view.account, view.region, deployment].join("|"), view); },
      followStacks: (job, profile, deployment, region) => this.follow(job, profile, deployment, region),
      changed: (profile, deployment) => {
        this.observer.invalidate(profile);
        this.prerequisites = undefined;
        this.docker = undefined;
        this.broadcast("deploy-changed", { profile: profile ?? null, deployment: deployment ?? null });
      },
    };
  }

  /** The deployments this repository intends: declared targets and your development deployment. */
  targets(): RepositoryTarget[] {
    let targets: RepositoryTarget[];
    try {
      targets = repositoryTargets(this.root, this.env).map((entry) => ({
        name: entry.name, mode: entry.mode, origin: entry.origin,
        ...(entry.account ? { account: entry.account } : {}), ...(entry.region ? { region: entry.region } : {}), ...(entry.inputs ? { inputs: entry.inputs } : {}),
      }));
    } catch {
      targets = [];
    }
    // With no CDK_APP_NAME and no declared development target, the CLI deploys the default name.
    if (!targets.some((entry) => entry.mode === "dev")) targets.unshift({ name: DEFAULT_DEPLOYMENT_NAME, mode: "dev", origin: "personal" });
    return targets;
  }

  private probeDocker(force = false): Promise<DockerView> {
    if (!force && this.docker && Date.now() - this.docker.at < 5000) return this.docker.promise;
    const promise = probeDocker(this.tools, this.run, this.env);
    this.docker = { at: Date.now(), promise };
    return promise;
  }

  private probe(force: boolean) {
    if (!force && this.prerequisites && Date.now() - this.prerequisites.at < 15_000) return this.prerequisites.promise;
    const promise = probePrerequisites(this.tools, this.run, this.env, this.root);
    this.prerequisites = { at: Date.now(), promise };
    this.docker = { at: Date.now(), promise: promise.then((result) => result.docker) };
    return promise;
  }

  private managed(lock: "local-watch" | "local-client"): ManagedProcessView {
    const running = this.jobs.holder(lock);
    if (running) return { running: true, jobId: running.id };
    const last = this.jobs.list().find((job) => job.kind === lock);
    return last ? { running: false, jobId: last.id, exitCode: last.exitCode ?? null, ...(last.status === "failed" && last.summary ? { summary: last.summary } : {}) } : { running: false };
  }

  async overview(force = false): Promise<DeployOverview> {
    const [{ prerequisites, docker }, profiles] = await Promise.all([this.probe(force), this.observer.profiles(force)]);
    const local = await this.local.view(docker, { watch: this.managed("local-watch"), client: this.managed("local-client") });
    return { targets: this.targets(), prerequisites, local, jobs: this.jobs.list(), preferences: this.preferences.read(), profiles };
  }

  async requireProfile(name: unknown): Promise<string> {
    if (typeof name !== "string" || !(await this.observer.profiles()).some((entry) => entry.name === name)) throw new OperationError(400, "Choose a profile from your AWS configuration.");
    return name;
  }

  discover(profile: string, region: string | undefined, force: boolean): Promise<Observation<unknown>> {
    return this.observer.discover(profile, region, force);
  }

  status(profile: string, deployment: string, region: string | undefined, force: boolean): Promise<Observation<unknown>> {
    return this.observer.status(profile, deployment, region, force);
  }

  async teardown(profile: string, deployment: string, mode: "dev" | "prod", region: string | undefined, retainFailed = false, disableProtection = false) {
    const observation = await this.observer.teardown(profile, deployment, mode, region, retainFailed, disableProtection);
    return observation.ok ? { ok: true as const, value: this.teardowns.save(observation.value) } : observation;
  }

  /** Plans, with any a running job is still writing kept out of the clean-up. */
  listPlans() {
    const active = new Set(this.jobs.running().map((job) => job.planId).filter((key): key is string => Boolean(key)));
    return this.plans.list((key) => active.has(key));
  }

  driftReport(deployment: string, account?: string, region?: string): DriftView | null {
    return account && region ? this.drift.get([account, region, deployment].join("|")) ?? null : null;
  }

  async perform(request: OperationRequest): Promise<JobView> {
    if (!request || typeof request.kind !== "string") throw new OperationError(400, "An operation has a kind.");
    const spec = await buildOperation(this.context, request);
    try {
      return this.jobs.start(spec);
    } catch (error) {
      // A refused start leaves no half-made plan directory behind.
      if (spec.planId && spec.kind === "deploy-plan") this.plans.removeUnfinished(spec.planId);
      throw error;
    }
  }

  private follow(job: string, profile: string, deployment: string, region: string | undefined): () => void {
    const statuses = new Map<string, string>();
    let baseline = true;
    let observedContext: { account?: string; region?: string } = { region };
    const prefix = `${deployment}-`;
    const short = (stack: unknown) => String(stack ?? "").startsWith(prefix) ? String(stack).slice(prefix.length) : String(stack ?? "");
    const watch = this.observer.watch(profile, deployment, region, (line) => {
      if (line.type === "context") {
        observedContext = (line.context as { account?: string; region?: string } | undefined) ?? observedContext;
      } else if (line.type === "stacks") {
        const stacks = (line.stacks as { name?: string; status?: string; reason?: string }[] | undefined) ?? [];
        for (const stack of stacks) {
          if (!stack.name || statuses.get(stack.name) === stack.status) continue;
          if (!baseline || stack.status?.endsWith("_IN_PROGRESS")) this.jobs.note(job, `CloudFormation · ${short(stack.name)} ${stack.status}`);
          statuses.set(stack.name, String(stack.status));
        }
        baseline = false;
        this.broadcast("deploy-stacks", { deployment, profile, ...observedContext, stacks });
      } else if (line.type === "event") {
        const event = line.event as { logicalId?: string; status?: string; reason?: string; type?: string } | undefined;
        if (event && event.logicalId !== line.stack) {
          this.jobs.note(job, `CloudFormation · ${short(line.stack)} · ${event.logicalId} ${event.status}${event.reason ? ` — ${event.reason}` : ""}`, /FAILED/.test(event.status ?? "") ? "err" : "info");
        }
        this.broadcast("deploy-event", { deployment, profile, ...observedContext, stack: line.stack, event });
      }
    });
    return () => {
      // One last look, so the page ends on what AWS holds.
      setTimeout(() => watch.stop(), 1500).unref();
    };
  }

  async dispose(): Promise<void> {
    this.observer.dispose();
    await this.jobs.dispose();
  }
}
