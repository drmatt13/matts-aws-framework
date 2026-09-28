import { containerEnvironment, dockerWithEnvironment } from "./docker";
import { randomUUID } from "node:crypto";
import type { FrameworkConfig } from "@repo/framework/config";
import {
  TASK_CONTAINER_KIND_LABEL,
  TASK_CONTAINER_PROJECT_LABEL,
  TASK_CONTAINER_RUN_LABEL,
  TASK_CONTAINER_TARGET_LABEL,
  findLocalTaskPlan,
  planLocalInvocation,
  resolveLocalWorkloadEnvironment,
  type LocalInvocationGraph,
  type ResolvedLocalTaskPlan,
} from "@repo/framework/local";

/**
 * The on-demand container runner for `tasks`.
 *
 * Tasks are not Compose services. A service is a long-running process Compose
 * maintains; a task is a container launched per invocation whose *result is its
 * exit status*. Declaring one as a Compose service would start it at `docker compose up`,
 * restart it when it finished, and give it no input — which is three different
 * ways of not being a task.
 *
 * This owns what a supervisor owns and the Lambda path deliberately does not:
 * launch acknowledgement separately from execution, inspect and wait, bounded
 * logs, stop, exit status, and project-scoped cleanup. In particular it does
 * *not* inherit the Lambda runner's ten-second global timeout, and it does not
 * wait for a Lambda runtime endpoint — a task has neither.
 *
 * Acceptance is separate from preparation. `submit` validates the submission,
 * allocates the run and returns; building the image and launching the container
 * happen afterwards, on this supervisor's own time. That is what the public
 * `runTask` contract has always promised — submission accepted, completion
 * observed separately — and it is why a cold build no longer holds an
 * application request open. Acceptance is in memory: a runner crash loses
 * accepted work, which is the honest difference between this and ECS's durable
 * delivery.
 *
 * Preparation is *shared*. Twenty submissions of one target do not run twenty
 * builds; they run one, and the rule that keeps that safe is written down at
 * {@link LocalTaskSupervisor.acquireImage}.
 *
 * What it cannot do is emulate IAM, VPC isolation or Fargate startup timing.
 * Those are properties of the cloud, and the cloud acceptance cases are where
 * they are proven.
 */

export type TaskRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped";

export interface TaskRun {
  readonly runId: string;
  /**
   * A short session-unique label for log correlation.
   *
   * The full run id stays the identifier — in the API, in container labels and
   * in `npm run dev:runs`. This exists because a full id repeated on every
   * application line is noise, and two concurrent runs of the same target still
   * have to be told apart. It is unique to this runner process, not to history.
   */
  readonly displayId: string;
  readonly target: string;
  /** Allocated when the container is created, so absent while preparing. */
  containerName?: string;
  status: TaskRunStatus;
  exitCode?: number;
  /** When the submission was accepted, which is before anything was built. */
  readonly acceptedAt: string;
  /** When the container actually started. Absent if it never did. */
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
  /**
   * A bounded tail, captured *before* the container is removed — or, for a run
   * that failed while preparing, the build diagnostics, because there is no
   * container to read them from.
   */
  logs?: string;
}

export interface DockerCommand {
  (...args: string[]): Promise<string>;
}

/**
 * `docker build`, cancellable by the preparation that asked for it.
 *
 * Separate from {@link DockerCommand} because a build is the single call a stop
 * has to be able to interrupt, and the shared command takes no signal. Injected
 * so a test can defer a build without a daemon.
 */
export interface DockerBuildCommand {
  (args: readonly string[], signal: AbortSignal): Promise<string>;
}

/** A rejected submission, with the status the runner's route should answer. */
export class TaskSubmissionError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TaskSubmissionError";
  }
}

export interface LocalTaskSupervisorOptions {
  readonly config: FrameworkConfig;
  readonly repositoryRoot: string;
  readonly projectName: string;
  readonly network: () => Promise<string>;
  readonly docker: DockerCommand;
  readonly runContainer?: typeof dockerWithEnvironment;
  readonly awsConfigSource?: string;
  /** Defaults to the shared command without cancellation. */
  readonly buildImage?: DockerBuildCommand;
  /**
   * The clock acceptance and build starts are compared on.
   *
   * Injected so the sharing rule at {@link LocalTaskSupervisor.acquireImage}
   * can be tested as the comparison it is, rather than by sleeping and hoping
   * two events land in different milliseconds.
   */
  readonly now?: () => number;
  readonly followLogs?: (container: string, prefix: string) => () => void | Promise<void>;
}

// The labels are declared in @repo/framework/local, beside the project-name
// rule, so runner shutdown removes exactly what this supervisor created.
const TASK_LABEL_KIND = TASK_CONTAINER_KIND_LABEL;
const TASK_LABEL_PROJECT = TASK_CONTAINER_PROJECT_LABEL;
const TASK_LABEL_TARGET = TASK_CONTAINER_TARGET_LABEL;
const TASK_LABEL_RUN = TASK_CONTAINER_RUN_LABEL;

const LOG_TAIL_LINES = "500";
/**
 * Accepted runs that have not reached a terminal status.
 *
 * Generous, because preparation is shared: a hundred clicks are one or two
 * builds and a hundred launches, not a hundred builds. This exists so a runaway
 * caller cannot grow this process without bound, not to ration ordinary use.
 */
const ACTIVE_RUN_LIMIT = 200;
/**
 * Containers being created at once.
 *
 * `docker run` is quick but not free, and a hundred simultaneous creations make
 * a daemon slower at all of them. They launch in waves instead.
 */
const LAUNCH_CONCURRENCY = 8;
/** Terminal runs kept for inspection; the oldest delivered ones are dropped. */
const RUN_HISTORY_LIMIT = 200;
/** Bounded build output kept on a run that failed before it had a container. */
const DIAGNOSTIC_LIMIT = 4_000;

/**
 * What one accepted submission owns privately.
 *
 * The payload, the resolved environment and the abort controller live here
 * rather than on {@link TaskRun}: the public record is served over HTTP and
 * printed by `dev:runs`, and a task's resolved environment can hold secrets.
 */
interface TaskRunRecord {
  readonly run: TaskRun;
  /** Acceptance as a number, for comparison against a build's start. */
  readonly acceptedAt: number;
  readonly completion: Promise<TaskRun>;
  readonly settle: (run: TaskRun) => void;
  /** Present for an accepted submission; absent for an adopted container. */
  readonly launch?: {
    readonly plan: ResolvedLocalTaskPlan;
    /** The serialized input, or "" when the submission carried none. */
    readonly input: string;
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly preparation: AbortController;
  /** Set by `stop` and by shutdown, never unset: a stopped run stays stopped. */
  stopRequested: boolean;
  /** Consumers awaiting completion right now. History pruning waits for them. */
  waiting: number;
  settled: boolean;
}

/**
 * One image build, shared by every run it is fresh enough for.
 *
 * Its reference is a tag minted for this build alone. Nothing else ever writes
 * it, so it cannot be moved out from under a launch — which is exactly what the
 * shared per-target tag did: two builds of *identical* source produce two
 * different image ids, and when the second took the tag, the first id stopped
 * resolving and its container could not be created.
 */
interface TargetPreparation {
  readonly target: string;
  /** When the builder was asked. The freshness watermark for joining runs. */
  readonly startedAt: number;
  readonly reference: string;
  readonly controller: AbortController;
  /** Runs holding the image. The reference is dropped when the last lets go. */
  readonly holders: Set<string>;
  image: Promise<string>;
  built: boolean;
  released: boolean;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function dockerPlatform(plan: ResolvedLocalTaskPlan): string {
  return plan.architecture === "arm64" ? "linux/arm64" : "linux/amd64";
}

function architecture(plan: ResolvedLocalTaskPlan): string {
  return dockerPlatform(plan).endsWith("arm64") ? "arm64" : "amd64";
}

export class LocalTaskSupervisor {
  private closing = false;
  private displayCounter = 0;
  private launching = 0;
  private readonly launchQueue: (() => void)[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly records = new Map<string, TaskRunRecord>();
  private readonly preparations = new Map<string, TargetPreparation>();
  private readonly graph: LocalInvocationGraph;
  private readonly options: LocalTaskSupervisorOptions;

  public constructor(options: LocalTaskSupervisorOptions) {
    this.options = options;
    this.graph = planLocalInvocation(options.config, {
      repositoryRoot: options.repositoryRoot,
    });
  }

  public plans(): readonly ResolvedLocalTaskPlan[] {
    return this.graph.tasks;
  }

  /**
   * Adopts or cleans up containers left by a previous runner process.
   *
   * A restart must not orphan a running job or lose a finished one's status, so
   * every tracked container is either watched again or recorded and removed.
   */
  public async initialize(): Promise<void> {
    const listed = await this.options
      .docker(
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${TASK_LABEL_KIND}=task`,
        "--filter",
        `label=${TASK_LABEL_PROJECT}=${this.options.projectName}`,
        "--format",
        "{{.Names}}\t{{.Label \"" + TASK_LABEL_RUN + "\"}}\t{{.Label \"" + TASK_LABEL_TARGET + "\"}}\t{{.State}}",
      )
      .catch(() => "");

    for (const line of listed.split(/\r?\n/).filter(Boolean)) {
      const [containerName, runId, target, state] = line.split("\t");
      if (!containerName || !runId || !target) continue;
      // An adopted run takes a display id from this session's counter, so it
      // cannot collide with one this process hands out later.
      const adopted = this.stamp();
      const record = this.register({
        runId,
        displayId: this.nextDisplayId(),
        target,
        containerName,
        status: state === "running" ? "running" : "failed",
        acceptedAt: adopted,
        startedAt: adopted,
      });
      if (state === "running") {
        this.watch(record);
        continue;
      }
      // Already finished while nothing was watching: record what can still be
      // learned, then remove it. A result recorded after the container is gone
      // is a result nobody can read.
      record.run.error = "The runner restarted while this run was not being watched.";
      await this.capture(record.run);
      await this.remove(record.run);
      this.finish(record, "failed");
    }

    // Preparation tags outlive a runner killed between a build and its launch.
    // They are ours by name, and an unforced removal refuses an image a
    // container still uses, so this cannot take a running task's image away.
    await this.releaseAbandonedReferences();
  }

  /**
   * Accepts a submission and returns.
   *
   * Everything a caller can get wrong is checked here — the task is enabled,
   * the input serializes, the launch settings resolve, the client token is not
   * already in use, the runner is not saturated — so a rejection is a rejected
   * submission rather than a run that quietly never starts. Everything the
   * *machine* can get wrong afterwards, a build failure above all, becomes an
   * inspectable `failed` run instead.
   *
   * Synchronous by design: there is nothing left to await once the run is
   * registered, and a promise here would invite the caller to believe the
   * container exists by the time it resolves.
   */
  public submit(
    id: string,
    input: unknown,
    options: {
      readonly clientToken?: string;
      /**
       * The callback handle a task started in callback mode reports through.
       *
       * Passed rather than resolved here, because the broker mints it: the
       * callback is registered before the container is launched, so a fast
       * container cannot answer before anything is listening.
       */
      readonly callback?: string;
    } = {},
  ): TaskRun {
    if (this.closing) {
      throw new TaskSubmissionError("Local runner is shutting down.", 503);
    }
    const plan = findLocalTaskPlan(this.graph, id);
    if (!plan) {
      throw new TaskSubmissionError(
        `task:${id} is not enabled for local execution. Declare it under tasks with a deploy setting that includes "local".`,
        400,
      );
    }

    let encoded: string | undefined;
    try {
      encoded = input === undefined ? "" : JSON.stringify(input);
    } catch {
      encoded = undefined;
    }
    if (encoded === undefined) {
      throw new TaskSubmissionError(
        `task:${id} was given an input that is not JSON-serializable.`,
        400,
      );
    }

    const active = [...this.records.values()].filter((record) => !record.settled).length;
    if (active >= ACTIVE_RUN_LIMIT) {
      throw new TaskSubmissionError(
        `The local runner already has ${ACTIVE_RUN_LIMIT} runs in flight. Wait for some to finish; submissions are not queued.`,
        429,
      );
    }

    const runId = `local-task-${id}-${options.clientToken ?? randomUUID()}`;
    if (this.records.has(runId)) {
      throw new TaskSubmissionError(
        `Run "${runId}" already exists. A client token identifies one submission; it does not retry it.`,
        409,
      );
    }

    // Resolved now, for this submission alone: a later export of root .env
    // changes the next task's inputs, never one already accepted.
    const environment = {
      ...(options.callback === undefined
        ? {}
        : { FRAMEWORK_TASK_CALLBACK: options.callback }),
    };

    const record = this.register(
      {
        runId,
        displayId: this.nextDisplayId(),
        target: id,
        status: "starting",
        acceptedAt: this.stamp(),
      },
      { plan, input: encoded, environment },
    );

    const preparation = this.prepare(record);
    this.pending.add(preparation);
    // `.catch` on the chain, not on the work: preparation records its own
    // failures, and a settled promise must never surface as an unhandled one.
    void preparation.finally(() => this.pending.delete(preparation)).catch(() => undefined);
    return record.run;
  }

  public get(runId: string): TaskRun | undefined {
    return this.records.get(runId)?.run;
  }

  public list(): readonly TaskRun[] {
    return [...this.records.values()].map((record) => record.run);
  }

  /**
   * A bounded log tail: live from the container, the captured tail after it, or
   * the preparation diagnostics of a run that never had one.
   */
  public async logs(runId: string): Promise<string> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Unknown run "${runId}".`);
    if (record.run.logs !== undefined) return record.run.logs;
    if (!record.run.containerName) return "";
    return this.options
      .docker("logs", "--tail", LOG_TAIL_LINES, record.run.containerName)
      .catch(() => "");
  }

  /**
   * Requests a stop.
   *
   * Best effort, and said as such: the container is asked to stop, and work it
   * has already done elsewhere is not undone. A run that is still preparing is
   * stopped too — it leaves the build it was waiting on, and no container is
   * launched for it. The build itself is cancelled only when no run is left
   * waiting on it: stopping one task must not sabotage the four beside it.
   */
  public async stop(runId: string): Promise<TaskRun> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Unknown run "${runId}".`);
    if (record.run.status === "running" || record.run.status === "starting") {
      record.stopRequested = true;
      record.preparation.abort(new Error(`Run "${runId}" was stopped.`));
      if (record.run.containerName) {
        await this.options
          .docker("stop", "--time", "10", record.run.containerName)
          .catch(() => undefined);
      }
      record.run.status = "stopped";
    }
    await this.wait(runId).catch(() => undefined);
    return record.run;
  }

  /**
   * Resolves when the run has reached a terminal status.
   *
   * That includes preparation: a caller waiting on a task that is still being
   * built is waiting for the same thing it would wait for in AWS — the job.
   */
  public async wait(runId: string, signal?: AbortSignal): Promise<TaskRun> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Unknown run "${runId}".`);
    record.waiting += 1;
    try {
      if (!signal) return await record.completion;
      return await Promise.race([
        record.completion,
        new Promise<TaskRun>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason as Error);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason as Error), {
            once: true,
          });
        }),
      ]);
    } finally {
      record.waiting -= 1;
    }
  }

  /** Removes every container this project owns. Called by runner shutdown. */
  public async shutdown(): Promise<void> {
    this.closing = true;
    for (const record of this.records.values()) {
      record.stopRequested = true;
      record.preparation.abort(new Error("Local runner is shutting down."));
    }
    const preparations = [...this.preparations.values()];
    for (const preparation of preparations) {
      preparation.controller.abort(new Error("Local runner is shutting down."));
    }
    // Nothing is left blocked behind a launch slot that will never open.
    while (this.launchQueue.length > 0) this.launchQueue.shift()?.();
    await Promise.all([
      Promise.allSettled([...this.pending]),
      ...[...this.records.values()].map((record) => this.remove(record.run)),
    ]);
    for (const preparation of preparations) {
      await this.releaseReference(preparation);
    }
    // Nothing is left waiting on a promise that can no longer settle.
    for (const record of this.records.values()) {
      this.finish(record, record.run.status === "starting" ? "stopped" : record.run.status);
    }
    this.records.clear();
    this.preparations.clear();
  }

  /**
   * The accepted submission's own work: get an image, then launch a container.
   *
   * Cancellation is checked at every boundary it can cross — before the build,
   * before the launch, and again after the launch resolves, because a container
   * created during that last race still has to be removed.
   */
  private async prepare(record: TaskRunRecord): Promise<void> {
    let launch = record.launch;
    if (!launch) return;
    let release: (() => Promise<void>) | undefined;
    try {
      if (this.stopped(record)) {
        this.finish(record, "stopped");
        return;
      }
      launch = { ...launch, environment: {
        ...await resolveLocalWorkloadEnvironment(this.options.config, launch.plan.reference, { repositoryRoot: this.options.repositoryRoot }),
        ...launch.environment,
      } };
      const acquired = await this.acquireImage(record, launch.plan);
      release = acquired.release;
      if (this.stopped(record)) {
        this.finish(record, "stopped");
        return;
      }
      await this.launchContainer(record, launch, acquired.reference);
    } catch (error) {
      // A stop that races a failing build still reads as stopped: the operator
      // asked for that outcome, and the build's failure is not news.
      if (this.stopped(record)) {
        record.run.logs ??= this.diagnostics(error);
        this.finish(record, "stopped");
        return;
      }
      record.run.error = error instanceof Error ? error.message : String(error);
      record.run.logs ??= this.diagnostics(error);
      console.error(
        `[${this.prefix(record.run)}] preparation failed: ${record.run.error}`,
      );
      this.finish(record, "failed");
    } finally {
      // Held until the container exists, so nothing can drop the image between
      // the build that made it and the run that needs it.
      await release?.().catch(() => undefined);
    }
  }

  /**
   * The image for one run — built, or shared with the runs beside it.
   *
   * The rule that makes sharing safe is a watermark, not a guess. BuildKit
   * snapshots the build context when a build *starts*, so a build that started
   * at or after this submission was accepted necessarily contains every edit
   * the developer had made by the time they submitted. A build that started
   * earlier might not, so this run declines it, waits, and takes the next one.
   *
   * That single comparison is what turns a burst of clicks into two builds
   * instead of twenty: the first click starts a build; every click that arrives
   * while it runs is too late for that one, waits, and then all of them share
   * the single build the first of them starts. Nobody ever runs an image built
   * before they asked for it.
   *
   * Concurrent builds are what made this necessary: four of them on one target
   * in this repository took 108 seconds each, against two seconds for one.
   */
  private async acquireImage(
    record: TaskRunRecord,
    plan: ResolvedLocalTaskPlan,
  ): Promise<{ readonly reference: string; readonly release: () => Promise<void> }> {
    const requested = this.now();
    for (;;) {
      if (this.stopped(record)) {
        throw new Error("The run was stopped before its image was built.");
      }
      const current = this.preparations.get(plan.id);
      if (current && current.startedAt < record.acceptedAt) {
        // Older than this submission, so it may not carry the edit that
        // prompted it. Wait for it to finish, then look again: by then the next
        // build has usually been started by a run in the same position.
        await current.image.catch(() => undefined);
        continue;
      }
      const preparation = current ?? this.startPreparation(plan);
      preparation.holders.add(record.run.runId);
      try {
        const reference = await this.raceAbort(
          preparation.image,
          record.preparation.signal,
        );
        const shared = preparation.holders.size;
        console.log(
          `[${this.prefix(record.run)}] image ready in ${seconds(this.now() - requested)}` +
            (shared > 1 ? ` (one build shared by ${shared} runs)` : ""),
        );
        return {
          reference,
          release: () => this.releaseHold(preparation, record.run.runId),
        };
      } catch (error) {
        await this.releaseHold(preparation, record.run.runId);
        throw error;
      }
    }
  }

  /**
   * Starts one build and registers it as this target's in-flight preparation.
   *
   * Registered synchronously, before the first await, so two submissions that
   * arrive in the same tick cannot both start one.
   */
  private startPreparation(plan: ResolvedLocalTaskPlan): TargetPreparation {
    const preparation: TargetPreparation = {
      target: plan.id,
      startedAt: this.now(),
      reference: `matts-framework-task-${plan.id}:prepare-${randomUUID().slice(0, 8)}`,
      controller: new AbortController(),
      holders: new Set(),
      image: Promise.resolve(""),
      built: false,
      released: false,
    };
    preparation.image = this.buildImage(plan, preparation)
      .then((reference) => {
        preparation.built = true;
        return reference;
      })
      .finally(() => {
        if (this.preparations.get(plan.id) === preparation) {
          this.preparations.delete(plan.id);
        }
      });
    preparation.image.catch(() => undefined);
    this.preparations.set(plan.id, preparation);
    return preparation;
  }

  /** Drops one run's hold, and the image reference when the last one lets go. */
  private async releaseHold(
    preparation: TargetPreparation,
    runId: string,
  ): Promise<void> {
    if (!preparation.holders.delete(runId)) return;
    if (preparation.holders.size > 0) return;
    if (!preparation.built) {
      // Every run waiting on this build has gone. Nothing will launch it.
      preparation.controller.abort(
        new Error("Every run waiting on this build was stopped."),
      );
      return;
    }
    await this.releaseReference(preparation);
  }

  /**
   * Removes the tag this build minted.
   *
   * Only the tag: a container created from it holds the image itself, which is
   * why the removal is unforced — it refuses while anything still uses it.
   */
  private async releaseReference(preparation: TargetPreparation): Promise<void> {
    if (preparation.released || !preparation.built) return;
    preparation.released = true;
    await this.options
      .docker("image", "rm", preparation.reference)
      .catch(() => undefined);
  }

  private async releaseAbandonedReferences(): Promise<void> {
    const listed = await this.options
      .docker(
        "image",
        "ls",
        "--filter",
        "reference=matts-framework-task-*:prepare-*",
        // Scoped to this project, like the container sweep: two checkouts on
        // one machine build the same target names and must not untag each
        // other's images.
        "--filter",
        `label=${TASK_LABEL_PROJECT}=${this.options.projectName}`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      )
      .catch(() => "");
    const references = listed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (references.length === 0) return;
    await this.options.docker("image", "rm", ...references).catch(() => undefined);
  }

  private async launchContainer(
    record: TaskRunRecord,
    launch: NonNullable<TaskRunRecord["launch"]>,
    image: string,
  ): Promise<void> {
    const { plan, input, environment } = launch;
    const containerName = `matts-task-${plan.id}-${randomUUID().slice(0, 8)}`;
    const args = [
      "run",
      "--detach",
      "--name",
      containerName,
      "--network",
      await this.options.network(),
      "--label",
      `${TASK_LABEL_KIND}=task`,
      "--label",
      `${TASK_LABEL_PROJECT}=${this.options.projectName}`,
      "--label",
      `${TASK_LABEL_TARGET}=${plan.id}`,
      "--label",
      `${TASK_LABEL_RUN}=${record.run.runId}`,
      "--platform",
      dockerPlatform(plan),
      // The same sizing the task definition declares. This does not promise
      // Fargate's scheduling or performance - it stops a local run from being
      // shaped nothing like the deployed one.
      "--cpus",
      (plan.cpu / 1024).toFixed(3),
      "--memory",
      `${plan.memoryMiB}m`,
    ];
    // Only declared values and the framework-owned input reach the container.
    // The runner's own environment is deliberately not copied in: it holds this
    // machine's configuration, not the task's.
    const injected = containerEnvironment(environment);
    if (input !== "") injected.FRAMEWORK_TASK_INPUT = input;
    for (const name of Object.keys(injected)) args.push("--env", name);
    if (this.options.awsConfigSource && plan.resources.includes("awsCredentials")) {
      args.push("--mount", `type=bind,source=${this.options.awsConfigSource},target=/root/.aws,readonly`);
    }
    // The tag this run's own build minted, and never the shared per-target tag:
    // that one moves whenever anything rebuilds, and the image it named a
    // moment ago stops resolving.
    args.push(image);

    if (this.stopped(record)) {
      this.finish(record, "stopped");
      return;
    }
    const launching = this.now();
    await this.withLaunchSlot(async () => {
      if (this.stopped(record)) return;
      await (this.options.runContainer ?? dockerWithEnvironment)(args, injected);
      if (this.stopped(record)) {
        // Created during the stop: it exists, so it is this supervisor's to remove.
        await this.options.docker("rm", "--force", containerName).catch(() => undefined);
        return;
      }
      record.run.containerName = containerName;
    });
    if (!record.run.containerName) {
      this.finish(record, "stopped");
      return;
    }

    record.run.startedAt = this.stamp();
    record.run.status = "running";
    this.watch(record, seconds(this.now() - launching));
  }

  /** Bounds how many containers are being created at once. */
  private async withLaunchSlot<Result>(work: () => Promise<Result>): Promise<Result> {
    if (this.launching >= LAUNCH_CONCURRENCY) {
      await new Promise<void>((resolve) => this.launchQueue.push(resolve));
    }
    this.launching += 1;
    try {
      return await work();
    } finally {
      this.launching -= 1;
      this.launchQueue.shift()?.();
    }
  }

  /**
   * Asks BuildKit for the image and returns the tag it wrote.
   *
   * There is no second cache here, on purpose. A handcrafted file hash has to
   * enumerate the build context to be correct, and this context is the whole
   * repository root; the one this replaced missed root configuration, other
   * workspace manifests and the ignore rules, so an edit could still run
   * yesterday's build. Docker already knows what the Dockerfile reads, and
   * reuses unchanged layers, so this is a cache check rather than a rebuild.
   *
   * Two tags, for two different readers. The stable one is for a developer
   * running `docker image ls`; it moves with every build, so nothing is ever
   * launched from it. The `prepare-` one belongs to this build alone and is
   * what runs, then is dropped once every run holding it has its container.
   *
   * `--provenance=false` keeps the image deterministic for identical input.
   * With attestations on, two builds of the same source produce two different
   * images, which is how one of them can be deleted while the other is launching.
   */
  private async buildImage(
    plan: ResolvedLocalTaskPlan,
    preparation: TargetPreparation,
  ): Promise<string> {
    const args = [
      "build",
      "--platform",
      dockerPlatform(plan),
      "--provenance=false",
      "--file",
      `${this.options.repositoryRoot}/${plan.dockerfile}`,
      "--tag",
      `matts-framework-task-${plan.id}:${architecture(plan)}`,
      "--tag",
      preparation.reference,
      "--label",
      `${TASK_LABEL_KIND}=task`,
      "--label",
      `${TASK_LABEL_PROJECT}=${this.options.projectName}`,
    ];
    if (plan.buildTarget) args.push("--target", plan.buildTarget);
    // The repository root, as ECS builds it: the Dockerfile installs from the
    // root lockfile so npm workspaces can resolve `@repo/*`.
    args.push(this.options.repositoryRoot);

    await this.runBuild(args, preparation.controller.signal);
    return preparation.reference;
  }

  /**
   * Runs the build, and stops waiting for it the moment it is cancelled.
   *
   * The builder is given the signal and is expected to honour it. This does not
   * assume it does: a stop has to settle the run either way, and a build that
   * answers late — with a failure, even — must not become an unhandled
   * rejection or hold a stopped run open forever.
   */
  private async runBuild(args: readonly string[], signal: AbortSignal): Promise<void> {
    const build = this.options.buildImage
      ? this.options.buildImage(args, signal)
      : this.options.docker(...args);
    build.catch(() => undefined);
    await this.raceAbort(build, signal);
  }

  /** Resolves with the work, or rejects as soon as the signal aborts. */
  private async raceAbort<Result>(
    work: Promise<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      onAbort = (): void => reject(signal.reason as Error);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    cancelled.catch(() => undefined);
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private register(run: TaskRun, launch?: TaskRunRecord["launch"]): TaskRunRecord {
    let settle: (value: TaskRun) => void = () => undefined;
    const completion = new Promise<TaskRun>((resolve) => {
      settle = resolve;
    });
    const record: TaskRunRecord = {
      run,
      acceptedAt: this.now(),
      completion,
      settle,
      ...(launch ? { launch } : {}),
      preparation: new AbortController(),
      stopRequested: false,
      waiting: 0,
      settled: false,
    };
    this.records.set(run.runId, record);
    this.prune();
    if (launch) console.log(`[${this.prefix(run)}] preparing image`);
    return record;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private nextDisplayId(): string {
    this.displayCounter += 1;
    return `#${this.displayCounter}`;
  }

  private prefix(run: TaskRun): string {
    return `${run.target} ${run.displayId}`;
  }

  private stopped(record: TaskRunRecord): boolean {
    return record.stopRequested || this.closing;
  }

  /** Records the terminal status once, and releases everyone waiting on it. */
  private finish(record: TaskRunRecord, status: TaskRunStatus): void {
    if (record.settled) return;
    record.settled = true;
    record.run.status = status;
    record.run.stoppedAt ??= this.stamp();
    record.settle(record.run);
    this.prune();
  }

  private diagnostics(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.length > DIAGNOSTIC_LIMIT ? text.slice(-DIAGNOSTIC_LIMIT) : text;
  }

  private watch(record: TaskRunRecord, launchDuration?: string): void {
    const run = record.run;
    const containerName = run.containerName as string;
    const prefix = this.prefix(run);
    console.log(`[${prefix}] running${launchDuration ? ` (launched in ${launchDuration})` : ""}`);
    const stopLogs = this.options.followLogs?.(containerName, prefix);
    const waiter = (async () => {
      let status: TaskRunStatus = "failed";
      let exitCode: number | undefined;
      let failure: string | undefined;
      try {
        const code = await this.options.docker("wait", containerName);
        const parsed = Number.parseInt(code.trim().split(/\s+/).pop() ?? "", 10);
        exitCode = Number.isFinite(parsed) ? parsed : undefined;
        status = exitCode === 0 ? "succeeded" : "failed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (record.stopRequested) status = "stopped";

      // Everything is recorded *before* the status becomes terminal. A caller
      // that polls until "succeeded" and then asks for logs would otherwise
      // race the container's removal and be told the run produced nothing —
      // which is exactly what "the result is recorded before the container is
      // removed" is supposed to rule out.
      const logs = await this.readLogs(containerName);
      await stopLogs?.();
      await this.remove(run);
      run.exitCode = exitCode;
      run.logs = logs;
      if (failure) run.error = failure;
      run.stoppedAt = this.stamp();
      console.log(`[${prefix}] ${status} (exit ${exitCode ?? "unknown"})`);
      this.finish(record, status);
    })();
    this.pending.add(waiter);
    void waiter.finally(() => this.pending.delete(waiter)).catch(() => undefined);
  }

  private async readLogs(containerName: string): Promise<string> {
    return this.options
      .docker("logs", "--tail", LOG_TAIL_LINES, containerName)
      .catch(() => "");
  }

  private async capture(run: TaskRun): Promise<void> {
    if (!run.containerName) return;
    run.logs = await this.readLogs(run.containerName);
  }

  private async remove(run: TaskRun): Promise<void> {
    if (!run.containerName) return;
    await this.options
      .docker("rm", "--force", run.containerName)
      .catch(() => undefined);
  }

  /**
   * Keeps the journal bounded.
   *
   * Terminal runs are dropped oldest first, and only once nobody is waiting on
   * them: a workflow still awaiting its own task must not lose the result
   * because a hundred other tasks finished in the meantime.
   */
  private prune(): void {
    if (this.records.size <= RUN_HISTORY_LIMIT) return;
    for (const [runId, record] of this.records) {
      if (this.records.size <= RUN_HISTORY_LIMIT) break;
      if (!record.settled || record.waiting > 0) continue;
      this.records.delete(runId);
    }
  }
}
