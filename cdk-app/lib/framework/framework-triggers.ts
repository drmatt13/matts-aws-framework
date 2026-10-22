import { markInfrastructure } from "./framework-inventory";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import type { IConstruct } from "constructs";
import { createHash } from "node:crypto";
import { COGNITO_TRIGGER_OPERATIONS, normalizeFrameworkConfig, type CdkResourceSpec, type FrameworkConfig, type NormalizedFailureDestination, type NormalizedTrigger } from "@repo/framework/config";
import { eventFunction } from "./framework-events";
import { linkedConstruct } from "./framework-resources";
import { registerServiceTriggerAdapters } from "./framework-trigger-services";

export interface TriggerAttachmentContext {
  readonly binding: NormalizedTrigger;
  readonly resource: IConstruct;
  readonly fn: lambda.Function;
}

export function triggerOptionResource(context: TriggerAttachmentContext, name: string): IConstruct | undefined {
  const reference = context.binding.options[name] as unknown as CdkResourceSpec | undefined;
  if (!reference) return undefined;
  const resource = linkedConstruct(context.resource, reference)?.construct as IConstruct | undefined;
  if (!resource?.node) throw new Error(`${context.binding.origin}: ${name} is not linked in this graph.`);
  return resource;
}

export function triggerAttachmentId(binding: NormalizedTrigger): string {
  const source = createHash("sha256").update(`${binding.adapter}:${binding.resource?.path.join(".") ?? ""}`).digest("hex").slice(0, 16);
  return `FrameworkTrigger-${source}-${binding.id}`;
}
export interface CdkTriggerAdapter {
  readonly kind: string;
  /** All adapters are validated before any attachment mutates the construct tree. */
  validate(context: TriggerAttachmentContext): void;
  attach(context: TriggerAttachmentContext): void;
}
const adapters = new Map<string, CdkTriggerAdapter>();
export function registerCdkTriggerAdapter(adapter: CdkTriggerAdapter): void {
  if (adapters.has(adapter.kind)) throw new Error(`CDK trigger adapter ${adapter.kind} is already registered.`);
  adapters.set(adapter.kind, adapter);
}

const hooks: Readonly<Record<string, cognito.UserPoolOperation>> = Object.fromEntries(
  Object.entries(COGNITO_TRIGGER_OPERATIONS).map(([hook, operation]) => [hook, cognito.UserPoolOperation[operation]]),
);

registerCdkTriggerAdapter({
  kind: "cognito",
  validate({ resource, binding }) {
    if (!(resource instanceof cognito.UserPool)) throw new Error(`${binding.origin}: imported pools do not support mutation; an owned UserPool is required.`);
    const child = resource.node.defaultChild;
    if (!(child instanceof cognito.CfnUserPool)) throw new Error(`${binding.origin}: unknown native ownership, manual wiring review required.`);
    const configuration = cdk.Stack.of(resource).resolve(child.lambdaConfig) as Record<string, unknown> | undefined;
    if (configuration && (typeof configuration !== "object" || cdk.Token.isUnresolved(configuration) || Object.keys(configuration).some((key) => key === "Ref" || key.startsWith("Fn::")))) throw new Error(`${binding.origin}: unknown native ownership, manual wiring review required.`);
    const operation = String(binding.options.operation);
    if (!hooks[operation]) throw new Error(`${binding.origin}: unsupported Cognito hook.`);
    if (configuration?.[operation] !== undefined) throw new Error(`${binding.origin}: ${operation} is occupied by native wiring; review required.`);
  },
  attach({ resource, binding, fn }) {
    (resource as cognito.UserPool).addTrigger(hooks[String(binding.options.operation)]!, fn);
  },
});

registerCdkTriggerAdapter({
  kind: "eventbridge",
  validate(context) {
    const { resource, fn, binding } = context;
    if (cdk.Stack.of(fn).node.tryFindChild(triggerAttachmentId(binding))) throw new Error(`${binding.origin}: attachment identity is occupied; unknown native ownership requires review.`);
    if (typeof (resource as events.IEventBus).eventBusArn !== "string" || typeof (resource as events.IEventBus).grantPutEventsTo !== "function") throw new Error(`${binding.origin}: an EventBridge bus is required.`);
    const bus = (resource as events.IEventBus).env;
    if (cdk.Token.isUnresolved(bus.account) || cdk.Token.isUnresolved(bus.region) || bus.account !== fn.env.account || bus.region !== fn.env.region) throw new Error(`${binding.origin}: the bus and function require the same explicit account and region.`);
    const dlq = triggerOptionResource(context, "deadLetterQueue") as sqs.IQueue | undefined;
    if (dlq && (!(dlq instanceof sqs.Queue) || dlq.fifo || dlq.env.account !== fn.env.account || dlq.env.region !== fn.env.region)) throw new Error(`${binding.origin}: the dead-letter queue must be an owned standard queue in the function's account and region.`);
    if (dlq?.encryptionMasterKey && !(dlq.encryptionMasterKey instanceof kms.Key)) throw new Error(`${binding.origin}: an imported DLQ encryption key's policy requires manual review.`);
  },
  attach(context) {
    const { resource, fn, binding } = context;
    const options = binding.options;
    const stack = cdk.Stack.of(fn);
    const name = `${stack.stackName.slice(0, 24)}-trigger-${createHash("sha256").update(`${stack.stackName}:${binding.key}`).digest("hex").slice(0, 24)}`;
    // A function may read its bus. Keeping the rule in its existing owner avoids a reverse dependency.
    const rule = new events.Rule(stack, triggerAttachmentId(binding), {
      ruleName: name,
      eventBus: resource as events.IEventBus,
      eventPattern: options.eventPattern as events.EventPattern,
      enabled: options.enabled as boolean | undefined,
    });
    markInfrastructure(rule, `lambda:${binding.event}`, "supporting");
    const target = new targets.LambdaFunction(fn, {
      ...(options.input ? { event: events.RuleTargetInput.fromObject(options.input) } : {}),
      retryAttempts: options.retryAttempts as number | undefined,
      maxEventAge: options.maxEventAgeSeconds === undefined ? undefined : cdk.Duration.seconds(options.maxEventAgeSeconds as number),
    });
    const dlq = triggerOptionResource(context, "deadLetterQueue") as sqs.IQueue | undefined;
    rule.addTarget(dlq ? { bind: (owner, id) => ({ ...target.bind(owner, id), deadLetterConfig: { arn: dlq.queueArn } }) } : target);
    if (dlq) {
      // The derived physical name scopes the shared queue policy without a reverse rule-stack token.
      const principal = new iam.ServicePrincipal("events.amazonaws.com").withConditions({ ArnEquals: { "aws:SourceArn": stack.formatArn({ service: "events", resource: "rule", resourceName: name, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME }) } });
      if (!dlq.grantSendMessages(principal).success) throw new Error(`${binding.origin}: could not grant dead-letter delivery.`);
    }
  },
});

registerCdkTriggerAdapter({
  kind: "schedule",
  validate({ fn, binding }) {
    if (cdk.Stack.of(fn).node.tryFindChild(triggerAttachmentId(binding))) throw new Error(`${binding.origin}: attachment identity is occupied; unknown native ownership requires review.`);
  },
  attach({ fn, binding }) {
    const options = binding.options;
    const invocation = new schedulerTargets.LambdaInvoke(fn, options.input ? { input: scheduler.ScheduleTargetInput.fromObject(options.input) } : {});
    const schedule = new scheduler.Schedule(cdk.Stack.of(fn), triggerAttachmentId(binding), {
      schedule: scheduler.ScheduleExpression.expression(String(options.expression), typeof options.timezone === "string" ? cdk.TimeZone.of(options.timezone) : undefined),
      target: { bind: owner => {
        const target = invocation.bind(owner);
        // CDK shares this role by target and places it beside the schedule.
        // Its native identity stays intact; each same-target schedule records
        // the same workload owner instead of inheriting traversal order.
        markInfrastructure(target.role, `lambda:${binding.event}`, "supporting");
        return target;
      } },
      enabled: options.enabled as boolean | undefined,
      description: `${binding.event}: ${binding.id}`,
    });
    markInfrastructure(schedule, `lambda:${binding.event}`, "supporting");
  },
});

registerServiceTriggerAdapters();

/** The composition root finalizes resources only after every native owner has finished. */
export function attachFrameworkTriggers(scope: IConstruct, config: FrameworkConfig): void {
  const normalized = normalizeFrameworkConfig(config);
  const prepared = normalized.triggers.map((binding) => {
    const adapter = adapters.get(binding.adapter);
    if (!adapter) throw new Error(`${binding.origin}: no CDK adapter registered for ${binding.adapter}.`);
    const fn = eventFunction(scope, binding.event);
    // A resourceless trigger creates its own source beside the function.
    const resource = binding.resource ? linkedConstruct(scope, binding.resource)?.construct as IConstruct | undefined : fn;
    if (!resource?.node) throw new Error(`${binding.origin}: resources.${binding.resource!.path.join(".")} is not linked in this graph.`);
    const context = { resource, fn, binding };
    adapter.validate(context);
    return { adapter, context };
  });
  for (const { adapter, context } of prepared) adapter.attach(context);
  attachFailureDestinations(scope, normalized.failureDestinations);
}

/** Each event's onFailure: a standard queue or topic that receives runs Lambda stopped retrying. */
function attachFailureDestinations(scope: IConstruct, failures: readonly NormalizedFailureDestination[]): void {
  for (const failure of failures) {
    const fn = eventFunction(scope, failure.event);
    const destination = linkedConstruct(scope, failure.destination)?.construct as IConstruct | undefined;
    if (!destination?.node) throw new Error(`${failure.origin}: resources.${failure.destination.path.join(".")} is not linked in this graph.`);
    const queue = destination as sqs.IQueue, topic = destination as sns.ITopic;
    const onFailure = typeof queue.queueArn === "string" && typeof queue.grantSendMessages === "function" ? (queue.fifo ? undefined : new destinations.SqsDestination(queue))
      : typeof topic.topicArn === "string" && typeof topic.grantPublish === "function" ? (topic.fifo ? undefined : new destinations.SnsDestination(topic))
      : undefined;
    if (!onFailure) throw new Error(`${failure.origin}: the destination must be a standard SQS queue or SNS topic.`);
    if (fn.node.tryFindChild("EventInvokeConfig")) throw new Error(`${failure.origin}: ${fn.node.path} already configures asynchronous invocation natively; keep one of them.`);
    fn.configureAsyncInvoke({
      onFailure,
      ...(failure.retryAttempts !== undefined ? { retryAttempts: failure.retryAttempts } : {}),
      ...(failure.maxEventAgeSeconds !== undefined ? { maxEventAge: cdk.Duration.seconds(failure.maxEventAgeSeconds) } : {}),
    });
  }
}
