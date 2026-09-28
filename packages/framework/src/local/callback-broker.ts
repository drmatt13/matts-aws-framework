import { randomBytes } from "node:crypto";
import {
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
} from "@repo/framework/config";
import {
  CALLBACK_HANDLE_VERSION,
  type CallbackHandle,
} from "@repo/framework/runtime/callbacks";

/**
 * The local half of the callback pattern.
 *
 * In AWS a suspended step is held by Step Functions and resumed by a task
 * token. Locally the execution is a promise in the runner's process, and this
 * is what holds it: a token, the promise waiting on it, and the rules about who
 * may resolve it and when.
 *
 * ## What it guarantees
 *
 * **Registration happens before dispatch.** The token is minted and recorded,
 * and only then is the message sent or the container launched. A worker fast
 * enough to answer before the sender's next line still finds a callback to
 * complete — the race that would otherwise be rare, real, and impossible to
 * reproduce.
 *
 * **A retry gets a fresh token, and the old one stops working.** Otherwise the
 * previous attempt's worker — still running, because a timeout does not reach
 * into it — could answer for the attempt that replaced it.
 *
 * **The first terminal completion wins.** A queue can deliver a message twice;
 * both deliveries may complete. The second is refused rather than resuming an
 * execution that has moved on.
 *
 * ## What it does not
 *
 * It is not durable. There is no journal and no redrive: restarting the runner
 * invalidates every pending callback, and a stale message arriving afterwards
 * is told so rather than retried forever. That is a development orchestrator
 * being honest about not being Step Functions, and it is why the same graph in
 * AWS is held by the managed service instead.
 */

/**
 * A value with every callback token removed.
 *
 * A token is a credential: anyone holding one can resume an execution. They
 * travel in messages and in container environments, which means they can end up
 * in an execution's own history — a step's resolved arguments, a failure cause
 * quoting them back. Anything this process is willing to show a developer goes
 * through here first.
 *
 * The shape is the giveaway rather than the name, so a handle nested anywhere
 * is found: a version, a delivery and a token together are a handle wherever
 * they appear.
 */
export function redactCallbackHandles<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(walk);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return current;
    seen.add(current);

    const record = current as Record<string, unknown>;
    const looksLikeHandle =
      typeof record.token === "string" &&
      typeof record.delivery === "string" &&
      typeof record.version === "number";

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      result[key] =
        looksLikeHandle && key === "token" ? "[redacted]" : walk(entry);
    }
    return result;
  };
  return walk(value) as T;
}

export interface CallbackDispatchRequest {
  /**
   * Which *step of which execution* is waiting.
   *
   * A retry of the same step reuses this key, which is how the previous
   * attempt's token is found and invalidated.
   */
  readonly stepKey: string;
  /** The state name, for diagnostics. */
  readonly state: string;
  readonly timeoutSeconds: number;
  readonly heartbeatSeconds?: number | undefined;
  /**
   * Starts the work that will complete this callback.
   *
   * Called after registration, with the handle to send. A dispatch that throws
   * fails the step immediately: nothing is waiting for an answer that was never
   * asked for.
   */
  readonly dispatch: (handle: CallbackHandle) => Promise<void>;
}

interface PendingCallback {
  readonly token: string;
  readonly stepKey: string;
  readonly state: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: WorkflowStateError) => void;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class CallbackCompletionError extends Error {
  public constructor(
    message: string,
    /** What an HTTP caller should be told: gone, not merely wrong. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "CallbackCompletionError";
  }
}

/** How many settled tokens are remembered, so a duplicate is *recognised*. */
const REMEMBERED_TOKENS = 1000;

export class LocalCallbackBroker {
  private readonly pending = new Map<string, PendingCallback>();
  private readonly byStep = new Map<string, string>();
  /** Insertion-ordered, so the oldest memory is the one that is dropped. */
  private readonly settled = new Set<string>();
  private closed = false;

  /**
   * Registers a callback, dispatches the work, and waits for the answer.
   *
   * The absolute deadline is *not* enforced here: the interpreter already
   * bounds every pending operation, and a second timer would be a second
   * opinion about when a step ran out of time. What is enforced here is the
   * heartbeat, because only the broker knows when the last one arrived.
   */
  public async await(
    request: CallbackDispatchRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) {
      throw new WorkflowStateError(
        WORKFLOW_ERROR_NAMES.runtime,
        "The local runner is shutting down, so no callback can be registered.",
      );
    }

    // A retry replaces the previous attempt. The old worker may still be
    // running; it is simply no longer the one being listened to.
    this.invalidatePrevious(request.stepKey);

    const token = `wf-${randomBytes(24).toString("base64url")}`;
    const handle: CallbackHandle = {
      version: CALLBACK_HANDLE_VERSION,
      delivery: "local",
      token,
      execution: request.stepKey.split(":")[0] as string,
    };

    const answer = new Promise<unknown>((resolve, reject) => {
      const entry: PendingCallback = {
        token,
        stepKey: request.stepKey,
        state: request.state,
        resolve,
        reject,
        settled: false,
      };
      this.pending.set(token, entry);
      this.byStep.set(request.stepKey, token);
      this.armHeartbeat(entry, request.heartbeatSeconds);
    });

    const onAbort = (): void => {
      this.settle(token, (entry) =>
        entry.reject(
          new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.timeout,
            `${request.state} stopped waiting for its callback.`,
          ),
        ),
      );
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // Registered first, dispatched second. The other order has a race that
      // only appears when a worker is quick.
      await request.dispatch(handle);
      return await answer;
    } finally {
      options.signal.removeEventListener("abort", onAbort);
      this.forget(token);
    }
  }

  /** Resumes the execution with the worker's result. */
  public succeed(token: string, result: unknown): void {
    this.settle(token, (entry) => entry.resolve(result), token);
  }

  /** Fails the step under the worker's own error name. */
  public fail(
    token: string,
    failure: { readonly error: string; readonly cause?: string },
  ): void {
    this.settle(
      token,
      (entry) =>
        entry.reject(
          new WorkflowStateError(
            failure.error,
            failure.cause ?? `${entry.state} was failed by its worker.`,
          ),
        ),
      token,
    );
  }

  /** Restarts the heartbeat window. It never extends the step's deadline. */
  public heartbeat(token: string, heartbeatSeconds?: number): void {
    const entry = this.require(token);
    this.armHeartbeat(entry, heartbeatSeconds ?? this.heartbeatWindows.get(token));
  }

  /** Whether a token is one this process is waiting on. */
  public has(token: string): boolean {
    return this.pending.has(token);
  }

  public shutdown(): void {
    this.closed = true;
    for (const token of [...this.pending.keys()]) {
      this.settle(token, (entry) =>
        entry.reject(
          new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.runtime,
            `${entry.state} was waiting for a callback when the local runner stopped. Local callbacks are not durable.`,
          ),
        ),
      );
    }
  }

  private readonly heartbeatWindows = new Map<string, number | undefined>();

  private armHeartbeat(
    entry: PendingCallback,
    heartbeatSeconds: number | undefined,
  ): void {
    this.heartbeatWindows.set(entry.token, heartbeatSeconds);
    if (entry.heartbeatTimer) clearTimeout(entry.heartbeatTimer);
    if (heartbeatSeconds === undefined) return;
    const timer = setTimeout(() => {
      this.settle(entry.token, (pending) =>
        pending.reject(
          new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.heartbeatTimeout,
            `${pending.state} heard nothing from its worker for ${heartbeatSeconds} seconds.`,
          ),
        ),
      );
    }, heartbeatSeconds * 1000);
    timer.unref?.();
    entry.heartbeatTimer = timer;
  }

  private invalidatePrevious(stepKey: string): void {
    const previous = this.byStep.get(stepKey);
    if (previous === undefined) return;
    this.settle(previous, (entry) =>
      entry.reject(
        new WorkflowStateError(
          WORKFLOW_ERROR_NAMES.runtime,
          `${entry.state} was retried, so this attempt's callback no longer resumes anything.`,
        ),
      ),
    );
  }

  /**
   * The pending callback a completion names, or a reason it cannot have one.
   *
   * The distinction between "never existed" and "already answered" matters to
   * the worker on the other end: one is a bug, the other is a duplicate
   * delivery it should stop retrying.
   */
  private require(token: string): PendingCallback {
    const entry = this.pending.get(token);
    if (entry !== undefined) return entry;
    if (this.settled.has(token)) {
      throw new CallbackCompletionError(
        "This callback has already been completed. The first terminal completion wins; a duplicate delivery changes nothing.",
        409,
      );
    }
    throw new CallbackCompletionError(
      "No execution is waiting for this callback. It may belong to a retried attempt, or to a runner that has since restarted; local callbacks are not durable.",
      410,
    );
  }

  private settle(
    token: string,
    finish: (entry: PendingCallback) => void,
    reportTo?: string,
  ): void {
    const entry = reportTo === undefined ? this.pending.get(token) : this.require(token);
    if (entry === undefined || entry.settled) return;
    entry.settled = true;
    if (entry.heartbeatTimer) clearTimeout(entry.heartbeatTimer);
    finish(entry);
    this.forget(token);
  }

  private forget(token: string): void {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    this.heartbeatWindows.delete(token);
    if (entry !== undefined && this.byStep.get(entry.stepKey) === token) {
      this.byStep.delete(entry.stepKey);
    }
    this.settled.add(token);
    if (this.settled.size > REMEMBERED_TOKENS) {
      const oldest = this.settled.values().next();
      if (!oldest.done) this.settled.delete(oldest.value);
    }
  }
}
