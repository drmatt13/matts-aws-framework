import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OperationsClient } from "../operations/client";
import { RUNNER_KINDS } from "../operations/adapter";
import { listAwsProfiles } from "../../../scripts/aws-profiles";
import { isAwsProfileName } from "../../shared/aws-connections";
import { repositoryTargets } from "@repo/framework/deploy/node";
import type { DeployOverview, DriftView, JobView, ManagedProcessView, OperationRequest, PrerequisiteView } from "../../shared/deploy";
import { JobManager } from "./jobs";
import { LocalEnvironment } from "./local";
import { AwsObserver, type Observation } from "./observe";
import { PlanStore, TeardownStore } from "./plans";
import { Preferences } from "./preferences";
import { probeDockerStatus, probePrerequisites } from "./prereqs";
import { DockerStatus } from "../machine/docker";
import { withDockerStatus } from "../../shared/machine";
import { runCommand, Tools, type Runner } from "./process";
import { buildOperation, exportDirectory, managedSpec, OperationError, type ManagedCommands, type OperationContext, type RepositoryTarget } from "./registry";
import type { AwsConnectionsService } from "../aws-connections/service";

/**
 * Deploy & Run's server side: the observers, the operation registry and the
 * jobs, behind one object the routes call.
 */

export interface DeployServiceOptions {
  /** Production Studio uses the independent runner. Injected legacy service tests opt out. */
  readonly operations?: boolean;
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
  private prerequisites?: { at: number; promise: Promise<PrerequisiteView[]> };
  readonly dockerStatus: DockerStatus;
  private readonly context: OperationContext;
  private connections?: Pick<AwsConnectionsService, "catalog" | "check" | "startAuthentication">;
  private readonly operationsClient?: OperationsClient;
  private readonly state: string;
  private operationViews: JobView[] = [];
  private readonly operationVersions = new Map<string, string>();
  private readonly operationCursors = new Map<string, number>();
  private readonly operationEventCursors = new Map<string, number>();
  private operationPoll?: NodeJS.Timeout;
  private operationRefresh?: Promise<JobView[]>;
  private disposed = false;
  private operationStatusUnknown = true;
  private admissions = Promise.resolve();

  constructor(readonly root: string, private readonly broadcast: (event: string, data: unknown) => void, options: DeployServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.run = options.run ?? runCommand;
    this.tools = new Tools(root, this.env);
    this.dockerStatus = new DockerStatus(() => probeDockerStatus(this.tools, this.run, this.env), status => this.broadcast("machine-docker", status));
    // FRAMEWORK_STUDIO_STATE_DIRECTORY keeps a test run's jobs and plans apart from yours.
    const state = options.stateDirectory ?? (this.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ? path.resolve(this.env.FRAMEWORK_STUDIO_STATE_DIRECTORY) : path.join(root, ".cache", "framework-studio"));
    this.state = state;
    this.jobs = new JobManager({ directory: path.join(state, "jobs"), emit: (event, data) => {
      broadcast(event, data);
      if (event === "deploy-job") broadcast("operation-job", data);
      if (event === "deploy-log") broadcast("operation-log", data);
    } });
    if (options.operations) {
      this.operationsClient = new OperationsClient(root, state, this.env);
      this.operationPoll = setInterval(() => { void this.refreshOperations().catch(() => {}); }, 500);
      this.operationPoll.unref();
      void this.refreshOperations().catch(() => {});
    }
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
      probeDocker: () => this.dockerStatus.read(true).then(status => status.docker),
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
        this.dockerStatus.invalidate();
        if (!this.disposed) void this.dockerStatus.read(true).catch(() => {});
        this.broadcast("deploy-changed", { profile: profile ?? null, deployment: deployment ?? null });
      },
    };
  }

  /** The deployments this repository intends, as cdk-app/cdk.json names them: the dev stage first. */
  targets(): RepositoryTarget[] {
    return this.listTargets().targets;
  }

  private listTargets(): { targets: RepositoryTarget[]; problem?: string } {
    try {
      return {
        targets: repositoryTargets(this.root).map((entry) => ({
          name: entry.name, mode: entry.mode, origin: entry.origin,
          ...(entry.stage ? { stage: entry.stage } : {}), ...(entry.appId ? { appId: entry.appId } : {}), ...(entry.deployAs ? { deployAs: entry.deployAs } : {}),
          ...(entry.account ? { account: entry.account } : {}), ...(entry.region ? { region: entry.region } : {}), ...(entry.inputs ? { inputs: entry.inputs } : {}),
        })),
      };
    } catch (error) {
      // The CLI refuses the same configuration; say why rather than show an empty list.
      return { targets: [], problem: error instanceof Error ? error.message : String(error) };
    }
  }

  private probe(force: boolean) {
    if (!force && this.prerequisites && Date.now() - this.prerequisites.at < 15_000) return this.prerequisites.promise;
    const promise = probePrerequisites(this.tools, this.run, this.env, this.root, this.dockerStatus.read(force))
      .then(result => result.prerequisites.filter(check => check.id !== "docker" && check.id !== "compose"));
    this.prerequisites = { at: Date.now(), promise };
    return promise;
  }

  private managed(lock: "local-watch" | "local-client"): ManagedProcessView {
    const running = this.jobs.holder(lock);
    if (running) return { running: true, jobId: running.id };
    const last = this.jobs.list().find((job) => job.kind === lock);
    return last ? { running: false, jobId: last.id, exitCode: last.exitCode ?? null, ...(last.status === "failed" && last.summary ? { summary: last.summary } : {}) } : { running: false };
  }

  async overview(force = false): Promise<DeployOverview> {
    const [prerequisites, profiles, machine] = await Promise.all([this.probe(force), this.observer.profiles(force), this.dockerStatus.read(force)]);
    const docker = machine.docker;
    const local = await this.local.view(docker, { watch: this.managed("local-watch"), client: this.managed("local-client") });
    const { targets, problem } = this.listTargets();
    return withDockerStatus({ targets, ...(problem ? { targetsProblem: problem } : {}), prerequisites, local, jobs: await this.listOperations(), preferences: this.preferences.read(), profiles }, machine);
  }

  async requireProfile(name: unknown): Promise<string> {
    if (!isAwsProfileName(name) || !this.profiles().some((entry) => entry.name === name)) throw new OperationError(400, "Choose a profile from your AWS configuration.");
    return name;
  }

  profiles() { return listAwsProfiles(this.env); }

  setConnections(service: Pick<AwsConnectionsService, "catalog" | "check" | "startAuthentication">) { this.connections = service; }

  async authenticate(profile: unknown) {
    if (!this.connections) throw new OperationError(409, "Open AWS profile configuration to connect. Restart Studio if it is unavailable.");
    return this.connections.startAuthentication({ profile: await this.requireProfile(profile) });
  }

  async identity(profile: string, force: boolean): Promise<Observation<{ context: import("../../shared/deploy").AccountContext }>> {
    if (!this.connections) return this.observer.identity(profile, force);
    const observation = await this.connections.check(profile, force);
    if (observation.state === "connected" && observation.identity) return { ok: true, value: { context: { profile, ...observation.identity, region: observation.region.value ?? "" } } };
    const code = observation.problem?.code;
    const kind = code === "expired" || code === "no-credentials" || code === "missing-cli" || code === "denied" || code === "throttled" ? code : code === "profile" || code === "configuration" ? "profile" : "failed";
    return { ok: false, problem: { kind, message: observation.problem?.message ?? "The selected AWS identity is unverified. Open connection diagnostics." } };
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
  async listPlans() {
    await this.refreshOperations();
    const active = new Set(this.activeJobs().map((job) => job.planId).filter((key): key is string => Boolean(key)));
    return this.plans.list((key) => active.has(key));
  }

  driftReport(deployment: string, account?: string, region?: string): DriftView | null {
    if (this.operationsClient && account && region) {
      const key = createHash("sha256").update(JSON.stringify([account, region, deployment])).digest("hex");
      try { return JSON.parse(readFileSync(path.join(this.state, "operations", `drift-${key}.json`), "utf8")) as DriftView; } catch { return null; }
    }
    return account && region ? this.drift.get([account, region, deployment].join("|")) ?? null : null;
  }

  perform(request: OperationRequest): Promise<JobView> {
    const admitted = this.admissions.then(() => this.performAdmitted(request));
    this.admissions = admitted.then(() => {}, () => {});
    return admitted;
  }

  private async performAdmitted(request: OperationRequest): Promise<JobView> {
    if (this.disposed) throw new OperationError(503, "Studio has stopped accepting operations.");
    if (!request || typeof request.kind !== "string") throw new OperationError(400, "An operation has a kind.");
    if (request.kind === "docker-start") {
      const running = this.jobs.holder("docker");
      if (running) return running;
    }
    if (request.kind === "aws-login") throw new OperationError(400, "Authentication uses AWS connection management. Open Configure AWS profiles.");
    if (this.operationsClient && RUNNER_KINDS.has(request.kind)) {
      if (this.jobs.running().some(job => !["local-watch", "local-client"].includes(job.kind))) throw new OperationError(409, "A local workspace operation is running. Wait for it before starting independent work.");
      const job = await this.operationsClient.submit(request);
      this.operationViews = [job, ...this.operationViews.filter(entry => entry.id !== job.id)];
      this.broadcast("operation-job", job);
      this.broadcast("deploy-job", job);
      void this.refreshOperations().catch(() => {});
      return job;
    }
    if (this.operationsClient && ["local-start", "local-restart", "local-attach-watch", "deps-install"].includes(request.kind)) {
      if ((await this.refreshOperations()).some(job => job.status === "running" || job.execution === "lost" || job.outcome === "uncertain")) throw new OperationError(409, "Independent work still owns this checkout. Inspect its outcome before changing local dependencies or exports.");
    }
    const spec = await buildOperation(this.context, request);
    try {
      return this.jobs.start(spec);
    } catch (error) {
      // A refused start leaves no half-made plan directory behind.
      if (spec.planId && spec.kind === "deploy-plan") this.plans.removeUnfinished(spec.planId);
      throw error;
    }
  }

  activeJobs(): JobView[] { return [...this.jobs.running(), ...this.operationViews.filter(job => job.status === "running" || job.execution === "lost" || job.outcome === "uncertain")]; }
  hasUnobservedOperations(): boolean { return Boolean(this.operationsClient) && this.operationStatusUnknown; }

  async listOperations(): Promise<JobView[]> {
    const operations = await this.refreshOperations();
    return [...operations, ...this.jobs.list()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async cancelOperation(id: string): Promise<JobView> {
    if (this.jobs.get(id)) return this.jobs.cancel(id);
    if (!this.operationsClient) throw new OperationError(404, "No such operation.");
    const job = await this.operationsClient.cancel(id);
    this.operationViews = [job, ...this.operationViews.filter(entry => entry.id !== job.id)];
    this.broadcast("operation-job", job);
    this.broadcast("deploy-job", job);
    void this.refreshOperations().catch(() => {});
    return job;
  }

  async operationLog(id: string, after = 0) {
    if (this.jobs.get(id)) return this.jobs.log(id, after);
    if (!this.operationsClient) throw new OperationError(404, "No such operation.");
    return this.operationsClient.log(id, after);
  }

  async frameworkCheck(requestKey?: string) {
    const started = Date.now();
    const accepted = await this.perform({ kind: "framework-check", params: {}, requestKey });
    let job = accepted;
    let output = "";
    let cursor = 0;
    while (!this.disposed) {
      const page = await this.operationLog(job.id, cursor);
      job = page.job;
      if (page.lines.length) {
        cursor = page.lines.at(-1)!.seq;
        output = (output + page.lines.map(line => line.text).join("\n") + "\n").slice(-256 * 1024);
      }
      if (job.status !== "running" && cursor >= job.lastSeq) return { command: "framework:check", exitCode: job.exitCode ?? null, output, durationMs: Date.now() - started };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new OperationError(503, "Studio stopped observing; the framework check continues in Activity.");
  }

  private refreshOperations(): Promise<JobView[]> {
    if (!this.operationsClient || this.disposed) return Promise.resolve(this.operationViews);
    if (this.operationRefresh) return this.operationRefresh;
    this.operationRefresh = (async () => {
      const observed = await this.operationsClient!.list();
      if (this.disposed) return observed;
      // An earlier discovery response must not erase an acceptance/cancellation receipt
      // acknowledged while that read was in flight. History is retained in this version.
      const known = new Map(this.operationViews.map(job => [job.id, job]));
      const phase = { accepted: 0, dispatching: 1, running: 2, finished: 3, lost: 3 };
      for (const job of observed) {
        const previous = known.get(job.id);
        if (previous && (previous.lastSeq > job.lastSeq || previous.status !== "running" && job.status === "running" || phase[previous.execution ?? "accepted"] > phase[job.execution ?? "accepted"])) continue;
        known.set(job.id, previous?.cancelRequested ? { ...job, cancelRequested: true } : job);
      }
      const jobs = [...known.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      this.operationViews = jobs;
      this.operationStatusUnknown = false;
      for (const job of jobs) {
        const version = JSON.stringify(job);
        const changed = this.operationVersions.get(job.id) !== version;
        if (changed) {
          this.operationVersions.set(job.id, version);
          this.broadcast("operation-job", job);
          this.broadcast("deploy-job", job);
          if (job.status !== "running") this.broadcast("deploy-changed", { deployment: job.deployment, profile: job.params.profile });
        }
        if (changed || job.status === "running") {
          let cursor = this.operationEventCursors.get(job.id) ?? 0;
          let page;
          do {
            page = await this.operationsClient!.events(job.id, cursor);
            for (const entry of page.events) {
              if (!this.disposed) this.broadcast(entry.event, entry.data);
              cursor = entry.seq;
            }
            this.operationEventCursors.set(job.id, cursor);
          } while (page.events.length && cursor < page.lastSeq);
        }
        const cursor = this.operationCursors.get(job.id);
        if (cursor === undefined) { this.operationCursors.set(job.id, job.lastSeq); continue; }
        if (cursor < job.lastSeq) {
          const { lines } = await this.operationsClient!.log(job.id, cursor);
          if (this.disposed) return jobs;
          if (lines.length) {
            this.operationCursors.set(job.id, lines.at(-1)!.seq);
            this.broadcast("operation-log", { id: job.id, lines });
            this.broadcast("deploy-log", { id: job.id, lines });
          }
        }
      }
      return jobs;
    })().catch(error => { this.operationStatusUnknown = true; throw error; }).finally(() => { this.operationRefresh = undefined; });
    return this.operationRefresh;
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
    this.disposed = true;
    if (this.operationPoll) clearInterval(this.operationPoll);
    this.operationsClient?.close();
    this.observer.dispose();
    await this.jobs.dispose();
  }
}
