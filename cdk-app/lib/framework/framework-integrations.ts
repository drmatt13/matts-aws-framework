import {
  deferResourceAttachment,
  integrationRegistry,
  linkedConstruct,
  linkedResourcePaths,
} from "./framework-resources";
import * as cdk from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import type { IGrantable } from "aws-cdk-lib/aws-iam";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { IConnection } from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  getLocalTargets,
  integrationKey,
  integrationOutputId,
  isIntegrationReference,
  needsDevelopmentBridge,
  resolveWorkflow,
  type AnyIntegrationReference,
  type FrameworkConfig,
  type AwsOperationReference,
  type HttpConnectionReference,
  type IntegrationResolution,
  type IntegrationSpec,
} from "@repo/framework/config";

/**
 * Where a workflow step meets the construct it names.
 *
 * A step points at a catalog entry — `resources.orders.recordsTable` — and the
 * application already linked that entry beside the construct it creates. So
 * there is nothing extra to register here: this module reads the link, applies
 * exactly the permissions the graph's operations need, and publishes the
 * resource's identifier so local development reaches the same resource.
 *
 * What it is not is a resource catalog. Nothing here creates a table, a queue
 * or a subscription — creation, lifecycle, encryption and event source
 * mappings stay in the application stack that owns the resource, with the
 * native CDK it already uses.
 *
 * Links must exist before `createFrameworkWorkflows` runs, because that is when
 * the graphs resolve them. The composition root builds application resource
 * stacks first, which is where `linkResources` belongs.
 */

/**
 * How a binding output announces which reference it is for.
 *
 * Read by `npm run export:cdk-outputs`, which scans the deployment's stacks
 * rather than holding a list of the application's stack names.
 */
export const INTEGRATION_OUTPUT_DESCRIPTION_PREFIX = "framework:workflow-integration:";

/** One reference, resolved to the construct and the grants it needs. */
export interface BoundIntegration {
  readonly spec: IntegrationSpec;
  /**
   * What the compiler needs in order to talk to this resource.
   *
   * For the ordinary services it is one identifier — a table name, a queue URL,
   * a topic ARN, an event bus name. The advanced two need more: an HTTP call
   * needs the endpoint and the connection that authenticates it, and an
   * explicit AWS operation needs the parameters the binding fixed. Every field
   * may be a CDK token.
   */
  readonly resolution: IntegrationResolution;
  /** What the binding output publishes, when there is something to publish. */
  readonly published?: string;
  /**
   * Applies the permissions these operations need, and nothing else.
   *
   * The operations come from the graph, so a workflow that only reads a table
   * gets read permission. The L2 grants are used rather than hand-written
   * statements precisely because they also cover the resource's encryption key
   * when it has a customer-managed one.
   */
  readonly grant: (grantee: IGrantable, operations: readonly string[]) => void;
}

function registryFor(scope: IConstruct) {
  const entries = integrationRegistry(scope);
  return {
    add(binding: BoundIntegration, where: string): void {
      const key = integrationKey(binding.spec);
      const existing = entries.get(key);
      if (existing) throw new Error(`${key} is bound twice: first at ${existing.where}, then at ${where}.`);
      entries.set(key, { binding, where });
    },
    get(spec: IntegrationSpec): BoundIntegration | undefined { return entries.get(integrationKey(spec))?.binding; },
    keys(): readonly string[] { return [...entries.keys()]; },
  };
}

/**
 * The binding for a reference, or a message naming what this app did link.
 *
 * A table, queue, topic or bus resolves through the catalog link its
 * application already made — there is no second registration for a workflow —
 * and is described once, then reused. An HTTP connection and an explicit AWS
 * operation carry data no construct has, so they are still bound by hand.
 */
export function requireIntegration(
  scope: IConstruct,
  spec: IntegrationSpec,
): BoundIntegration {
  const registry = registryFor(scope);
  const existing = registry.get(spec);
  if (existing !== undefined) return existing;

  if (spec.resource) {
    const link = linkedConstruct(scope, spec.resource);
    if (!link) {
      const linked = linkedResourcePaths(scope);
      throw new Error(
        `A workflow talks to resources.${spec.resource.path.join(".")}, which no stack linked. Call linkResources(this, resources.<stack>) beside the construct, in a stack built before createFrameworkWorkflows. Linked in this app: ${linked.length > 0 ? linked.join(", ") : "nothing"}.`,
      );
    }
    const where = link.owner.node.path;
    const binding = describeBinding(spec as AnyIntegrationReference, link.construct, where);
    registryFor(scope).add(binding, where);
    publishIntegration(link.owner, spec, binding);
    return binding;
  }

  const bound = registry.keys();
  throw new Error(
    `A workflow talks to ${integrationKey(spec)}, which no stack bound. Bind it beside the construct, in a stack built before createFrameworkWorkflows. Bound in this app: ${bound.length > 0 ? bound.join(", ") : "nothing"}.`,
  );
}

/**
 * Publishes the identifier local development reaches this resource by.
 *
 * A name, a URL or an ARN — never a credential, and never a value a workflow
 * author supplied. The description carries the reference key in a fixed,
 * machine-readable form because the output *id* cannot: it is PascalCase, and
 * reversing that is ambiguous. `npm run export:cdk-outputs` reads this to build
 * the binding document without being told which application stacks hold what.
 */
function publishIntegration(
  owner: IConstruct,
  spec: IntegrationSpec,
  binding: BoundIntegration,
): void {
  if (binding.published === undefined) return;
  const stack = cdk.Stack.of(owner);
  const id = integrationOutputId(spec);
  if (stack.node.tryFindChild(id)) return;
  new cdk.CfnOutput(stack, id, {
    value: binding.published,
    description: `${INTEGRATION_OUTPUT_DESCRIPTION_PREFIX}${integrationKey(spec)}`,
  });
}

/** Every binding registered in this app, for the exported document. */
export function boundIntegrations(scope: IConstruct): readonly string[] {
  return registryFor(scope).keys();
}

/**
 * Publishes every table, queue, topic and bus a locally executed workflow uses.
 *
 * A development deployment builds no state machine, so nothing else resolves
 * these references, and without the published identifier the export refuses
 * the workflow. No grant is applied: the local lane calls these services with
 * the developer's own credentials. Deferred until finalization, because the
 * stacks that link the constructs may be built after this is called.
 */
export function publishLocalWorkflowIntegrations(
  scope: IConstruct,
  config: FrameworkConfig,
): void {
  deferResourceAttachment(scope, () => {
    for (const target of getLocalTargets(config, ["workflow"])) {
      for (const use of resolveWorkflow(config, target.id).integrations) {
        if (!use.reference.resource || needsDevelopmentBridge(use.reference)) continue;
        requireIntegration(scope, use.reference);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function grantsFor(
  spec: IntegrationSpec,
  operations: readonly string[],
): readonly string[] {
  const supported: Readonly<Record<string, readonly string[]>> = {
    table: ["get", "put", "update", "delete"],
    queue: ["send", "request"],
    topic: ["publish", "request"],
    eventBus: ["put", "request"],
  };
  const known = supported[spec.kind] ?? [];
  for (const operation of operations) {
    if (!known.includes(operation)) {
      throw new Error(
        `${integrationKey(spec)} cannot ${operation}. Its kind supports ${known.join(", ")}.`,
      );
    }
  }
  return operations;
}


/**
 * Binds an HTTPS endpoint, authenticated by an EventBridge Connection.
 *
 * The endpoint is fixed here rather than supplied by the graph, which is what
 * makes `path` a path: a workflow cannot turn it into a different host. The
 * connection owns the credential, so nothing secret is written in a workflow
 * or published in an output.
 */
export function bindWorkflowHttpConnection(
  scope: IConstruct,
  reference: HttpConnectionReference,
  connection: IConnection,
  options: { readonly endpoint: string },
): void {
  if (!isIntegrationReference(reference) || reference.kind !== "httpConnection") {
    throw new Error(
      'bindWorkflowHttpConnection() takes an http.connection("...") reference.',
    );
  }
  if (typeof connection?.connectionArn !== "string") {
    throw new Error(
      `${integrationKey(reference)} must be bound to an EventBridge Connection.`,
    );
  }
  const endpoint = options?.endpoint;
  if (typeof endpoint !== "string" || !/^https:\/\/[^\s]+$/.test(endpoint)) {
    throw new Error(
      `${integrationKey(reference)} needs an https endpoint, such as { endpoint: "https://api.example.com" }.`,
    );
  }
  const stack = cdk.Stack.of(scope);
  registryFor(scope).add(
    {
      spec: reference,
      resolution: {
        endpoint: endpoint.replace(/\/+$/, ""),
        connectionArn: connection.connectionArn,
      },
      grant: (grantee) => {
        // The HTTP task invokes an endpoint rather than an ARN, so the action
        // has no resource to scope to. What *is* scoped is the connection: only
        // a role holding its credentials can authenticate a call.
        grantee.grantPrincipal.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:InvokeHTTPEndpoint"],
            resources: ["*"],
            conditions: {
              StringEquals: { "states:HTTPEndpoint": endpoint },
            },
          }),
        );
        grantee.grantPrincipal.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["events:RetrieveConnectionCredentials"],
            resources: [connection.connectionArn],
          }),
        );
        grantee.grantPrincipal.addToPrincipalPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
            resources: [
              cdk.Arn.format(
                {
                  service: "secretsmanager",
                  resource: "secret",
                  resourceName: "events!connection/*",
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                },
                stack,
              ),
            ],
          }),
        );
      },
    },
    `${stack.stackName}/${scope.node.id}`,
  );
}

/**
 * Binds one explicitly declared AWS API action.
 *
 * Both halves are explicit on purpose. `grant` is written beside the resource
 * by whoever owns it, because only they know what the action should be allowed
 * to touch; `parameters` fixes the resource identity, and the compiled call
 * merges them *over* whatever the graph supplies, so a runtime value cannot
 * point the action somewhere else.
 */
export function bindWorkflowAwsOperation<Input, Output>(
  scope: IConstruct,
  reference: AwsOperationReference<Input, Output>,
  options: {
    readonly grant: (grantee: IGrantable) => void;
    readonly parameters?: Readonly<Record<string, unknown>>;
  },
): void {
  if (!isIntegrationReference(reference) || reference.kind !== "awsOperation") {
    throw new Error(
      'bindWorkflowAwsOperation() takes an aws.operation("...", { service, action }) reference.',
    );
  }
  if (typeof options?.grant !== "function") {
    throw new Error(
      `${integrationKey(reference)} needs an explicit grant. The framework does not infer IAM for an arbitrary AWS action.`,
    );
  }
  const stack = cdk.Stack.of(scope);
  registryFor(scope).add(
    {
      spec: reference,
      resolution: {
        ...(options.parameters === undefined
          ? {}
          : { parameters: options.parameters }),
      },
      grant: (grantee) => options.grant(grantee),
    },
    `${stack.stackName}/${scope.node.id}`,
  );
}

function describeBinding(
  reference: AnyIntegrationReference,
  construct: unknown,
  where: string,
): BoundIntegration {
  const wrongConstruct = (expected: string): Error =>
    new Error(
      `${integrationKey(reference)} is bound at ${where} to something that is not ${expected}.`,
    );

  switch (reference.kind) {
    case "table": {
      const table = construct as ITable;
      if (typeof table?.tableName !== "string") throw wrongConstruct("a DynamoDB table");
      return {
        spec: reference,
        resolution: { target: table.tableName },
        published: table.tableName,
        grant: (grantee, operations) => {
          const wanted = grantsFor(reference, operations);
          if (wanted.includes("get")) table.grantReadData(grantee);
          if (wanted.some((operation) => operation !== "get")) {
            table.grantWriteData(grantee);
          }
        },
      };
    }

    case "queue": {
      const queue = construct as IQueue;
      if (typeof queue?.queueUrl !== "string") throw wrongConstruct("an SQS queue");
      return {
        spec: reference,
        resolution: { target: queue.queueUrl },
        published: queue.queueUrl,
        grant: (grantee, operations) => {
          grantsFor(reference, operations);
          queue.grantSendMessages(grantee);
        },
      };
    }

    case "topic": {
      const topic = construct as ITopic;
      if (typeof topic?.topicArn !== "string") throw wrongConstruct("an SNS topic");
      return {
        spec: reference,
        resolution: { target: topic.topicArn },
        published: topic.topicArn,
        grant: (grantee, operations) => {
          grantsFor(reference, operations);
          topic.grantPublish(grantee);
        },
      };
    }

    case "eventBus": {
      const bus = construct as IEventBus;
      if (typeof bus?.eventBusName !== "string") throw wrongConstruct("an event bus");
      return {
        spec: reference,
        resolution: { target: bus.eventBusName },
        published: bus.eventBusName,
        grant: (grantee, operations) => {
          grantsFor(reference, operations);
          bus.grantPutEventsTo(grantee);
        },
      };
    }

    default:
      throw new Error(
        `${integrationKey(reference)} cannot be bound yet. HTTP connections and explicit AWS operations are bound with their own helpers.`,
      );
  }
}
