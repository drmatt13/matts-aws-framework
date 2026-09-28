import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue as SdkAttributeValue,
} from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SFNClient, StartSyncExecutionCommand } from "@aws-sdk/client-sfn";
import {
  assertTaskInputIsDocument,
  marshalDocument,
  marshalValue,
  unmarshalDocument,
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
  type AttributeMap,
  type AttributeValue,
  type IntegrationSpec,
} from "@repo/framework/config";
import {
  requireBinding,
  type WorkflowBindingDocument,
} from "./workflow-bindings";

/**
 * Managed-service steps, executed against the real development resources.
 *
 * The local lane orchestrates on this machine and leaves the services in AWS,
 * so this is an ordinary SDK call to the table, queue, topic or bus the
 * deployment published. It is not a simulator and there is no in-memory
 * substitute behind a flag: a test double is a testing technique, and making it
 * the developer's runtime would mean the thing being developed against is not
 * the thing that runs.
 *
 * What it does own is the *shape* of the conversation. AWS's request and
 * response vocabularies never reach a workflow — a document goes in, a document
 * comes out, and an acknowledgment is the small object the compiled state also
 * produces. The marshalling rules are shared with the compiler, so the two
 * lanes cannot disagree about what a stored item looks like.
 */

export interface IntegrationRequest {
  readonly reference: IntegrationSpec;
  readonly operation: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface IntegrationCallOptions {
  readonly timeoutSeconds?: number | undefined;
  readonly signal: AbortSignal;
}

/** The clients, created once per runner rather than per call. */
export interface IntegrationClients {
  readonly dynamodb: Pick<DynamoDBClient, "send">;
  readonly sqs: Pick<SQSClient, "send">;
  readonly sns: Pick<SNSClient, "send">;
  readonly eventbridge: Pick<EventBridgeClient, "send">;
  /** For the generated development bridges, which are Express executions. */
  readonly stepFunctions: Pick<SFNClient, "send">;
}

export function createIntegrationClients(region: string): IntegrationClients {
  return {
    dynamodb: new DynamoDBClient({ region }),
    sqs: new SQSClient({ region }),
    sns: new SNSClient({ region }),
    eventbridge: new EventBridgeClient({ region }),
    stepFunctions: new SFNClient({ region }),
  };
}

/**
 * A service failure, under the name a declared clause can match.
 *
 * AWS SDK errors carry the service's own error name — `ConditionalCheckFailedException`,
 * `ProvisionedThroughputExceededException` — and a graph written against one in
 * the cloud should match the same one here. Flattening them to a generic
 * failure is what makes a retry clause work in production and never fire during
 * development.
 */
function serviceFailure(error: unknown, where: string): WorkflowStateError {
  if (error instanceof WorkflowStateError) return error;
  const name =
    typeof error === "object" && error !== null && typeof (error as Error).name === "string"
      ? (error as Error).name
      : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowStateError(
    name === "Error" || name === "" ? WORKFLOW_ERROR_NAMES.taskFailed : name,
    `${where}: ${message}`,
  );
}

/**
 * `{ payload, callback }` — the one shape a messaging worker receives.
 *
 * The same envelope the compiled state builds, assembled here from the
 * resolved arguments the interpreter passes. Keeping the application's message
 * under `payload` is what lets a worker read its own contract without knowing
 * anything about callbacks, and the handle under `callback` is what lets it
 * answer without being told a URL.
 */
function callbackRequest(
  args: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  return { payload: args[field] ?? {}, callback: args.callback };
}

function documentArgument(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowStateError(
      WORKFLOW_ERROR_NAMES.runtime,
      `${where} needs a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

/** The framework's attribute values are the SDK's; the cast states it once. */
function toSdk(attributes: AttributeMap): Record<string, SdkAttributeValue> {
  return attributes as unknown as Record<string, SdkAttributeValue>;
}

function fromSdk(
  attributes: Readonly<Record<string, SdkAttributeValue>>,
): AttributeMap {
  return attributes as unknown as AttributeMap;
}

function conditionArguments(
  condition: unknown,
  where: string,
): {
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, SdkAttributeValue>;
} {
  if (condition === null || typeof condition !== "object") return {};
  const declared = condition as {
    readonly expression: string;
    readonly names?: Readonly<Record<string, string>>;
    readonly values?: Readonly<Record<string, unknown>>;
  };
  const values: Record<string, SdkAttributeValue> = {};
  for (const [placeholder, value] of Object.entries(declared.values ?? {})) {
    values[placeholder] = marshalValue(
      value,
      `${where} condition ${placeholder}`,
    ) as unknown as SdkAttributeValue;
  }
  return {
    ConditionExpression: declared.expression,
    ...(declared.names === undefined
      ? {}
      : { ExpressionAttributeNames: { ...declared.names } }),
    ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }),
  };
}

/**
 * The update expression, built exactly as the compiler builds it.
 *
 * Same placeholder prefixes, same clause order, same use of a name placeholder
 * for every attribute — so a workflow updating an item called `status` behaves
 * the same way here as in the deployed state machine.
 */
function updateArguments(
  set: Readonly<Record<string, unknown>>,
  remove: readonly string[],
  where: string,
): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, SdkAttributeValue>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, SdkAttributeValue> = {};
  const assignments: string[] = [];
  const removals: string[] = [];

  Object.entries(set).forEach(([attribute, value], index) => {
    const namePlaceholder = `#wfn${index}`;
    const valuePlaceholder = `:wfv${index}`;
    names[namePlaceholder] = attribute;
    values[valuePlaceholder] = marshalValue(
      value,
      `${where}.set.${attribute}`,
    ) as unknown as SdkAttributeValue;
    assignments.push(`${namePlaceholder} = ${valuePlaceholder}`);
  });
  remove.forEach((attribute, index) => {
    const namePlaceholder = `#wfr${index}`;
    names[namePlaceholder] = attribute;
    removals.push(namePlaceholder);
  });

  const clauses: string[] = [];
  if (assignments.length > 0) clauses.push(`SET ${assignments.join(", ")}`);
  if (removals.length > 0) clauses.push(`REMOVE ${removals.join(", ")}`);
  return {
    UpdateExpression: clauses.join(" "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * One Express execution of a generated bridge, run to its result.
 *
 * `StartSyncExecution` is what makes this a call rather than a submission: the
 * answer comes back on the same request, and a failure keeps the state
 * machine's own error name so a declared retry or catch clause matches it here
 * exactly as it would in a deployed graph.
 */
async function throughBridge(
  stateMachineArn: string,
  input: Readonly<Record<string, unknown>>,
  clients: IntegrationClients,
  where: string,
  options: IntegrationCallOptions,
): Promise<unknown> {
  const response = await clients.stepFunctions.send(
    new StartSyncExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(input),
    }),
    { abortSignal: options.signal },
  );
  if (response.status !== "SUCCEEDED") {
    throw new WorkflowStateError(
      response.error ?? WORKFLOW_ERROR_NAMES.taskFailed,
      `${where} failed in its development bridge: ${response.cause ?? response.status ?? "unknown"}`,
    );
  }
  return response.output === undefined
    ? null
    : (JSON.parse(response.output) as unknown);
}

/** Runs one managed-service step against the deployment's real resources. */
export async function callIntegration(
  request: IntegrationRequest,
  clients: IntegrationClients,
  bindings: WorkflowBindingDocument | undefined,
  options: IntegrationCallOptions,
): Promise<unknown> {
  const target = requireBinding(bindings, request.reference);
  const where = `${request.reference.kind}:${request.reference.id} ${request.operation}`;
  const send = { abortSignal: options.signal } as const;

  try {
    switch (`${request.reference.kind}:${request.operation}`) {
      case "table:get": {
        const response = await clients.dynamodb.send(
          new GetItemCommand({
            TableName: target,
            Key: toSdk(
              marshalDocument(documentArgument(request.arguments.key, `${where} key`)),
            ),
            ...(request.arguments.consistentRead === undefined
              ? {}
              : { ConsistentRead: Boolean(request.arguments.consistentRead) }),
          }),
          send,
        );
        // No item is `null`, not an absent value: "there is no such record" is
        // an ordinary answer a graph branches on.
        return response.Item === undefined ? null : unmarshalDocument(fromSdk(response.Item));
      }

      case "table:put": {
        await clients.dynamodb.send(
          new PutItemCommand({
            TableName: target,
            Item: toSdk(
              marshalDocument(documentArgument(request.arguments.item, `${where} item`)),
            ),
            ...conditionArguments(request.arguments.condition, where),
          }),
          send,
        );
        return null;
      }

      case "table:delete": {
        await clients.dynamodb.send(
          new DeleteItemCommand({
            TableName: target,
            Key: toSdk(
              marshalDocument(documentArgument(request.arguments.key, `${where} key`)),
            ),
            ...conditionArguments(request.arguments.condition, where),
          }),
          send,
        );
        return null;
      }

      case "table:update": {
        const update = updateArguments(
          (request.arguments.set ?? {}) as Record<string, unknown>,
          (request.arguments.remove ?? []) as readonly string[],
          where,
        );
        const condition = conditionArguments(request.arguments.condition, where);
        const response = await clients.dynamodb.send(
          new UpdateItemCommand({
            TableName: target,
            Key: toSdk(
              marshalDocument(documentArgument(request.arguments.key, `${where} key`)),
            ),
            UpdateExpression: update.UpdateExpression,
            ReturnValues: "ALL_NEW",
            ExpressionAttributeNames: {
              ...update.ExpressionAttributeNames,
              ...condition.ExpressionAttributeNames,
            },
            ...(Object.keys({
              ...update.ExpressionAttributeValues,
              ...condition.ExpressionAttributeValues,
            }).length === 0
              ? {}
              : {
                  ExpressionAttributeValues: {
                    ...update.ExpressionAttributeValues,
                    ...condition.ExpressionAttributeValues,
                  },
                }),
            ...(condition.ConditionExpression === undefined
              ? {}
              : { ConditionExpression: condition.ConditionExpression }),
          }),
          send,
        );
        return response.Attributes === undefined
          ? {}
          : unmarshalDocument(fromSdk(response.Attributes));
      }

      case "httpConnection:request":
      case "awsOperation:call":
        // Through the deployment's generated bridge, not from here. The
        // connection's credentials and the operation's role belong to AWS, and
        // the point of the bridge is that they stay there: this sends a request
        // and reads a response.
        return await throughBridge(
          target,
          request.arguments,
          clients,
          where,
          options,
        );

      case "queue:request":
      case "queue:send": {
        const message =
          request.operation === "request"
            ? callbackRequest(request.arguments, "message")
            : request.arguments.message;
        assertTaskInputIsDocument(message, `${where} message`);
        const response = await clients.sqs.send(
          new SendMessageCommand({
            QueueUrl: target,
            MessageBody: JSON.stringify(message),
            ...(request.arguments.groupId === undefined
              ? {}
              : { MessageGroupId: String(request.arguments.groupId) }),
            ...(request.arguments.deduplicationId === undefined
              ? {}
              : { MessageDeduplicationId: String(request.arguments.deduplicationId) }),
            ...(request.arguments.delaySeconds === undefined
              ? {}
              : { DelaySeconds: Number(request.arguments.delaySeconds) }),
          }),
          send,
        );
        return { messageId: response.MessageId ?? "" };
      }

      case "topic:request":
      case "topic:publish": {
        const message =
          request.operation === "request"
            ? callbackRequest(request.arguments, "message")
            : request.arguments.message;
        assertTaskInputIsDocument(message, `${where} message`);
        const response = await clients.sns.send(
          new PublishCommand({
            TopicArn: target,
            Message: JSON.stringify(message),
            ...(request.arguments.subject === undefined
              ? {}
              : { Subject: String(request.arguments.subject) }),
            ...(request.arguments.groupId === undefined
              ? {}
              : { MessageGroupId: String(request.arguments.groupId) }),
            ...(request.arguments.deduplicationId === undefined
              ? {}
              : { MessageDeduplicationId: String(request.arguments.deduplicationId) }),
          }),
          send,
        );
        return { messageId: response.MessageId ?? "" };
      }

      default: {
        const detail =
          request.operation === "request"
            ? callbackRequest(request.arguments, "detail")
            : (request.arguments.detail ?? {});
        assertTaskInputIsDocument(detail, `${where} detail`);
        const response = await clients.eventbridge.send(
          new PutEventsCommand({
            Entries: [
              {
                EventBusName: target,
                Source: String(request.arguments.source),
                DetailType: String(request.arguments.detailType),
                Detail: JSON.stringify(detail),
              },
            ],
          }),
          send,
        );
        const entry = response.Entries?.[0];
        // PutEvents answers 200 for a request whose entry was rejected. The
        // compiled state reaches the same conclusion through an expression that
        // produces nothing, so both lanes fail under the same error name.
        if ((response.FailedEntryCount ?? 0) > 0 || entry?.EventId === undefined) {
          throw new WorkflowStateError(
            WORKFLOW_ERROR_NAMES.queryEvaluation,
            `${where} was accepted by EventBridge but the entry was rejected: ${entry?.ErrorCode ?? "unknown"} ${entry?.ErrorMessage ?? ""}`.trim(),
          );
        }
        return { eventId: entry.EventId };
      }
    }
  } catch (error) {
    throw serviceFailure(error, where);
  }
}

export type { AttributeMap, AttributeValue };
