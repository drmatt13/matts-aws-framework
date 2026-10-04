import assert from "node:assert/strict";
import test from "node:test";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import {
  aws,
  defineResources,
  resource,
  compileIntegrationBridge,
  compileWorkflowToAsl,
  dynamodb,
  eventbridge,
  http,
  normalizeWorkflow,
  sequence,
  sns,
  sqs,
  succeed,
  WORKFLOW_ERROR_NAMES,
  workflow,
  type AslResolver,
  type WorkflowDefinition,
} from "@repo/framework/config";
import {
  callIntegration,
  newExecution,
  parseWorkflowBindings,
  runWorkflow,
  WorkflowBindingError,
  WORKFLOW_BINDINGS_DESCRIPTION,
  type IntegrationClients,
  type WorkflowBindingDocument,
} from "@repo/framework/local";

/**
 * Managed-service steps: what the compiled state says, and what the local call
 * actually does.
 *
 * The two halves are asserted separately and deliberately against the same
 * declarations, because they are the two lanes the design promises agree. The
 * document boundary they share is checked in `workflow-documents.test.ts`.
 */

interface OrderRecord {
  readonly orderId: string;
  readonly total: number;
  readonly status: string;
}

// Catalog entries, not declarations of their own: a step names the construct
// the application already links, and its id is the catalog path.
const catalog = defineResources({
  orders: resource.cdk<ITable>(),
  approvals: resource.cdk<IQueue>(),
  notices: resource.cdk<ITopic>(),
  orderEvents: resource.cdk<IEventBus>(),
});
const { orders, approvals, notices, orderEvents } = catalog;
const paymentsApi = http.connection("payments-api");
const translate = aws.operation<
  { readonly Text: string },
  { readonly TranslatedText: string }
>("translate-text", { service: "translate", action: "translateText" });

const ADVANCED: Readonly<Record<string, ReturnType<NonNullable<AslResolver["integrationTarget"]>>>> = {
  "httpConnection:payments-api": {
    endpoint: "https://payments.example.com",
    connectionArn: "arn:aws:events:eu-west-2:111122223333:connection/payments/abc",
  },
  "awsOperation:translate-text": {
    parameters: { SourceLanguageCode: "en", TargetLanguageCode: "fr" },
  },
};

const TARGETS: Readonly<Record<string, string>> = {
  "table:orders": "orders-table",
  "queue:approvals": "https://sqs.eu-west-2.amazonaws.com/111122223333/approvals",
  "topic:notices": "arn:aws:sns:eu-west-2:111122223333:notices",
  "eventBus:order-events": "order-events-bus",
};

const resolver: AslResolver = {
  lambdaArn: (id) => `arn:aws:lambda:eu-west-2:111122223333:function:${id}`,
  taskLaunch: () => {
    throw new Error("no task in these fixtures");
  },
  integrationTarget: (spec) => {
    const advanced = ADVANCED[`${spec.kind}:${spec.id}`];
    if (advanced !== undefined) return advanced;
    const target = TARGETS[`${spec.kind}:${spec.id}`];
    assert.ok(target, `bound ${spec.kind}:${spec.id}`);
    return { target };
  },
};

type Json = Record<string, unknown>;

function statesOf(definition: WorkflowDefinition): Json {
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  return compileWorkflowToAsl(compiled, resolver).States as Json;
}

function onlyTask(states: Json): Json {
  const tasks = Object.values(states).filter(
    (state) => (state as Json).Type === "Task",
  );
  assert.equal(tasks.length, 1);
  return tasks[0] as Json;
}

// ---------------------------------------------------------------------------
// What the compiled states say
// ---------------------------------------------------------------------------

test("a table read compiles to the optimized getItem integration", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        dynamodb.get(orders, { key: { orderId: input.orderId } }),
      { timeoutSeconds: 60 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::dynamodb:getItem");
  assert.equal((state.Arguments as Json).TableName, "orders-table");
  assert.match((state.Arguments as Json).Key as string, /^\{% \(\$wf_marshal/);
  // A missing item is null rather than an absent value.
  assert.match(state.Output as string, /\$exists\(\$states\.result\.Item\).*: null/);
});

test("a table write compiles with the declared condition and no invented one", () => {
  const state = onlyTask(
    statesOf(
      workflow<OrderRecord>(({ input }) =>
        dynamodb.put(orders, {
          item: input,
          condition: {
            expression: "attribute_not_exists(#id)",
            names: { "#id": "orderId" },
          },
        }),
      { timeoutSeconds: 60 }),
    ),
  );
  const args = state.Arguments as Json;
  assert.equal(args.ConditionExpression, "attribute_not_exists(#id)");
  assert.deepEqual(args.ExpressionAttributeNames, { "#id": "orderId" });
  assert.equal(state.Output, null);
});

test("a put with no condition carries none, rather than an inferred existence check", () => {
  const state = onlyTask(
    statesOf(
      workflow<OrderRecord>(({ input }) => dynamodb.put(orders, { item: input }), {
        timeoutSeconds: 60,
      }),
    ),
  );
  assert.equal((state.Arguments as Json).ConditionExpression, undefined);
});

test("an update builds an explicit expression with placeholders for every name", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        dynamodb.update(orders, {
          key: { orderId: input.orderId },
          set: { status: "approved" },
          remove: ["total"],
        }),
      { timeoutSeconds: 60 }),
    ),
  );
  const args = state.Arguments as Json;
  assert.equal(args.UpdateExpression, "SET #wfn0 = :wfv0 REMOVE #wfr0");
  assert.deepEqual(args.ExpressionAttributeNames, {
    "#wfn0": "status",
    "#wfr0": "total",
  });
  assert.equal(args.ReturnValues, "ALL_NEW");
  assert.match(state.Output as string, /\$wf_unmarshal/);
});

test("sending a message compiles to sqs:sendMessage with a JSON body", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        sqs.send(approvals, { orderId: input.orderId }),
      { timeoutSeconds: 60 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::sqs:sendMessage");
  assert.equal((state.Arguments as Json).QueueUrl, TARGETS["queue:approvals"]);
  assert.match((state.Arguments as Json).MessageBody as string, /^\{% \$string\(/);
  assert.equal(state.Output, '{% {"messageId": $states.result.MessageId} %}');
});

test("publishing compiles to sns:publish", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        sns.publish(notices, { orderId: input.orderId }, { subject: "Order" }),
      { timeoutSeconds: 60 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::sns:publish");
  assert.equal((state.Arguments as Json).Subject, "Order");
});

test("putting an event checks the entry's own outcome, not just the request's", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        eventbridge.put(orderEvents, {
          source: "orders",
          detailType: "OrderApproved",
          detail: { orderId: input.orderId },
        }),
      { timeoutSeconds: 60 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::events:putEvents");
  assert.match(state.Output as string, /FailedEntryCount = 0/);
});

// ---------------------------------------------------------------------------
// The advanced integrations
// ---------------------------------------------------------------------------

test("an HTTPS call joins the binding's host to the graph's path, and nothing else", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ orderId: string }>(({ input }) =>
        http.request(paymentsApi, {
          method: "POST",
          path: "/v1/settlements",
          query: { trace: input.orderId },
          headers: { "content-type": "application/json" },
          body: { orderId: input.orderId },
          timeoutSeconds: 30,
        }),
      { timeoutSeconds: 120 }),
    ),
  );
  assert.equal(state.Resource, "arn:aws:states:::http:invoke");
  assert.equal(state.TimeoutSeconds, 30);
  const args = state.Arguments as Json;
  assert.equal(
    args.ApiEndpoint,
    '{% "https://payments.example.com" & "/v1/settlements" %}',
  );
  assert.deepEqual(args.Authentication, {
    ConnectionArn: "arn:aws:events:eu-west-2:111122223333:connection/payments/abc",
  });
  assert.equal(state.Output, '{% {"statusCode": $states.result.StatusCode, "headers": $states.result.Headers, "body": $states.result.ResponseBody} %}');
});

test("an HTTPS call needs the endpoint its binding was supposed to fix", () => {
  assert.throws(
    () =>
      compileWorkflowToAsl(
        normalizeWorkflow(
          "example",
          workflow(() => http.request(paymentsApi, { method: "GET", path: "/ping" }), {
            timeoutSeconds: 60,
          }),
          'workflows["example"]',
        ),
        { ...resolver, integrationTarget: () => ({}) },
      ),
    /needs the endpoint and the connection/,
  );
});

test("an explicit AWS action compiles to its own SDK integration", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ text: string }>(({ input }) =>
        aws.call(translate, { Text: input.text }),
      { timeoutSeconds: 60 }),
    ),
  );
  assert.equal(
    state.Resource,
    "arn:aws:states:::aws-sdk:translate:translateText",
  );
});

test("fixed parameters win over whatever the graph supplies", () => {
  const state = onlyTask(
    statesOf(
      workflow<{ text: string; TargetLanguageCode: string }>(({ input }) =>
        aws.call(translate, {
          Text: input.text,
          // A runtime value trying to redirect the action.
          TargetLanguageCode: input.TargetLanguageCode,
        } as never),
      { timeoutSeconds: 60 }),
    ),
  );
  // Merged with the binding's parameters last, so they are the ones that stand.
  assert.match(state.Arguments as string, /\$merge\(\[/);
  assert.match(
    state.Arguments as string,
    /\{"SourceLanguageCode":"en","TargetLanguageCode":"fr"\}\]\)/,
  );
});

// ---------------------------------------------------------------------------
// The development bridge
// ---------------------------------------------------------------------------

test("an HTTPS bridge takes its path from the execution input and its host from the binding", () => {
  const definition = compileIntegrationBridge(
    { kind: "httpConnection", id: "payments-api" },
    "request",
    ADVANCED["httpConnection:payments-api"] as Json,
  );
  const state = (definition.States as Json).Perform as Json;
  assert.equal(definition.QueryLanguage, "JSONata");
  assert.equal(state.Resource, "arn:aws:states:::http:invoke");
  assert.match(state.Arguments as string, /"https:\/\/payments\.example\.com" & \$states\.context\.Execution\.Input\.path/);
  assert.match(state.Arguments as string, /"ConnectionArn": "arn:aws:events/);
  assert.equal(state.End, true);
});

test("an AWS bridge merges the binding's parameters over the execution input", () => {
  const definition = compileIntegrationBridge(
    {
      kind: "awsOperation",
      id: "translate-text",
      service: "translate",
      action: "translateText",
    },
    "call",
    ADVANCED["awsOperation:translate-text"] as Json,
  );
  const state = (definition.States as Json).Perform as Json;
  assert.equal(state.Resource, "arn:aws:states:::aws-sdk:translate:translateText");
  assert.match(
    state.Arguments as string,
    /\$merge\(\[\$states\.context\.Execution\.Input\.parameters, \{"SourceLanguageCode"/,
  );
});

test("an ordinary service needs no bridge: a laptop can call it directly", () => {
  assert.throws(
    () => compileIntegrationBridge({ kind: "queue", id: "approvals" }, "send", {}),
    /needs no development bridge/,
  );
});

// ---------------------------------------------------------------------------
// What the graph reports about itself
// ---------------------------------------------------------------------------

test("the graph reports the resources it uses and what it does to them", () => {
  const compiled = normalizeWorkflow(
    "example",
    workflow<{ orderId: string }>(({ input }) => {
      const loaded = dynamodb.get(orders, { key: { orderId: input.orderId } });
      return sequence(
        loaded,
        dynamodb.update(orders, {
          key: { orderId: input.orderId },
          set: { status: "seen" },
        }),
        sqs.send(approvals, { orderId: input.orderId }),
        succeed(loaded.output),
      );
    }, { timeoutSeconds: 60 }),
    'workflows["example"]',
  );

  assert.deepEqual(
    compiled.integrations.map((use) => [
      `${use.reference.kind}:${use.reference.id}`,
      use.operations,
    ]),
    [
      ["table:orders", ["get", "update"]],
      ["queue:approvals", ["send"]],
    ],
  );
});

test("a resource used with the wrong operation is refused at the call site", () => {
  // The operation decides the kind, so the mismatch is a type error: `sqs.send`
  // asks for a CdkResource<IQueue> and a table cannot satisfy it.
  // @ts-expect-error - a table is not a queue
  () => sqs.send(orders, { orderId: "a" } as never);

  // At runtime what is still checkable is that a catalog resource was given.
  assert.throws(
    () =>
      workflow(
        () => sqs.send({ kind: "queue", id: "orders" } as never, { orderId: "a" } as never),
        { timeoutSeconds: 60 },
      ),
    /takes a catalog resource/,
  );
});

test("an update that changes nothing is refused", () => {
  assert.throws(
    () =>
      workflow<{ orderId: string }>(
        ({ input }) => dynamodb.update(orders, { key: { orderId: input.orderId } }),
        { timeoutSeconds: 60 },
      ),
    /needs something to change/,
  );
});

test("an update that both sets and removes one attribute is refused", () => {
  assert.throws(
    () =>
      workflow<{ orderId: string }>(
        ({ input }) =>
          dynamodb.update(orders, {
            key: { orderId: input.orderId },
            set: { status: "a" },
            remove: ["status"],
          }),
        { timeoutSeconds: 60 },
      ),
    /touches one attribute twice/,
  );
});

// ---------------------------------------------------------------------------
// What the local call does
// ---------------------------------------------------------------------------

const bindings: WorkflowBindingDocument = {
  version: 1,
  deployment: "example-dev",
  account: "111122223333",
  region: "eu-west-2",
  mode: "dev",
  integrations: TARGETS,
};

interface Sent {
  readonly service: string;
  readonly input: Json;
}

function fakeClients(
  responses: Readonly<Record<string, unknown>>,
  sent: Sent[] = [],
): IntegrationClients {
  const lane = (service: string) => ({
    send: async (command: { input: Json; constructor: { name: string } }) => {
      sent.push({ service, input: command.input });
      const response = responses[command.constructor.name];
      if (response instanceof Error) throw response;
      return response ?? {};
    },
  });
  return {
    dynamodb: lane("dynamodb") as IntegrationClients["dynamodb"],
    sqs: lane("sqs") as IntegrationClients["sqs"],
    sns: lane("sns") as IntegrationClients["sns"],
    eventbridge: lane("eventbridge") as IntegrationClients["eventbridge"],
    stepFunctions: lane("stepFunctions") as IntegrationClients["stepFunctions"],
  };
}

function call(
  operation: string,
  kind: "table" | "queue" | "topic" | "eventBus",
  id: string,
  args: Json,
  responses: Readonly<Record<string, unknown>>,
  sent: Sent[] = [],
): Promise<unknown> {
  return callIntegration(
    { reference: { kind, id }, operation, arguments: args },
    fakeClients(responses, sent),
    bindings,
    { signal: new AbortController().signal },
  );
}

test("a read answers with the document, and with null when there is no item", async () => {
  const found = await call(
    "get",
    "table",
    "orders",
    { key: { orderId: "A-1" } },
    { GetItemCommand: { Item: { orderId: { S: "A-1" }, total: { N: "12" } } } },
  );
  assert.deepEqual(found, { orderId: "A-1", total: 12 });

  const missing = await call("get", "table", "orders", { key: { orderId: "A-2" } }, {
    GetItemCommand: {},
  });
  assert.equal(missing, null);
});

test("a read marshals its key and names the bound table", async () => {
  const sent: Sent[] = [];
  await call("get", "table", "orders", { key: { orderId: "A-1" } }, {
    GetItemCommand: {},
  }, sent);
  assert.equal(sent[0]?.input.TableName, "orders-table");
  assert.deepEqual(sent[0]?.input.Key, { orderId: { S: "A-1" } });
});

test("a write answers with null and carries the declared condition", async () => {
  const sent: Sent[] = [];
  const result = await call(
    "put",
    "table",
    "orders",
    {
      item: { orderId: "A-1", total: 1 },
      condition: { expression: "attribute_not_exists(#id)", names: { "#id": "orderId" } },
    },
    { PutItemCommand: {} },
    sent,
  );
  assert.equal(result, null);
  assert.equal(sent[0]?.input.ConditionExpression, "attribute_not_exists(#id)");
});

test("an update sends the same expression the compiler emits and returns the new item", async () => {
  const sent: Sent[] = [];
  const result = await call(
    "update",
    "table",
    "orders",
    { key: { orderId: "A-1" }, set: { status: "approved" }, remove: ["total"] },
    { UpdateItemCommand: { Attributes: { orderId: { S: "A-1" }, status: { S: "approved" } } } },
    sent,
  );
  assert.equal(sent[0]?.input.UpdateExpression, "SET #wfn0 = :wfv0 REMOVE #wfr0");
  assert.deepEqual(result, { orderId: "A-1", status: "approved" });
});

test("a failed conditional write keeps the service's own error name", async () => {
  const failure = new Error("The conditional request failed");
  failure.name = "ConditionalCheckFailedException";
  await assert.rejects(
    call("put", "table", "orders", { item: { orderId: "A-1" } }, {
      PutItemCommand: failure,
    }),
    (error: { errorName?: string }) =>
      error.errorName === "ConditionalCheckFailedException",
  );
});

test("sending answers with the acknowledgment, not with a consumer's result", async () => {
  const sent: Sent[] = [];
  const result = await call(
    "send",
    "queue",
    "approvals",
    { message: { orderId: "A-1" } },
    { SendMessageCommand: { MessageId: "m-1" } },
    sent,
  );
  assert.deepEqual(result, { messageId: "m-1" });
  assert.equal(sent[0]?.input.QueueUrl, TARGETS["queue:approvals"]);
  assert.equal(sent[0]?.input.MessageBody, '{"orderId":"A-1"}');
});

test("publishing answers with the acknowledgment", async () => {
  const result = await call("publish", "topic", "notices", { message: { orderId: "A-1" } }, {
    PublishCommand: { MessageId: "m-2" },
  });
  assert.deepEqual(result, { messageId: "m-2" });
});

test("an accepted event answers with its id", async () => {
  const result = await call(
    "put",
    "eventBus",
    "order-events",
    { source: "orders", detailType: "OrderApproved", detail: { orderId: "A-1" } },
    { PutEventsCommand: { FailedEntryCount: 0, Entries: [{ EventId: "e-1" }] } },
  );
  assert.deepEqual(result, { eventId: "e-1" });
});

test("a rejected event fails the step although the request succeeded", async () => {
  await assert.rejects(
    call(
      "put",
      "eventBus",
      "order-events",
      { source: "orders", detailType: "OrderApproved", detail: {} },
      {
        PutEventsCommand: {
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "NotAuthorizedForSourceException", ErrorMessage: "no" }],
        },
      },
    ),
    (error: { errorName?: string; cause?: string }) =>
      error.errorName === WORKFLOW_ERROR_NAMES.queryEvaluation &&
      /NotAuthorizedForSourceException/.test(error.cause ?? ""),
  );
});

test("a message that is not a JSON document is refused in the local lane", async () => {
  await assert.rejects(
    call("send", "queue", "approvals", { message: "bare string" }, {
      SendMessageCommand: {},
    }),
    /JSON object or array/,
  );
});

// ---------------------------------------------------------------------------
// Running a graph
// ---------------------------------------------------------------------------

test("a graph reads a table and branches on the result", async () => {
  const definition = workflow<{ orderId: string }>(({ input }) => {
    const loaded = dynamodb.get(orders, { key: { orderId: input.orderId } });
    return sequence(loaded, succeed(loaded.output));
  }, { timeoutSeconds: 60 });

  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: {
      invokeLambda: async () => null,
      runTask: async () => ({ runId: "run", exitCode: 0 }),
      callIntegration: (request, options) =>
        callIntegration(
          request,
          fakeClients({
            GetItemCommand: { Item: { orderId: { S: "A-1" }, total: { N: "3" } } },
          }),
          bindings,
          options,
        ),
    },
  });

  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { orderId: "A-1", total: 3 });
});

test("a graph with an integration is refused by a runner that has no service lane", async () => {
  const definition = workflow<{ orderId: string }>(({ input }) =>
    dynamodb.get(orders, { key: { orderId: input.orderId } }),
  { timeoutSeconds: 60 });
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input: { orderId: "A-1" },
    runner: {
      invokeLambda: async () => null,
      runTask: async () => ({ runId: "run", exitCode: 0 }),
    },
  });
  assert.equal(execution.status, "failed");
  assert.match(execution.error?.cause ?? "", /no lane for/);
});

// ---------------------------------------------------------------------------
// The binding document
// ---------------------------------------------------------------------------

test("the binding document is read as written, with its deployment identity", () => {
  const parsed = parseWorkflowBindings(JSON.stringify(bindings));
  assert.equal(parsed.deployment, "example-dev");
  assert.equal(parsed.account, "111122223333");
  assert.equal(parsed.region, "eu-west-2");
  assert.equal(parsed.mode, "dev");
  assert.equal(parsed.integrations["table:orders"], "orders-table");
});

test("a document from an incompatible version is refused with what to re-run", () => {
  assert.throws(
    () => parseWorkflowBindings(JSON.stringify({ ...bindings, version: 99 })),
    /export:cdk-outputs/,
  );
});

test("a document that is not JSON names the command that writes it", () => {
  assert.throws(() => parseWorkflowBindings("not json"), (error: Error) => {
    assert.ok(error instanceof WorkflowBindingError);
    assert.match(error.message, new RegExp(WORKFLOW_BINDINGS_DESCRIPTION));
    return true;
  });
});

test("an unbound reference names the deployment it was looked for in", async () => {
  await assert.rejects(
    callIntegration(
      {
        reference: { kind: "table", id: "unbound" },
        operation: "get",
        arguments: { key: {} },
      },
      fakeClients({}),
      bindings,
      { signal: new AbortController().signal },
    ),
    /not bound in deployment "example-dev"/,
  );
});

test("no binding document at all says what to run", async () => {
  await assert.rejects(
    callIntegration(
      { reference: { kind: "table", id: "orders" }, operation: "get", arguments: { key: {} } },
      fakeClients({}),
      undefined,
      { signal: new AbortController().signal },
    ),
    /export:cdk-outputs/,
  );
});
