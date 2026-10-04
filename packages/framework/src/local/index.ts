export * from "./agentcore";
export * from "./agentcore-contracts";

import {
  getLambdaTargetIds,
  parseTargetReference,
  resolveLambdaTarget,
  toTargetReference,
  type FrameworkConfig,
  type LambdaTarget,
  type ServiceTarget,
} from "@repo/framework/config";
import {
  findRepositoryRoot,
  resolveServicePort,
} from "@repo/framework/config/source";
import { getTargetEnvironmentPrefix } from "./services";
import { invokeLocalNodeLambda, LambdaWorkerPool } from "./lambda-process";

export * from "./invocation";
export * from "./environment";
export * from "./lambda-process";
export * from "./paths";
export * from "./resources";
export * from "./services";
export * from "./callback-broker";
export * from "./workflow-bindings";
export * from "./workflow-integrations";
export * from "./workflow-interpreter";

// Keep the exported result readable without coupling local execution to Lambda types.
export type LambdaInvocationResult = {
  statusCode: number;
  body?: string;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  cookies?: string[];
  isBase64Encoded?: boolean;
};

export interface LocalLambdaExecutorOptions {
  readonly config: FrameworkConfig;
  readonly repositoryRoot?: string;
  readonly runnerUrl?: string;
  /**
   * Warm handler processes, or `null` to start every invocation cold. Absent,
   * the pool LOCAL_LAMBDA_WARM* describes is used; see LambdaWorkerPool.
   */
  readonly pool?: LambdaWorkerPool | null;
}

/** Fields a caller may pin on the context a handler receives. */
export interface LocalInvocationContext {
  /** Defaults to a fresh id; a replay passes the captured invocation's. */
  readonly awsRequestId?: string;
  /** What a Gateway hands a tool: the tool's wire name, the MCP message, the Gateway. */
  readonly clientContext?: { readonly custom: Readonly<Record<string, string>> };
}

/** Resolve a declared service through Compose DNS, with an optional endpoint override. */
export function resolveLocalServiceUrl(
  config: FrameworkConfig,
  target: ServiceTarget,
  repositoryRoot = findRepositoryRoot(process.cwd()),
): string {
  const { id } = parseTargetReference(target);

  // The documented advanced override: an endpoint, not a registration. It
  // points this target somewhere else; it never suppresses container creation.
  const override = process.env[`${getTargetEnvironmentPrefix(id)}_SERVICE_URL`];
  if (override) return override.replace(/\/+$/, "");

  return `http://${id}:${resolveServicePort(config, id, { repositoryRoot })}`;
}

function allowedLambdaTargets(config: FrameworkConfig): Set<LambdaTarget> {
  return new Set(
    getLambdaTargetIds(config).map(
      (id) => toTargetReference("lambda", id) as LambdaTarget,
    ),
  );
}

export class LocalLambdaExecutor {
  private readonly config: FrameworkConfig;
  private readonly allowedTargets: Set<LambdaTarget>;
  private readonly repositoryRoot: string;
  private readonly runnerUrl: string;
  private readonly pool: LambdaWorkerPool | undefined;

  public constructor(options: LocalLambdaExecutorOptions) {
    this.config = options.config;
    this.allowedTargets = allowedLambdaTargets(options.config);
    this.repositoryRoot =
      options.repositoryRoot ?? findRepositoryRoot(process.cwd());
    this.pool =
      options.pool === null
        ? undefined
        : (options.pool ?? LambdaWorkerPool.fromEnvironment(this.repositoryRoot));
    this.runnerUrl = (
      options.runnerUrl ??
      process.env.LOCAL_INVOCATION_RUNNER_URL ??
      "http://local-invocation-runner:8090"
    ).replace(/\/+$/, "");
  }

  public async invoke<Result = LambdaInvocationResult>(
    target: LambdaTarget,
    event: unknown,
    context?: LocalInvocationContext,
  ): Promise<Result> {
    if (!this.allowedTargets.has(target)) {
      throw new Error(
        `Local Lambda target "${target}" is not declared under http, webSocket, or events in the framework config.`,
      );
    }

    // Packaging comes from the config, not from whether a Dockerfile happens to
    // be sitting in the directory, so local execution and the deployed Lambda
    // can never disagree about how the code is built.
    const { id } = parseTargetReference(target);
    if (resolveLambdaTarget(this.config, id).packaging === "container") {
      return this.invokeContainer<Result>(target, event, context);
    }

    return invokeLocalNodeLambda(this.config, target, event, {
      repositoryRoot: this.repositoryRoot,
      runnerUrl: this.runnerUrl,
      ...(context ? { context } : {}),
      ...(this.pool ? { pool: this.pool } : {}),
    }) as Promise<Result>;
  }

  /** Stops any warm handler processes. They also exit on their own with this process. */
  public close(): void {
    this.pool?.close();
  }

  /**
   * An image Lambda runs in its own container, so its descriptors travel in its
   * private process environment rather than in this one's scoped map.
   */
  private async invokeContainer<Result>(
    target: LambdaTarget,
    event: unknown,
    context: LocalInvocationContext | undefined,
  ): Promise<Result> {
    const response = await fetch(`${this.runnerUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, event, context }),
    });
    const payload = (await response.json()) as
      | { result: Result }
      | { error: string };
    if (!response.ok || !("result" in payload)) {
      throw new Error(
        "error" in payload
          ? payload.error
          : `Local Lambda runner returned HTTP ${response.status}.`,
      );
    }
    return payload.result;
  }
}
