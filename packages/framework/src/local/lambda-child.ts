/**
 * One handler process. Its environment is complete before any application
 * import, exactly as in a Lambda execution environment.
 *
 * By default it answers one invocation and exits. Asked to stay (`keepAlive`),
 * it keeps the imported module — and everything the module cached at the top
 * level — for the next invocation of the same handler, which is what a warm
 * Lambda environment does.
 */
import { randomUUID } from "node:crypto";

interface LambdaDescription {
  readonly functionName: string;
  readonly memoryLimitInMB: number;
  readonly timeoutSeconds: number;
}

interface Request {
  /** Echoed in the reply, so a warm worker's answers can be matched to requests. */
  readonly id?: number;
  readonly entry: string;
  readonly handler: string;
  readonly event: unknown;
  /**
   * Fields a caller may pin: a replayed invocation's original request id, or
   * the client context a Gateway hands a tool.
   */
  readonly context?: {
    readonly awsRequestId?: string;
    readonly clientContext?: { readonly custom: Readonly<Record<string, string>> };
  };
  readonly lambda?: LambdaDescription;
  /** Stay alive for the next invocation instead of exiting after this one. */
  readonly keepAlive?: boolean;
}

type Handler = (event: unknown, context: unknown) => unknown;

let loaded: { readonly entry: string; readonly handler: Handler } | undefined;

/**
 * The context a Lambda runtime hands a handler: identifiers, limits, and a
 * `getRemainingTimeInMillis` that counts down from this invocation's deadline.
 * Built here because functions cannot cross the IPC channel.
 */
function lambdaContext(request: Request) {
  const functionName = request.lambda?.functionName ?? "local";
  const deadline = Date.now() + (request.lambda?.timeoutSeconds ?? 900) * 1000;
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:local:000000000000:function:${functionName}`,
    memoryLimitInMB: String(request.lambda?.memoryLimitInMB ?? 128),
    awsRequestId: request.context?.awsRequestId ?? randomUUID(),
    ...(request.context?.clientContext ? { clientContext: request.context.clientContext } : {}),
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: "local",
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/** The error as the parent will print it, stack included. */
function describeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "Error", message: String(error) };
}

async function load(request: Request): Promise<Handler> {
  if (loaded) {
    if (loaded.entry !== request.entry) {
      throw new Error("This process already serves another handler.");
    }
    return loaded.handler;
  }
  const module = (await import(request.entry)) as Record<string, unknown>;
  const handler = module[request.handler];
  if (typeof handler !== "function") {
    throw new Error(`The handler module does not export ${request.handler}.`);
  }
  loaded = { entry: request.entry, handler: handler as Handler };
  return loaded.handler;
}

async function execute(request: Request): Promise<void> {
  let reply: Record<string, unknown>;
  try {
    const handler = await load(request);
    const result = await handler(request.event, lambdaContext(request));
    reply = { id: request.id, ok: true, result: JSON.parse(JSON.stringify(result ?? null)) };
  } catch (error) {
    reply = { id: request.id, ok: false, error: describeError(error) };
  }
  if (request.keepAlive) {
    process.send?.(reply);
  } else {
    process.send?.(reply, () => process.exit(reply.ok ? 0 : 1));
  }
}

// A worker never outlives the process that started it: when a dev server
// restarts or crashes, the IPC channel closes and this exits with it.
process.on("disconnect", () => process.exit(0));
process.on("message", (request: Request) => {
  void execute(request);
});
