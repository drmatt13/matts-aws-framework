import { Construct, type IConstruct } from "constructs";
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import {
  DATABASE_ENVIRONMENT_KEYS,
  getCallbackBindings,
  getConnectsToBindings,
  getEventReplayManifest,
  getEventReplayTarget,
  normalizeFrameworkConfig,
  resolveLambdaTarget,
  type CloudMode,
  type FrameworkConfig,
  type NormalizedTarget,
  type ResourceEnvironmentReaders,
  type ResolvedCloudValues,
  type SuggestedEventId,
} from "@repo/framework/config";
import {
  frameworkLambdaById,
  type FrameworkLambdaOptions,
} from "./framework-lambda";
import { FrameworkTargetRegistry } from "./framework-target-registry";
import { lambdaPlacement } from "./framework-network";
import {
  attachLambdaResources,
  assertLambdaEnvironmentBudget,
  emitCloudOutputs,
  resolveInvocationDescriptors,
  resolveTargetCloudValues,
} from "./framework-cloud";

export type EventTargetId<C extends FrameworkConfig> = Extract<
  keyof C["events"],
  string
>;

export interface EventLambdaContext<C extends FrameworkConfig> {
  readonly config: C;
  readonly targets: FrameworkTargetRegistry;
  /** Provider values, before resolving env-backed inputs. */
  readonly cloud: { readonly mode: CloudMode };
  readonly readers?: ResourceEnvironmentReaders;
  readonly replay?: {
    readonly bucket: s3.IBucket;
    readonly queue: sqs.IQueue;
  };
}

const REPLAY_ENVIRONMENT_KEYS = [
  "USE_LOCAL_DEV_STACK",
  "DEV_LAMBDA_REPLAY_BUCKET_NAME",
  "DEV_LAMBDA_REPLAY_QUEUE_URL",
  "FRAMEWORK_REPLAY_ID",
] as const;

function validateEvent<C extends FrameworkConfig>(
  context: EventLambdaContext<C>,
  targetId: string,
) {
  const target = normalizeFrameworkConfig(context.config).targets.get(
    `lambda:${targetId}`,
  );
  if (!target || target.role !== "event") {
    throw new Error(
      `Framework event target "${targetId}" is not an event Lambda in the resolved config.`,
    );
  }
  if (context.targets.get(`lambda:${targetId}`)) {
    throw new Error(
      `Framework target "lambda:${targetId}" is registered more than once.`,
    );
  }
  if (!context.cloud || !["dev", "prod"].includes(context.cloud.mode)) {
    throw new Error(
      `Framework event target "${targetId}" requires an explicit cloud.mode (dev or prod).`,
    );
  }
  const local = context.cloud.mode === "dev";
  if (!local && context.replay) {
    throw new Error(
      `Framework event target "${targetId}": replay resources require a dev deployment.`,
    );
  }
  const capture =
    local &&
    !!getEventReplayTarget(getEventReplayManifest(context.config), targetId);
  if (capture) {
    const missing = [
      !context.replay?.bucket?.bucketName && "replay.bucket",
      !context.replay?.queue?.queueUrl && "replay.queue",
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(
        `Framework event target "${targetId}" requires ${missing.join(" and ")} for local replay.`,
      );
    }
  }
  return { target, capture };
}

interface PreparedEvent {
  readonly target: NormalizedTarget;
  readonly capture: boolean;
}

/** Preflight the entire selection before constructing any of its functions. */
function prepareEvents<C extends FrameworkConfig>(
  scope: Construct,
  context: EventLambdaContext<C>,
  ids: readonly EventTargetId<C>[],
): PreparedEvent[] {
  if (new Set(ids).size !== ids.length) {
    throw new Error("Framework event selection contains duplicate target ids.");
  }
  const events = ids.map((id) => validateEvent(context, id));
  // The one image a dev deployment can still publish, named before it happens.
  // An event Lambda deploys in every graph because AWS invokes it, and a
  // container-packaged Lambda cannot deploy without an image - so this follows
  // from the rule rather than being an exception to it. Nothing else reaches
  // ECR in a dev deployment.
  if (context.cloud.mode === "dev") {
    const containers = events
      .filter(
        (event) =>
          resolveLambdaTarget(context.config, event.target.id).packaging ===
          "container",
      )
      .map((event) => event.target.reference);
    if (containers.length > 0) {
      console.warn(
        `[cdk-app] A dev deployment publishes no images to ECR except for container-packaged event functions, which AWS invokes and so cannot omit: ${containers.join(", ")}. Declare packaging: "zip" to avoid the push.`,
      );
    }
  }

  return events.map((event) => {
    validateReplayEnvironment(
      event.target.id,
      declaredEnvironment(event.target),
    );
    return event;
  });
}

/** Includes inactive bindings: their names still belong to the declaration. */
function declaredEnvironment(
  target: NormalizedTarget,
): Record<string, unknown> {
  return {
    ...target.environment,
    ...Object.fromEntries(
      target.cloud.bindings
        // A callback completion injects no environment: it is routed by the
        // worker's own framework-issued variables and the handle in the message.
        .filter((binding) => binding.capability !== "completesCallback" && binding.capability !== "nativeGrant" && binding.capability !== "connectsTo")
        .map((binding) => [binding.environment, true]),
    ),
    ...(getConnectsToBindings(target.cloud.bindings).length > 0
      ? Object.fromEntries(DATABASE_ENVIRONMENT_KEYS.map((name) => [name, true]))
      : {}),
  };
}

function validateNativeEnvironment(
  event: PreparedEvent,
  environment: Record<string, unknown>,
): void {
  validateReplayEnvironment(event.target.id, environment);
  for (const key of Object.keys(declaredEnvironment(event.target))) {
    if (key in environment) {
      throw new Error(
        `Framework event target "${event.target.id}": environment key "${key}" is owned by its config declaration.`,
      );
    }
  }
}

function validateConstructId<C extends FrameworkConfig>(
  context: EventLambdaContext<C>,
  targetId: string,
  constructId: string,
): void {
  const pinned = context.config.events[targetId]?.cloud?.constructId;
  if (pinned !== undefined && pinned !== constructId) {
    throw new Error(
      `Framework event target "${targetId}": construct id "${constructId}" conflicts with cloud.constructId "${pinned}".`,
    );
  }
}

function validateReplayEnvironment(
  targetId: string,
  environment: Record<string, unknown>,
) {
  for (const key of REPLAY_ENVIRONMENT_KEYS) {
    if (key in environment) {
      throw new Error(
        `Framework event target "${targetId}": environment key "${key}" is reserved for the replay helper.`,
      );
    }
  }
}

/** Build in the application's scope, preserving its construct path and ownership. */
export function createEventLambda<C extends FrameworkConfig>(
  scope: Construct,
  constructId: string,
  context: EventLambdaContext<C>,
  targetId: EventTargetId<C>,
  options: FrameworkLambdaOptions = {},
): lambda.Function {
  // Fail before construction (including bundling) whenever possible.
  const [event] = prepareEvents(scope, context, [targetId]);
  return createPreparedEvent(scope, constructId, context, event, options);
}

function createPreparedEvent<C extends FrameworkConfig>(
  scope: Construct,
  constructId: string,
  context: EventLambdaContext<C>,
  event: PreparedEvent,
  options: FrameworkLambdaOptions = {},
): lambda.Function {
  validateConstructId(context, event.target.id, constructId);
  validateNativeEnvironment(event, options.environment ?? {});
  const fn = frameworkLambdaById(
    scope,
    constructId,
    context.config,
    event.target.id,
    options,
    lambdaPlacement(scope, event.target),
  );
  return registerPreparedEvent(context, event, fn);
}

/** The generic stack and native owners use the same construction path. */
export function buildEventLambdas<C extends FrameworkConfig>(
  scope: Construct,
  context: EventLambdaContext<C>,
  ids: readonly EventTargetId<C>[],
): void {
  const events = prepareEvents(scope, context, ids);
  for (const event of events) {
    createPreparedEvent(scope, event.target.cloud.constructId, context, event);
  }
}

/**
 * Register an application-built mutable function, preserving its subtype.
 * Build overrides must already have been applied by its native constructor.
 * Registration applies declared environment, permissions, outputs and replay;
 * it cannot apply build settings retroactively.
 */
export function registerEventLambda<
  C extends FrameworkConfig,
  T extends lambda.Function,
>(context: EventLambdaContext<C>, targetId: EventTargetId<C>, fn: T): T {
  const [event] = prepareEvents(fn, context, [targetId]);
  return registerPreparedEvent(context, event, fn);
}

function registerPreparedEvent<
  C extends FrameworkConfig,
  T extends lambda.Function,
>(context: EventLambdaContext<C>, event: PreparedEvent, fn: T): T {
  const { target, capture } = event;
  const targetId = target.id;
  if (!(fn instanceof lambda.Function)) {
    throw new Error(
      `Framework event target "${targetId}" requires a mutable lambda.Function for replay registration.`,
    );
  }
  validateConstructId(context, targetId, fn.node.id);
  // Read the public L1 view rather than Lambda's private environment map.
  const resource = fn.node.defaultChild;
  if (resource instanceof lambda.CfnFunction) {
    const environment = resource.stack.resolve(resource.environment) as
      { variables?: Record<string, unknown> } | undefined;
    validateNativeEnvironment(event, environment?.variables ?? {});
  }
  // A worker that completes callbacks needs the same bucket, for a different
  // reason: in a development deployment the execution waiting for its answer is
  // on a developer's machine, which this function cannot reach. The replay
  // bucket is the path that already exists between the two, and the local
  // dispatcher that drains it forwards the completion to the private runner.
  const completesCallbacks =
    getCallbackBindings(target.cloud.bindings).length > 0;
  if ((capture || completesCallbacks) && context.replay) {
    const grant = context.replay.bucket.grantWrite(fn);
    if (!grant.success) {
      throw new Error(
        `Framework event target "${targetId}": could not grant replay bucket write access to the function's role.`,
      );
    }
    fn.addEnvironment("USE_LOCAL_DEV_STACK", "true");
    fn.addEnvironment(
      "DEV_LAMBDA_REPLAY_BUCKET_NAME",
      context.replay.bucket.bucketName,
    );
    fn.addEnvironment(
      "DEV_LAMBDA_REPLAY_QUEUE_URL",
      context.replay.queue.queueUrl,
    );
    // Which declaration this function is, so `withLocalReplay` needs no id
    // argument and a handler cannot capture under another target's name.
    if (capture) fn.addEnvironment("FRAMEWORK_REPLAY_ID", targetId);
  }
  // Declared values first, then the descriptors the target's invocation
  // bindings inject. Both are checked against Lambda's environment budget
  // together, because AWS charges the function for the total.
  attachLambdaResources(fn, fn, target, { config: context.config, mode: context.cloud.mode });
  emitCloudOutputs(Stack.of(fn), target, { arn: fn.functionArn });
  // Recorded app-wide before the owner's own registry, so two owners claiming
  // one id fail here rather than at the merge in the composition root.
  appEventRegistry(fn).lambda(targetId, fn);
  return context.targets.lambda(targetId, fn);
}

/**
 * Every event Lambda built in one CDK app, whoever built it.
 *
 * Keyed on the app's root node rather than kept in a module-level singleton, so
 * the several apps a test file builds never see each other's functions. Nothing
 * is added to the construct tree, so no template changes.
 */
const APP_EVENT_REGISTRIES = new WeakMap<IConstruct, FrameworkTargetRegistry>();

export function appEventRegistry(scope: IConstruct): FrameworkTargetRegistry {
  const root = scope.node.root;
  let registry = APP_EVENT_REGISTRIES.get(root);
  if (!registry) {
    registry = new FrameworkTargetRegistry();
    APP_EVENT_REGISTRIES.set(root, registry);
  }
  return registry;
}

/**
 * The event Lambda `id` names, ready to hand to any AWS construct.
 *
 * This is the whole path from a declaration under `framework-config/events/` to
 * a native trigger: the stack creating the trigger asks for the function where
 * it needs it, instead of being handed one through props from the entrypoint.
 *
 * No stack dependency is added here, on purpose. CDK adds the edge itself when
 * a reference actually crosses stacks — that is what gives `CognitoStack` its
 * `Fn::ImportValue`s. Forcing one would be wrong in the other direction:
 * `fn.addEventSource(source)` puts the mapping and its grant in the *function's*
 * stack, so that stack depends on the source's, and a forced edge back would
 * close the cycle.
 */
export function eventFunction(
  scope: IConstruct,
  id: SuggestedEventId,
): lambda.Function {
  const registry = appEventRegistry(scope);
  const registered = registry.get(`lambda:${id}`);
  if (!registered) {
    // Only events are recorded here, so every entry is one of the ids that
    // would have worked.
    const built = [...registry.entries()].map(([reference]) =>
      reference.slice("lambda:".length),
    );
    throw new Error(
      `Event Lambda "${id}" is not built in this app. Declare it under framework-config/events/ and construct EventLambdaFunctionsStack (or call createEventLambda) before the stack that triggers it. Built here: ${
        built.length > 0 ? built.join(", ") : "nothing yet"
      }.`,
    );
  }
  const fn = registered.kind === "lambda" ? registered.function : undefined;
  if (!(fn instanceof lambda.Function)) {
    throw new Error(
      `Event Lambda "${id}" is registered as an imported function; a native trigger needs the mutable construct.`,
    );
  }
  return fn;
}
