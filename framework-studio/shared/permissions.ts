import type { ModeModel, ModelEdge } from "./model";
import { nativeGrantLabels } from "./grants";

/** Typed source intent. Labels and authored descriptions never determine authorization. */
export type PermissionContext =
  | { readonly kind: "database"; readonly connection: "application" | "direct"; readonly readers: boolean }
  | { readonly kind: "native"; readonly method: string; readonly arguments: readonly unknown[] }
  | { readonly kind: "secret"; readonly delivery: "arn" | "startup" }
  | { readonly kind: "step"; readonly target: "lambda" | "task" | "workflow" | "agent"; readonly callback: boolean }
  | { readonly kind: "integration"; readonly service: string; readonly operations: readonly string[] }
  | { readonly kind: "trigger"; readonly adapter: string; readonly delivery?: string }
  | { readonly kind: "trigger-dlq"; readonly adapter: string }
  | { readonly kind: "subscription"; readonly protocol: "sqs" }
  | { readonly kind: "failure" };

export interface PermissionGrant {
  readonly principal: string;
  readonly principalEntity?: string;
  readonly policy: "Identity policy" | "Resource policy" | "Native CDK grant";
  /** Absent for native/custom grants whose exact expansion requires synthesis. */
  readonly actions?: readonly string[];
  readonly scope: string;
  readonly via?: string;
  readonly conditions?: readonly string[];
}

export interface ConnectionAuthorization {
  readonly kind: "iam" | "user-token" | "local" | "unknown";
  readonly operation: string;
  readonly state: "planned" | "not-built" | "local";
  readonly grants: readonly PermissionGrant[];
  readonly notes: readonly string[];
}

export const hasIam = (edge: Pick<ModelEdge, "authorization">): boolean => edge.authorization?.kind === "iam";
/** A connection keeps its authored purpose; authorization only adds supporting facts. */
export const connectionTitle = (edge: ModelEdge): string => edge.label;
export function authorizationLabel(authorization: ConnectionAuthorization): string {
  return authorization.kind === "iam" ? authorization.state === "planned" ? "IAM grant" : "Cloud IAM intent"
    : authorization.kind === "local" ? "Local connection" : authorization.kind === "user-token" ? "User token" : "Source evidence";
}
export function authorizationSummary(authorization: ConnectionAuthorization): string[] {
  if (authorization.kind !== "iam") return [];
  const permissions = [...new Set(authorization.grants.flatMap(grant => grant.actions ?? [grant.via ?? "Native grant"]))];
  if (!permissions.length) return [];
  const summary = permissions.slice(0, 3).join(", ");
  return [`IAM: ${summary}${permissions.length > 3 ? `, +${permissions.length - 3} more` : ""}`];
}

// Read/write helpers also exist on non-bucket constructs, including Secrets Manager.
export const NATIVE_GRANT_LABELS: Readonly<Record<string, string>> = { ...nativeGrantLabels,
  grantRead: "Read resource", grantWrite: "Write resource", grantReadWrite: "Read and write resource",
};

/** Fast declaration evidence, shared by normal evaluation, source enrichment and reviewed previews.
 * These facts describe the framework adapters, never effective or deployed IAM access. */
export function withConnectionAuthorizations(model: ModeModel): ModeModel {
  const targets = new Map(model.targets.map(target => [target.ref, target]));
  const resources = new Map(model.resources.map(resource => [resource.id, resource]));
  const role = (id: string, execution = false): string => {
    const kind = targets.get(id)?.kind;
    return `${execution ? "ECS execution role" : kind === "lambda" ? "Lambda execution role" : kind === "task" || kind === "service" ? "ECS task role" : kind === "workflow" ? "Workflow role" : kind === "agent" ? "Agent Runtime role" : "Workload role"} · ${id}`;
  };
  const identity = (id: string, actions: readonly string[] | undefined, scope: string, extra: Partial<PermissionGrant> = {}): PermissionGrant =>
    ({ principal: role(id), principalEntity: id, policy: "Identity policy", ...(actions ? { actions } : {}), scope, ...extra });
  const launch = (from: string, to: string): PermissionGrant[] => [
    identity(from, ["ecs:RunTask"], `${to} task-definition family:*`, { conditions: ["ecs:cluster = declared cluster"] }),
    identity(from, ["ecs:TagResource"], `${to} tasks in declared cluster`, { conditions: ["ecs:CreateAction = RunTask"] }),
    identity(from, ["iam:PassRole"], `${to} task role and execution role`, { conditions: ["iam:PassedToService = ecs-tasks.amazonaws.com"] }),
  ];
  const callback = (from: string): PermissionGrant => identity(from,
    ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"],
    '* (callback actions do not support resource-level scoping; possession of a valid task token is required)');
  const native = (from: string, to: string, method: string, args: readonly unknown[] = []): PermissionGrant =>
    identity(from, method === "grant" && args.every(argument => typeof argument === "string") ? args as string[] : undefined, to,
      { policy: "Native CDK grant", via: `${method}(${args.map(argument => JSON.stringify(argument)).join(", ")})` });
  const status = (edge: ModelEdge, grants: readonly PermissionGrant[]): ConnectionAuthorization["state"] => {
    const ids = new Set([edge.from, edge.to, ...grants.flatMap(grant => grant.principalEntity ? [grant.principalEntity] : [])]);
    return [...ids].some(id => {
      const target = targets.get(id), resource = resources.get(id);
      return target ? !target.lanes[model.mode] : resource?.absent;
    }) ? "not-built" : "planned";
  };
  const describe = (edge: ModelEdge): ConnectionAuthorization | undefined => {
    const context = edge.permissionContext;
    let operation = edge.label, grants: PermissionGrant[] = [], notes: string[] = [];
    if (edge.relation === "database") {
      operation = context?.kind === "database" && context.connection === "direct" ? "Connect PostgreSQL directly" : "Connect PostgreSQL";
      if (edge.to.startsWith("local:")) return { kind: "local", operation, state: "local", grants: [], notes: ["Compose PostgreSQL uses the local database connection, without an RDS IAM grant."] };
      grants = [identity(edge.from, ["rds-db:connect"], `${edge.to} · ${context?.kind === "database" && context.connection === "direct" ? "direct writer" : "application writer / Proxy"} · login app_user`)];
      if (context?.kind === "database" && context.readers) {
        grants.push(identity(edge.from, ["rds-db:connect"], `${edge.to} · configured readers · login app_user`));
        notes.push("Reader access retains writer access; it does not make this workload read-only.");
      }
      notes.push("Also configures network placement and password-free endpoints. PostgreSQL privileges and application authorization are separate.");
    } else if (context?.kind === "native") {
      operation = NATIVE_GRANT_LABELS[context.method] ?? (context.method === "grant" ? "Grant AWS actions" : context.method);
      grants = [native(edge.from, edge.to, context.method, context.arguments)];
      notes.push("Native CDK determines the full action set and applicable resource/key policies. Inspect synthesis for the expanded statements.");
    } else if (context?.kind === "secret" || edge.relation === "secret") {
      const startup = context?.kind === "secret" ? context.delivery === "startup" : true;
      operation = startup ? "Inject startup secret" : "Read secret";
      grants = [identity(edge.from, ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], edge.to,
        startup ? { principal: role(edge.from, true) } : {})];
      notes.push(startup ? "ECS reads the secret before application startup; this permission belongs to the execution role." : "Delivers the typed secret ARN to the workload; the workload reads its contents.",
        "A customer-managed encryption key also requires kms:Decrypt restricted through Secrets Manager.");
    } else if (edge.relation === "runsTask" || context?.kind === "step" && context.target === "task") {
      operation = "Launch ECS task"; grants = launch(edge.from, edge.to);
      if (context?.kind === "step") {
        grants.push(identity(edge.from, ["ecs:DescribeTasks", "ecs:StopTask"], "* (task IDs are assigned at runtime)"),
          identity(edge.from, ["events:PutRule", "events:PutTargets", "events:DescribeRule"], "Step Functions managed ECS task event rule"));
        if (context.callback) grants.push(callback(edge.to));
      }
      notes.push("Also supplies launch configuration; this capability does not establish that a task has run.");
    } else if (edge.relation === "startsWorkflow" || context?.kind === "step" && context.target === "workflow") {
      operation = "Start workflow"; grants = [identity(edge.from, ["states:StartExecution"], edge.to)];
      if (context?.kind === "step") grants.push(identity(edge.from, ["states:DescribeExecution", "states:StopExecution"], "execution:* in this stack's account and region"),
        identity(edge.from, ["events:PutRule", "events:PutTargets", "events:DescribeRule"], "Step Functions managed execution event rule"));
    } else if (edge.relation === "invokesAgent" || context?.kind === "step" && context.target === "agent") {
      operation = "Invoke agent";
      if (targets.get(edge.to)?.auth) return { kind: "user-token", operation, state: status(edge, []), grants: [], notes: ["Forwards the authenticated user's token. No caller-role IAM invocation grant is derived."] };
      grants = [identity(edge.from, ["bedrock-agentcore:InvokeAgentRuntime"], edge.to)];
    } else if (context?.kind === "step" && context.target === "lambda") {
      operation = "Invoke Lambda"; grants = [identity(edge.from, ["lambda:InvokeFunction"], edge.to)];
    } else if (edge.relation === "usesTool") {
      operation = "Access agent tool";
      grants = [identity(edge.from, ["bedrock-agentcore:InvokeGateway"], `${edge.from} tool Gateway`),
        { principal: `Agent Gateway role · ${edge.from}`, principalEntity: edge.from, policy: "Native CDK grant", scope: edge.to, via: "Gateway Lambda target authorization" }];
      notes.push("Access passes through the agent's IAM-protected Gateway. Inspect synthesis for native target policy details.");
    } else if (edge.relation === "completesCallback") {
      operation = "Complete workflow callback"; grants = [callback(edge.from)];
      notes.push("The connected integration is delivery context; the IAM permission is on Step Functions, not on this queue/topic.");
    } else if (context?.kind === "integration") {
      operation = `${context.operations.join(", ")} · ${context.service}`;
      const methods: Record<string, string> = { queue: "grantSendMessages", topic: "grantPublish", eventBus: "grantPutEventsTo" };
      if (context.service === "table") {
        if (context.operations.includes("get")) grants.push(native(edge.from, edge.to, "grantReadData"));
        if (context.operations.some(operation => operation !== "get")) grants.push(native(edge.from, edge.to, "grantWriteData"));
      } else if (methods[context.service]) grants = [native(edge.from, edge.to, methods[context.service]!)];
      else if (context.service === "httpConnection") {
        grants = [identity(edge.from, ["states:InvokeHTTPEndpoint"], "*", { conditions: ["states:HTTPEndpoint = HTTPS endpoint fixed by the native binding"] }),
          identity(edge.from, ["events:RetrieveConnectionCredentials"], `EventBridge Connection bound to ${edge.to}`),
          identity(edge.from, ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], "events!connection/* secrets in this stack's account and region")];
        notes.push("The native HTTP binding fixes the endpoint and connection. Their resolved identifiers require synthesis.");
      }
      else return { kind: "unknown", operation, state: status(edge, []), grants: [], notes: ["This integration uses an application-defined grant. Inspect its native binding and synthesized policies."] };
      notes.push("Declared operations choose native CDK grants; helpers can include multiple actions and encryption permissions.");
    } else if (context?.kind === "trigger-dlq") {
      operation = "Deliver trigger failures";
      if (context.adapter === "dynamodb") grants = [native(edge.from, edge.to, "grantSendMessages")];
      else if (context.adapter === "sns" || context.adapter === "eventbridge") grants = [{
        principal: context.adapter === "sns" ? "sns.amazonaws.com" : "events.amazonaws.com", policy: "Native CDK grant", scope: edge.to,
        via: "grantSendMessages (plus applicable encryption grants)", conditions: ["Restricted to the configured source topic / rule"],
      }];
      else return { kind: "unknown", operation, state: "planned", grants: [], notes: ["Custom trigger failure delivery requires native adapter or synthesis evidence."] };
    } else if (context?.kind === "trigger") {
      const adapter = context.adapter === "s3" && context.delivery === "eventbridge" ? "eventbridge" : context.adapter;
      if (adapter === "schedule") {
        operation = "Invoke on schedule";
        grants = [{ principal: `Scheduler execution role · ${edge.from}`, policy: "Identity policy", actions: ["lambda:InvokeFunction"], scope: edge.to }];
        notes.push("The schedule role trusts scheduler.amazonaws.com; it is distinct from the function's execution role.");
      } else if (adapter === "sqs" || adapter === "dynamodb") {
        operation = adapter === "sqs" ? "Consume queue messages" : "Read DynamoDB stream";
        grants = [native(edge.to, edge.from, adapter === "sqs" ? "grantConsumeMessages" : "grantStreamRead")];
        notes.push("The event-delivery arrow points toward the function; its execution role receives permission to read the source.");
      } else {
        const principals: Record<string, string> = { sns: "sns.amazonaws.com", s3: "s3.amazonaws.com", cognito: "cognito-idp.amazonaws.com", eventbridge: "events.amazonaws.com" };
        if (!principals[adapter]) return { kind: "unknown", operation: "Deliver event", state: "planned", grants: [], notes: ["Custom trigger authorization requires native adapter or synthesis evidence."] };
        operation = "Deliver event";
        grants = [{ principal: principals[adapter]!, policy: "Resource policy", actions: ["lambda:InvokeFunction"], scope: edge.to, conditions: [`Restricted to the configured ${adapter === "eventbridge" ? "EventBridge rule for" : adapter + " source:"} ${edge.from}`] }];
      }
    } else if (context?.kind === "subscription") {
      operation = "Deliver topic messages to queue";
      grants = [{ principal: "sns.amazonaws.com", policy: "Resource policy", actions: ["sqs:SendMessage"], scope: edge.to, conditions: [`aws:SourceArn = ${edge.from}`] }];
      notes.push("Native SNS/SQS subscription; synthesis resolves the queue policy and applicable encryption permissions.");
    } else if (context?.kind === "failure") {
      operation = "Deliver failed invocations";
      grants = [identity(edge.from, undefined, edge.to, { policy: "Native CDK grant", via: "SQS/SNS asynchronous failure destination" })];
    } else if (edge.relation === "manageConnections") {
      operation = "Send to WebSocket clients";
      grants = [identity(edge.from, ["execute-api:ManageConnections"], "Declared WebSocket API and stage")];
    } else if (edge.relation === "localReplay") {
      operation = "Capture development replay";
      grants = [native(edge.from, `${edge.to} replay bucket`, "grantWrite")];
      notes.push("Development capture/transport only. Production invokes the handler directly.");
    } else if (edge.relation === "routes" && targets.get(edge.to)?.kind === "lambda") {
      operation = edge.label;
      grants = [{ principal: "apigateway.amazonaws.com", policy: "Resource policy", actions: ["lambda:InvokeFunction"], scope: edge.to, via: "Native API Gateway Lambda integration" }];
    } else if (edge.relation === "authorizes" && targets.get(edge.from)?.kind === "lambda") {
      operation = "Authorize WebSocket connection";
      grants = [{ principal: "apigateway.amazonaws.com", policy: "Resource policy", actions: ["lambda:InvokeFunction"], scope: edge.from, via: "Native API Gateway Lambda authorizer" }];
    } else if (edge.relation === "cdk") return { kind: "unknown", operation: edge.label, state: "planned", grants: [], notes: ["A native source reference does not establish its IAM effects. Inspect the linked CDK or synthesized policies."] };
    else return undefined;
    return { kind: "iam", operation, state: status(edge, grants), grants, notes };
  };
  const edges: ModelEdge[] = model.edges.map(edge => {
    const { authorization: _old, ...source } = edge;
    const authorization = describe(source);
    return authorization ? { ...source, authorization } : source;
  });
  return { ...model, edges, targets: model.targets.map(target => ({ ...target,
    authorizations: [
      ...edges.filter(edge => edge.authorization && (edge.from === target.ref || edge.to === target.ref || edge.authorization.grants.some(grant => grant.principalEntity === target.ref)))
        .map(edge => ({ connection: edge.id, authorization: edge.authorization! })),
      ...(target.permissionSources ?? []).flatMap((source, index) => {
        const authorization = describe({ id: `permission:${target.ref}:${index}`, relation: source.relation,
          from: source.incoming ? source.peer : target.ref, to: source.incoming ? target.ref : source.peer,
          label: source.label, provenance: "derived", permissionContext: source.context });
        return authorization ? [{ authorization }] : [];
      }),
      ...target.access.map(statement => ({ authorization: { kind: "iam" as const, operation: "Explicit IAM policy", state: target.lanes[model.mode] ? "planned" as const : "not-built" as const,
        grants: [identity(target.ref, statement.actions, statement.resources.join(", "))], notes: ["Explicit Allow policy from cloud.access; resource patterns retain deployment placeholders."] } })),
    ],
  })) };
}
