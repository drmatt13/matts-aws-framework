import { integrationIdForPath, isCdkResource, type CdkResourceSpec } from "./cdk-resources";
/**
 * What a workflow step points at.
 *
 * A step names a resource the catalog already holds — `resources.orders.recordsTable`
 * — so there is no second declaration of it and nothing to keep in step. The
 * kind comes from the operation, not from the reference: calling
 * `dynamodb.get(...)` is what says "this is a table", and a queue passed there
 * fails to compile against the construct type the operation asks for.
 *
 * ```ts
 * // framework-config/resources.ts � the stack's own constructs
 * export const resources = defineResources({ orders: resource.stack<OrdersStack>() });
 *
 * // in a workflow graph
 * dynamodb.update<Order, { orderId: string }>(resources.orders.recordsTable, {
 *   key: { orderId: input.orderId },
 *   set: { status: "approved" },
 * });
 * ```
 *
 * Application CDK does nothing extra: `linkResources(this, resources.orders)`
 * beside the constructs is the whole binding, and the workflow finds the table
 * through the same link a Lambda's environment variable uses.
 */

/** The kinds of resource a workflow step can be pointed at. */
export const INTEGRATION_KINDS = [
  "table",
  "queue",
  "topic",
  "eventBus",
  "httpConnection",
  "awsOperation",
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/**
 * A phantom marker carrying the reference's application types.
 *
 * Type-only — `declare const` means it never exists at runtime. It is what lets
 * `sqs.request(approvals, message)` typecheck the message against the queue's
 * declared shape and give the step the queue's declared result type.
 */
export declare const INTEGRATION_TYPES: unique symbol;

/** What every reference carries, whatever it points at. */
export interface IntegrationSpec {
  readonly kind: IntegrationKind;
  /** Stable, kebab-case, and unique within its kind. */
  readonly id: string;
  /**
   * The catalog entry holding the construct, for the four kinds that have one.
   *
   * This is what replaced a declared binding: the construct is already linked
   * for every other consumer, so a workflow resolves it through the same link
   * rather than through a registry of its own.
   */
  readonly resource?: CdkResourceSpec;
  /** `awsOperation` only: the AWS service the operation belongs to. */
  readonly service?: string;
  /** `awsOperation` only: the API action, camelCase as the SDK spells it. */
  readonly action?: string;
}

export interface IntegrationReference<Kind extends IntegrationKind, Types>
  extends IntegrationSpec {
  readonly kind: Kind;
  readonly [INTEGRATION_TYPES]: Types;
}

/** An EventBridge Connection: an endpoint plus the authentication for it. */
export type HttpConnectionReference = IntegrationReference<
  "httpConnection",
  { readonly connection: true }
>;

/** One explicitly bound AWS API action. */
export type AwsOperationReference<Input, Output> = IntegrationReference<
  "awsOperation",
  { readonly input: Input; readonly output: Output }
>;

/** Any reference, where the kind matters and the types do not. */
export type AnyIntegrationReference = IntegrationReference<IntegrationKind, unknown>;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function reference<Kind extends IntegrationKind, Types>(
  kind: Kind,
  id: string | undefined,
  extra: { readonly service?: string; readonly action?: string } = {},
): IntegrationReference<Kind, Types> {
  if (id !== undefined && (typeof id !== "string" || !ID_PATTERN.test(id))) {
    throw new Error(
      `A ${kind} reference needs a stable kebab-case id, such as "order-approvals". Received ${JSON.stringify(id)}.`,
    );
  }
  return Object.freeze({ kind, id: id ?? "", ...extra }) as unknown as IntegrationReference<Kind, Types>;
}

/**
 * The reference a step holds, derived from the catalog entry it was given.
 *
 * The kind is the operation's, not the author's: `dynamodb.get` produces a
 * table reference and nothing else can. The id is the catalog path, so two
 * steps naming one construct name one integration, and neither had to invent a
 * spelling for it.
 */
export function integrationFor<Kind extends IntegrationKind, Types>(
  kind: Kind,
  resource: unknown,
  origin: string,
): IntegrationReference<Kind, Types> {
  // An attribute projection carries `$resource` rather than `$cdk`, so this
  // also rejects `resources.orders.recordsTable.tableName` — reading a member
  // off the proxy is what mints one, and a step wants the table, not its name.
  if (!isCdkResource(resource) || !resource.path.length) {
    throw new Error(
      `${origin} takes a catalog resource, such as resources.orders.recordsTable. Declare the stack that owns it with resource.stack<OrdersStack>().`,
    );
  }
  return Object.freeze({
    kind,
    id: integrationIdForPath(resource.path),
    resource,
  }) as unknown as IntegrationReference<Kind, Types>;
}

/** Whether a value is an integration reference rather than ordinary data. */
export function isIntegrationReference(value: unknown): value is AnyIntegrationReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IntegrationSpec).id === "string" &&
    (INTEGRATION_KINDS as readonly string[]).includes((value as IntegrationSpec).kind)
  );
}

/** `queue:approvals` — how a reference is named in messages and registries. */
export function integrationKey(spec: IntegrationSpec): string {
  return `${spec.kind}:${spec.id}`;
}

export function assertIntegrationKind<Kind extends IntegrationKind>(
  spec: unknown,
  kind: Kind,
  origin: string,
): IntegrationReference<Kind, unknown> {
  if (!isIntegrationReference(spec)) {
    throw new Error(
      `${origin} takes a catalog resource, such as resources.orders.processingQueue.`,
    );
  }
  if (spec.kind !== kind) {
    throw new Error(
      `${origin} takes a ${kind} reference and was given ${integrationKey(spec)}.`,
    );
  }
  return spec as IntegrationReference<Kind, unknown>;
}

// ---------------------------------------------------------------------------
// The two that are not catalog resources
//
// A table, queue, topic or bus is a construct, so it comes from the catalog. An
// HTTP endpoint and a named AWS action are not: the first is an address plus a
// credential, the second is an API call with a hand-written grant. Both are
// declared where the workflow is and bound explicitly in CDK.
// ---------------------------------------------------------------------------

export function httpConnectionReference(id: string): HttpConnectionReference {
  return reference<"httpConnection", { readonly connection: true }>(
    "httpConnection",
    id,
  );
}

/**
 * One AWS API action, named explicitly.
 *
 * Explicit because the alternative — inferring a call and its permissions from
 * a service name and an arbitrary action — cannot produce a policy anyone
 * should deploy. The action is declared, the grant is written beside the
 * resource in CDK, and nothing here guesses at either.
 */
export function awsOperationReference<Input, Output>(
  id: string,
  operation: { readonly service: string; readonly action: string },
): AwsOperationReference<Input, Output> {
  if (
    typeof operation?.service !== "string" ||
    operation.service.length === 0 ||
    typeof operation.action !== "string" ||
    operation.action.length === 0
  ) {
    throw new Error(
      `aws.operation("${id}") needs { service, action }, such as { service: "translate", action: "translateText" }.`,
    );
  }
  return reference<
    "awsOperation",
    { readonly input: Input; readonly output: Output }
  >("awsOperation", id, operation);
}

// ---------------------------------------------------------------------------
// What a graph asks of a resource
// ---------------------------------------------------------------------------

/**
 * The operations a step can perform, by service.
 *
 * A closed set per service, because each one is a specific AWS integration with
 * its own arguments, its own result shape and its own grant. "Whatever the SDK
 * offers" is what `aws.operation` is for, and it is explicit for the same
 * reason.
 */
export const INTEGRATION_OPERATIONS = {
  table: ["get", "put", "update", "delete"],
  queue: ["send", "request"],
  topic: ["publish", "request"],
  eventBus: ["put", "request"],
  httpConnection: ["request"],
  awsOperation: ["call"],
} as const satisfies Readonly<Record<IntegrationKind, readonly string[]>>;

export type IntegrationOperation<Kind extends IntegrationKind> =
  (typeof INTEGRATION_OPERATIONS)[Kind][number];

/**
 * The CloudFormation output id a binding publishes its target under.
 *
 * Namespaced with a fixed prefix so the export command can find every binding
 * in a deployment without being given a list of application stack names — the
 * stacks that bind resources are the application's, and the framework should
 * not hold a copy of their names.
 */
export const INTEGRATION_OUTPUT_PREFIX = "WorkflowIntegration";

export function integrationOutputId(spec: IntegrationSpec): string {
  return `${INTEGRATION_OUTPUT_PREFIX}${pascal(spec.kind)}${pascal(spec.id)}`;
}

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => (part[0] as string).toUpperCase() + part.slice(1))
    .join("");
}

/** One resource a graph uses, with the operations it performs on it. */
export interface IntegrationUse {
  readonly reference: IntegrationSpec;
  /** Distinct operations, in first-use order: what the role is derived from. */
  readonly operations: readonly string[];
  /** Whether any use of it waits for a callback. */
  readonly awaitsCallback: boolean;
}
