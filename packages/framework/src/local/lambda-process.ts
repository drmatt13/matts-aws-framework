import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isNodeLambdaRuntime, resolveLambdaTarget, type FrameworkConfig, type LambdaTarget } from "@repo/framework/config";
import { resolveLambdaSourcePath } from "@repo/framework/config/source";
import { resolveLocalWorkloadEnvironment, type LocalEnvironmentOptions } from "./environment";

/** Fields a caller may pin on the Lambda context. See lambda-child.ts. */
export interface PinnedLambdaContext {
  readonly awsRequestId?: string;
  readonly clientContext?: { readonly custom: Readonly<Record<string, string>> };
}

/** What one invocation sends the child. See lambda-child.ts. */
interface ChildRequest {
  readonly entry: string;
  readonly handler: string;
  readonly event: unknown;
  readonly context?: PinnedLambdaContext;
  readonly lambda: { readonly functionName: string; readonly memoryLimitInMB: number; readonly timeoutSeconds: number };
  readonly egress?: "ipv6";
}

interface ChildReply {
  readonly id?: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly name?: string; readonly message?: string; readonly stack?: string };
}

export interface LocalLambdaInvocationOptions extends LocalEnvironmentOptions {
  readonly context?: PinnedLambdaContext;
  readonly signal?: AbortSignal;
  /** Reuse warm handler processes. Absent, every invocation gets a fresh one. */
  readonly pool?: LambdaWorkerPool;
}

const CHILD_ENTRY = path.join(__dirname, "lambda-child.ts");

function spawnChild(environment: Record<string, string>, repositoryRoot: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD_ENTRY], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  return child;
}

/**
 * The handler's own error, as it was thrown in the child: same name, same
 * message, and the child's stack, so a local failure points at the line in
 * the handler that caused it rather than at this file.
 */
function handlerError(target: LambdaTarget, reply: ChildReply): Error {
  const error = new Error(reply.error?.message ?? `${target} failed.`);
  error.name = reply.error?.name ?? "Error";
  if (reply.error?.stack) error.stack = reply.error.stack;
  return error;
}

function timeoutError(target: LambdaTarget, seconds: number): Error {
  return Object.assign(new Error(`${target} exceeded its ${seconds}-second timeout.`), { name: "States.Timeout" });
}

/** One invocation in a process of its own, which exits when it answers. */
function invokeOnce(
  target: LambdaTarget,
  environment: Record<string, string>,
  request: ChildRequest,
  options: { readonly repositoryRoot: string; readonly signal?: AbortSignal },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(environment, options.repositoryRoot);
    let settled = false;
    const finish = (error?: unknown, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.once("close", () => { error ? reject(error) : resolve(result); });
      child.kill("SIGKILL");
    };
    const abort = () => finish(options.signal?.reason ?? new Error("Lambda invocation cancelled."));
    const timer = setTimeout(() => finish(timeoutError(target, request.lambda.timeoutSeconds)), request.lambda.timeoutSeconds * 1000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", finish);
    child.once("exit", (code) => finish(new Error(`${target} exited before returning a result (exit ${code}).`)));
    child.once("message", (reply: ChildReply) => (reply.ok ? finish(undefined, reply.result) : finish(handlerError(target, reply))));
    child.send(request, (error) => { if (error) finish(new Error(`${target} could not receive its invocation.`)); });
  });
}

export interface LambdaWorkerPoolOptions {
  readonly repositoryRoot: string;
  /** Most warm processes kept at once, across every handler. */
  readonly maxWarm: number;
  /** Seconds an idle warm process is kept before it exits. */
  readonly idleSeconds: number;
}

/** One warm handler process, serving one target one invocation at a time. */
class Worker {
  public busy = false;
  public lastUsed = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private pending:
    | { readonly id: number; readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }
    | undefined;

  public constructor(
    public readonly target: LambdaTarget,
    public readonly fingerprint: string,
    private readonly child: ChildProcess,
    private readonly onGone: (worker: Worker) => void,
  ) {
    child.on("message", (reply: ChildReply) => {
      const pending = this.pending;
      if (!pending || reply.id !== pending.id) return;
      this.pending = undefined;
      reply.ok ? pending.resolve(reply.result) : pending.reject(handlerError(target, reply));
    });
    child.once("exit", (code) => {
      this.pending?.reject(new Error(`${target} exited before returning a result (exit ${code}).`));
      this.pending = undefined;
      this.dispose();
    });
    child.once("error", (error) => {
      this.pending?.reject(error);
      this.pending = undefined;
      this.dispose();
    });
  }

  public invoke(request: ChildRequest, signal: AbortSignal | undefined, idleSeconds: number): Promise<unknown> {
    this.busy = true;
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.busy = false;
        this.lastUsed = Date.now();
        this.idleTimer = setTimeout(() => this.kill(), idleSeconds * 1000);
        this.idleTimer.unref();
      };
      // A timed-out or cancelled invocation takes its environment with it, as
      // a Lambda timeout does: the next call starts cold.
      const fail = (error: unknown) => {
        this.pending = undefined;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.kill();
        reject(error);
      };
      const abort = () => fail(signal?.reason ?? new Error("Lambda invocation cancelled."));
      const timer = setTimeout(() => fail(timeoutError(this.target, request.lambda.timeoutSeconds)), request.lambda.timeoutSeconds * 1000);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending = {
        id,
        resolve: (value) => { done(); resolve(value); },
        reject: (error) => { done(); reject(error); },
      };
      this.child.send({ ...request, id, keepAlive: true }, (error) => {
        if (error) fail(new Error(`${this.target} could not receive its invocation.`));
      });
    });
  }

  public kill(): void {
    this.child.kill("SIGKILL");
    this.dispose();
  }

  private dispose(): void {
    clearTimeout(this.idleTimer);
    this.onGone(this);
  }
}

/**
 * Warm handler processes for the local lanes, with hard limits.
 *
 * A process is started the first time a handler is invoked — never ahead of
 * time — and kept for that handler's next invocation, so module-level state
 * behaves as it does in a warm Lambda and the import cost is paid once. At
 * most `maxWarm` exist at a time, across all handlers; each exits after
 * `idleSeconds` without work. A call that finds its handler's process busy, or
 * the pool full of busy processes, runs in a fresh process that exits when it
 * answers, so concurrency never grows the pool.
 *
 * A process is replaced when its handler's resolved environment changes, and
 * every process exits with the dev server that owns it, so a code change —
 * which restarts the dev server — always starts cold.
 */
export class LambdaWorkerPool {
  private readonly workers = new Map<LambdaTarget, Worker>();

  public constructor(private readonly options: LambdaWorkerPoolOptions) {}

  /**
   * The pool these settings describe, or `undefined` for cold-only execution.
   *
   *   LOCAL_LAMBDA_WARM=false               every invocation starts cold
   *   LOCAL_LAMBDA_WARM_MAX=6               warm processes kept at most
   *   LOCAL_LAMBDA_WARM_IDLE_SECONDS=120    idle seconds before one exits
   */
  public static fromEnvironment(
    repositoryRoot: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): LambdaWorkerPool | undefined {
    if (environment.LOCAL_LAMBDA_WARM?.trim().toLowerCase() === "false") return undefined;
    const positive = (name: string, fallback: number): number => {
      const raw = environment[name]?.trim();
      if (!raw) return fallback;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a whole number of 1 or more. Received: ${raw}`);
      }
      return value;
    };
    return new LambdaWorkerPool({
      repositoryRoot,
      maxWarm: positive("LOCAL_LAMBDA_WARM_MAX", 6),
      idleSeconds: positive("LOCAL_LAMBDA_WARM_IDLE_SECONDS", 120),
    });
  }

  /** How many warm processes exist right now. */
  public get size(): number {
    return this.workers.size;
  }

  public async invoke(
    target: LambdaTarget,
    environment: Record<string, string>,
    request: ChildRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // A fingerprint rather than the values themselves, so the pool never
    // holds a second copy of a workload's secrets.
    const fingerprint = createHash("sha256").update(JSON.stringify(environment)).digest("hex");
    let worker = this.workers.get(target);
    if (worker && worker.fingerprint !== fingerprint && !worker.busy) {
      worker.kill();
      worker = undefined;
    }
    if (worker?.busy || (worker && worker.fingerprint !== fingerprint)) {
      return invokeOnce(target, environment, request, { repositoryRoot: this.options.repositoryRoot, signal });
    }
    if (!worker) {
      if (!this.makeRoom()) {
        return invokeOnce(target, environment, request, { repositoryRoot: this.options.repositoryRoot, signal });
      }
      worker = new Worker(target, fingerprint, spawnChild(environment, this.options.repositoryRoot), (gone) => {
        if (this.workers.get(gone.target) === gone) this.workers.delete(gone.target);
      });
      this.workers.set(target, worker);
    }
    return worker.invoke(request, signal, this.options.idleSeconds);
  }

  /** Stops every warm process. */
  public close(): void {
    for (const worker of [...this.workers.values()]) worker.kill();
  }

  /** Frees a slot by retiring the least recently used idle process, if one is needed. */
  private makeRoom(): boolean {
    if (this.workers.size < this.options.maxWarm) return true;
    const idle = [...this.workers.values()].filter((worker) => !worker.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) return false;
    idle.kill();
    return true;
  }
}

/**
 * The egress a handler's process is held to. A Lambda in the VPC (`vpc: true`
 * or `database: true`) runs in its private subnets in AWS, so it gets their
 * egress here too: IPv6 only, unless the network has a NAT gateway.
 */
export function localLambdaEgress(config: FrameworkConfig, target: LambdaTarget): "ipv6" | undefined {
  if (config.network?.nat === true) return undefined;
  return resolveLambdaTarget(config, target.slice("lambda:".length)).vpc ? "ipv6" : undefined;
}

export async function invokeLocalNodeLambda(config: FrameworkConfig, target: LambdaTarget, event: unknown, options: LocalLambdaInvocationOptions): Promise<unknown> {
  const id = target.slice("lambda:".length);
  const spec = resolveLambdaTarget(config, id);
  if (spec.packaging !== "zip" || !isNodeLambdaRuntime(spec.runtime)) throw new Error(`${target} has no local Node zip execution lane.`);
  const environment = await resolveLocalWorkloadEnvironment(config, target, options);
  if (options.signal?.aborted) throw options.signal.reason;
  const egress = localLambdaEgress(config, target);
  const request: ChildRequest = {
    entry: pathToFileURL(path.join(resolveLambdaSourcePath(config, id, { repositoryRoot: options.repositoryRoot }), "index.ts")).href,
    handler: spec.handler,
    event,
    ...(options.context ? { context: options.context } : {}),
    lambda: { functionName: id, memoryLimitInMB: spec.memorySize, timeoutSeconds: spec.timeoutSeconds },
    ...(egress ? { egress } : {}),
  };
  return options.pool
    ? options.pool.invoke(target, environment, request, options.signal)
    : invokeOnce(target, environment, request, { repositoryRoot: options.repositoryRoot, signal: options.signal });
}
