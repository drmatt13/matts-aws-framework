import type { ApplicationListener } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type { IGrantable } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import type { TaskDefinition } from "aws-cdk-lib/aws-ecs";
import type { IStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import {
  getLambdaTargetIds,
  getServiceTargetIds,
  getTaskTargetIds,
  getWorkflowTargetIds,
  isTargetDeployed,
  isTargetEnabled,
  parseTargetReference,
  toTargetReference,
  type CloudMode,
  type FrameworkConfig,
  type LambdaTarget,
  type ServiceTarget,
  type TargetKind,
  type TargetReference,
  type TaskTarget,
  type WorkflowTarget,
} from "@repo/framework/config";

export type FrameworkLambdaTarget = {
  readonly kind: "lambda";
  readonly function: IFunction;
};

export type FrameworkServiceTarget = {
  readonly kind: "service";
  readonly url: string;
  /**
   * The load balancer's listener when it is internal: the HTTP API reaches it
   * over a VPC link rather than at its URL.
   */
  readonly listener?: ApplicationListener;
};

/**
 * The resolved launch specification, as CDK values.
 *
 * The same object the runtime descriptor and the workflow's `.sync` step are
 * both projected from, so a direct `runTask` and a workflow step can never
 * launch the same task two different ways. Every field may be a token.
 */
export interface FrameworkTaskLaunch {
  readonly region: string;
  /** Cluster ARN, which is also what the RunTask grant is conditioned on. */
  readonly cluster: string;
  /** Revision-qualified: a family-only ARN would drift from the grant. */
  readonly taskDefinitionArn: string;
  readonly containerName: string;
  readonly launchType: "FARGATE";
  readonly platformVersion: string;
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
  readonly assignPublicIp: boolean;
}

export type FrameworkTaskTarget = {
  readonly kind: "task";
  readonly launch: FrameworkTaskLaunch;
  readonly taskDefinition: TaskDefinition;
  /**
   * Applies `ecs:RunTask` on this exact revision plus `iam:PassRole` on both
   * roles, each with its own condition. Owned by the task's own stack so a
   * caller cannot widen it, and so there is one implementation for Lambda
   * callers, container callers and the workflow role alike.
   */
  readonly grantRun: (grantee: IGrantable) => void;
};

export type FrameworkWorkflowTarget = {
  readonly kind: "workflow";
  readonly stateMachine: IStateMachine;
  /** `states:StartExecution` on this machine only. */
  readonly grantStart: (grantee: IGrantable) => void;
};

export type FrameworkCdkTarget =
  | FrameworkLambdaTarget
  | FrameworkServiceTarget
  | FrameworkTaskTarget
  | FrameworkWorkflowTarget;

export class FrameworkTargetRegistry {
  private readonly targetMap = new Map<TargetReference, FrameworkCdkTarget>();

  public lambda<T extends IFunction>(id: string, fn: T): T {
    this.register(`lambda:${id}`, { kind: "lambda", function: fn });
    return fn;
  }

  public service(id: string, url: string, listener?: ApplicationListener): string {
    this.register(`service:${id}`, { kind: "service", url, ...(listener ? { listener } : {}) });
    return url;
  }

  public task(id: string, target: Omit<FrameworkTaskTarget, "kind">): void {
    this.register(`task:${id}`, { kind: "task", ...target });
  }

  public workflow(
    id: string,
    target: Omit<FrameworkWorkflowTarget, "kind">,
  ): void {
    this.register(`workflow:${id}`, { kind: "workflow", ...target });
  }

  public merge(...registries: readonly FrameworkTargetRegistry[]): this {
    for (const registry of registries) {
      for (const [reference, target] of registry.entries()) {
        this.register(reference, target);
      }
    }
    return this;
  }

  public get(reference: TargetReference): FrameworkCdkTarget | undefined {
    return this.targetMap.get(reference);
  }

  public requireLambda(reference: LambdaTarget): IFunction {
    const target = this.require(reference);
    if (target.kind !== "lambda") {
      throw new Error(`Framework target "${reference}" is not a Lambda function.`);
    }
    return target.function;
  }

  public requireService(reference: ServiceTarget): FrameworkServiceTarget {
    const target = this.require(reference);
    if (target.kind !== "service") {
      throw new Error(`Framework target "${reference}" is not an HTTP service.`);
    }
    return target;
  }

  public requireTask(reference: TaskTarget): FrameworkTaskTarget {
    const target = this.require(reference);
    if (target.kind !== "task") {
      throw new Error(`Framework target "${reference}" is not an ECS task.`);
    }
    return target;
  }

  public requireWorkflow(reference: WorkflowTarget): FrameworkWorkflowTarget {
    const target = this.require(reference);
    if (target.kind !== "workflow") {
      throw new Error(`Framework target "${reference}" is not a workflow.`);
    }
    return target;
  }

  public entries(): IterableIterator<[TargetReference, FrameworkCdkTarget]> {
    return this.targetMap.entries();
  }

  private require(reference: TargetReference): FrameworkCdkTarget {
    const target = this.get(reference);
    if (!target) {
      throw new Error(`Framework target "${reference}" is not registered in CDK.`);
    }
    return target;
  }

  private register(
    reference: TargetReference,
    target: FrameworkCdkTarget,
  ): void {
    parseTargetReference(reference);
    if (this.targetMap.has(reference)) {
      throw new Error(`Framework target "${reference}" is registered more than once.`);
    }
    this.targetMap.set(reference, target);
  }
}

/** Declared targets this graph deliberately does not contain, by reason. */
export interface SkippedTargets {
  /** Removed by their own `deploy` token. The author asked for this. */
  readonly disabled: readonly TargetReference[];
  /**
   * Enabled for the cloud, but not held by this deployment. Only a dev
   * deployment produces these, and only for targets a developer invokes.
   */
  readonly notInThisDeployment: readonly TargetReference[];
  /**
   * WebSocket handlers with no WebSocket API to route to them, because this
   * deployment does not build one (DEPLOY_WEBSOCKET_API is off). Built, they
   * would be Lambdas nothing can invoke.
   */
  readonly withoutWebSocketApi: readonly TargetReference[];
}

/**
 * Ensures config declarations and CDK registrations stay complete in both
 * directions, for the graph this mode actually builds.
 *
 * There is no per-kind exception any more. Services used to be skipped by name
 * because Compose owns them locally; that is now one instance of the general
 * rule, which `isTargetDeployed` answers for every kind: a dev deployment holds
 * only what AWS invokes.
 */
export function assertFrameworkTargetsComplete(
  config: FrameworkConfig,
  registry: FrameworkTargetRegistry,
  options: {
    readonly mode: CloudMode;
    /** Targets deliberately left unbuilt because their router is not built. */
    readonly withoutWebSocketApi?: ReadonlySet<TargetReference>;
  },
): SkippedTargets {
  const disabled: TargetReference[] = [];
  const notInThisDeployment: TargetReference[] = [];
  const withoutWebSocketApi: TargetReference[] = [];
  for (const [kind, ids] of [
    ["lambda", getLambdaTargetIds(config)],
    ["service", getServiceTargetIds(config)],
    ["task", getTaskTargetIds(config)],
    ["workflow", getWorkflowTargetIds(config)],
  ] as const) {
    for (const id of ids) {
      const reference = toTargetReference(kind, id);
      // A target that was built anyway is the more dangerous half of both
      // checks below: the point is to remove the resource, not just the route
      // that points at it.
      const registered = Boolean(registry.get(reference));
      if (!isTargetEnabled(config, kind, id, "cloud")) {
        if (registered) {
          throw new Error(
            `Framework target "${reference}" is disabled for the cloud scope in framework.config.ts but a stack registered it.`,
          );
        }
        disabled.push(reference);
        continue;
      }
      if (!isTargetDeployed(config, kind, id, options.mode)) {
        if (registered) {
          throw new Error(
            `Framework target "${reference}" is not built by a ${options.mode} deployment but a stack registered it. A ${options.mode} deployment holds only what AWS invokes; everything else runs under Docker Compose.`,
          );
        }
        notInThisDeployment.push(reference);
        continue;
      }
      if (options.withoutWebSocketApi?.has(reference)) {
        if (registered) {
          throw new Error(
            `Framework target "${reference}" was built although this deployment has no WebSocket API to route to it.`,
          );
        }
        withoutWebSocketApi.push(reference);
        continue;
      }
      if (!registered) {
        throw new Error(
          `Framework target "${reference}" is declared in framework.config.ts but no stack registered it.`,
        );
      }
    }
  }

  const declaredIds: Readonly<Record<TargetKind, readonly string[]>> = {
    lambda: getLambdaTargetIds(config),
    service: getServiceTargetIds(config),
    task: getTaskTargetIds(config),
    workflow: getWorkflowTargetIds(config),
  };
  for (const [reference] of registry.entries()) {
    const { kind, id } = parseTargetReference(reference);
    if (!declaredIds[kind].includes(id)) {
      throw new Error(
        `Framework target "${reference}" is registered in CDK but is not declared in framework.config.ts.`,
      );
    }
  }

  return { disabled, notInThisDeployment, withoutWebSocketApi };
}
