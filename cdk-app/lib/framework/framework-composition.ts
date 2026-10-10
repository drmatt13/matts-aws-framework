import type * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  getCloudTargets,
  getEventReplayManifest,
  validateFrameworkConfig,
  type CloudMode,
  type FrameworkConfig,
  type LambdaTarget,
  type NormalizedTarget,
  type ResourceEnvironmentReaders,
} from "@repo/framework/config";
import { DevLambdaReplayStack } from "./dev-lambda-replay-stack";
import { EcsServicesStack } from "./ecs-services-stack";
import { EcsTasksStack } from "./ecs-tasks-stack";
import type { FrameworkAgentCore } from "./framework-agentcore";
import { hasOrchestrationCloudResources, OrchestrationStack } from "./orchestration-stack";
import {
  developmentBridgeReferences,
  WorkflowBridgesStack,
} from "./workflow-bridges-stack";
import { appInvocationRegistry } from "./framework-tasks";
import { publishLocalWorkflowIntegrations } from "./framework-integrations";
import { HttpApiGatewayStack, type CognitoResources } from "./http-api-gateway-stack";
import { SynchronousLambdaFunctionsStack } from "./synchronous-lambda-functions-stack";
import { WebSocketApiStack } from "./websocket-api-stack";
import { WebSocketLambdaFunctionsStack } from "./websocket-lambda-functions-stack";
import { appEventRegistry, type EventLambdaContext } from "./framework-events";
import {
  assertFrameworkTargetsComplete,
  FrameworkTargetRegistry,
  type SkippedTargets,
} from "./framework-target-registry";

export interface FrameworkCompositionProps {
  readonly env: cdk.Environment;
  readonly stackId: (name: string) => string;
  readonly mode: CloudMode;
}

export interface FrameworkFoundation {
  readonly replayStack?: DevLambdaReplayStack;
  readonly replay?: EventLambdaContext<FrameworkConfig>["replay"];
}

/**
 * Resources needed before event functions can be constructed.
 * Factories create stacks directly in the supplied scope: moving orchestration
 * must not change stack paths, names, exports or deployment boundaries.
 */
export function createFrameworkFoundation(
  scope: Construct,
  props: FrameworkCompositionProps,
): FrameworkFoundation {
  if (props.mode === "prod") return {};
  const replayStack = new DevLambdaReplayStack(scope, props.stackId("DevLambdaReplayStack"), {
    env: props.env,
  });
  return { replayStack, replay: { bucket: replayStack.bucket, queue: replayStack.queue } };
}

export interface FrameworkTasksProps {
  readonly env: cdk.Environment;
  readonly stackId: (name: string) => string;
  readonly config: FrameworkConfig;
  /**
   * The narrow task catalog. Deliberately without Cognito: task infrastructure
   * is built before the event owners, so a task that could read the user pool
   * would let an event call a task that depends on Cognito, which depends on
   * events.
   */
  readonly cloud: { readonly mode: CloudMode };
  readonly readers?: ResourceEnvironmentReaders;
}

/**
 * Container tasks, built before the event owners that call them.
 *
 * A task is invoked by a developer — a route handler, a test, a workflow you
 * start — so a dev deployment builds none, and `getCloudTargets` returns empty
 * there without this factory needing to know why. That is also what keeps a
 * task image out of ECR in dev: the only two `fromAsset` calls a task reaches
 * are inside the stack below.
 *
 * The handles join the app-scoped invocation registry, so a caller declared
 * anywhere resolves its destination without it being threaded through props -
 * the same arrangement event Lambdas already use.
 */
export function createFrameworkTasks(
  scope: Construct,
  props: FrameworkTasksProps,
): { readonly stack?: EcsTasksStack } {
  const targets = getCloudTargets(props.config, ["task"], props.cloud.mode);
  if (targets.length === 0) return {};

  const cloud = { mode: props.cloud.mode };

  return {
    stack: new EcsTasksStack(scope, props.stackId("EcsTasksStack"), {
      env: props.env,
      config: props.config,
      cloud,
      targets,
    }),
  };
}

export interface FrameworkOrchestrationProps {
  readonly env: cdk.Environment;
  readonly stackId: (name: string) => string;
  readonly config: FrameworkConfig;
  /**
   * Which graph this is. Workflows and agents need no resource catalog, but
   * they still need the mode: an execution is started, and an agent invoked,
   * by a developer, so a dev deployment builds neither and the local runner
   * answers instead.
   */
  readonly mode: CloudMode;
  /** The user pool an agent with `auth: true` accepts tokens from. */
  readonly cognito: CognitoResources;
  /** Stacks whose targets this graph invokes, so the reference edge is explicit. */
  readonly dependencies?: readonly cdk.Stack[];
}

/**
 * Workflows and agents, in the one stack they share, built after the events and
 * tasks their graphs name and before the routed handlers that start or invoke
 * them.
 *
 * They reference targets rather than resources, so they take no catalog view:
 * what they need is the *handles* of the event Lambdas and tasks already built,
 * which is exactly why they are constructed here and not earlier. Why the two
 * share a stack is in `orchestration-stack.ts`.
 */
export function createFrameworkOrchestration(
  scope: Construct,
  props: FrameworkOrchestrationProps,
): {
  readonly stack?: OrchestrationStack;
  readonly agentcore?: FrameworkAgentCore;
  readonly bridges?: WorkflowBridgesStack;
} {
  // A development deployment builds no state machines, but it may still owe the
  // developer's machine two things it cannot do for itself: an authenticated
  // HTTPS call and an explicitly granted AWS action. Those get a bridge.
  const bridges =
    props.mode === "dev" && developmentBridgeReferences(props.config).length > 0
      ? new WorkflowBridgesStack(scope, props.stackId("WorkflowBridgesStack"), {
          env: props.env,
          config: props.config,
        })
      : undefined;

  // The ordinary managed services need no bridge, only their identifier: the
  // local runner reaches them with the developer's credentials.
  if (props.mode === "dev") publishLocalWorkflowIntegrations(scope, props.config);

  if (!hasOrchestrationCloudResources(props.config, props.mode)) return bridges ? { bridges } : {};

  // `WorkflowsStack` is the deployed name of this stack, from before it held
  // agents too; it is kept so existing state machines are not replaced.
  const stack = new OrchestrationStack(scope, props.stackId("WorkflowsStack"), {
    env: props.env,
    config: props.config,
    mode: props.mode,
    cognito: props.cognito,
    workflows: getCloudTargets(props.config, ["workflow"], props.mode),
  });
  for (const dependency of props.dependencies ?? []) {
    stack.addStackDependency(dependency);
  }
  return {
    stack,
    ...(stack.agentcore ? { agentcore: stack.agentcore } : {}),
    ...(bridges ? { bridges } : {}),
  };
}

export interface FrameworkWorkloadsProps {
  readonly env: cdk.Environment;
  readonly stackId: (name: string) => string;
  readonly config: FrameworkConfig;
  /**
   * Which CDK graph this is, with every value this application's own
   * infrastructure produces. One provider rather than one per stack: the
   * sections differ in what they may *reference*, which their own contracts
   * still express, not in where a user pool id comes from.
   *
   * `mode` is the graph, so no separate `useLocalDevStack` is passed here.
   */
  readonly cloud: { readonly mode: CloudMode };
  readonly cognito: CognitoResources;
  /**
   * Where declarations that name their own `fromEnv` are read. Passed in, never
   * discovered: this module loads no `.env` file and consults no global
   * environment of its own.
   */
  readonly readers?: ResourceEnvironmentReaders;
  readonly frontendUrls: string[];
  readonly deployWebSocketApi: boolean;
  /**
   * AgentCore, from the orchestration stack, so its tool Lambdas join the
   * target inventory. Built before this factory runs: a routed handler that
   * invokes an agent reads its Runtime from the app's invocation registry.
   */
  readonly agentcore?: FrameworkAgentCore;
  /** Application ordering requirements shared by HTTP and WebSocket handlers. */
  readonly handlerDependencies?: readonly cdk.Stack[];
  /** Additional application ordering requirements for the HTTP API. */
  readonly httpApiDependencies?: readonly cdk.Stack[];
}

export interface FrameworkWorkloads {
  /**
   * Every workload stack is optional for one reason: a dev deployment holds
   * only what AWS invokes, and an empty stack is still a stack CloudFormation
   * has to create and a developer has to read past.
   */
  readonly httpHandlers?: SynchronousLambdaFunctionsStack;
  readonly webSocketHandlers?: WebSocketLambdaFunctionsStack;
  readonly services?: EcsServicesStack;
  readonly httpApi?: HttpApiGatewayStack;
  readonly webSocketApi?: WebSocketApiStack;
  readonly targets: FrameworkTargetRegistry;
  readonly skippedTargets: SkippedTargets;
}

/**
 * Project the manifest after application resources and event handlers exist.
 * Resource values and application dependencies are explicit inputs; this module
 * never imports application stacks, reads environment variables or loads config.
 */
export function createFrameworkWorkloads(
  scope: Construct,
  props: FrameworkWorkloadsProps,
): FrameworkWorkloads {
  const { config, env, stackId } = props;
  validateFrameworkConfig(config);
  const mode = props.cloud.mode;

  // One selection, used for both validation and construction, so a preflight
  // can never check an inventory the stacks below do not build. The API
  // Gateways are routers over these workloads rather than workloads of their
  // own. Event Lambdas were already constructed before their native triggers.
  //
  // Every role is selected the same way. Services used to be special-cased to
  // empty in the dev graph while HTTP, WebSocket, tasks and workflows were
  // not - which is how a dev deployment ended up with Lambdas behind no API
  // and two images in ECR. `getCloudTargets` applies the one rule to all of
  // them: a dev deployment holds only what AWS invokes.
  const httpTargets = getCloudTargets(config, ["http"], mode);
  // WebSocket handlers exist to be routed to. Without a WebSocket API in this
  // deployment nothing could invoke them, so none are built; locally the
  // WebSocket dev server runs the same handlers either way.
  const declaredWebSocketTargets = getCloudTargets(
    config,
    ["webSocket", "webSocketAuthorizer"],
    mode,
  );
  const webSocketTargets = props.deployWebSocketApi ? declaredWebSocketTargets : [];
  const serviceTargets: readonly NormalizedTarget[] = getCloudTargets(
    config,
    ["service"],
    mode,
  );

  const cloud = { mode };

  const agentcore = props.agentcore;
  const httpHandlers = httpTargets.length > 0
    ? new SynchronousLambdaFunctionsStack(
        scope, stackId("SynchronousLambdaFunctionsStack"),
        { env, config, cloud, targets: httpTargets },
      )
    : undefined;

  const services = serviceTargets.length > 0
    ? new EcsServicesStack(scope, stackId("EcsServicesStack"), {
        env, config, cloud, targets: serviceTargets,
      })
    : undefined;

  const webSocketHandlers = webSocketTargets.length > 0
    ? new WebSocketLambdaFunctionsStack(
        scope, stackId("WebSocketLambdaFunctionsStack"),
        { env, config, cloud, targets: webSocketTargets },
      )
    : undefined;

  for (const dependency of props.handlerDependencies ?? []) {
    httpHandlers?.addStackDependency(dependency);
    webSocketHandlers?.addStackDependency(dependency);
  }

  const targets = new FrameworkTargetRegistry().merge(
    ...(agentcore ? [agentcore.targets] : []),
    ...(httpHandlers ? [httpHandlers.targets] : []),
    // Every event Lambda this app built, whether by the generic stack or by an
    // application stack constructing one natively. Nothing has to be passed in
    // for one to count, and one built twice has already failed by now.
    appEventRegistry(scope),
    // Tasks and workflows, likewise: both were constructed before this factory
    // ran, because their callers need the handles.
    appInvocationRegistry(scope),
    ...(webSocketHandlers ? [webSocketHandlers.targets] : []),
    ...(services ? [services.targets] : []),
  );
  Object.values(getEventReplayManifest(config)).forEach((target) =>
    targets.requireLambda(target as LambdaTarget),
  );
  const skippedTargets = assertFrameworkTargetsComplete(config, targets, {
    mode,
    withoutWebSocketApi: new Set(
      props.deployWebSocketApi ? [] : declaredWebSocketTargets.map((target) => target.reference),
    ),
  });

  // A router with nothing to route is not built. In a dev deployment there are
  // no HTTP handlers to point it at, which is the same reason the handlers
  // themselves are absent rather than deployed behind no API.
  const httpApi = mode === "prod"
    ? new HttpApiGatewayStack(scope, stackId("HttpApiGatewayStack"), {
        env, config, targets, frontendUrls: props.frontendUrls,
        cognito: props.cognito,
      })
    : undefined;
  if (httpHandlers) httpApi?.addStackDependency(httpHandlers);
  if (services) httpApi?.addStackDependency(services);
  for (const dependency of props.httpApiDependencies ?? []) {
    httpApi?.addStackDependency(dependency);
  }

  const webSocketApi = webSocketTargets.length > 0
    ? new WebSocketApiStack(scope, stackId("WebSocketApiStack"), {
        env, config, targets, mode,
      })
    : undefined;

  return { httpHandlers, webSocketHandlers, services, httpApi, webSocketApi, targets, skippedTargets };
}
