/**
 * The workflow language.
 *
 * Everything here builds an AST. Nothing executes, nothing is asynchronous, and
 * nothing reads a value: `InvokeLambda("validate")` inside a workflow callback
 * constructs a node, and `validated.output.accountId` records a path. That is
 * why the language is not spelled with `await` — these are declarations, not
 * JavaScript operations, and a fake Promise would only disguise the difference
 * until someone reordered two lines and changed nothing.
 *
 * Browser-safe and pure. The only imports are the IR and the deploy vocabulary.
 *
 * ## Reading a workflow
 *
 * ```ts
 * workflow(({ input }) => {
 *   const validated = invokeLambda("validate-document", { payload: input });
 *   const processed = runTask("process-document", { payload: validated.output });
 *
 *   return sequence(validated, processed);
 * }, { timeoutSeconds: 900 })
 * ```
 *
 * The first node of the returned flow starts the workflow, sequential nodes are
 * connected, the last node ends it, and the workflow's result is that node's
 * output unless `succeed()` says otherwise. No state names, no transitions.
 */

import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { CdkResource } from "./cdk-resources";
import {
  assertIntegrationKind,
  awsOperationReference,
  httpConnectionReference,
  integrationFor,
  type AwsOperationReference,
  type HttpConnectionReference,
  type IntegrationSpec,
} from "./workflow-integrations";
import {
  WORKFLOW_REFERENCE,
  type AttemptNode,
  type ChoiceNode,
  type FailNode,
  type IntegrationNode,
  type InvocationNode,
  type MapNode,
  type ParallelNode,
  type PassNode,
  type RawStateNode,
  type RetryNode,
  type SequenceNode,
  type SucceedNode,
  type WaitNode,
  type WorkflowComparator,
  type WorkflowCondition,
  type WorkflowDefinition,
  type WorkflowErrorSelector,
  type WorkflowErrorValue,
  type WorkflowExpression,
  type WorkflowNode,
  type WorkflowNodeId,
  type WorkflowBindingId,
  type WorkflowLambda,
  type WorkflowOperand,
  type WorkflowOperation,
  type WorkflowOperator,
  type WorkflowOptions,
  type WorkflowPathStep,
  type WorkflowReference,
  type WorkflowRetryPolicy,
  type WorkflowTerm,
  type WorkflowValue,
  type WorkflowValueSource,
} from "./workflow-ast";

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/** A node together with the type its result carries. */
export type Flow<T = unknown> = WorkflowNode & { readonly output: WorkflowValue<T> };

/** The result type of a flow. */
export type OutputOf<F> = F extends Flow<infer T> ? T : never;

/**
 * The constraint for "some flow", used where a combinator accepts any step.
 *
 * `any` rather than `never` or `unknown`: the phantom output marker makes
 * `Flow<T>` invariant in `T`, so `Flow<never>` would reject every real step and
 * `Flow<unknown>` would reject narrower ones.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFlow = Flow<any>;

type LastOf<Items extends readonly unknown[]> = Items extends readonly [
  ...unknown[],
  infer Last,
]
  ? Last
  : never;

// ---------------------------------------------------------------------------
// Build context
//
// Node ids are allocated per workflow in construction order, which is what makes
// them deterministic: the same source builds the same graph, so a rebuild
// produces the same state names and an unchanged CloudFormation diff.
// ---------------------------------------------------------------------------

interface WorkflowBuild {
  counter: number;
  /**
   * Expression element bindings, counted separately.
   *
   * Separate because node ids become state names: sharing one counter would
   * make adding an `expr.project` renumber every state after it, and an
   * unchanged workflow would produce a changed CloudFormation diff.
   */
  bindings: number;
}

let activeBuild: WorkflowBuild | undefined;

function nextNodeId(): WorkflowNodeId {
  if (activeBuild === undefined) {
    throw new Error(
      "A workflow node was constructed outside workflow(). Build the graph inside the workflow callback, so its nodes belong to one graph.",
    );
  }
  activeBuild.counter += 1;
  return String(activeBuild.counter);
}

function nextBindingId(): WorkflowBindingId {
  if (activeBuild === undefined) {
    throw new Error(
      "An expression was constructed outside workflow(). Build expressions inside the workflow callback, so their bindings belong to one graph.",
    );
  }
  activeBuild.bindings += 1;
  return String(activeBuild.bindings);
}

// ---------------------------------------------------------------------------
// Symbolic values
// ---------------------------------------------------------------------------

/**
 * A typed reference that records property access.
 *
 * `then` deliberately answers `undefined`. A proxy that answered with another
 * proxy would be thenable, so `await` on a workflow value would hang forever
 * instead of failing — and the whole point of this design is that workflow
 * values are not promises. A payload member genuinely named `then` is the price,
 * and it is a far rarer thing than an accidental `await`.
 */
function symbolicTerm<T>(term: WorkflowTerm): WorkflowValue<T> {
  const target = {} as Record<string | symbol, unknown>;

  return new Proxy(target, {
    get(_target, property): unknown {
      if (property === WORKFLOW_REFERENCE) return term;
      if (property === "then") return undefined;
      if (typeof property === "symbol") return undefined;
      const step: WorkflowPathStep = /^(0|[1-9]\d*)$/.test(property)
        ? Number.parseInt(property, 10)
        : property;
      return symbolicTerm({ ...term, path: [...term.path, step] });
    },
    has(_target, property): boolean {
      return property === WORKFLOW_REFERENCE;
    },
  }) as WorkflowValue<T>;
}

function symbolicValue<T>(
  source: WorkflowValueSource,
  path: readonly WorkflowPathStep[] = [],
): WorkflowValue<T> {
  return symbolicTerm<T>({ kind: "reference", source, path });
}

/** Whether a value is symbolic rather than ordinary data. */
export function isWorkflowValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[WORKFLOW_REFERENCE] !== undefined
  );
}

/** The term a symbolic value carries, or `undefined` for plain data. */
export function termOf(value: unknown): WorkflowTerm | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, WorkflowTerm | undefined>)[WORKFLOW_REFERENCE];
}

/** The reference a symbolic value carries, when it is a plain read. */
export function referenceOf(value: unknown): WorkflowReference | undefined {
  const term = termOf(value);
  return term?.kind === "reference" ? term : undefined;
}

/**
 * Attaches a node's result type to it.
 *
 * `output` is non-enumerable so the AST stays plain data — a snapshot, a
 * structural comparison or a JSON round-trip sees the graph and not the
 * accessor.
 */
function asFlow<T>(node: WorkflowNode, source?: WorkflowValueSource): Flow<T> {
  Object.defineProperty(node, "output", {
    enumerable: false,
    configurable: false,
    get: () => symbolicValue<T>(source ?? { kind: "node", node: node.id }),
  });
  return node as Flow<T>;
}

// ---------------------------------------------------------------------------
// Execution primitives
// ---------------------------------------------------------------------------

export interface InvokeOptions<In> {
  readonly payload?: WorkflowExpression<In>;
  readonly timeoutSeconds?: number;
}

/**
 * Invokes a declared event Lambda and waits for its response.
 *
 * `.output` is the function's own return value. Step Functions' payload-only
 * integration is used, so there is no `{Payload, StatusCode}` envelope to
 * unwrap and a thrown error fails the step rather than succeeding with a
 * `FunctionError` field a graph would have to remember to check.
 */
export function invokeLambda<Out = unknown, In = unknown>(
  target: string,
  options: InvokeOptions<In> = {},
): Flow<Out> {
  return asFlow<Out>(invocation("lambda", target, options));
}

/** What a container task reports when it finishes. */
export interface TaskResult {
  readonly runId: string;
  readonly exitCode: number;
}

/** Ordinary `runTask`: the step ends when the container stops. */
export interface TaskExitOptions<In> extends InvokeOptions<In> {
  readonly completion?: "exit";
}

/**
 * `runTask` in callback mode: the step ends when the container reports.
 *
 * The timeout is required rather than optional. A step waiting for something
 * outside the graph with no deadline is an execution that can hang until the
 * workflow's own timeout, and by then the reason is long gone.
 */
export interface TaskCallbackOptions<In> extends InvokeOptions<In> {
  readonly completion: "callback";
  readonly timeoutSeconds: number;
  /**
   * How long the container may go without a heartbeat.
   *
   * Opt-in, and never an extension of `timeoutSeconds`: a worker that keeps
   * saying "still here" does not get more than the step was given.
   */
  readonly heartbeatSeconds?: number;
}

/**
 * Runs a declared container task.
 *
 * By default the step ends when the container stops, and the result is the
 * framework's task summary — never the container's stdout, which is logging
 * and has no business-output contract. A non-zero exit fails the step, so a
 * following node does not run merely because ECS accepted the launch.
 *
 * In callback mode the container reports its own result:
 *
 * ```ts
 * const parsed = runTask<ParseResult>("parse-document", {
 *   payload: input,
 *   completion: "callback",
 *   timeoutSeconds: 600,
 * });
 * ```
 *
 * ```ts
 * // inside the container
 * await completeCallback(taskCallback(), result);
 * ```
 *
 * The step then ends when the callback succeeds or fails. It does *not* also
 * wait for the process to exit: a container that reports and then takes ten
 * seconds to shut down has already answered, and the two events are different.
 */
export function runTask<In = unknown>(
  target: string,
  options?: TaskExitOptions<In>,
): Flow<TaskResult>;
export function runTask<Out, In = unknown>(
  target: string,
  options: TaskCallbackOptions<In>,
): Flow<Out>;
export function runTask(
  target: string,
  options: TaskExitOptions<unknown> | TaskCallbackOptions<unknown> = {},
): Flow<unknown> {
  if (options.completion !== "callback") {
    return asFlow<TaskResult>(invocation("task", target, options));
  }
  assertPositiveInteger(
    options.timeoutSeconds,
    'runTask() with completion: "callback" needs timeoutSeconds',
  );
  if (options.heartbeatSeconds !== undefined) {
    assertPositiveInteger(options.heartbeatSeconds, "runTask() heartbeatSeconds");
    if (options.heartbeatSeconds >= options.timeoutSeconds) {
      throw new Error(
        `runTask("${target}") has heartbeatSeconds ${options.heartbeatSeconds} and timeoutSeconds ${options.timeoutSeconds}. A heartbeat interval at or beyond the deadline never fires before it.`,
      );
    }
  }
  const node = invocation("task", target, options);
  return asFlow<unknown>({
    ...node,
    completion: "callback",
    ...(options.heartbeatSeconds === undefined
      ? {}
      : { heartbeatSeconds: options.heartbeatSeconds }),
  });
}

/**
 * Runs a declared child workflow and waits for its result.
 *
 * `.output` is the child's business output, not the execution description the
 * AWS integration answers with.
 */
export function runWorkflow<Out = unknown, In = unknown>(
  target: string,
  options: InvokeOptions<In> = {},
): Flow<Out> {
  return asFlow<Out>(invocation("workflow", target, options));
}

function invocation<In>(
  invokes: InvocationNode["invokes"],
  target: string,
  options: InvokeOptions<In>,
): InvocationNode {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`A ${invokes} step must name a declared target.`);
  }
  return {
    kind: "invocation",
    id: nextNodeId(),
    invokes,
    target,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.timeoutSeconds }),
  };
}

// ---------------------------------------------------------------------------
// Managed-service steps
//
// A step that talks to a resource application CDK creates, rather than to a
// workload this repository builds. The reference says which resource and what
// travels over it; the operation says what is done to it; the binding in CDK
// says which construct it actually is.
//
// Every operation here waits for the API call and answers with a small,
// documented acknowledgment. Accepting a message is not the same as a consumer
// having processed it, and none of these pretend otherwise — waiting for a
// worker's *answer* is `request`, which is a different step with a different
// completion.
// ---------------------------------------------------------------------------

function integrationStep<Out>(
  reference: IntegrationSpec,
  operation: string,
  options: {
    readonly arguments?: unknown;
    readonly timeoutSeconds?: number | undefined;
    readonly completion?: "response" | "callback";
    readonly heartbeatSeconds?: number | undefined;
  } = {},
): Flow<Out> {
  const node: IntegrationNode = {
    kind: "integration",
    id: nextNodeId(),
    reference,
    operation,
    completion: options.completion ?? "response",
    ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds: options.timeoutSeconds }),
    ...(options.heartbeatSeconds === undefined
      ? {}
      : { heartbeatSeconds: options.heartbeatSeconds }),
  };
  return asFlow<Out>(node);
}

/**
 * A conditional write, spelled the way DynamoDB spells it.
 *
 * Native on purpose. A framework that inferred `attribute_not_exists(pk)` from
 * "this looks like a create" would be adding a precondition nobody wrote, and
 * the first time it guessed wrong it would be an outage rather than a bug.
 */
export interface WriteCondition {
  /** A DynamoDB condition expression, such as `attribute_not_exists(#id)`. */
  readonly expression: string;
  readonly names?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, WorkflowExpression<unknown>>>;
}

function assertCondition_(condition: WriteCondition | undefined, origin: string): void {
  if (condition === undefined) return;
  if (typeof condition.expression !== "string" || condition.expression.length === 0) {
    throw new Error(`${origin} was given a condition with no expression.`);
  }
}

export interface TableGetOptions<Key> {
  readonly key: WorkflowExpression<Key>;
  /** A strongly consistent read. Costs more and is never the default. */
  readonly consistentRead?: boolean;
}

export interface TablePutOptions<Item> {
  readonly item: WorkflowExpression<Item>;
  readonly condition?: WriteCondition;
}

export interface TableUpdateOptions<Item, Key> {
  readonly key: WorkflowExpression<Key>;
  /** Members to write. Their names are literal; their values may be symbolic. */
  readonly set?: { readonly [K in keyof Item]?: WorkflowExpression<Item[K]> };
  /** Members to remove. */
  readonly remove?: readonly string[];
  readonly condition?: WriteCondition;
}

export interface TableDeleteOptions<Key> {
  readonly key: WorkflowExpression<Key>;
  readonly condition?: WriteCondition;
}

/**
 * DynamoDB, over JSON documents.
 *
 * Attribute values never reach a workflow: a document goes in and a document
 * comes out, marshalled by rules the compiled state and the local SDK call
 * share. Binary values, sets and precision-sensitive numbers are deliberately
 * outside this API — see `workflow-documents.ts`.
 */
export const dynamodb = {
  /** The item, or `null` when the table holds none for that key. */
  get<Item, Key>(
    table: CdkResource<ITable>,
    options: TableGetOptions<Key>,
  ): Flow<Item | null> {
    const target = integrationFor("table", table, "dynamodb.get()");
    if (options?.key === undefined) {
      throw new Error("dynamodb.get() needs the item's key.");
    }
    return integrationStep<Item | null>(target, "get", {
      arguments: {
        key: options.key,
        ...(options.consistentRead === undefined
          ? {}
          : { consistentRead: options.consistentRead }),
      },
    });
  },

  /** Writes the item. The result is `null`: a put has no business output. */
  put<Item, Key>(
    table: CdkResource<ITable>,
    options: TablePutOptions<Item>,
  ): Flow<null> {
    const target = integrationFor("table", table, "dynamodb.put()");
    if (options?.item === undefined) {
      throw new Error("dynamodb.put() needs the item to write.");
    }
    assertCondition_(options.condition, "dynamodb.put()");
    return integrationStep<null>(target, "put", {
      arguments: {
        item: options.item,
        ...(options.condition === undefined ? {} : { condition: options.condition }),
      },
    });
  },

  /** Applies explicit changes and answers with the updated item. */
  update<Item, Key>(
    table: CdkResource<ITable>,
    options: TableUpdateOptions<Item, Key>,
  ): Flow<Item> {
    const target = integrationFor("table", table, "dynamodb.update()");
    if (options?.key === undefined) {
      throw new Error("dynamodb.update() needs the item's key.");
    }
    const set = options.set ?? {};
    const remove = options.remove ?? [];
    if (Object.keys(set).length === 0 && remove.length === 0) {
      throw new Error(
        "dynamodb.update() needs something to change: pass set, remove, or both.",
      );
    }
    for (const name of remove) {
      if (name in set) {
        throw new Error(
          `dynamodb.update() both sets and removes "${name}". DynamoDB refuses an update expression that touches one attribute twice.`,
        );
      }
    }
    assertCondition_(options.condition, "dynamodb.update()");
    return integrationStep<Item>(target, "update", {
      arguments: {
        key: options.key,
        set,
        remove,
        ...(options.condition === undefined ? {} : { condition: options.condition }),
      },
    });
  },

  /** Removes the item. The result is `null`. */
  delete<Item, Key>(
    table: CdkResource<ITable>,
    options: TableDeleteOptions<Key>,
  ): Flow<null> {
    const target = integrationFor("table", table, "dynamodb.delete()");
    if (options?.key === undefined) {
      throw new Error("dynamodb.delete() needs the item's key.");
    }
    assertCondition_(options.condition, "dynamodb.delete()");
    return integrationStep<null>(target, "delete", {
      arguments: {
        key: options.key,
        ...(options.condition === undefined ? {} : { condition: options.condition }),
      },
    });
  },
} as const;

/** What SQS answers when it accepts a message. */
export interface QueueSendResult {
  readonly messageId: string;
}

export interface QueueSendOptions {
  /** FIFO queues only. */
  readonly groupId?: WorkflowExpression<string>;
  readonly deduplicationId?: WorkflowExpression<string>;
  readonly delaySeconds?: number;
}

export const sqs = {
  /**
   * Sends one message and waits for SQS to accept it.
   *
   * Acceptance, not processing. The result names the message SQS stored; it
   * says nothing about a consumer having read it, let alone succeeded. A
   * workflow that needs the answer waits for a callback instead.
   */
  send<Message, Result>(
    queue: CdkResource<IQueue>,
    message: WorkflowExpression<Message>,
    options: QueueSendOptions = {},
  ): Flow<QueueSendResult> {
    const target = integrationFor("queue", queue, "sqs.send()");
    return integrationStep<QueueSendResult>(target, "send", {
      arguments: { message, ...options },
    });
  },

  /**
   * Sends one message and waits for a worker's answer.
   *
   * The worker receives `{ payload, callback }` and reports through
   * `completeCallback(request.callback, result)`. The step's result is that
   * answer — not an acknowledgment, and not an inference from the message
   * having been delivered.
   */
  request<Message, Result>(
    queue: CdkResource<IQueue>,
    message: WorkflowExpression<Message>,
    options: RequestOptions,
  ): Flow<Result> {
    const target = integrationFor("queue", queue, "sqs.request()");
    return requestStep<Result>(
      target,
      "request",
      { message },
      options,
      "sqs.request()",
    );
  },
} as const;

/** What SNS answers when it accepts a message. */
export interface TopicPublishResult {
  readonly messageId: string;
}

export interface TopicPublishOptions {
  readonly subject?: WorkflowExpression<string>;
  /** FIFO topics only. */
  readonly groupId?: WorkflowExpression<string>;
  readonly deduplicationId?: WorkflowExpression<string>;
}

export const sns = {

  /** Publishes one message and waits for SNS to accept it. */
  publish<Message, Result>(
    topic: CdkResource<ITopic>,
    message: WorkflowExpression<Message>,
    options: TopicPublishOptions = {},
  ): Flow<TopicPublishResult> {
    const target = integrationFor("topic", topic, "sns.publish()");
    return integrationStep<TopicPublishResult>(target, "publish", {
      arguments: { message, ...options },
    });
  },

  /** Publishes one message and waits for a subscriber's answer. */
  request<Message, Result>(
    topic: CdkResource<ITopic>,
    message: WorkflowExpression<Message>,
    options: RequestOptions,
  ): Flow<Result> {
    const target = integrationFor("topic", topic, "sns.request()");
    return requestStep<Result>(
      target,
      "request",
      { message },
      options,
      "sns.request()",
    );
  },
} as const;

/** What EventBridge answers for one accepted entry. */
export interface EventPutResult {
  readonly eventId: string;
}

export interface EventPutOptions<Detail> {
  readonly source: WorkflowExpression<string>;
  readonly detailType: WorkflowExpression<string>;
  readonly detail: WorkflowExpression<Detail>;
}

export const eventbridge = {

  /**
   * Puts one event on the bus.
   *
   * EventBridge answers `200` for a request in which individual entries failed,
   * so the compiled step and the local call both check the per-entry outcome
   * and fail the state when the entry was rejected.
   *
   * @see https://docs.aws.amazon.com/step-functions/latest/dg/connect-eventbridge.html
   */
  put<Detail, Result>(
    bus: CdkResource<IEventBus>,
    options: EventPutOptions<Detail>,
  ): Flow<EventPutResult> {
    const target = integrationFor("eventBus", bus, "eventbridge.put()");
    if (options?.source === undefined || options.detailType === undefined) {
      throw new Error("eventbridge.put() needs a source and a detailType.");
    }
    return integrationStep<EventPutResult>(target, "put", {
      arguments: {
        source: options.source,
        detailType: options.detailType,
        detail: options.detail === undefined ? {} : options.detail,
      },
    });
  },

  /** Puts one event and waits for a consumer's answer. */
  request<Detail, Result>(
    bus: CdkResource<IEventBus>,
    options: EventPutOptions<Detail> & RequestOptions,
  ): Flow<Result> {
    const target = integrationFor("eventBus", bus, "eventbridge.request()");
    if (options?.source === undefined || options.detailType === undefined) {
      throw new Error("eventbridge.request() needs a source and a detailType.");
    }
    return requestStep<Result>(
      target,
      "request",
      {
        source: options.source,
        detailType: options.detailType,
        detail: options.detail === undefined ? {} : options.detail,
      },
      options,
      "eventbridge.request()",
    );
  },
} as const;

/**
 * What a messaging step that waits for an answer needs.
 *
 * `timeoutSeconds` is required for the same reason a callback task's is: a step
 * waiting on something outside the graph without a deadline is a hang.
 */
export interface RequestOptions {
  readonly timeoutSeconds: number;
  /** Opt-in. A heartbeat never extends the absolute deadline. */
  readonly heartbeatSeconds?: number;
}

function requestStep<Result>(
  reference: IntegrationSpec,
  operation: string,
  authored: Record<string, unknown>,
  options: RequestOptions,
  origin: string,
): Flow<Result> {
  assertPositiveInteger(options?.timeoutSeconds, `${origin} timeoutSeconds`);
  if (options.heartbeatSeconds !== undefined) {
    assertPositiveInteger(options.heartbeatSeconds, `${origin} heartbeatSeconds`);
    if (options.heartbeatSeconds >= options.timeoutSeconds) {
      throw new Error(
        `${origin} has heartbeatSeconds ${options.heartbeatSeconds} and timeoutSeconds ${options.timeoutSeconds}. A heartbeat interval at or beyond the deadline never fires before it.`,
      );
    }
  }
  return integrationStep<Result>(reference, operation, {
    arguments: authored,
    completion: "callback",
    timeoutSeconds: options.timeoutSeconds,
    ...(options.heartbeatSeconds === undefined
      ? {}
      : { heartbeatSeconds: options.heartbeatSeconds }),
  });
}

/** What a native HTTP task answers with. */
export interface HttpResponse<Body = unknown> {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Body;
}

export interface HttpRequestOptions<Body = unknown> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** Appended to the endpoint the binding fixes. Always starts with `/`. */
  readonly path: WorkflowExpression<string>;
  readonly query?: Readonly<Record<string, WorkflowExpression<string>>>;
  readonly headers?: Readonly<Record<string, WorkflowExpression<string>>>;
  readonly body?: WorkflowExpression<Body>;
  /**
   * The step's own deadline.
   *
   * The native integration bounds a request at 60 seconds regardless, so this
   * can only make it shorter. It is not a general-purpose HTTP client.
   */
  readonly timeoutSeconds?: number;
}

/**
 * HTTPS calls, through an EventBridge Connection.
 *
 * Deliberately not described as `fetch`. The native integration has real
 * limits — a 60-second request timeout, a fixed set of response formats, and
 * authentication that belongs to the connection rather than to the graph — and
 * a workflow that treated it as a general HTTP client would discover those
 * limits in production.
 *
 * The connection owns authentication, so no credential is ever written in a
 * workflow, and the endpoint is fixed by the binding rather than supplied by
 * the graph: a `path` cannot become a different host.
 *
 * @see https://docs.aws.amazon.com/step-functions/latest/dg/call-https-apis.html
 */
export const http = {
  connection: httpConnectionReference,

  request<Body = unknown>(
    connection: HttpConnectionReference,
    options: HttpRequestOptions,
  ): Flow<HttpResponse<Body>> {
    assertIntegrationKind(connection, "httpConnection", "http.request()");
    if (typeof options?.method !== "string") {
      throw new Error("http.request() needs a method, such as \"POST\".");
    }
    if (options.path === undefined) {
      throw new Error(
        'http.request() needs a path, such as "/v1/payments". The host comes from the binding.',
      );
    }
    if (options.timeoutSeconds !== undefined) {
      assertPositiveInteger(options.timeoutSeconds, "http.request() timeoutSeconds");
    }
    return integrationStep<HttpResponse<Body>>(connection, "request", {
      arguments: {
        method: options.method,
        path: options.path,
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.body === undefined ? {} : { body: options.body }),
      },
      ...(options.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: options.timeoutSeconds }),
    });
  },
} as const;

/**
 * Explicitly bound AWS API actions.
 *
 * The advanced surface, and last on purpose. An operation names one service and
 * one action, the binding in CDK writes the grant and fixes the resource
 * identity, and the graph supplies only the parameters that are genuinely its
 * own. There is no reflective importer over every AWS SDK, and no attempt to
 * infer a policy from an action name — a framework that guessed at IAM would be
 * guessing at the blast radius.
 */
export const aws = {
  operation: awsOperationReference,

  /**
   * Calls one bound operation.
   *
   * The parameters are merged *under* the ones the binding fixed: a runtime
   * value cannot replace the table, bucket or key the binding named. That is
   * what makes an explicit grant meaningful.
   */
  call<Input, Output>(
    operation: AwsOperationReference<Input, Output>,
    parameters: WorkflowExpression<Input>,
  ): Flow<Output> {
    assertIntegrationKind(operation, "awsOperation", "aws.call()");
    return integrationStep<Output>(operation, "call", {
      arguments: { parameters: parameters === undefined ? {} : parameters },
    });
  },
} as const;

export type { AwsOperationReference, HttpConnectionReference };

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

/**
 * Ordered execution.
 *
 * Nested sequences flatten, so `sequence(sequence(a, b), c)` and
 * `sequence(a, b, c)` are the same graph. The result is the last step's result.
 */
export function sequence<const Steps extends readonly AnyFlow[]>(
  ...steps: Steps
): Flow<OutputOf<LastOf<Steps>>> {
  if (steps.length === 0) {
    throw new Error("sequence() needs at least one step.");
  }
  const flattened: WorkflowNode[] = [];
  for (const step of steps) {
    assertNode(step, "sequence()");
    if (step.kind === "sequence" && step.label === undefined) {
      flattened.push(...step.steps);
      continue;
    }
    flattened.push(step);
  }

  const only = flattened.length === 1 ? flattened[0] : undefined;
  if (only !== undefined) return only as Flow<OutputOf<LastOf<Steps>>>;

  const node: SequenceNode = {
    kind: "sequence",
    id: nextNodeId(),
    steps: flattened,
  };
  const last = flattened[flattened.length - 1] as WorkflowNode;
  return asFlow(node, { kind: "node", node: last.id });
}

type NamedBranches = Readonly<Record<string, AnyFlow>>;

/**
 * Concurrent branches, joined when all finish.
 *
 * The named form is preferred when results matter, because the object it
 * produces reads the way the author wrote it:
 *
 * ```ts
 * const context = parallel({ user: invokeLambda("get-user"), account: ... });
 * context.output.user
 * ```
 *
 * AWS returns branch results as an array; the compiler reassembles it, so the
 * array never reaches application code.
 */
export function parallel<const Branches extends NamedBranches>(
  branches: Branches,
): Flow<{ readonly [K in keyof Branches]: OutputOf<Branches[K]> }>;
export function parallel<const Branches extends readonly AnyFlow[]>(
  ...branches: Branches
): Flow<{ readonly [K in keyof Branches]: OutputOf<Branches[K]> }>;
export function parallel(...args: readonly unknown[]): Flow<unknown> {
  const named =
    args.length === 1 && isBranchRecord(args[0]) ? (args[0] as NamedBranches) : undefined;

  const branches = named ? Object.values(named) : (args as readonly WorkflowNode[]);
  if (branches.length === 0) {
    throw new Error("parallel() needs at least one branch.");
  }
  for (const branch of branches) assertNode(branch, "parallel()");

  const node: ParallelNode = {
    kind: "parallel",
    id: nextNodeId(),
    branches: [...branches],
    ...(named ? { names: Object.keys(named) } : {}),
  };
  return asFlow(node);
}

function isBranchRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as WorkflowNode).kind === undefined
  );
}

/**
 * A two-way branch.
 *
 * With no false branch the true branch is simply skipped, both paths continue,
 * and the result is `T | undefined` — because a value produced by work that may
 * not have run is exactly that.
 */
export function when<T>(condition: WorkflowCondition, whenTrue: Flow<T>): Flow<T | undefined>;
export function when<T, F>(
  condition: WorkflowCondition,
  whenTrue: Flow<T>,
  whenFalse: Flow<F>,
): Flow<T | F>;
export function when(
  condition: WorkflowCondition,
  whenTrue: WorkflowNode,
  whenFalse?: WorkflowNode,
): Flow<unknown> {
  assertCondition(condition, "when()");
  assertNode(whenTrue, "when()");
  if (whenFalse !== undefined) assertNode(whenFalse, "when()");

  const otherwise = whenFalse ?? passThrough();
  const node: ChoiceNode = {
    kind: "choice",
    id: nextNodeId(),
    rules: [{ when: condition, then: whenTrue }],
    otherwise,
    ...(whenFalse === undefined ? { optional: true as const } : {}),
  };
  return asFlow(node);
}

/** The default branch of a `choose`. */
export function otherwise<T>(flow: Flow<T>): Otherwise<T> {
  assertNode(flow, "otherwise()");
  return { [OTHERWISE]: flow } as Otherwise<T>;
}

const OTHERWISE = Symbol.for("framework.workflow.otherwise");

export interface Otherwise<T> {
  readonly [OTHERWISE]: Flow<T>;
}

export type ChooseRule<T> = readonly [WorkflowCondition, Flow<T>];

/**
 * Multi-way branching, evaluated in order, first match wins.
 *
 * The `otherwise` branch is required. An unmatched Choice is a runtime failure
 * in AWS, and demanding a default here is a better answer than discovering
 * `States.NoChoiceMatched` in a production execution.
 */
export function choose<
  const Rules extends readonly ChooseRule<unknown>[],
  Default,
>(
  ...args: readonly [...Rules, Otherwise<Default>]
): Flow<OutputOf<Rules[number][1]> | Default> {
  const fallback = args[args.length - 1] as Otherwise<Default> | undefined;
  if (fallback === undefined || fallback[OTHERWISE] === undefined) {
    throw new Error(
      "choose() needs an otherwise() branch. An unmatched choice fails the execution, so the default is declared rather than discovered.",
    );
  }
  const rules = args.slice(0, -1) as readonly ChooseRule<unknown>[];
  if (rules.length === 0) {
    throw new Error("choose() needs at least one rule.");
  }

  const node: ChoiceNode = {
    kind: "choice",
    id: nextNodeId(),
    rules: rules.map((rule, index) => {
      const origin = `choose() rule ${index + 1}`;
      if (!Array.isArray(rule) || rule.length !== 2) {
        throw new Error(
          `${origin} is not a rule. Each rule is a [condition, flow] pair, and the last argument is the otherwise() branch.`,
        );
      }
      const [condition, flow] = rule as ChooseRule<unknown>;
      assertCondition(condition, origin);
      assertNode(flow, origin);
      return { when: condition, then: flow };
    }),
    otherwise: fallback[OTHERWISE],
  };
  return asFlow(node);
}

export interface MapOptions {
  /**
   * How many iterations may run at once.
   *
   * Named the way AWS names it, and bounded the same way: an inline map runs at
   * most {@link INLINE_MAP_CONCURRENCY_LIMIT} iterations concurrently, which is
   * also the default here. An unbounded local default would make a graph that
   * fans out over a thousand items behave one way on a laptop and another in
   * production.
   *
   * @see https://docs.aws.amazon.com/step-functions/latest/dg/state-map-inline.html
   */
  readonly maxConcurrency?: number;
  readonly mode?: "inline" | "distributed";
}

/** AWS's ceiling on concurrent iterations of an inline `Map`. */
export const INLINE_MAP_CONCURRENCY_LIMIT = 40;

/** The `{ item, index }` binding a map body receives. */
export interface MapIteration<Element> {
  readonly item: WorkflowValue<Element>;
  readonly index: WorkflowValue<number>;
}

/**
 * Runs a subgraph once per item.
 *
 * The callback constructs a subgraph; it does not iterate. It is handed one
 * object rather than two positional parameters, so a body that only needs the
 * item is written `({ item }) => ...` and never has to name an `index` it does
 * not use.
 */
export function map<Element, Result>(
  items: WorkflowValue<readonly Element[]>,
  body: (iteration: MapIteration<Element>) => Flow<Result>,
  options: MapOptions = {},
): Flow<readonly Result[]> {
  const reference = termOf(items);
  if (reference === undefined) {
    throw new Error(
      "map() iterates a workflow value, such as input.files or a previous step's output.",
    );
  }
  const mode = options.mode ?? "inline";
  if (options.maxConcurrency !== undefined) {
    assertPositiveInteger(options.maxConcurrency, "map() maxConcurrency");
    if (mode === "inline" && options.maxConcurrency > INLINE_MAP_CONCURRENCY_LIMIT) {
      throw new Error(
        `map() maxConcurrency is ${options.maxConcurrency}, and an inline map runs at most ${INLINE_MAP_CONCURRENCY_LIMIT} iterations at once. Ask for ${INLINE_MAP_CONCURRENCY_LIMIT} or fewer.`,
      );
    }
  }

  const id = nextNodeId();
  const built = body({
    item: symbolicValue<Element>({ kind: "mapBinding", map: id, field: "item" }),
    index: symbolicValue<number>({ kind: "mapBinding", map: id, field: "index" }),
  });
  assertNode(built, "map()");

  const node: MapNode = {
    kind: "map",
    id,
    items: reference,
    body: built,
    mode,
    maxConcurrency: options.maxConcurrency ?? INLINE_MAP_CONCURRENCY_LIMIT,
  };
  return asFlow(node);
}

export interface WaitOptions {
  readonly seconds?: WorkflowExpression<number>;
  readonly until?: WorkflowExpression<string>;
}

/** Suspends execution, for a duration or until a timestamp. */
export function wait(options: WaitOptions): Flow<undefined> {
  const hasSeconds = options.seconds !== undefined;
  const hasUntil = options.until !== undefined;
  if (hasSeconds === hasUntil) {
    throw new Error(
      'wait() takes either { seconds } or { until }, and exactly one of them.',
    );
  }
  const node: WaitNode = {
    kind: "wait",
    id: nextNodeId(),
    ...(hasSeconds ? { seconds: options.seconds } : {}),
    ...(hasUntil ? { until: options.until } : {}),
  };
  return asFlow(node);
}

/**
 * Retries failing work.
 *
 * `retries: 3` means three retries — four runs in total — which is AWS's own
 * counting and is worth stating because it is the obvious thing to get wrong.
 */
export function retry<T>(body: Flow<T>, policy: WorkflowRetryPolicy): Flow<T> {
  assertNode(body, "retry()");
  assertPositiveInteger(policy.retries, "retry() retries", { allowZero: true });

  const node: RetryNode = {
    kind: "retry",
    id: nextNodeId(),
    body,
    policy,
  };
  return asFlow(node, { kind: "node", node: body.id });
}

export interface AttemptOptions {
  readonly on?: WorkflowErrorSelector;
}

/**
 * An error boundary.
 *
 * The handler receives a symbolic error value, so it can report what failed
 * without the graph having to name an ASL field.
 */
export function attempt<T, H>(
  body: Flow<T>,
  handler: (error: WorkflowValue<WorkflowErrorValue>) => Flow<H>,
  options: AttemptOptions = {},
): Flow<T | H> {
  assertNode(body, "attempt()");

  const id = nextNodeId();
  const built = handler(
    symbolicValue<WorkflowErrorValue>({ kind: "error", attempt: id }),
  );
  assertNode(built, "attempt()");

  const node: AttemptNode = {
    kind: "attempt",
    id,
    body,
    handler: built,
    ...(options.on === undefined ? {} : { on: options.on }),
  };
  return asFlow(node);
}

/**
 * A named intermediate value.
 *
 * A `transform` is not required to reshape data — a payload position already
 * accepts objects, arrays, literals and symbolic values in any arrangement.
 * It exists for when the reshaped value needs a *name*, because two later
 * steps both read it, or because the history should show it as a step.
 *
 * ```ts
 * const summary = transform({
 *   orderId: input.orderId,
 *   status: expr.ifElse(eq(approval.output.approved, true), "approved", "rejected"),
 * });
 * ```
 */
export function transform<const Value>(value: Value): Flow<ValueOf<Value>> {
  if (value === undefined) {
    throw new Error("transform() takes the value to produce.");
  }
  const node: PassNode = { kind: "pass", id: nextNodeId(), result: value };
  return asFlow<ValueOf<Value>>(node);
}

/** Ends the workflow, or a branch of it, successfully. */
export function succeed<T = undefined>(
  output?: WorkflowExpression<T>,
): Flow<T> {
  const node: SucceedNode = {
    kind: "succeed",
    id: nextNodeId(),
    ...(output === undefined ? {} : { result: output }),
  };
  return asFlow(node);
}

export interface FailOptions {
  readonly error: string;
  readonly cause?: string;
}

/** Ends the workflow, or a branch of it, with a failure. */
export function fail(error: string | FailOptions): Flow<never> {
  const options = typeof error === "string" ? { error } : error;
  if (typeof options?.error !== "string" || options.error.length === 0) {
    throw new Error('fail() needs an error name, such as fail("ValidationFailed").');
  }
  const node: FailNode = {
    kind: "fail",
    id: nextNodeId(),
    error: options.error,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
  return asFlow(node);
}

/**
 * Names a flow for the console and local logs.
 *
 * Observability only: a label never participates in wiring, so removing one can
 * never change what a graph does.
 */
export function label<T>(name: string, flow: Flow<T>): Flow<T> {
  assertNode(flow, "label()");
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("label() needs a name.");
  }
  Object.defineProperty(flow, "label", {
    value: name,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return flow;
}

/**
 * The implicit else of a one-armed `when`.
 *
 * A pass rather than a succeed: skipping optional work continues the flow, and
 * ending the execution instead would be a very surprising reading of
 * `when(condition, optionalWork)`.
 */
function passThrough(): PassNode {
  return { kind: "pass", id: nextNodeId() };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function operand(value: unknown): WorkflowOperand {
  return termOf(value) ?? { literal: value };
}

function comparison(
  comparator: WorkflowComparator,
  left: unknown,
  right: unknown,
): WorkflowCondition {
  return { kind: "compare", comparator, left: operand(left), right: operand(right) };
}

export function eq<T>(left: WorkflowExpression<T>, right: WorkflowExpression<T>): WorkflowCondition {
  return comparison("eq", left, right);
}
export function ne<T>(left: WorkflowExpression<T>, right: WorkflowExpression<T>): WorkflowCondition {
  return comparison("ne", left, right);
}
export function gt(left: WorkflowExpression<number>, right: WorkflowExpression<number>): WorkflowCondition {
  return comparison("gt", left, right);
}
export function gte(left: WorkflowExpression<number>, right: WorkflowExpression<number>): WorkflowCondition {
  return comparison("gte", left, right);
}
export function lt(left: WorkflowExpression<number>, right: WorkflowExpression<number>): WorkflowCondition {
  return comparison("lt", left, right);
}
export function lte(left: WorkflowExpression<number>, right: WorkflowExpression<number>): WorkflowCondition {
  return comparison("lte", left, right);
}
export function contains(value: WorkflowExpression<string>, needle: WorkflowExpression<string>): WorkflowCondition {
  return comparison("contains", value, needle);
}
export function startsWith(value: WorkflowExpression<string>, prefix: WorkflowExpression<string>): WorkflowCondition {
  return comparison("startsWith", value, prefix);
}
export function endsWith(value: WorkflowExpression<string>, suffix: WorkflowExpression<string>): WorkflowCondition {
  return comparison("endsWith", value, suffix);
}

export function and(...operands: readonly WorkflowCondition[]): WorkflowCondition {
  assertOperands(operands, "and()");
  return { kind: "and", operands };
}
export function or(...operands: readonly WorkflowCondition[]): WorkflowCondition {
  assertOperands(operands, "or()");
  return { kind: "or", operands };
}
export function not(operand: WorkflowCondition): WorkflowCondition {
  assertCondition(operand, "not()");
  return { kind: "not", operand };
}

/** Whether a member is present at all, which is not the same as being null. */
export function exists(value: WorkflowValue<unknown>): WorkflowCondition {
  return { kind: "exists", value: requireTerm(value, "exists()") };
}

export function isNull(value: WorkflowValue<unknown>): WorkflowCondition {
  return { kind: "isNull", value: requireTerm(value, "isNull()") };
}

// ---------------------------------------------------------------------------
// Expressions
//
// The data half of the language. A workflow step orchestrates work; these
// reshape what the steps produced, without a Lambda whose whole job is to
// rename three fields.
//
// A closed set, deliberately. Accepting raw JSONata would put an expression
// language the framework does not evaluate into the one place both lanes have
// to agree — the local interpreter would then need its own JSONata engine, and
// keeping two engines in agreement is the problem this design exists to avoid.
// ---------------------------------------------------------------------------

/** The value an authored expression produces at run time. */
export type ValueOf<Value> = Value extends WorkflowValue<infer T>
  ? T
  : Value extends readonly unknown[]
    ? { -readonly [K in keyof Value]: ValueOf<Value[K]> }
    : Value extends object
      ? { -readonly [K in keyof Value]: ValueOf<Value[K]> }
      : Value;

function operation<T>(
  operator: WorkflowOperator,
  operands: readonly unknown[],
  extra: {
    readonly condition?: WorkflowCondition;
    readonly lambda?: WorkflowLambda;
  } = {},
): WorkflowValue<T> {
  const node: WorkflowOperation = {
    kind: "operation",
    operator,
    operands,
    path: [],
    ...(extra.condition === undefined ? {} : { condition: extra.condition }),
    ...(extra.lambda === undefined ? {} : { lambda: extra.lambda }),
  };
  return symbolicTerm<T>(node);
}

function requireArray(value: unknown, origin: string): WorkflowTerm {
  return requireTerm(value, origin);
}

/**
 * Operations over symbolic values.
 *
 * Every one of these is total in the same way in both lanes: an operand that
 * is absent makes the whole expression absent, which fails where it is read;
 * an operand of the wrong type is a query-evaluation error, because that is
 * what the compiled expression produces.
 */
export const expr = {
  add(
    left: WorkflowExpression<number>,
    right: WorkflowExpression<number>,
  ): WorkflowValue<number> {
    return operation<number>("add", [left, right]);
  },
  subtract(
    left: WorkflowExpression<number>,
    right: WorkflowExpression<number>,
  ): WorkflowValue<number> {
    return operation<number>("subtract", [left, right]);
  },
  multiply(
    left: WorkflowExpression<number>,
    right: WorkflowExpression<number>,
  ): WorkflowValue<number> {
    return operation<number>("multiply", [left, right]);
  },
  /** Division by zero is a query-evaluation error: JSONata has no infinity. */
  divide(
    left: WorkflowExpression<number>,
    right: WorkflowExpression<number>,
  ): WorkflowValue<number> {
    return operation<number>("divide", [left, right]);
  },
  /** Joins strings. A non-string operand is an error rather than coerced. */
  concat(...parts: readonly WorkflowExpression<string>[]): WorkflowValue<string> {
    if (parts.length < 2) {
      throw new Error("expr.concat() joins at least two values.");
    }
    return operation<string>("concat", parts);
  },
  /**
   * The first value that is present and not null.
   *
   * This is the supported way to read something that may genuinely be absent.
   * Reading it directly is an error in both lanes, because JSON has no
   * undefined and AWS refuses an expression that produces one.
   */
  coalesce<T>(
    value: WorkflowExpression<T | null | undefined>,
    fallback: WorkflowExpression<T>,
    ...rest: readonly WorkflowExpression<T>[]
  ): WorkflowValue<T> {
    return operation<T>("coalesce", [value, fallback, ...rest]);
  },
  /** Chooses between two values. Control flow is `when`; this is data. */
  ifElse<T, F>(
    condition: WorkflowCondition,
    whenTrue: WorkflowExpression<T>,
    whenFalse: WorkflowExpression<F>,
  ): WorkflowValue<T | F> {
    assertCondition(condition, "expr.ifElse()");
    return operation<T | F>("ifElse", [whenTrue, whenFalse], { condition });
  },
  /** The length of a string or an array. */
  length(
    value: WorkflowValue<string> | WorkflowValue<readonly unknown[]>,
  ): WorkflowValue<number> {
    requireTerm(value, "expr.length()");
    return operation<number>("length", [value]);
  },
  /** One element of an array. Out of range is absent, not an error. */
  at<Element>(
    array: WorkflowValue<readonly Element[]>,
    index: WorkflowExpression<number>,
  ): WorkflowValue<Element> {
    requireArray(array, "expr.at()");
    return operation<Element>("at", [array, index]);
  },
  /**
   * Every element, transformed.
   *
   * Data only: nothing is scheduled and nothing runs concurrently. Use `map`
   * when each element needs work done to it, and this when each element needs
   * to be *shaped*.
   */
  project<Element, Selected>(
    array: WorkflowValue<readonly Element[]>,
    select: (element: WorkflowValue<Element>) => Selected,
  ): WorkflowValue<readonly ValueOf<Selected>[]> {
    requireArray(array, "expr.project()");
    const binding = nextBindingId();
    const body = select(
      symbolicValue<Element>({ kind: "elementBinding", binding }),
    );
    return operation<readonly ValueOf<Selected>[]>("project", [array], {
      lambda: { binding, body },
    });
  },
  /** The elements a predicate keeps, in order. */
  filter<Element>(
    array: WorkflowValue<readonly Element[]>,
    keep: (element: WorkflowValue<Element>) => WorkflowCondition,
  ): WorkflowValue<readonly Element[]> {
    requireArray(array, "expr.filter()");
    const binding = nextBindingId();
    const predicate = keep(
      symbolicValue<Element>({ kind: "elementBinding", binding }),
    );
    assertCondition(predicate, "expr.filter()");
    return operation<readonly Element[]>("filter", [array], {
      lambda: { binding, predicate },
    });
  },
  /** A shallow combination of JSON objects, later operands winning. */
  merge<Left extends object, Right extends object>(
    left: WorkflowExpression<Left>,
    right: WorkflowExpression<Right>,
    ...rest: readonly WorkflowExpression<object>[]
  ): WorkflowValue<Left & Right> {
    return operation<Left & Right>("merge", [left, right, ...rest]);
  },
} as const;

// ---------------------------------------------------------------------------
// The escape hatch
// ---------------------------------------------------------------------------

/**
 * Verbatim AWS states, for what the language does not model.
 *
 * Named to be unattractive, and not imported by ordinary workflows. A raw state
 * asks for AWS-specific behavior the framework cannot derive: local parity is
 * not automatic, type safety is reduced, and the local interpreter refuses to
 * run a graph containing one rather than approximating it.
 */
export const unsafe = {
  rawState(state: Readonly<Record<string, unknown>>): Flow<unknown> {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("unsafe.rawState() takes an ASL state object.");
    }
    const node: RawStateNode = { kind: "rawState", id: nextNodeId(), state };
    return asFlow(node);
  },
} as const;

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export interface WorkflowContext<In> {
  readonly input: WorkflowValue<In>;
}

/**
 * Declares a workflow.
 *
 * The callback runs once, immediately, and must be synchronous: it is building a
 * graph, not executing one. Its returned flow is the workflow — its first node
 * starts execution, its last ends it, and the workflow's result is that node's
 * output unless a `succeed()` says otherwise.
 */
export function workflow<In = unknown, Out = unknown>(
  build: (context: WorkflowContext<In>) => Flow<Out>,
  options: WorkflowOptions,
): WorkflowDefinition {
  if (typeof build !== "function") {
    throw new Error("workflow() takes a callback that builds its graph.");
  }
  if (activeBuild !== undefined) {
    throw new Error(
      "workflow() was called inside another workflow(). Declare each graph separately and compose them with runWorkflow().",
    );
  }

  const previous = activeBuild;
  activeBuild = { counter: 0, bindings: 0 };
  let root: Flow<Out>;
  try {
    root = build({ input: symbolicValue<In>({ kind: "input" }) });
  } finally {
    activeBuild = previous;
  }

  assertNode(root, "workflow()");
  assertPositiveInteger(options?.timeoutSeconds, "workflow() timeoutSeconds");

  return {
    root,
    timeoutSeconds: options.timeoutSeconds,
    ...(options.deploy === undefined ? {} : { deploy: options.deploy }),
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
  };
}

// ---------------------------------------------------------------------------
// Argument checks
//
// Cheap, and at the call site: a mistake here is a stack trace pointing at the
// line that made it, rather than a puzzle discovered during compilation.
// ---------------------------------------------------------------------------

function assertNode(value: unknown, origin: string): asserts value is WorkflowNode {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as WorkflowNode).kind !== "string" ||
    typeof (value as WorkflowNode).id !== "string"
  ) {
    throw new Error(
      `${origin} expects a workflow step, such as invokeLambda(...), runTask(...) or sequence(...).`,
    );
  }
}

function assertCondition(value: unknown, origin: string): void {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error(
      `${origin} expects a condition, such as eq(input.status, "ready") or and(...).`,
    );
  }
}

function assertOperands(operands: readonly unknown[], origin: string): void {
  if (operands.length === 0) {
    throw new Error(`${origin} needs at least one condition.`);
  }
  for (const operand of operands) assertCondition(operand, origin);
}

function requireTerm(value: unknown, origin: string): WorkflowTerm {
  const term = termOf(value);
  if (term === undefined) {
    throw new Error(`${origin} expects a workflow value, such as a step's output.`);
  }
  return term;
}

function assertPositiveInteger(
  value: unknown,
  origin: string,
  { allowZero = false }: { readonly allowZero?: boolean } = {},
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(
      `${origin} must be a ${allowZero ? "non-negative" : "positive"} integer.`,
    );
  }
}
