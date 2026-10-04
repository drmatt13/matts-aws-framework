import { createHash, randomUUID } from "node:crypto";
import {
  assertPayloadWithinLimit,
  assertTaskInputIsDocument,
  errorMatches,
  evaluateCondition,
  resolvePayload,
  resolveTermOrFail,
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
  WORKFLOW_HISTORY_EVENT_LIMIT,
  type IntegrationSpec,
  type NormalizedWorkflow,
  type Resolution,
  type WorkflowErrorSelector,
  type WorkflowNode,
  type WorkflowNodeId,
  type WorkflowTerm,
  type WorkflowRetryPolicy,
  type WorkflowValues,
} from "@repo/framework/config";

/**
 * The local execution lane for a workflow graph.
 *
 * A projection of the same graph the ASL compiler lowers, reading the same
 * semantics module for reference resolution and condition evaluation. It walks
 * the framework's own representation directly — it never compiles to ASL and
 * then interprets that, because a second ASL implementation is exactly the thing
 * most likely to disagree with the first.
 *
 * It is not a reimplementation of Step Functions: the fidelity promise is the
 * supported step, data and error semantics, and explicitly *not* the managed
 * service's durability. Crash recovery, redrive and matching availability are
 * unsupported, and this says so rather than pretending.
 *
 * Real seconds by default — for `wait`, for retry intervals and for deadlines.
 * The clock is injectable so a test containing `wait({ seconds: 600 })` need not
 * take ten minutes, but a `docker compose up` presented as parity with
 * production waits for real.
 *
 * ## Deadlines
 *
 * Both deadlines bound *pending work*, not just the moment a state is entered.
 * Checking only on entry was the earlier behavior, and it let a one-second
 * execution finish comfortably after a second: the last step was already
 * running when the budget ran out, and nothing looked again. Each awaited
 * operation now races the execution deadline and the step's own timeout, and a
 * deadline that fires cancels the work it was waiting on.
 */

export type WorkflowExecutionStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timedOut"
  | "aborted";

export interface WorkflowHistoryEvent {
  readonly at: string;
  readonly state: string;
  readonly type: "entered" | "exited" | "retrying" | "caught" | "failed" | "succeeded";
  readonly detail?: string;
  /** Nesting, so a parallel branch or a map iteration reads as one. */
  readonly depth?: number;
}

export interface WorkflowExecution {
  readonly executionId: string;
  readonly displayId: string;
  readonly workflowId: string;
  readonly startedAt: string;
  status: WorkflowExecutionStatus;
  stoppedAt?: string;
  output?: unknown;
  error?: { readonly name: string; readonly cause: string };
  readonly history: WorkflowHistoryEvent[];
}

/** How the interpreter runs one step. Supplied so transports stay swappable. */
export interface WorkflowStepRunner {
  readonly invokeLambda: (
    id: string,
    input: unknown,
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
  ) => Promise<unknown>;
  readonly runTask: (
    id: string,
    input: unknown,
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
  ) => Promise<{ readonly runId: string; readonly exitCode: number }>;
  /**
   * Invokes an agent and returns its `result`.
   *
   * `conversationId` is derived from the execution and the step's session, as
   * the cloud lane derives it. An
   * agent that answers with an error status is reported as
   * `BedrockAgentCore.RuntimeClientErrorException`, the name Step Functions
   * gives the same failure. Absent means this runner has no agent lane.
   */
  readonly invokeAgent?: (
    id: string,
    request: { readonly conversationId: string; readonly input: unknown },
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
  ) => Promise<unknown>;
  /** Runs a child workflow to completion. Absent until nested workflows land. */
  readonly runWorkflow?: (
    id: string,
    input: unknown,
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
  ) => Promise<unknown>;
  /**
   * Performs one managed-service operation against the bound resource.
   *
   * Absent means this runner has no service lane, and a graph with an
   * integration step is refused rather than run with part of it missing.
   */
  readonly callIntegration?: (
    request: {
      readonly reference: IntegrationSpec;
      readonly operation: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
    options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal },
  ) => Promise<unknown>;
  /**
   * Suspends the step until a worker reports, and dispatches the work.
   *
   * The runner registers the callback *first* and then calls `dispatch` with
   * the handle to send, which is what makes a worker fast enough to answer
   * before the sender's next line still find something to answer to.
   *
   * Absent means this runner cannot suspend a step, and a graph containing a
   * callback is refused rather than run with the waiting part missing.
   */
  readonly awaitCallback?: (
    request: {
      /** The step of the execution that is waiting; a retry reuses it. */
      readonly stepKey: string;
      readonly state: string;
      readonly timeoutSeconds: number;
      readonly heartbeatSeconds?: number | undefined;
      readonly dispatch: (handle: unknown) => Promise<void>;
    },
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
  /**
   * Launches a container task in callback mode, without waiting for it.
   *
   * The step ends when the container *reports*, which is a different event
   * from the process exiting — so this returns once the launch is accepted and
   * the callback decides the rest.
   */
  readonly startTaskWithCallback?: (
    id: string,
    input: unknown,
    callback: unknown,
    options: { readonly signal: AbortSignal },
  ) => Promise<void>;
}

export interface WorkflowRunOptions {
  readonly input: unknown;
  readonly runner: WorkflowStepRunner;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly onEvent?: (event: WorkflowHistoryEvent) => void;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asStateError(error: unknown): WorkflowStateError {
  if (error instanceof WorkflowStateError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Everything an integration raises that is not already an ASL error is a task
  // failure, which is the error name a catch clause is written against.
  return new WorkflowStateError(WORKFLOW_ERROR_NAMES.taskFailed, message);
}

/**
 * A branch that ended successfully on purpose.
 *
 * Thrown rather than returned because `succeed()` terminates whatever contains
 * it — the execution at the top level, or one branch of a parallel or one map
 * iteration — and the states between it and that boundary must not run.
 */
class SucceededSignal {
  public constructor(public readonly output: unknown) {}
}

/**
 * The value a step with no result carries.
 *
 * `null` rather than `undefined`, in both lanes. JSON has no undefined: a
 * skipped optional branch used to be `undefined` locally and `null` in the
 * compiled graph, so a `isNull` test or an equality against null answered
 * differently depending on where the workflow ran.
 */
const NO_RESULT = null;

// ---------------------------------------------------------------------------
// Scopes
//
// A branch or iteration reads what was computed before it and writes only where
// it can see. That is AWS's rule — values assigned inside a Parallel or Map do
// not survive it — and reproducing it here is what stops a graph that works
// locally from failing in production on the one branch nobody tested.
//
// A scope also owns a cancellation signal, so a failing branch stops its
// siblings the way a failing Parallel branch does in AWS, without reaching
// outward and stopping the whole execution.
// ---------------------------------------------------------------------------

interface Scope {
  readonly results: Map<WorkflowNodeId, unknown>;
  readonly bindings: Map<string, unknown>;
  readonly errors: Map<WorkflowNodeId, unknown>;
  readonly parent?: Scope;
  readonly controller: AbortController;
}

function linkedController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else {
    parent.addEventListener("abort", () => controller.abort(parent.reason), {
      once: true,
    });
  }
  return controller;
}

function lookup(
  scope: Scope | undefined,
  read: (scope: Scope) => { readonly has: boolean; readonly value: unknown },
): Resolution {
  for (let current = scope; current !== undefined; current = current.parent) {
    const { has, value } = read(current);
    if (has) return { found: true, value };
  }
  return { found: false, value: undefined };
}

function valuesFor(scope: Scope, input: unknown): WorkflowValues {
  return {
    input,
    node: (id) =>
      lookup(scope, (current) => ({
        has: current.results.has(id),
        value: current.results.get(id),
      })),
    mapBinding: (map, field) =>
      lookup(scope, (current) => ({
        has: current.bindings.has(`${map}:${field}`),
        value: current.bindings.get(`${map}:${field}`),
      })),
    error: (attempt) =>
      lookup(scope, (current) => ({
        has: current.errors.has(attempt),
        value: current.errors.get(attempt),
      })),
  };
}

/** The term a symbolic value carries. */
function referenceIn(value: unknown): WorkflowTerm | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const carried = (value as Record<symbol, unknown>)[
    Symbol.for("framework.workflow.reference")
  ];
  return carried === undefined ? undefined : (carried as WorkflowTerm);
}

// ---------------------------------------------------------------------------
// Error selection
// ---------------------------------------------------------------------------

function selectorErrors(selector: WorkflowErrorSelector | undefined): readonly string[] {
  if (selector === undefined || selector === "any") return [WORKFLOW_ERROR_NAMES.all];
  if (selector === "timeout") return [WORKFLOW_ERROR_NAMES.timeout];
  return selector;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Runs one graph to a terminal state.
 *
 * Bounded by the execution timeout and by the history budget, exactly as AWS
 * bounds them. Neither is a substitute for the other.
 */
export async function runWorkflow(
  workflow: NormalizedWorkflow,
  execution: WorkflowExecution,
  options: WorkflowRunOptions,
): Promise<WorkflowExecution> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + workflow.timeoutSeconds * 1000;

  const controller = new AbortController();
  const abortOuter = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortOuter, { once: true });

  /**
   * Whether the execution's own deadline is what ended it.
   *
   * Tracked rather than inferred from the error name, because a *step* timeout
   * raises the same `States.Timeout` and fails the execution instead of timing
   * it out — the distinction AWS draws between a FAILED and a TIMED_OUT
   * execution.
   */
  let executionTimedOut = false;

  const record = (event: WorkflowHistoryEvent): void => {
    execution.history.push(event);
    options.onEvent?.(event);
    if (execution.history.length > WORKFLOW_HISTORY_EVENT_LIMIT) {
      execution.history.splice(0, execution.history.length - WORKFLOW_HISTORY_EVENT_LIMIT);
    }
  };
  const stamp = (): string => new Date(now()).toISOString();

  const finish = (
    status: WorkflowExecutionStatus,
    detail?: { readonly output?: unknown; readonly error?: WorkflowStateError },
  ): WorkflowExecution => {
    options.signal?.removeEventListener("abort", abortOuter);
    // Stopping ignores late results; it does not reach into a Lambda that is
    // already running, and never claims to have undone its side effects.
    controller.abort(new Error(`Workflow execution ${status}.`));
    execution.status = status;
    execution.stoppedAt = stamp();
    if (detail?.output !== undefined) execution.output = detail.output;
    if (detail?.error) {
      execution.error = { name: detail.error.errorName, cause: detail.error.cause };
    }
    return execution;
  };

  const nameOf = (node: WorkflowNode): string =>
    workflow.names.get(node.id) ?? `${node.kind}_${node.id}`;

  const executionExpired = (where: string): WorkflowStateError =>
    new WorkflowStateError(
      WORKFLOW_ERROR_NAMES.timeout,
      `Execution exceeded its ${workflow.timeoutSeconds}-second timeout while ${where} was running.`,
    );

  /** The budget checks that bound every node, wherever it runs. */
  const checkBudget = (): void => {
    if (now() >= deadline) {
      executionTimedOut = true;
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.timeout,
        `Execution exceeded its ${workflow.timeoutSeconds}-second timeout.`,
      );
    }
    if (execution.history.length >= WORKFLOW_HISTORY_EVENT_LIMIT) {
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.runtime,
        `Execution exceeded the ${WORKFLOW_HISTORY_EVENT_LIMIT}-event history limit.`,
      );
    }
  };

  /**
   * One awaited operation, under both deadlines.
   *
   * The work is given a signal so a transport that can cancel does; one that
   * cannot simply has its late result discarded, which is the honest half of
   * the promise. The execution deadline aborts everything, because nothing
   * after it can run; a step timeout aborts only that step, so a surrounding
   * `attempt` or `retry` still gets its turn.
   */
  const bounded = <T>(
    where: string,
    scope: Scope,
    stepSeconds: number | undefined,
    start: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (scope.controller.signal.aborted) {
      return Promise.reject(scope.controller.signal.reason as Error);
    }
    const step = linkedController(scope.controller.signal);
    const timers: ReturnType<typeof setTimeout>[] = [];

    const running = new Promise<T>((resolve, reject) => {
      const expire = (
        milliseconds: number,
        failure: () => WorkflowStateError,
        cancelEverything: boolean,
      ): void => {
        if (!Number.isFinite(milliseconds)) return;
        const timer = setTimeout(
          () => {
            const error = failure();
            if (cancelEverything) {
              executionTimedOut = true;
              controller.abort(error);
            }
            step.abort(error);
            reject(error);
          },
          Math.max(0, milliseconds),
        );
        timer.unref?.();
        timers.push(timer);
      };

      expire(deadline - now(), () => executionExpired(where), true);
      if (stepSeconds !== undefined) {
        expire(
          stepSeconds * 1000,
          () =>
            new WorkflowStateError(
              WORKFLOW_ERROR_NAMES.timeout,
              `${where} exceeded its ${stepSeconds}-second timeout.`,
            ),
          false,
        );
      }

      start(step.signal).then(resolve, reject);
    });

    return running.finally(() => {
      for (const timer of timers) clearTimeout(timer);
    });
  };

  /** Evaluates one node and returns its result. */
  const evaluate = async (
    node: WorkflowNode,
    scope: Scope,
    depth: number,
  ): Promise<unknown> => {
    checkBudget();
    const name = nameOf(node);
    const values = valuesFor(scope, options.input);
    const enter = (): void =>
      record({ at: stamp(), state: name, type: "entered", depth });
    const exit = (detail?: string): void =>
      record({
        at: stamp(),
        state: name,
        type: "exited",
        depth,
        ...(detail === undefined ? {} : { detail }),
      });

    const store = (value: unknown): unknown => {
      assertPayloadWithinLimit(value, `Step "${name}"`);
      scope.results.set(node.id, value);
      return value;
    };

    switch (node.kind) {
      case "sequence": {
        let last: unknown = NO_RESULT;
        for (const step of node.steps) last = await evaluate(step, scope, depth);
        return store(last);
      }

      case "invocation": {
        enter();
        // An absent payload is `{}`, not "whatever the previous state left
        // behind". The compiled graph emits an empty `Arguments`, so this is
        // the same document in both lanes.
        const payload =
          node.payload === undefined
            ? {}
            : resolvePayload(node.payload, values, referenceIn, `Step "${name}"`);
        const result = await runInvocation(node, payload, name, scope);
        exit();
        return store(result);
      }

      case "integration": {
        enter();
        const call = options.runner.callIntegration;
        if (call === undefined) {
          throw new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.runtime,
            `${name} talks to ${node.reference.kind}:${node.reference.id}, which this runner has no lane for.`,
          );
        }
        const resolved = resolvePayload(
          node.arguments ?? {},
          values,
          referenceIn,
          `Step "${name}"`,
        ) as Record<string, unknown>;

        const result =
          node.completion === "callback"
            ? await suspend(node.id, name, scope, node.timeoutSeconds, node.heartbeatSeconds, (handle, signal) =>
                call(
                  {
                    reference: node.reference,
                    operation: node.operation,
                    // The worker receives `{ payload, callback }`: the
                    // application's message and the handle that answers it,
                    // kept separate so neither can be mistaken for the other.
                    arguments: { ...resolved, callback: handle },
                  },
                  { signal },
                ).then(() => undefined),
              )
            : await bounded(name, scope, node.timeoutSeconds, (signal) =>
                call(
                  {
                    reference: node.reference,
                    operation: node.operation,
                    arguments: resolved,
                  },
                  {
                    ...(node.timeoutSeconds === undefined
                      ? {}
                      : { timeoutSeconds: node.timeoutSeconds }),
                    signal,
                  },
                ),
              );
        exit();
        return store(result);
      }

      case "choice": {
        enter();
        const rule = node.rules.find((candidate) =>
          evaluateCondition(candidate.when, values),
        );
        const branch = rule?.then ?? node.otherwise;
        exit(nameOf(branch));
        return store(await evaluate(branch, scope, depth));
      }

      case "parallel": {
        enter();
        // Each branch gets its own scope: it can read what came before, and
        // nothing it computes survives the join except through the result.
        const children = node.branches.map(() => newScope(scope));
        const results = await Promise.all(
          node.branches.map(async (branch, index) => {
            const child = children[index] as Scope;
            try {
              return await evaluate(branch, child, depth + 1);
            } catch (error) {
              if (error instanceof SucceededSignal) return error.output;
              // A failing branch stops its siblings, as the Parallel state
              // does. They are not merely ignored: work that can be cancelled
              // is cancelled.
              const failure = asStateError(error);
              for (const [other, sibling] of children.entries()) {
                if (other !== index) sibling.controller.abort(failure);
              }
              throw failure;
            }
          }),
        );
        exit();
        const joined =
          node.names === undefined
            ? results
            : Object.fromEntries(
                node.names.map((branchName, index) => [branchName, results[index]]),
              );
        return store(joined);
      }

      case "map": {
        enter();
        const items = resolveTermOrFail(node.items, values, `Step "${name}"`);
        if (!Array.isArray(items)) {
          throw new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.runtime,
            `${name} iterates a value that is not an array.`,
          );
        }
        const results = await runMap(
          node.id,
          node.body,
          items,
          scope,
          depth,
          node.maxConcurrency,
        );
        exit();
        return store(results);
      }

      case "wait": {
        enter();
        const milliseconds = waitMilliseconds(node, values, name, now());
        await bounded(name, scope, undefined, (signal) => sleep(milliseconds, signal));
        exit();
        return store(NO_RESULT);
      }

      case "retry":
        return store(await runRetry(node.body, node.policy, scope, depth, name));

      case "attempt": {
        try {
          return store(await evaluate(node.body, scope, depth));
        } catch (error) {
          if (error instanceof SucceededSignal) throw error;
          const failure = asStateError(error);
          if (scope.controller.signal.aborted) throw failure;
          if (!errorMatches(selectorErrors(node.on), failure.errorName)) throw failure;

          record({ at: stamp(), state: name, type: "caught", depth, detail: failure.message });
          scope.errors.set(node.id, failure.toCatchOutput());
          return store(await evaluate(node.handler, scope, depth));
        }
      }

      case "pass":
        return store(
          node.result === undefined
            ? NO_RESULT
            : resolvePayload(node.result, values, referenceIn, `Step "${name}"`),
        );

      case "succeed": {
        enter();
        record({ at: stamp(), state: name, type: "succeeded", depth });
        throw new SucceededSignal(
          node.result === undefined
            ? NO_RESULT
            : resolvePayload(node.result, values, referenceIn, `Step "${name}"`),
        );
      }

      case "fail": {
        enter();
        const error = new WorkflowStateError(
          node.error,
          node.cause ?? `The workflow reached ${name}.`,
        );
        record({ at: stamp(), state: name, type: "failed", depth, detail: error.message });
        throw error;
      }

      default:
        // A verbatim AWS state asks for behavior the framework cannot derive.
        // Refused rather than approximated: running something that merely
        // resembles it would be worse than not running it.
        throw new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.runtime,
          `${name} is a raw AWS state, which the local lane cannot reproduce. Run this workflow in AWS, or express the step with the workflow language.`,
        );
    }
  };

  const newScope = (parent?: Scope): Scope => ({
    results: new Map(),
    bindings: new Map(),
    errors: new Map(),
    ...(parent === undefined ? {} : { parent }),
    controller: linkedController(
      parent === undefined ? controller.signal : parent.controller.signal,
    ),
  });

  /** One invocation, through whichever transport the runner provides. */
  const runInvocation = async (
    node: Extract<WorkflowNode, { kind: "invocation" }>,
    payload: unknown,
    name: string,
    scope: Scope,
  ): Promise<unknown> => {
    const timeout =
      node.timeoutSeconds === undefined ? {} : { timeoutSeconds: node.timeoutSeconds };

    if (node.invokes === "lambda") {
      return bounded(name, scope, node.timeoutSeconds, (signal) =>
        options.runner.invokeLambda(node.target, payload, { ...timeout, signal }),
      );
    }

    if (node.invokes === "agent") {
      const invoke = options.runner.invokeAgent;
      if (invoke === undefined) {
        throw new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.runtime,
          `${name} invokes an agent, which this runner does not support.`,
        );
      }
      // The execution's session, or the one the step names: a digest of the
      // execution and the key, as the cloud lane computes it, so it belongs to
      // this execution alone and always fits the adapter's pattern. A key that
      // is not a string is stringified, as JSONata's `&` does.
      const key =
        node.session === undefined
          ? ""
          : resolvePayload(node.session, valuesFor(scope, options.input), referenceIn, `Step "${name}" session`);
      const conversationId = createHash("sha256")
        .update(`${execution.executionId}\n${typeof key === "string" ? key : JSON.stringify(key)}`)
        .digest("hex");
      return bounded(name, scope, node.timeoutSeconds, (signal) =>
        invoke(node.target, { conversationId, input: payload }, { ...timeout, signal }),
      );
    }

    if (node.invokes === "workflow") {
      const run = options.runner.runWorkflow;
      if (run === undefined) {
        throw new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.runtime,
          `${name} runs a child workflow, which this runner does not support.`,
        );
      }
      return bounded(name, scope, node.timeoutSeconds, (signal) =>
        run(node.target, payload, { ...timeout, signal }),
      );
    }

    // The cloud lane stringifies the task's input with JSONata's `$string`,
    // which leaves a bare string unquoted. Requiring a document keeps the two
    // lanes agreeing rather than differing only for a scalar payload.
    assertTaskInputIsDocument(payload, name);

    if (node.completion === "callback") {
      const start = options.runner.startTaskWithCallback;
      if (start === undefined) {
        throw new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.runtime,
          `${name} waits for its container to report a result, which this runner cannot do.`,
        );
      }
      return suspend(
        node.id,
        name,
        scope,
        node.timeoutSeconds,
        node.heartbeatSeconds,
        (handle, signal) => start(node.target, payload, handle, { signal }),
      );
    }
    const summary = await bounded(name, scope, node.timeoutSeconds, (signal) =>
      options.runner.runTask(node.target, payload, { ...timeout, signal }),
    );
    if (summary.exitCode !== 0) {
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.taskFailed,
        `task:${node.target} exited ${summary.exitCode} (run ${summary.runId}).`,
      );
    }
    // The small framework summary, not the container's stdout: a task has no
    // business-output channel, and results travel through application-owned
    // storage referenced in the input.
    return { runId: summary.runId, exitCode: summary.exitCode };
  };

  /**
   * A step that ends when someone else says so.
   *
   * Two deadlines apply and they are owned by different things. The absolute
   * one is `bounded`'s, because every pending operation has it; the heartbeat
   * is the broker's, because only it knows when the last one arrived. A
   * heartbeat never extends the absolute deadline — that is the point of
   * having one.
   */
  const suspend = async (
    nodeId: WorkflowNodeId,
    name: string,
    scope: Scope,
    timeoutSeconds: number | undefined,
    heartbeatSeconds: number | undefined,
    dispatch: (handle: unknown, signal: AbortSignal) => Promise<void>,
  ): Promise<unknown> => {
    const wait = options.runner.awaitCallback;
    if (wait === undefined) {
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.runtime,
        `${name} waits for a callback, which this runner cannot hold.`,
      );
    }
    if (timeoutSeconds === undefined) {
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.runtime,
        `${name} waits for a callback with no deadline. A callback step declares timeoutSeconds.`,
      );
    }
    return bounded(name, scope, timeoutSeconds, (signal) =>
      wait(
        {
          // The execution and the node: a retry of this step reuses the key,
          // which is how the previous attempt's token stops working.
          stepKey: `${execution.executionId}:${nodeId}`,
          state: name,
          timeoutSeconds,
          ...(heartbeatSeconds === undefined ? {} : { heartbeatSeconds }),
          dispatch: (handle) => dispatch(handle, signal),
        },
        { signal },
      ),
    );
  };

  /**
   * The retry policy, applied around one step.
   *
   * AWS's attempt counting is preserved: `retries` counts *retries*, so a policy
   * with `retries: 3` runs the step up to four times.
   */
  const runRetry = async (
    body: WorkflowNode,
    policy: WorkflowRetryPolicy,
    scope: Scope,
    depth: number,
    name: string,
  ): Promise<unknown> => {
    const errors = selectorErrors(policy.on);
    for (let used = 0; ; used += 1) {
      try {
        return await evaluate(body, scope, depth);
      } catch (error) {
        if (error instanceof SucceededSignal) throw error;
        const failure = asStateError(error);
        if (scope.controller.signal.aborted) throw failure;
        if (used >= policy.retries) throw failure;
        if (!errorMatches(errors, failure.errorName)) throw failure;

        const interval = (policy.intervalSeconds ?? 1) * 1000;
        let delay = interval * Math.pow(policy.backoffRate ?? 2, used);
        if (policy.maxDelaySeconds !== undefined) {
          delay = Math.min(delay, policy.maxDelaySeconds * 1000);
        }
        // Full jitter spreads a retry storm; the cap is what AWS randomises under.
        if (policy.jitter === "full") delay = Math.random() * delay;

        record({
          at: stamp(),
          state: name,
          type: "retrying",
          depth,
          detail: `${failure.errorName} attempt ${used + 1}/${policy.retries}`,
        });
        if (now() + delay >= deadline) throw failure;
        await sleep(delay, scope.controller.signal);
      }
    }
  };

  /**
   * Map iterations, bounded by the declared concurrency.
   *
   * A failure stops the map: no further iteration is *scheduled*, and the ones
   * already running are cancelled. Continuing to launch work for a state that
   * has already failed is the local lane doing something AWS does not.
   */
  const runMap = async (
    mapId: WorkflowNodeId,
    body: WorkflowNode,
    items: readonly unknown[],
    scope: Scope,
    depth: number,
    maxConcurrency: number,
  ): Promise<readonly unknown[]> => {
    const results = new Array<unknown>(items.length);
    const width = items.length === 0 ? 1 : items.length;
    const limit = Math.max(1, Math.min(maxConcurrency, width));
    const running = new Set<Scope>();
    let next = 0;
    let failure: WorkflowStateError | undefined;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure !== undefined) return;
        const index = next;
        next += 1;
        if (index >= items.length) return;

        // Each iteration is its own scope, holding its own item binding.
        const child = newScope(scope);
        child.bindings.set(`${mapId}:item`, items[index]);
        child.bindings.set(`${mapId}:index`, index);
        running.add(child);
        try {
          results[index] = await evaluate(body, child, depth + 1);
        } catch (error) {
          if (error instanceof SucceededSignal) {
            results[index] = error.output;
            continue;
          }
          failure = asStateError(error);
          for (const sibling of running) {
            if (sibling !== child) sibling.controller.abort(failure);
          }
          throw failure;
        } finally {
          running.delete(child);
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, worker));
    return results;
  };

  const waitMilliseconds = (
    node: Extract<WorkflowNode, { kind: "wait" }>,
    values: WorkflowValues,
    name: string,
    at: number,
  ): number => {
    const resolve = (value: unknown): unknown => {
      const reference = referenceIn(value);
      return reference === undefined
        ? value
        : resolveTermOrFail(reference, values, `Step "${name}"`);
    };

    if (node.seconds !== undefined) {
      const seconds = resolve(node.seconds);
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
        throw new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.runtime,
          `${name} waits for a value that is not a number of seconds.`,
        );
      }
      return Math.max(0, seconds * 1000);
    }

    const until = resolve(node.until);
    const parsed = typeof until === "string" ? Date.parse(until) : Number.NaN;
    if (Number.isNaN(parsed)) {
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.runtime,
        `${name} waits until a value that is not a timestamp.`,
      );
    }
    return Math.max(0, parsed - at);
  };

  try {
    const output = await evaluate(workflow.root, newScope(), 0);
    return finish("succeeded", { output });
  } catch (error) {
    if (error instanceof SucceededSignal) {
      return finish("succeeded", { output: error.output });
    }
    const failure = asStateError(error);
    if (executionTimedOut || now() >= deadline) {
      return finish("timedOut", { error: failure });
    }
    if (controller.signal.aborted) return finish("aborted", { error: failure });
    return finish("failed", { error: failure });
  }
}

/**
 * A fresh execution record.
 *
 * The display id comes from the caller because the counter belongs to a
 * session: this function keeps no memory between calls, and it is the runner
 * process hosting the engine that makes `#3` name exactly one execution.
 */
export function newExecution(
  workflowId: string,
  displayId: string,
): WorkflowExecution {
  return {
    executionId: `local-${workflowId}-${randomUUID()}`,
    displayId,
    workflowId,
    startedAt: new Date().toISOString(),
    status: "running",
    history: [],
  };
}
