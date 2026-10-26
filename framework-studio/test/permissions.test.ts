import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineFrameworkConfig, defineResources, resource, trigger, type FrameworkConfig } from "@repo/framework/config";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import { projectModel } from "../server/model/project";
import type { ModeModel, ModelEdge, ModelTarget } from "../shared/model";
import { authorizationSummary, connectionTitle, hasIam, withConnectionAuthorizations } from "../shared/permissions";
import { grantOptions } from "../shared/grants";
import { aggregateConnections } from "../src/connections";
import { connectionVisible } from "../src/scene/connections";
import { connectionSignature } from "../server/edits/batch";
import { planConnection } from "../server/edits/connections";
import type { StudioState } from "../server/snapshot";

const base = () => projectModel({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: { "/caller": { directory: "/lambda_functions/caller", methods: ["GET"] } }, webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {} } as FrameworkConfig, { mode: "prod" });
const target = (ref: string, kind: ModelTarget["kind"] = "lambda", extra: Partial<ModelTarget> = {}): ModelTarget => ({ ...base().targets[0]!, ref, id: ref.split(":")[1]!, kind, role: kind === "lambda" ? "http" : kind, ...extra });
const edge = (relation: ModelEdge["relation"], context?: ModelEdge["permissionContext"], extra: Partial<ModelEdge> = {}): ModelEdge => ({ id: "test", relation, from: "lambda:caller", to: "resource:store.data", label: "An authored label", provenance: "declared", permissionContext: context, ...extra });
function describe(item: ModelEdge, targets: readonly ModelTarget[] = [target("lambda:caller")], mode: "dev" | "prod" = "prod") {
  return withConnectionAuthorizations({ ...base(), mode, targets, edges: [item] }).edges[0]!;
}

test("database IAM describes writer, readers and direct access; local enrichment removes AWS grants", () => {
  const source = edge("database", { kind: "database", connection: "direct", readers: true });
  const cloud = describe(source);
  assert.equal(connectionTitle(cloud), source.label);
  assert.equal(cloud.authorization!.operation, "Connect PostgreSQL directly");
  assert.equal(cloud.authorization!.grants.length, 2);
  assert.deepEqual(cloud.authorization!.grants[0]!.actions, ["rds-db:connect"]);
  assert.match(cloud.authorization!.grants[0]!.scope, /direct writer.*app_user/);
  assert.ok(cloud.authorization!.notes.some(note => note.includes("retains writer")));
  const local = describe({ ...cloud, to: "local:postgres" }, undefined, "dev");
  assert.equal(local.authorization!.kind, "local");
  assert.deepEqual(local.authorization!.grants, []);
  assert.equal(local.label, source.label, "presentation preserves authored labels and descriptions");
});

test("permission facts preserve route, input, scope and callback labels as connection identity", () => {
  const cases = [
    edge("routes", undefined, { from: "route:http:/caller", to: "lambda:caller", label: "/api/caller" }),
    edge("routes", undefined, { from: "route:webSocket:customAction", to: "lambda:caller", label: "customAction" }),
    edge("env", { kind: "secret", delivery: "arn" }, { label: "API_KEY_ARN" }),
    edge("secret", { kind: "secret", delivery: "startup" }, { label: "SERVICE_TOKEN" }),
    edge("grant", { kind: "native", method: "grantRead", arguments: ["tenant/*"] }, { label: 'grantRead("tenant/*")' }),
    edge("database", { kind: "database", connection: "application", readers: true }, { label: "database + readers" }),
    edge("step", { kind: "step", target: "task", callback: true }, { label: "runTask (callback)" }),
    edge("integration", { kind: "integration", service: "table", operations: ["get", "put"] }, { label: "get, put" }),
  ];
  for (const source of cases) {
    const result = describe(source);
    assert.equal(result.authorization!.kind, "iam", source.label);
    assert.equal(connectionTitle(result), source.label);
  }
});

test("hover permission summaries are secondary, bounded and distinguish AWS-only grants", () => {
  const route = describe(edge("routes", undefined, { to: "lambda:caller" }));
  assert.deepEqual(authorizationSummary(route.authorization!), ["IAM: lambda:InvokeFunction"]);
  assert.deepEqual(authorizationSummary({ ...route.authorization!, state: "not-built" }), ["IAM: lambda:InvokeFunction (AWS only)"]);
  const grant = route.authorization!.grants[0]!;
  const summary = authorizationSummary({ ...route.authorization!, grants: [
    { ...grant, actions: ["ecs:RunTask", "ecs:TagResource", "iam:PassRole"] },
    { ...grant, actions: ["ecs:RunTask", "ecs:DescribeTasks", "ecs:StopTask"] },
  ] });
  assert.equal(summary.length, 1);
  assert.equal(summary[0], "IAM: ecs:RunTask, ecs:TagResource, iam:PassRole, +2 more");
  for (const kind of ["local", "user-token", "unknown"] as const) {
    assert.deepEqual(authorizationSummary({ ...route.authorization!, kind, grants: [] }), []);
  }
  const native = describe(edge("grant", { kind: "native", method: "grantRead", arguments: ["tenant/*"] }));
  assert.deepEqual(authorizationSummary(native.authorization!), ['IAM: grantRead("tenant/*")']);
});

test("secret ARN and startup injection distinguish task role from execution role; ordinary reads grant nothing", () => {
  const targets = [target("task:caller", "task")];
  const startup = describe(edge("secret", { kind: "secret", delivery: "startup" }, { from: "task:caller" }), targets);
  const arn = describe(edge("env", { kind: "secret", delivery: "arn" }, { from: "task:caller" }), targets);
  assert.match(startup.authorization!.grants[0]!.principal, /ECS execution role/);
  assert.match(arn.authorization!.grants[0]!.principal, /ECS task role/);
  assert.deepEqual(arn.authorization!.grants[0]!.actions, ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]);
  assert.equal(describe(edge("env", undefined, { label: "grantRead is just text" })).authorization, undefined);
});

test("invocation capabilities include RunTask, scoped PassRole, workflow waits and reverse callback permission", () => {
  const item = describe(edge("step", { kind: "step", target: "task", callback: true }, { from: "workflow:parent", to: "task:worker" }), [target("workflow:parent", "workflow"), target("task:worker", "task")]);
  const grants = item.authorization!.grants;
  assert.ok(grants.some(grant => grant.actions?.includes("ecs:RunTask") && grant.conditions?.some(condition => condition.includes("ecs:cluster"))));
  assert.ok(grants.some(grant => grant.actions?.includes("iam:PassRole") && grant.conditions?.some(condition => condition.includes("ecs-tasks.amazonaws.com"))));
  assert.ok(grants.some(grant => grant.actions?.includes("ecs:StopTask")));
  assert.equal(grants.find(grant => grant.actions?.includes("states:SendTaskSuccess"))?.principalEntity, "task:worker");
  const child = describe(edge("step", { kind: "step", target: "workflow", callback: false }));
  assert.ok(child.authorization!.grants.some(grant => grant.actions?.includes("states:StopExecution")));
});

test("authenticated agents use user tokens; service agents and tools retain their IAM paths", () => {
  const source = edge("invokesAgent", undefined, { to: "agent:assistant" });
  const targets = [target("lambda:caller"), target("agent:assistant", "agent", { auth: true })];
  assert.equal(describe(source, targets).authorization!.kind, "user-token");
  assert.equal(hasIam(describe(source, targets)), false);
  assert.deepEqual(describe(source, targets.map(item => ({ ...item, auth: false }))).authorization!.grants[0]!.actions, ["bedrock-agentcore:InvokeAgentRuntime"]);
  const tool = describe(edge("usesTool", undefined, { from: "agent:assistant", to: "lambda:tool" }), targets);
  assert.equal(tool.authorization!.grants.length, 2);
  assert.match(tool.authorization!.grants[1]!.principal, /Gateway role/);
});

test("pull triggers reverse IAM principal; push triggers use resource policies and S3 EventBridge delivery uses Events", () => {
  const targets = [target("lambda:consumer")];
  const pull = describe(edge("trigger", { kind: "trigger", adapter: "sqs" }, { from: "resource:store.queue", to: "lambda:consumer" }), targets);
  assert.equal(pull.authorization!.grants[0]!.principalEntity, "lambda:consumer");
  assert.equal(pull.authorization!.grants[0]!.via, "grantConsumeMessages()");
  for (const [adapter, principal] of [["sns", "sns.amazonaws.com"], ["cognito", "cognito-idp.amazonaws.com"], ["s3", "s3.amazonaws.com"]]) {
    const result = describe(edge("trigger", { kind: "trigger", adapter }, { to: "lambda:consumer" }), targets);
    assert.equal(result.authorization!.grants[0]!.principal, principal);
    assert.equal(result.authorization!.grants[0]!.policy, "Resource policy");
  }
  const bus = describe(edge("trigger", { kind: "trigger", adapter: "s3", delivery: "eventbridge" }, { to: "lambda:consumer" }), targets);
  assert.equal(bus.authorization!.grants[0]!.principal, "events.amazonaws.com");
  assert.equal(describe(edge("grant", { kind: "trigger-dlq", adapter: "sns" })).authorization!.grants[0]!.principal, "sns.amazonaws.com");
});

test("native helpers retain scope without inventing action lists; custom integration and CDK references stay explicit unknowns", () => {
  const item = describe(edge("grant", { kind: "native", method: "grantRead", arguments: ["tenant/*"] }));
  assert.equal(item.authorization!.grants[0]!.actions, undefined);
  assert.equal(item.authorization!.grants[0]!.via, 'grantRead("tenant/*")');
  const table = describe(edge("integration", { kind: "integration", service: "table", operations: ["get", "put"] }));
  assert.deepEqual(table.authorization!.grants.map(grant => grant.via), ["grantReadData()", "grantWriteData()"]);
  assert.equal(describe(edge("integration", { kind: "integration", service: "aws", operations: ["custom"] })).authorization!.kind, "unknown");
  assert.equal(describe(edge("cdk")).authorization!.kind, "unknown");
  const http = describe(edge("integration", { kind: "integration", service: "httpConnection", operations: ["invoke"] }));
  assert.equal(http.authorization!.grants.length, 3);
  assert.deepEqual(http.authorization!.grants[0]!.actions, ["states:InvokeHTTPEndpoint"]);
  assert.ok(http.authorization!.grants[0]!.conditions?.some(condition => condition.includes("states:HTTPEndpoint")));
});

test("group IAM filtering checks every active-mode member and keeps inspected context visible", () => {
  const plain = edge("env", undefined, { id: "a" });
  const grant = edge("env", { kind: "secret", delivery: "arn" }, { id: "z" });
  const prod = withConnectionAuthorizations({ ...base(), edges: [plain, grant] });
  const dev: ModeModel = { ...prod, mode: "dev", edges: [plain] };
  const group = aggregateConnections(prod, [dev])[0]!;
  assert.equal(group.members.length, 2);
  assert.equal(group.iam, true);
  assert.equal(aggregateConnections(dev, [prod])[0]!.iam, false);
  const scene = { ...group, category: "inputs" as const };
  assert.equal(connectionVisible(scene, new Set(["inputs"]), undefined, true), true);
  assert.equal(connectionVisible({ ...scene, iam: false }, undefined, undefined, true), false);
  assert.equal(connectionVisible({ ...scene, iam: false }, new Set(), scene.from, true), true);
  assert.equal(connectionSignature({ edges: [grant] }), connectionSignature({ edges: [describe(grant)] }));
});

test("projection creates typed secret/native/schedule/WebSocket facts directly from declarations", () => {
  const resources = defineResources({ data: resource.stack<{ bucket: IBucket; queue: IQueue }>(), key: resource.secret("EXAMPLE_KEY") });
  const config = defineFrameworkConfig({ resources, services: [],
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: [{ "/read": { directory: "/lambda_functions/read", methods: ["GET"], environment: { KEY_ARN: resources.key.arn }, cloud: { bindings: [resources.data.bucket.grantRead("tenant/*")] } } }],
    webSocket: [{ send: { directory: "/lambda_functions/send", cloud: { manageConnections: true } } }],
    events: [{ tick: { directory: "/lambda_functions/tick", triggers: [trigger.schedule({ id: "timer", expression: "rate(1 hour)", accepts: "schedule" })] } }],
  });
  const model = projectModel(config, { mode: "prod" });
  assert.equal(model.edges.find(item => item.label === "KEY_ARN")?.authorization?.operation, "Read secret");
  assert.equal(model.edges.find(item => item.relation === "grant")?.authorization?.grants[0]?.via, 'grantRead("tenant/*")');
  assert.equal(model.edges.find(item => item.relation === "manageConnections")?.authorization?.grants[0]?.actions?.[0], "execute-api:ManageConnections");
  const schedule = model.targets.find(item => item.id === "tick")!.authorizations!.find(item => item.authorization.operation === "Invoke on schedule")!;
  assert.match(schedule.authorization.grants[0]!.principal, /Scheduler execution role/);
  assert.equal(model.edges.some(item => item.from.startsWith("schedule:")), false, "resourceless schedules do not create phantom graph nodes");
  const dev = projectModel(config, { mode: "dev" });
  assert.equal(dev.edges.find(item => item.relation === "grant")?.authorization?.state, "not-built");
});

test("grant choices and backend refuse mismatched methods, arbitrary IAM and unsupported scopes", () => {
  for (const [type, method] of [["aws-dynamodb:ITable", "grantReadData"], ["aws-sns:ITopic", "grantPublish"], ["aws-events:IEventBus", "grantPutEventsTo"]]) assert.ok(grantOptions([type!]).some(option => option.method === method));
  assert.equal(grantOptions(["app:SomethingNamedBucket"]).length, 0);
  const model = { ...base(), resources: [{ id: "resource:store.data", path: ["store", "data"], kind: "member", absent: false }] };
  const state = { snapshot: { models: { dev: model, prod: model }, source: { triggerCapabilities: [{ resource: "resource:store.data", canonicalTypes: ["aws-dynamodb:ITable"] }] } } } as unknown as StudioState;
  const intent = { kind: "connection", target: "lambda:caller", connection: "grant", destination: "resource:store.data", enabled: true } as const;
  assert.throws(() => planConnection("unused", state, { ...intent, grant: "grantRead" }, new Map()), /supported native grant/);
  assert.throws(() => planConnection("unused", state, { ...intent, grant: "grantReadData", scope: "arbitrary/*" }, new Map()), /Only bucket grants/);
});

test("native grant creation dynamically writes the supported helper and refreshes its authorization facts", () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "permission-writer-"));
  const file = path.join(root, "framework.config.ts");
  writeFileSync(file, 'import { defineFrameworkConfig } from "@repo/framework/config"; export default defineFrameworkConfig({ http: [{ "/caller": { directory: "/lambda_functions/caller", methods: ["GET"] } }], webSocket: [], events: [], services: [] });');
  try {
    for (const [type, grant] of [["aws-dynamodb:ITable", "grantReadData"], ["aws-sns:ITopic", "grantPublish"], ["aws-events:IEventBus", "grantPutEventsTo"]] as const) {
      const resource = { id: "resource:store.data", path: ["store", "data"], kind: "member", absent: false };
      const model = { ...base(), resources: [resource] };
      const state = { snapshot: { models: { dev: model, prod: model }, source: { triggerCapabilities: [{ resource: resource.id, canonicalTypes: [type] }] } } } as unknown as StudioState;
      const overrides = new Map<string, string>();
      planConnection(root, state, { kind: "connection", target: "lambda:caller", connection: "grant", destination: resource.id, enabled: true, grant }, overrides);
      assert.ok(overrides.get(file)?.includes(`.${grant}()`), grant);
      assert.match(overrides.get(file)!, /cloud:.*bindings:/);
      assert.equal(describe(edge("grant", { kind: "native", method: grant, arguments: [] })).authorization?.kind, "iam");
    }
  } finally { rmSync(root, { recursive: true }); }
});
