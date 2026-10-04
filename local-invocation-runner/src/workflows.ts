import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveLambdaTarget,
  resolveWorkflow,
  isTargetEnabled,
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
  type FrameworkConfig,
  type NormalizedWorkflow,
} from "@repo/framework/config";
import { resolveLambdaSourcePath } from "@repo/framework/config/source";
import {
  invokeAgentStep,
  LocalCallbackBroker,
  newExecution,
  runWorkflow,
  stepInvocationEnvironment,
  resolveLocalWorkloadEnvironment,
  type LocalAgentInvoker,
  type WorkflowExecution,
  type WorkflowStepRunner,
} from "@repo/framework/local";
import { forwardLines } from "./docker";

/**
 * The local workflow engine, hosted by the private runner.
 *
 * It executes the *same authored graph* the ASL compiler lowers, through the
 * shared interpreter, so the two lanes cannot disagree about what a graph
 * means. It needs no local AWS Step Functions service and makes no AWS call.
 *
 * Start, status and stop live here rather than on the application's HTTP API.
 * Adding `POST /workflows/:id/start` there would bypass the declared route
 * inventory and could collide with an authored mount — the API serves what the
 * config says it serves, and nothing else.
 *
 * Execution history is bounded and in memory. Restarting this process discards
 * that history. Shutdown cancels active executions; there is no durable journal,
 * recovery or redrive.
 */

const EXECUTION_JOURNAL_LIMIT = 200;

/**
 * What the engine needs from the task lane.
 *
 * An interface rather than the supervisor class, so a workflow test can drive
 * the engine without Docker. `LocalTaskSupervisor` satisfies it as it stands;
 * the narrowing is what the engine actually depends on, written down.
 */
export interface WorkflowTaskLane {
  readonly submit: (
    id: string,
    input: unknown,
    options?: { readonly callback?: string },
  ) => { readonly runId: string };
  readonly wait: (
    runId: string,
    signal?: AbortSignal,
  ) => Promise<{ readonly runId: string; readonly exitCode?: number | undefined }>;
  readonly stop: (runId: string) => Promise<unknown>;
}

export interface LocalWorkflowEngineOptions {
  readonly config: FrameworkConfig;
  readonly repositoryRoot: string;
  readonly runnerUrl: string;
  readonly tasks: WorkflowTaskLane;
  /**
   * Runs a container-packaged Lambda step.
   *
   * The runner already owns image preparation, the runtime-emulator handshake
   * and container cleanup for `POST /invoke`; a workflow step reuses that
   * rather than growing a second copy. Absent means this engine has no
   * container lane, and a container step is refused with a reason instead of
   * being approximated by the Node child process.
   */
  readonly invokeContainerLambda?: (
    id: string,
    event: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /**
   * Performs one managed-service operation against the bound AWS resource.
   *
   * Development orchestration runs here; DynamoDB, SQS, SNS and EventBridge
   * stay in AWS. Absent means this runner has no service lane, and a graph with
   * an integration step is refused when it starts rather than part-way through.
   */
  readonly callIntegration?: WorkflowStepRunner["callIntegration"];
  /**
   * The runner's agent supervisor, for `invokeAgent` steps. Absent means this
   * engine has no agent lane, and a graph that invokes one is refused when it
   * starts.
   */
  readonly agents?: LocalAgentInvoker;
}

/**
 * One step failure, as an error a declared clause can name.
 *
 * A handler that throws `ThrottledError` produces the error name
 * `ThrottledError` in AWS, and a retry clause written against it matches. The
 * child process reports the name across the IPC boundary and it is rebuilt
 * here — flattening everything to a generic `Error` was what made
 * `on: ["ThrottledError"]` a clause that worked in the cloud and never matched
 * locally.
 */
export function stepFailure(
  fallbackTarget: string,
  error: { readonly name?: string; readonly message?: string } | undefined,
): WorkflowStateError {
  const message = error?.message ?? `${fallbackTarget} failed.`;
  const name = error?.name;
  if (name === undefined || name === "" || name === "Error") {
    return new WorkflowStateError(WORKFLOW_ERROR_NAMES.taskFailed, message);
  }
  return new WorkflowStateError(name, message);
}

/** The one duration format the runner logs use, shared with the task lane. */
function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export class LocalWorkflowEngine {
  /**
   * The suspended steps this process is holding.
   *
   * In memory and in this process only. A restart invalidates every pending
   * callback, which is why the broker says so rather than letting a stale
   * message retry forever.
   */
  public readonly callbacks = new LocalCallbackBroker();
  private closing = false;
  private displayCounter = 0;
  private readonly children = new Set<ChildProcess>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly executions = new Map<string, WorkflowExecution>();
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly options: LocalWorkflowEngineOptions) {}

  /** Accepts a submission and returns as soon as the execution is created. */
  public start(id: string, input: unknown): WorkflowExecution {
    if (this.closing) throw new Error("Local runner is shutting down.");
    if (!isTargetEnabled(this.options.config, "workflow", id, "local")) {
      throw new Error(
        `workflow:${id} is not enabled for local execution. Declare it under workflows with a deploy setting that includes "local".`,
      );
    }
    const workflow = resolveWorkflow(this.options.config, id);
    this.assertSupportedSteps(workflow);

    const execution = newExecution(id, this.nextDisplayId());
    const prefix = this.prefix(execution);
    const controller = new AbortController();
    this.executions.set(execution.executionId, execution);
    this.controllers.set(execution.executionId, controller);
    this.prune();

    // Deliberately not awaited: `startWorkflow` resolves after acceptance and
    // never holds a request open for the lifetime of the graph.
    const started = Date.now();
    const pending = runWorkflow(workflow, execution, {
      input,
      runner: this.stepRunner(execution),
      // `detail` is a destination on the ordinary transitions and a reason on
      // the two that need explaining, so only those two print it: a log that
      // appended the next state's name to every line would read as noise.
      onEvent: event =>
        console.log(
          `[${prefix}] ${event.state} ${event.type}` +
            (event.detail && (event.type === "retrying" || event.type === "failed")
              ? `: ${event.detail}`
              : ""),
        ),
      signal: controller.signal,
    })
      .catch((error: unknown) => {
        execution.status = "failed";
        execution.error = {
          name: "States.Runtime",
          cause: error instanceof Error ? error.message : String(error),
        };
        execution.stoppedAt = new Date().toISOString();
      })
      .finally(() => {
        this.controllers.delete(execution.executionId);
        this.pending.delete(pending);
        console.log(
          `[${prefix}] ${execution.status} in ${seconds(Date.now() - started)}`,
        );
      });
    this.pending.add(pending);

    return execution;
  }

  public get(executionId: string): WorkflowExecution | undefined {
    return this.executions.get(executionId);
  }

  public list(): readonly WorkflowExecution[] {
    return [...this.executions.values()];
  }

  /**
   * Stops orchestration.
   *
   * Future transitions stop and late results are ignored. It does not cancel an
   * in-flight Lambda's side effects, and a tracked container is asked to stop -
   * which is best effort, and can leave work running. A task the workflow's own
   * task launched independently is outside this entirely.
   */
  public async stop(executionId: string): Promise<WorkflowExecution> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Unknown execution "${executionId}".`);
    this.controllers
      .get(executionId)
      ?.abort(new Error("The execution was stopped by an operator."));
    return execution;
  }

  /**
   * Which steps this runner can actually execute.
   *
   * Node zip handlers run in an isolated child process; container-packaged
   * handlers run through the same image machinery `POST /invoke` uses. A zip
   * handler on a runtime this process cannot host — Python, today — is refused
   * with a reason rather than approximated, because an approximation is exactly
   * the kind of local-only behavior this design exists to avoid.
   */
  private assertSupportedSteps(workflow: NormalizedWorkflow): void {
    if (workflow.integrations.length > 0 && this.options.callIntegration === undefined) {
      throw new Error(
        `workflow:${workflow.id} talks to ${workflow.integrations.map((use) => `${use.reference.kind}:${use.reference.id}`).join(", ")}, and this runner has no managed-service lane.`,
      );
    }
    for (const target of workflow.targets) {
      if (target.startsWith("agent:")) {
        const agent = target.slice("agent:".length);
        if (this.options.agents === undefined) {
          throw new Error(`workflow:${workflow.id} invokes ${target}, and this runner has no agent lane.`);
        }
        if (!isTargetEnabled(this.options.config, "agent", agent, "local")) {
          throw new Error(
            `workflow:${workflow.id} invokes ${target}, which is not enabled for local execution. Declare it under agents with a deploy setting that includes "local".`,
          );
        }
        continue;
      }
      if (target.startsWith("workflow:")) {
        const child = target.slice("workflow:".length);
        if (!isTargetEnabled(this.options.config, "workflow", child, "local")) {
          throw new Error(
            `workflow:${workflow.id} runs ${target}, which is not enabled for local execution. Declare it under workflows with a deploy setting that includes "local".`,
          );
        }
        // The child's own steps have to be runnable here too, and a cycle would
        // make this recurse forever. Config validation has already refused one,
        // so this walks a finite graph.
        this.assertSupportedSteps(resolveWorkflow(this.options.config, child));
        continue;
      }
      if (!target.startsWith("lambda:")) continue;
      const id = target.slice("lambda:".length);
      const spec = resolveLambdaTarget(this.options.config, id);
      if (spec.packaging === "container") {
        if (this.options.invokeContainerLambda === undefined) {
          throw new Error(
            `workflow:${workflow.id} invokes ${target}, which is packaged as a container, and this runner has no container lane.`,
          );
        }
        continue;
      }
      if (!spec.runtime.startsWith("nodejs")) {
        throw new Error(
          `workflow:${workflow.id} invokes ${target}, which runs on ${spec.runtime}. Local workflow execution runs Node zip handlers in a child process and container handlers as images; a ${spec.runtime} zip handler has no local lane.`,
        );
      }
    }
  }

  private stepRunner(execution: WorkflowExecution): WorkflowStepRunner {
    return {
      invokeLambda: (id, input, options) =>
        this.invokeLambdaStep(id, input, options, this.prefix(execution)),
      runTask: (id, input, options) => this.runTaskStep(id, input, options),
      runWorkflow: (id, input, options) =>
        this.runWorkflowStep(id, input, options, execution),
      ...(this.options.callIntegration
        ? { callIntegration: this.options.callIntegration }
        : {}),
      ...(this.options.agents
        ? {
            invokeAgent: (id: string, request: { readonly conversationId: string; readonly input: unknown }, options: { readonly signal: AbortSignal }) =>
              invokeAgentStep(this.options.agents!, id, request, options.signal),
          }
        : {}),
      awaitCallback: (request, options) => this.callbacks.await(request, options),
      startTaskWithCallback: (id, input, callback, options) =>
        this.startCallbackTask(id, input, callback, options),
    };
  }

  /**
   * Launches a container that will report its own result.
   *
   * The launch is awaited, the *result* is not: the step ends when the
   * container calls `completeCallback`, which is a different event from the
   * process exiting. A step that runs out of time stops the container, because
   * waiting is not owning and a container left running after its state ended is
   * the local lane quietly disagreeing with the cloud one.
   */
  private async startCallbackTask(
    id: string,
    input: unknown,
    callback: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<void> {
    if (options.signal.aborted) throw options.signal.reason as Error;
    const run = this.options.tasks.submit(id, input, {
      callback: JSON.stringify(callback),
    });
    options.signal.addEventListener(
      "abort",
      () => {
        void this.options.tasks.stop(run.runId).catch(() => undefined);
      },
      { once: true },
    );
    // A container that exits without reporting leaves the step waiting for an
    // answer that is never coming, so the exit is watched and turned into a
    // failure. The callback still wins if it arrives first.
    void this.options.tasks
      .wait(run.runId)
      .then((finished) => {
        try {
          this.callbacks.fail(
            (callback as { token: string }).token,
            {
              error: WORKFLOW_ERROR_NAMES.taskFailed,
              cause: `task:${id} exited ${finished.exitCode ?? "without a code"} without completing its callback (run ${run.runId}).`,
            },
          );
        } catch {
          // Already completed, which is the ordinary case: the container
          // reported and then shut down.
        }
      })
      .catch(() => undefined);
  }

  /**
   * One child workflow, run to completion in this process.
   *
   * Recursion rather than a second transport: the child is the same kind of
   * graph, interpreted by the same interpreter, and giving it its own execution
   * record is what makes it visible in `GET /workflows` like any other.
   *
   * The parent waits, because `runWorkflow` means "and wait for its result" —
   * the child's business output, not the execution description AWS answers with.
   */
  private async runWorkflowStep(
    id: string,
    input: unknown,
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
    parent: WorkflowExecution,
  ): Promise<unknown> {
    if (options.signal.aborted) throw options.signal.reason as Error;

    const workflow = resolveWorkflow(this.options.config, id);
    const child = newExecution(id, this.nextDisplayId());
    const prefix = this.prefix(child);
    this.executions.set(child.executionId, child);
    this.prune();

    console.log(`[${this.prefix(parent)}] runs ${prefix}`);
    const finished = await runWorkflow(workflow, child, {
      input,
      runner: this.stepRunner(child),
      signal: options.signal,
      onEvent: event =>
        console.log(
          `[${prefix}] ${event.state} ${event.type}` +
            (event.detail && (event.type === "retrying" || event.type === "failed")
              ? `: ${event.detail}`
              : ""),
        ),
    });

    if (finished.status !== "succeeded") {
      throw new WorkflowStateError(
        finished.error?.name ?? WORKFLOW_ERROR_NAMES.taskFailed,
        finished.error?.cause ?? `workflow:${id} ended ${finished.status}.`,
      );
    }
    return finished.output;
  }

  private nextDisplayId(): string {
    this.displayCounter += 1;
    return `#${this.displayCounter}`;
  }

  /**
   * What every line this execution emits is labelled with.
   *
   * Deliberately the shape the task lane uses — `invocation-test-task #11` —
   * because the two interleave in one Compose terminal, and a reader scanning
   * that stream should not have to learn a second format. A task step's own
   * lines keep the task's prefix: the container is its own thing, and the
   * graph's line for that state says so either side of it.
   */
  private prefix(execution: WorkflowExecution): string {
    return `${execution.workflowId} ${execution.displayId}`;
  }

  /**
   * One task step, owned for as long as the state that launched it.
   *
   * Three things this has to do that abandoning the wait does not. An already
   * aborted step launches nothing at all. A state timeout *stops the task* —
   * waiting is not owning, and a container left running after its state ended
   * is the local lane quietly disagreeing with the cloud one. And the timeout
   * covers preparation: a task still being built when the deadline passes is
   * late in exactly the way a task still running is.
   *
   * Best effort, and only for this workflow's own task. A task somebody
   * submitted independently is outside this entirely.
   */
  private async runTaskStep(
    id: string,
    input: unknown,
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
  ): Promise<{ readonly runId: string; readonly exitCode: number }> {
    if (options.signal.aborted) throw options.signal.reason as Error;
    const run = this.options.tasks.submit(id, input);
    const stopTask = (): void => {
      void this.options.tasks.stop(run.runId).catch(() => undefined);
    };
    let timedOut = false;
    const onAbort = (): void => stopTask();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stopTask();
          }, options.timeoutSeconds * 1000);

    try {
      const finished = await this.options.tasks.wait(run.runId, options.signal);
      if (timedOut) {
        // The framework's own timeout error, so a declared retry or catch
        // clause matches it exactly as it would in AWS.
        throw new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.timeout,
          `task:${id} exceeded the state's ${options.timeoutSeconds}-second timeout (run ${run.runId}).`,
        );
      }
      return { runId: finished.runId, exitCode: finished.exitCode ?? 1 };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * One Lambda step, in an isolated child process.
   *
   * Its environment is its own: the dev server's variables minus the invocation
   * namespace, plus exactly this handler's descriptors. A step that itself
   * declares `runsTask` gets that binding and nobody else's.
   *
   * The handler's own timeout still bounds it, separately from the state's — a
   * state timeout stops orchestration, it does not reach into a running process.
   */
  private async invokeLambdaStep(
    id: string,
    input: unknown,
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
    executionPrefix: string,
  ): Promise<unknown> {
    const spec = resolveLambdaTarget(this.options.config, id);
    if (spec.packaging === "container") {
      const invoke = this.options.invokeContainerLambda;
      if (invoke === undefined) {
        return Promise.reject(
          new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.runtime,
            `lambda:${id} is packaged as a container and this runner has no container lane.`,
          ),
        );
      }
      // An image handler's environment is its container's, so there is no
      // scoped descriptor map to build here: the image lane supplies what that
      // handler receives.
      return invoke(id, input, options.signal).catch((error: unknown) => {
        throw stepFailure(
          `lambda:${id}`,
          error instanceof Error ? error : { message: String(error) },
        );
      });
    }
    const directory = resolveLambdaSourcePath(this.options.config, id, {
      repositoryRoot: this.options.repositoryRoot,
    });
    const entry = pathToFileURL(path.join(directory, "index.ts")).href;
    const handler = spec.packaging === "zip" ? spec.handler : "lambdaHandler";

    const environment = await resolveLocalWorkloadEnvironment(this.options.config, `lambda:${id}`, { repositoryRoot: this.options.repositoryRoot, runnerUrl: this.options.runnerUrl });

    if (options.signal.aborted) return Promise.reject(options.signal.reason);
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join(__dirname, "lambda-child.ts")],
        { cwd: this.options.repositoryRoot, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );

      child.send({ entry, handler, event: input });
      this.children.add(child);
      const prefix = `${executionPrefix} lambda:${id}`;
      forwardLines(child.stdout!, prefix);
      forwardLines(child.stderr!, prefix);
      let response:
        | { ok?: boolean; result?: unknown; error?: { name?: string; message?: string } }
        | undefined;
      child.on("message", message => { response = message as typeof response; });

      const timeout = setTimeout(
        () => {
          child.kill("SIGKILL");
          // The handler's own timeout, named the way AWS names it, so a clause
          // written `on: "timeout"` matches it here as well.
          reject(
            new WorkflowStateError(
              WORKFLOW_ERROR_NAMES.timeout,
              `lambda:${id} exceeded its ${spec.timeoutSeconds}-second timeout.`,
            ),
          );
        },
        spec.timeoutSeconds * 1000,
      );
      const onAbort = (): void => {
        child.kill("SIGKILL");
        reject(options.signal.reason as Error);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      child.once("error", (error) => {
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", onAbort);
        this.children.delete(child);
        if (!response) {
          reject(
            new WorkflowStateError(
              WORKFLOW_ERROR_NAMES.taskFailed,
              `lambda:${id} exited without an IPC result.`,
            ),
          );
          return;
        }
        if (response.ok) {
          resolve(response.result);
          return;
        }
        // A handler that threw fails the state, exactly as the payload-only
        // Lambda integration does in AWS — and under the error's own name, so
        // a retry or catch clause that names it matches.
        reject(stepFailure(`lambda:${id}`, response.error));
      });
    });
  }

  public async shutdown(): Promise<void> {
    this.closing = true;
    this.callbacks.shutdown();
    for (const controller of this.controllers.values()) controller.abort(new Error("Local runner is shutting down."));
    for (const child of this.children) child.kill("SIGKILL");
    await Promise.allSettled([...this.pending]);
  }

  /** Keeps the journal bounded; terminal executions are dropped oldest-first. */
  private prune(): void {
    if (this.executions.size <= EXECUTION_JOURNAL_LIMIT) return;
    for (const [id, execution] of this.executions) {
      if (this.executions.size <= EXECUTION_JOURNAL_LIMIT) break;
      if (execution.status === "running") continue;
      this.executions.delete(id);
    }
  }
}
