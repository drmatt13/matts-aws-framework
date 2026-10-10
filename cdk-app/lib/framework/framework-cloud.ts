import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { createHash } from "crypto";
import {
  formatAccessResource,
  getCallbackBindings,
  getInvocationBindings,
  getAgentInvocationBindings,
  INVOCATION_DESCRIPTOR_VERSION,
  LAMBDA_ENVIRONMENT_BYTE_LIMIT,
  resolveCloudValues,
  resolveLambdaTarget,
  type CloudMode,
  type FrameworkConfig,
  type NormalizedTarget,
  type ResolvedCloudValues,
  type SecretHandle,
} from "@repo/framework/config";
import { frameworkLambda } from "./framework-lambda";
import { isPlacedInNetwork, lambdaPlacement } from "./framework-network";
import { connectDatabase } from "./framework-database";
import { appInvocationRegistry } from "./framework-tasks";
import { FrameworkTargetRegistry } from "./framework-target-registry";
import { applyNativeGrant, deferResourceAttachment, hasFrameworkResources, resourceValuesForTarget } from "./framework-resources";

/**
 * Turning a target's declarations into AWS resources.
 *
 * `framework.config.ts` says what each workload needs; this says how a need
 * becomes a construct. It is deliberately generic: there is no switch on target
 * ids here, and adding a workload that uses existing resources adds nothing to
 * this file.
 */

/** The config being built, and which graph it is. */
export interface CloudBuildContext {
  readonly config: FrameworkConfig;
  readonly mode: CloudMode;
}

/**
 * One imported secret per distinct ARN per stack.
 *
 * `fromSecretCompleteArn` creates no CloudFormation resource, so this is about
 * the construct tree rather than the template — but two targets reading one
 * secret should still resolve through one construct.
 */
const importedSecrets = new WeakMap<cdk.Stack, Map<string, secretsmanager.ISecret>>();

export function importSecret(
  scope: Construct,
  handle: SecretHandle,
): secretsmanager.ISecret {
  const stack = cdk.Stack.of(scope);
  let byArn = importedSecrets.get(stack);
  if (!byArn) {
    byArn = new Map();
    importedSecrets.set(stack, byArn);
  }
  const cached = byArn.get(handle.secretArn);
  if (cached) return cached;

  // A token ARN has no stable text to name a construct after, so the id is
  // derived from what the token resolves to — serialized, because an
  // unresolved reference resolves to an object, and every one of those would
  // otherwise stringify to the same thing and collide.
  const digest = createHash("sha256")
    .update(JSON.stringify(stack.resolve(handle.secretArn)) ?? handle.secretArn)
    .digest("hex")
    .slice(0, 12);
  const secret = handle.encryptionKeyArn
    ? secretsmanager.Secret.fromSecretAttributes(stack, `ImportedSecret${digest}`, {
        secretCompleteArn: handle.secretArn,
        encryptionKey: kms.Key.fromKeyArn(
          stack,
          `ImportedSecretKey${digest}`,
          handle.encryptionKeyArn,
        ),
      })
    : secretsmanager.Secret.fromSecretCompleteArn(
        stack,
        `ImportedSecret${digest}`,
        handle.secretArn,
      );
  byArn.set(handle.secretArn, secret);
  return secret;
}

/**
 * The decrypt permission a customer-managed secret needs, on the reader itself.
 *
 * `ISecret.grantRead` routes decryption through a `ViaServicePrincipal`, which
 * an *imported* key cannot record anywhere: it has no key policy to write to,
 * and the wrapper never reaches the reading role's own policy. Every linked
 * secret arrives here imported — the real construct lives in the stack that
 * owns it — so the statement is written directly, scoped to that one key and
 * to Secrets Manager, which is the access CDK meant to grant.
 *
 * @see https://docs.aws.amazon.com/kms/latest/developerguide/services-secrets-manager.html
 */
function grantSecretDecryption(scope: Construct, handle: SecretHandle, grantee: iam.IGrantable): void {
  if (!handle.encryptionKeyArn) return;
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["kms:Decrypt"],
      resources: [handle.encryptionKeyArn],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${cdk.Stack.of(scope).region}.amazonaws.com`,
        },
      },
    }),
  );
}

/** A target's declarations with every reference replaced by a supplied value. */
export function resolveTargetCloudValues(
  target: NormalizedTarget,
  scope: Construct,
): ResolvedCloudValues {
  return resolveCloudValues(
    target,
    resourceValuesForTarget(scope, target),
    target.origins[0] ?? target.reference,
  );
}

/**
 * Applies the permissions a target declared to its own role: the read grant
 * each binding implies, plus any statement with no capability of its own.
 */
export function applyCloudPermissions(
  scope: Construct,
  grantee: iam.IGrantable,
  target: NormalizedTarget,
  values: ResolvedCloudValues,
): void {
  for (const binding of target.cloud.bindings) {
    if (binding.capability === "nativeGrant") applyNativeGrant(scope, grantee, binding, target.reference);
  }
  for (const binding of values.bindings) {
    importSecret(scope, binding.secret).grantRead(grantee);
    grantSecretDecryption(scope, binding.secret, grantee);
  }

  applyInvocationGrants(scope, grantee, target);
  applyCallbackGrants(grantee, target);

  const stack = cdk.Stack.of(scope);
  for (const statement of target.cloud.access) {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [...statement.actions],
        resources: statement.resources.map((template) =>
          formatAccessResource(template, {
            partition: cdk.Aws.PARTITION,
            account: stack.account,
            region: stack.region,
          }),
        ),
      }),
    );
  }
}

export function attachLambdaResources(scope: Construct, fn: lambda.Function, target: NormalizedTarget, context: CloudBuildContext): void {
  deferResourceAttachment(scope, () => {
    const values = resolveTargetCloudValues(target, scope);
    const environment = {
      ...values.environment,
      ...resolveInvocationDescriptors(scope, target),
      ...connectDatabase(scope, fn, target),
      // From the private subnets only IPv6 leaves, and several AWS APIs answer
      // IPv6 only on their dual-stack hostnames. Set in both lanes.
      ...(isPlacedInNetwork(scope, target) ? { AWS_USE_DUALSTACK_ENDPOINT: "true" } : {}),
    };
    assertLambdaEnvironmentBudget(target.id, environment);
    for (const [name, value] of Object.entries(environment)) fn.addEnvironment(name, value);
    applyCloudPermissions(scope, fn, target, values);
  });
}

export function attachContainerResources(scope: Construct, container: ecs.ContainerDefinition, grantee: iam.IGrantable, target: NormalizedTarget, context: CloudBuildContext): void {
  deferResourceAttachment(scope, () => {
    const values = resolveTargetCloudValues(target, scope);
    const environment = { ...values.environment, ...resolveInvocationDescriptors(scope, target), ...connectDatabase(scope, grantee, target) };
    for (const [name, value] of Object.entries(environment)) container.addEnvironment(name, value);
    for (const [name, secret] of Object.entries(values.secrets)) {
      // ECS reads a startup secret before the task runs, so the decrypt
      // permission belongs to the execution role, not to the task's grantee.
      container.addSecret(name, ecs.Secret.fromSecretsManager(importSecret(scope, secret.handle), secret.field));
      grantSecretDecryption(scope, secret.handle, container.taskDefinition.obtainExecutionRole());
    }
    applyCloudPermissions(scope, grantee, target, values);
  });
}

/**
 * Permission to answer the callbacks this worker declared it answers.
 *
 * `Resource: "*"` is not a shortcut. The Step Functions callback actions do not
 * support resource-level scoping — a task token is not an ARN, and there is
 * nothing narrower to name. AWS's own action reference says so, and the honest
 * response is to grant only the three actions, and only to the workers that
 * declared `completesCallback(...)`, rather than to pretend a condition exists.
 *
 * The token itself is the real control: it is minted per attempt, it is
 * invalidated when a step is retried, and the first terminal completion wins.
 *
 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_stepfunctions.html
 */
function applyCallbackGrants(
  grantee: iam.IGrantable,
  target: NormalizedTarget,
): void {
  const callbacks = getCallbackBindings(target.cloud.bindings);
  if (callbacks.length === 0) return;
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "states:SendTaskSuccess",
        "states:SendTaskFailure",
        "states:SendTaskHeartbeat",
      ],
      resources: ["*"],
    }),
  );
}

/**
 * The descriptors a target's invocation bindings inject, as environment.
 *
 * One versioned JSON document per binding, under a reserved name derived from
 * the destination's id. Every field may be an unresolved token: a token inside
 * a JSON string survives `JSON.stringify` and is resolved by CloudFormation at
 * deploy time, which is what lets a caller in one stack carry a task-definition
 * ARN from another without the ARN existing at synth.
 *
 * `transport: "aws"` is written unconditionally here, in *both* AWS graph
 * modes. That is the point of the whole descriptor design: a Lambda actually
 * running in AWS in the dev stack needs an AWS destination, because it cannot
 * reach the developer's Compose network, and no amount of `PROD_DEPLOYMENT`
 * would make that true. The local projection is written by local startup, into
 * processes that really are local.
 */
export function resolveInvocationDescriptors(
  scope: Construct,
  target: NormalizedTarget,
): Readonly<Record<string, string>> {
  const registry = appInvocationRegistry(scope);
  const environment: Record<string, string> = {};
  for (const binding of getAgentInvocationBindings(target.cloud.bindings)) {
    const agent = registry.requireAgent(binding.agent);
    environment[binding.environment] = JSON.stringify({
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind: "agent",
      transport: "aws",
      target: binding.agent,
      auth: agent.auth,
      arn: agent.arn,
      region: agent.region,
    });
  }

  for (const binding of getInvocationBindings(target.cloud.bindings)) {
    if (binding.capability === "runsTask") {
      const handle = registry.requireTask(`task:${binding.task}`);
      environment[binding.environment] = JSON.stringify({
        version: INVOCATION_DESCRIPTOR_VERSION,
        kind: "task",
        transport: "aws",
        target: binding.task,
        launch: handle.launch,
      });
      continue;
    }
    const handle = registry.requireWorkflow(`workflow:${binding.workflow}`);
    environment[binding.environment] = JSON.stringify({
      version: INVOCATION_DESCRIPTOR_VERSION,
      kind: "workflow",
      transport: "aws",
      target: binding.workflow,
      region: cdk.Stack.of(scope).region,
      stateMachineArn: handle.stateMachine.stateMachineArn,
    });
  }

  return environment;
}

/** The launch and start grants a target's invocation bindings imply. */
export function applyInvocationGrants(
  scope: Construct,
  grantee: iam.IGrantable,
  target: NormalizedTarget,
): void {
  const registry = appInvocationRegistry(scope);
  for (const binding of getInvocationBindings(target.cloud.bindings)) {
    // A binding grants a direct edge only. A caller of A gets nothing on
    // whatever A itself calls; that is a declaration on A.
    if (binding.capability === "runsTask") {
      registry.requireTask(`task:${binding.task}`).grantRun(grantee);
      continue;
    }
    registry.requireWorkflow(`workflow:${binding.workflow}`).grantStart(grantee);
  }
  // An agent with users accepts only the user's token, which its caller
  // forwards; an IAM grant on its Runtime would authorize nothing.
  for (const binding of getAgentInvocationBindings(target.cloud.bindings)) {
    const agent = registry.requireAgent(binding.agent);
    if (!agent.auth) agent.grantInvoke(grantee);
  }
}

/**
 * Rejects an environment that will not fit before AWS does.
 *
 * Lambda caps the total size of the environment, and injected descriptors count
 * against it. Only what is already concrete can be measured: an unresolved
 * token has no length yet, and CDK does not know what it will become — so the
 * budget is checked on what is known and the estimate is reported as an
 * estimate. AWS enforces the final expanded size, and no descriptor store is
 * introduced here to pretend otherwise.
 */
export function assertLambdaEnvironmentBudget(
  targetId: string,
  environment: Readonly<Record<string, string>>,
): void {
  let known = 0;
  let tokens = 0;
  for (const [name, value] of Object.entries(environment)) {
    known += name.length + 1;
    if (cdk.Token.isUnresolved(value)) {
      tokens += 1;
      continue;
    }
    known += value.length;
  }
  if (known <= LAMBDA_ENVIRONMENT_BYTE_LIMIT) return;
  throw new Error(
    `Lambda target "${targetId}" declares ${known} bytes of environment, over Lambda's ${LAMBDA_ENVIRONMENT_BYTE_LIMIT}-byte limit${
      tokens > 0
        ? `, and ${tokens} value(s) are unresolved tokens that will add more`
        : ""
    }. Remove a binding, or move configuration into a value the workload reads at runtime.`,
  );
}

/** Emits the outputs a target declared, if it declared any. */
export function emitCloudOutputs(
  stack: cdk.Stack,
  target: NormalizedTarget,
  values: Readonly<Record<string, string>>,
): void {
  for (const [name, spec] of Object.entries(target.cloud.outputs)) {
    const value = values[name];
    if (value === undefined) continue;
    new cdk.CfnOutput(stack, spec.id, {
      value,
      ...(spec.exportName
        ? { exportName: `${stack.stackName}:${spec.exportName}` }
        : {}),
    });
  }
}

/**
 * Builds every enabled target of the given roles, registers it, and applies its
 * declarations.
 *
 * Construction is from the unique target collection rather than from route
 * entries, so two routes pointing at one Lambda build one Lambda — and each
 * target is resolved and registered exactly once.
 */
export function buildFrameworkLambdas(
  stack: cdk.Stack,
  registry: FrameworkTargetRegistry,
  targets: readonly NormalizedTarget[],
  context: CloudBuildContext,
  lambdaScope: Construct = stack,
): Map<string, lambda.Function> {
  const built = new Map<string, lambda.Function>();

  for (const target of targets) {
    const fn = frameworkLambda(
      lambdaScope,
      target.cloud.constructId,
      resolveLambdaTarget(context.config, target.id),
      // An empty environment stays undefined so a function that needs nothing
      // keeps the template it has today.
      {},
      lambdaPlacement(stack, target),
    );
    registry.lambda(target.id, fn);
    attachLambdaResources(stack, fn, target, context);
    built.set(target.id, fn);
  }

  // Emitted in a second pass so a stack's outputs stay grouped after its
  // functions, exactly as the hand-written tables produced them.
  for (const target of targets) {
    const fn = built.get(target.id);
    if (fn) emitCloudOutputs(stack, target, { arn: fn.functionArn });
  }

  return built;
}
