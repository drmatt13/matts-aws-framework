import assert from "./support/assert";
import { test } from "node:test";
import type { DeploymentInputEntry, InputRequirement } from "../shared/deployment-inputs";
import type { ModeModel, ModelEdge, ModelResource, ModelTarget, Relation, SourceLocation } from "../shared/model";
import { withConnectionAuthorizations } from "../shared/permissions";
import { aggregateConnections } from "../src/connections";
import { presentConnection, presentConnectionHover, presentRelationship } from "../src/connection-presentation";
import { indexModel } from "../src/lookup";

const source: SourceLocation = { file: "stack.ts", line: 20, column: 1, start: 100, end: 140 };
const model = (extra: Partial<ModeModel> = {}): ModeModel => ({ mode: "dev", status: "ok", targets: [], routes: [], resources: [],
  edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0, ...extra });
const edge = (relation: ModelEdge["relation"], extra: Partial<ModelEdge> = {}): ModelEdge => ({
  id: "connection", relation, from: "lambda:caller", to: "resource:data", label: "declared label", provenance: "declared", ...extra,
});
const requirement = (status: InputRequirement["status"], extra: Partial<InputRequirement> = {}): InputRequirement => ({
  resource: "resource:input", name: "API_KEY", mode: "dev", file: "cdk-app/.env.dev", required: true, status, reasons: [], ...extra,
});
const inputIndex = (status: DeploymentInputEntry["status"], defaulted = false) => indexModel(model({ resources: [{
  id: "envfile:dev", path: ["cdk-app/.env.dev"], kind: "envFile", absent: false,
  deploymentFile: { mode: "dev", path: "cdk-app/.env.dev", template: "cdk-app/.env.dev.template", exists: true,
    entries: [{ name: "API_KEY", status, defaulted, sensitive: true, targets: ["resource:input"] }] },
}] }));
const inputEdge = (inputRequirement?: InputRequirement) => edge("supplies", {
  from: "envfile:dev", to: "resource:input", label: "API_KEY", provenance: "source", inputRequirement,
  detail: "cdk-app/.env.dev: configured. Required links can represent an unfilled input; values are excluded.",
});

test("every relationship has an action and a relevant value, never a capability-only or helper title", () => {
  const expected: Readonly<Record<Relation, string>> = {
    env: "Reads: declared label", secret: "Loads secret: declared label", supplies: "Supplies input: declared label", maps: "Maps into: declared label",
    routes: "Routes to: declared label", authorizes: "Authorizes: data", grant: "Grants access: data",
    database: "Connects to: data", localReplay: "Local replay: caller", trigger: "Triggers: declared label",
    runsTask: "Runs task: data", startsWorkflow: "Starts workflow: data", invokesAgent: "Invokes agent: data", usesTool: "Calls tool: data",
    step: "Executes step: data", integration: "Calls service: data", completesCallback: "Completes callback: data",
    manageConnections: "Sends replies via: data", contains: "Contains: data", cdk: "References: data", deployWhen: "Conditional deployment: $data",
  };
  const index = indexModel(model());
  for (const relation of Object.keys(expected) as Relation[]) {
    const result = presentRelationship(edge(relation, relation === "deployWhen" ? { from: "resource:data", to: "lambda:caller" } : {}), index);
    assert.equal(result.title, expected[relation]);
    assert.equal(result.title, `${result.action}: ${result.value}`);
    assert.match(result.title, /^[^:\r\n]+: \S/);
  }
  for (const relation of ["env", "secret", "supplies", "maps", "routes", "trigger"] as const) {
    assert.equal(presentRelationship(edge(relation, { label: " " }), index).value, "data", "empty labels fall back to the endpoint");
  }
});

test("conditional deployment titles use the configured input reference, including nested paths", () => {
  const index = indexModel(model({ resources: [{ id: "resource:features.enableWebSocketApi", path: ["features", "enableWebSocketApi"], kind: "input", fromEnv: "ENABLE_WEBSOCKET_API", absent: false }] }));
  const result = presentRelationship(edge("deployWhen", { from: "resource:features.enableWebSocketApi", to: "lambda:caller" }), index);
  assert.equal(result.title, "Conditional deployment: $features.enableWebSocketApi");
  assert.equal(result.title.includes("ENABLE_WEBSOCKET_API"), false, "the title names the framework input rather than its environment variable");
});

test("workflow steps and integrations name operations and destinations from typed facts", () => {
  const index = indexModel(model({ resources: [{ id: "resource:data", path: ["orders", "queue"], kind: "member", absent: false }] }));
  for (const [target, action] of [["lambda", "Invokes function"], ["task", "Runs task"], ["workflow", "Starts workflow"], ["agent", "Invokes agent"]] as const) {
    const result = presentRelationship(edge("step", { label: "internalHelperName", permissionContext: { kind: "step", target, callback: true } }), index);
    assert.equal(result.title, `${action}: orders.queue`);
    assert.deepEqual(result.lines, ["Waits for a workflow callback."]);
  }
  for (const [service, operations, action] of [
    ["queue", ["send"], "Sends messages to"], ["topic", ["publish"], "Publishes messages to"], ["eventBus", ["put"], "Publishes events to"],
    ["httpConnection", ["request"], "Calls HTTP endpoint"], ["table", ["get"], "Reads items from"], ["table", ["put"], "Writes items to"],
    ["table", ["update"], "Updates items in"], ["table", ["delete"], "Deletes items from"], ["table", ["get", "update"], "Reads and writes table"],
    ["custom", ["unknownAction"], "Calls service"],
  ] as const) {
    assert.equal(presentRelationship(edge("integration", { permissionContext: { kind: "integration", service, operations } }), index).title, `${action}: orders.queue`);
  }
  const delivery = presentRelationship(edge("cdk", { permissionContext: { kind: "subscription", protocol: "sqs" } }), index);
  assert.equal(delivery.title, "Delivers messages to: orders.queue");
  assert.equal(presentRelationship(edge("grant", { permissionContext: { kind: "failure" } }), index).title, "Sends failed events to: orders.queue");
  assert.equal(presentRelationship(edge("grant", { permissionContext: { kind: "trigger-dlq", adapter: "sns" } }), index).title, "Sends failed events to: orders.queue");
  assert.equal(presentRelationship(edge("trigger", { label: "sqs", permissionContext: { kind: "trigger", adapter: "sqs" } }), index).title, "Triggers: orders.queue");
  assert.equal(presentRelationship(edge("cdk", { label: "EventBridge rule" }), index).title, "Routes events to: orders.queue");
  assert.equal(presentRelationship(edge("cdk", { label: "Dead-letter queue" }), index).title, "Sends failed messages to: orders.queue");
});

test("input hovers show actionable state without repeating paths or generic source warnings", () => {
  const configured = presentRelationship(inputEdge(requirement("configured")), inputIndex("configured"));
  assert.equal(configured.title, "Supplies input: API_KEY");
  assert.deepEqual(configured.lines, []);
  assert.deepEqual(configured.notes, []);
  assert.deepEqual(presentRelationship(inputEdge(requirement("optional", { required: false })), inputIndex("empty")).lines, ["Empty in this file."]);
  assert.deepEqual(presentRelationship(inputEdge(), inputIndex("missing")).lines, ["Not set in this file."]);
  assert.deepEqual(presentRelationship(inputEdge(requirement("missing")), inputIndex("empty")).lines, ["Required value missing."]);
  assert.deepEqual(presentRelationship(inputEdge(requirement("default")), inputIndex("empty", true)).lines, ["Uses the declaration default."]);
  assert.deepEqual(presentRelationship(inputEdge(requirement("unknown")), inputIndex("missing")).lines, ["Input status unavailable."]);
});

test("destination input requirements take precedence over defaults on another use of the same variable", () => {
  const sharedDefault = inputIndex("empty", true);
  assert.deepEqual(presentRelationship(inputEdge(requirement("missing")), sharedDefault).lines, ["Required value missing."],
    "another parameter's default cannot supply a missing required secret");
  assert.deepEqual(presentRelationship(inputEdge(requirement("unknown")), sharedDefault).lines, ["Input status unavailable."],
    "a name-wide default flag cannot establish an unreadable destination's state");
  assert.deepEqual(presentRelationship(inputEdge(requirement("optional", { required: false })), sharedDefault).lines, ["Empty in this file."],
    "a blank declaration default is not an effective value");
});

test("route purpose remains the title and IAM stays a concise secondary note", () => {
  const route = edge("routes", { label: "/api/orders", authorization: {
    kind: "iam", state: "not-built", operation: "Lambda integration", notes: ["Detailed authorization evidence"],
    grants: [{ principal: "apigateway.amazonaws.com", policy: "Resource policy", actions: ["lambda:InvokeFunction"], scope: "lambda:orders" }],
  } });
  const result = presentRelationship(route, indexModel(model()));
  assert.equal(result.title, "Routes to: /api/orders");
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.notes, ["IAM: lambda:InvokeFunction"]);
});

test("database hovers explain the framework binding and distinguish local, direct and reader paths", () => {
  const database = edge("database", { label: "database", permissionContext: { kind: "database", connection: "application", readers: false } });
  const cloud = withConnectionAuthorizations(model({ mode: "prod", edges: [database] }));
  const result = presentRelationship(cloud.edges[0]!, indexModel(cloud));
  assert.equal(result.title, "Connects to: data");
  assert.deepEqual(result.lines, ["Framework supplies connection settings, private networking and IAM login."]);
  assert.deepEqual(result.notes, ["IAM: rds-db:connect"]);
  const local = withConnectionAuthorizations(model({ edges: [{ ...database, to: "local:postgres" }], localServices: [{
    id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image: "postgres:16", volumes: [], source, enabled: true,
  }] }));
  const localResult = presentRelationship(local.edges[0]!, indexModel(local));
  assert.equal(localResult.title, "Connects to: Local PostgreSQL");
  assert.deepEqual(localResult.lines, ["Framework supplies the local connection settings."]);
  assert.deepEqual(localResult.notes, [], "Compose database access carries no AWS IAM grant");
  const directReaders = { ...database, permissionContext: { kind: "database", connection: "direct", readers: true } } as const;
  const direct = presentRelationship(directReaders, indexModel(cloud));
  assert.equal(direct.title, "Connects directly to: data");
  assert.ok(direct.lines.includes("Includes writer and reader connections."), "readers retain writer access without claiming replicas exist");
  const localReaders = presentRelationship({ ...directReaders, to: "local:postgres" }, indexModel(local));
  assert.ok(localReaders.lines.includes("Writer and reader connections share the local database."));
});

test("managed database ownership is described from destination metadata", () => {
  const database: ModelResource = { id: "resource:data", path: ["storage", "database"], kind: "member", absent: false, frameworkManaged: "database" };
  const connection = edge("contains", { label: "Database in stack", detail: "This stack declares the application's framework-managed database." });
  const result = presentRelationship(connection, indexModel(model({ resources: [database] })));
  assert.equal(result.title, "Provides database: storage.database", "the owning declaration may provide an externally managed retained database");
  assert.deepEqual(result.lines, []);
  assert.equal(presentRelationship(connection, indexModel(model({ resources: [{ ...database, frameworkManaged: undefined }] }))).title, "Contains: storage.database");
});

test("native grants name the permission and resource while preserving exact scope and source details", () => {
  const bucket: ModelResource = { id: "resource:uploads.bucket", path: ["uploads", "bucket"], kind: "member", typeText: "s3.Bucket", absent: false };
  const index = indexModel(model({ resources: [bucket] }));
  const grant = edge("grant", { to: bucket.id, label: 'grantWrite("reports/*")', detail: 'resources.uploads.bucket.grantWrite("reports/*")',
    permissionContext: { kind: "native", method: "grantWrite", arguments: ["reports/*"] } });
  const before = JSON.stringify(grant);
  const result = presentRelationship(grant, index);
  assert.equal(result.title, "Write bucket objects: uploads.bucket");
  assert.deepEqual(result.lines, ["Object scope: reports/*"]);
  assert.equal(JSON.stringify(grant), before, "configuration retains the authored helper expression");
  for (const args of [[], ["*"]]) assert.deepEqual(presentRelationship({ ...grant, permissionContext: { kind: "native", method: "grantRead", arguments: args } }, index).lines, ["Object scope: All objects"]);
  const secret = { ...bucket, typeText: "secretsmanager.Secret" };
  const secretGrant = presentRelationship({ ...grant, permissionContext: { kind: "native", method: "grantRead", arguments: [] } }, indexModel(model({ resources: [secret] })));
  assert.equal(secretGrant.title, "Read resource: uploads.bucket");
  assert.deepEqual(secretGrant.lines, [], "a read helper does not imply bucket object scope");
  assert.equal(presentRelationship({ ...grant, permissionContext: { kind: "native", method: "customGrant", arguments: [] } }, index).title, "Grants access: uploads.bucket");
  assert.equal(presentRelationship({ ...grant, permissionContext: undefined }, index).title, "Grants access: uploads.bucket", "labels alone never establish native permission semantics");
});

test("grouped native grants describe operations and scopes without raw helper names", () => {
  const bucket: ModelResource = { id: "resource:uploads.bucket", path: ["uploads", "bucket"], kind: "member", typeText: "s3.IBucket", absent: false };
  const grants = ["reports/*", "exports/*"].map((scope, i) => edge("grant", { id: String(i), to: bucket.id, label: `grantWrite(${JSON.stringify(scope)})`,
    permissionContext: { kind: "native" as const, method: "grantWrite", arguments: [scope] } }));
  const current = model({ resources: [bucket], edges: grants });
  const result = presentConnection(aggregateConnections(current)[0]!, "dev", indexModel(current));
  assert.equal(result.title, "Grants access: 2 permissions");
  assert.deepEqual(result.lines, ["Write bucket objects: uploads.bucket · reports/*", "Write bucket objects: uploads.bucket · exports/*"]);
  const mixed = { ...current, edges: [...grants, edge("env", { id: "2", to: bucket.id, label: "BUCKET_NAME" })] };
  const groups = aggregateConnections(mixed);
  assert.equal(groups.length, 2);
  assert.deepEqual(presentConnection(groups.find(group => group.edge.relation === "grant")!, "dev", indexModel(mixed)).lines, [
    "Write bucket objects: uploads.bucket · reports/*", "Write bucket objects: uploads.bucket · exports/*",
  ]);
  assert.equal(presentConnection(groups.find(group => group.edge.relation === "env")!, "dev", indexModel(mixed)).title, "Reads: BUCKET_NAME");
});

test("grouped service calls retain each operation and resource field", () => {
  const resources: ModelResource[] = [
    { id: "resource:data.orders", path: ["data", "orders"], kind: "member", parent: "resource:data", absent: false },
    { id: "resource:data.events", path: ["data", "events"], kind: "member", parent: "resource:data", absent: false },
    { id: "resource:data", path: ["data"], kind: "stack", absent: false },
  ];
  const current = model({ resources, edges: [
    edge("integration", { id: "0", to: "resource:data.orders", permissionContext: { kind: "integration", service: "table", operations: ["get"] } }),
    edge("integration", { id: "1", to: "resource:data.events", permissionContext: { kind: "integration", service: "queue", operations: ["send"] } }),
  ] });
  const result = presentConnection(aggregateConnections(current)[0]!, "dev", indexModel(current));
  assert.equal(result.title, "Makes: 2 service calls");
  assert.deepEqual(result.lines, ["Reads items from: data.orders", "Sends messages to: data.events"]);
});

test("local replay names its purpose once and native triggers identify the actual CDK construct", () => {
  const index = indexModel(model());
  const replay = presentRelationship(edge("localReplay", { label: "Local replay", detail: "localReplay: true captures AWS invocations. Production invokes the handler directly." }), index);
  assert.equal(replay.title, "Local replay: caller");
  assert.deepEqual(replay.lines, []);
  const trigger = edge("trigger", { label: "postConfirmation", provenance: "source", source, sourceConstruct: "cdk.aws_cognito.UserPool",
    detail: "Native trigger · cdk-app/lib/app/cognito-stack.ts:246" });
  const result = presentRelationship(trigger, index);
  assert.equal(result.title, "Triggers: postConfirmation");
  assert.deepEqual(result.lines, ["Defined by cdk.aws_cognito.UserPool"]);
  assert.deepEqual(presentRelationship({ ...trigger, sourceConstruct: undefined }, index).lines, [], "missing constructor evidence does not invent a type or repeat a generic warning");
});

test("source provenance stays available on the edge without cluttering the hover", () => {
  const connection = edge("cdk", { provenance: "source", source, detail: "Inferred from CDK source · stack.ts:20" });
  const before = JSON.stringify(connection);
  const result = presentRelationship(connection, indexModel(model()));
  assert.deepEqual(result.lines, []);
  assert.equal(JSON.stringify(connection), before, "presentation must preserve inspector source evidence");
});

test("a homogeneous connection names its information and lists each variable without repeated verbs", () => {
  const names = ["TRUSTED_FRONTEND_ORIGINS", "USER_POOL_ID", "USER_POOL_CLIENT_ID"];
  const current = model({ edges: names.map((label, id) => edge("env", { id: String(id), label })) });
  const group = aggregateConnections(current)[0]!;
  const result = presentConnection(group, "dev", indexModel(current));
  assert.equal(result.title, "Reads: 3 environment values");
  assert.deepEqual(result.lines, names);
  assert.equal(result.homogeneous, true);
});

test("different purposes have separate titles and delivery is classified independently of grant relations", () => {
  const current = model({ edges: [
    edge("env", { id: "0", label: "QUEUE_URL" }),
    edge("grant", { id: "1", label: "grantSendMessages()", permissionContext: { kind: "native", method: "grantSendMessages", arguments: [] } }),
  ] });
  const groups = aggregateConnections(current);
  assert.deepEqual(groups.map(group => presentConnection(group, "dev", indexModel(current)).title).sort(), ["Reads: QUEUE_URL", "Send queue messages: data"].sort());
  const delivery = model({ edges: [edge("grant", { id: "0", permissionContext: { kind: "failure" } }),
    edge("grant", { id: "1", permissionContext: { kind: "trigger-dlq", adapter: "sns" } })] });
  assert.equal(presentConnection(aggregateConnections(delivery)[0]!, "dev", indexModel(delivery)).title, "Sends failed events to: 2 failure destinations");
});

test("forty relationships have a bounded preview with missing requirements beyond the preview preserved", () => {
  const edges = Array.from({ length: 40 }, (_, i) => edge("env", { id: String(i).padStart(2, "0"), label: `VALUE_${i}`,
    ...(i === 1 || i === 29 || i === 39 ? { inputRequirement: requirement("missing") } : {}),
  }));
  const current = model({ edges });
  const result = presentConnection(aggregateConnections(current)[0]!, "dev", indexModel(current));
  assert.equal(result.title, "Reads: 40 environment values");
  assert.equal(result.lines.length, 6);
  assert.deepEqual(result.lines.slice(0, 4), ["VALUE_0", "VALUE_1 — required value missing", "VALUE_2", "VALUE_3"]);
  assert.deepEqual(result.lines.slice(4), ["+36 more", "2 more required values missing."]);
});

test("many distinct purposes retain separate connections and every original member", () => {
  const relations = ["env", "grant", "database", "localReplay", "trigger", "startsWorkflow", "integration", "contains"] as const;
  const current = model({ edges: relations.map((relation, i) => edge(relation, { id: String(i) })) });
  const groups = aggregateConnections(current);
  assert.equal(groups.length, relations.length);
  assert.ok(groups.every(group => group.members.length === 1));
  assert.deepEqual(groups.flatMap(group => group.members.map(member => member.edge.id)).sort(), current.edges.map(edge => edge.id).sort());
});

test("bundle previews use selected-mode evidence and label relationships belonging only to the other mode", () => {
  const shared = edge("env", { id: "0", label: "DEV_VALUE", inputRequirement: requirement("missing") });
  const dev = model({ edges: [shared, edge("env", { id: "1", label: "DEV_ONLY" })] });
  const prod = model({ mode: "prod", edges: [{ ...shared, label: "PROD_VALUE", inputRequirement: requirement("configured", { mode: "prod" }) },
    edge("env", { id: "2", label: "PROD_ONLY" })] });
  const group = aggregateConnections(dev, [prod])[0]!;
  const development = presentConnection(group, "dev", indexModel(dev));
  const production = presentConnection(group, "prod", indexModel(prod));
  assert.deepEqual(development.lines, ["DEV_VALUE — required value missing", "DEV_ONLY", "PROD_ONLY (Prod)"]);
  assert.deepEqual(production.lines, ["PROD_VALUE", "DEV_ONLY (Dev)", "PROD_ONLY"]);
  assert.equal(development.title, "Reads: 3 environment values");
  assert.equal(production.title, development.title);
  const single = aggregateConnections({ ...dev, edges: [shared] }, [{ ...prod, edges: [prod.edges[0]!] }])[0]!;
  assert.equal(presentConnection(single, "prod", indexModel(prod)).title, "Reads: PROD_VALUE");
});

const hoverResources: readonly ModelResource[] = [
  { id: "resource:caller", path: ["caller"], kind: "construct", absent: false },
  { id: "resource:data", path: ["data"], kind: "stack", absent: false },
  ...["first", "second", "third"].map(name => ({ id: `resource:data.${name}`, path: ["data", name], kind: "member" as const, parent: "resource:data", absent: false })),
];
const hoverEdge = (relation: Relation, id: string, extra: Partial<ModelEdge> = {}): ModelEdge => edge(relation, {
  id, from: "resource:caller", to: `resource:data.${id}`, label: `VALUE_${id}`, ...extra,
});
const hoverPair = (devEdges: readonly ModelEdge[], prodEdges: readonly ModelEdge[], resources: readonly ModelResource[] = hoverResources) => {
  const dev = model({ resources, edges: devEdges });
  const prod = model({ mode: "prod", resources, edges: prodEdges });
  return { dev, prod, indexes: { dev: indexModel(dev), prod: indexModel(prod) }, connection: aggregateConnections(dev, [prod])[0]! };
};

test("every aggregation family retains all members and their independent development and production pills", () => {
  const relations: readonly Relation[] = ["env", "secret", "supplies", "maps", "routes", "authorizes", "grant", "database", "localReplay", "trigger", "runsTask", "startsWorkflow", "invokesAgent", "usesTool", "step", "integration", "completesCallback", "manageConnections", "contains", "cdk", "deployWhen"];
  for (const relation of relations) {
    const first = hoverEdge(relation, "first"), second = hoverEdge(relation, "second"), third = hoverEdge(relation, "third");
    const { connection, indexes } = hoverPair([first, second], [second, third]);
    const before = JSON.stringify(connection);
    const result = presentConnectionHover(connection, indexes);
    assert.equal(result.aggregated, true, relation);
    assert.deepEqual(result.rows.map(row => [row.id, row.availability]), [
      ["first", { dev: true, prod: false }], ["second", { dev: true, prod: true }], ["third", { dev: false, prod: true }],
    ], relation);
    assert.equal(result.from.label, "caller", relation);
    assert.deepEqual(result.to, { id: "resource:data", kind: "Stack", label: "data" }, relation);
    assert.equal(JSON.stringify(connection), before, "hover derivation never modifies model evidence");
    const disabled = { ...connection, availability: { dev: false, prod: false }, members: connection.members.map(member => ({ ...member, availability: { dev: false, prod: false } })) };
    assert.ok(presentConnectionHover(disabled, indexes).rows.every(row => !row.availability.dev && !row.availability.prod), relation);
  }
});

test("a large aggregation has no hidden members or missing requirements beyond an arbitrary preview limit", () => {
  const edges = Array.from({ length: 40 }, (_, at) => hoverEdge("env", String(at).padStart(2, "0"), { to: "resource:data.first", label: `VALUE_${at}`, ...(at === 39 ? { inputRequirement: requirement("missing") } : {}) }));
  const { connection, indexes } = hoverPair(edges, edges);
  const result = presentConnectionHover(connection, indexes);
  assert.equal(result.rows.length, 40);
  assert.equal(result.rows.at(-1)?.label, "VALUE_39");
  assert.deepEqual(result.rows.at(-1)?.details, [{ text: "Required value missing.", kind: "detail", tone: "warning" }]);
  assert.ok(!result.rows[0]?.details.length);
  assert.deepEqual(result.details, []);
});

test("shared declaration defaults are explained once while different environment requirements stay qualified", () => {
  const defaults = ["first", "second", "third"].map(id => hoverEdge("supplies", id, { inputRequirement: requirement("default") }));
  const { connection, indexes } = hoverPair(defaults, defaults);
  const common = presentConnectionHover(connection, indexes);
  assert.deepEqual(common.rows.map(row => row.label), ["first", "second", "third"]);
  assert.deepEqual(common.details, [{ text: "Uses the declaration default.", kind: "detail" }]);
  assert.ok(common.rows.every(row => row.details.length === 0));
  const production = defaults.map((edge, at) => at === 1 ? { ...edge, inputRequirement: requirement("missing", { mode: "prod" }) } : edge);
  const mixed = hoverPair(defaults, production);
  const result = presentConnectionHover(mixed.connection, mixed.indexes);
  assert.deepEqual(result.details, [], "the shared default cannot describe one member's missing production value");
  assert.deepEqual(result.rows[1]?.details, [
    { text: "Uses the declaration default.", kind: "detail", modes: ["dev"] },
    { text: "Required value missing.", kind: "detail", tone: "warning", modes: ["prod"] },
  ]);
});

test("environment-specific variable labels and facts remain explicit without borrowing the active graph", () => {
  const devEdge = hoverEdge("env", "first", { label: "DEVELOPMENT_POOL_ID", inputRequirement: requirement("missing") });
  const prodEdge = { ...devEdge, label: "PRODUCTION_POOL_ID", inputRequirement: requirement("configured", { mode: "prod" }) };
  const { connection, indexes } = hoverPair([devEdge], [prodEdge]);
  const result = presentConnectionHover(connection, indexes);
  assert.equal(result.aggregated, false);
  assert.equal(result.title, "Reads: environment value");
  assert.equal(result.rows[0]?.label, "Environment value");
  assert.deepEqual(result.details, [
    { text: "DEVELOPMENT_POOL_ID", kind: "detail", modes: ["dev"] },
    { text: "PRODUCTION_POOL_ID", kind: "detail", modes: ["prod"] },
    { text: "Required value missing.", kind: "detail", tone: "warning", modes: ["dev"] },
  ]);
  const prodOnly = hoverPair([], [prodEdge]);
  assert.equal(presentConnectionHover(prodOnly.connection, prodOnly.indexes).title, "Reads: PRODUCTION_POOL_ID");
});

test("conditional facts resolve against each environment's own target rather than the selected index", () => {
  const condition = edge("deployWhen", { id: "condition", from: "resource:features.enabled", to: "workflow:reports" });
  const resources: readonly ModelResource[] = [{ id: condition.from, path: ["features", "enabled"], kind: "input", absent: false }];
  const target = (equals: string): ModelTarget => ({
    ref: condition.to, kind: "workflow", id: "reports", role: "workflow", title: "reports", origins: [], constructId: "Reports", constructIdPinned: false,
    lanes: { deploy: "both", origin: "declared", local: true, cloud: true, dev: true, prod: true,
      when: { resource: condition.from, equals, dev: "holds", prod: "holds" } },
    compute: { kind: "workflow", type: "standard", steps: 1, timeoutSeconds: 30 }, placement: { kind: "managed", reason: "Workflow" },
    environment: [], secrets: [], access: [], requirements: 0, outputs: [],
  });
  const dev = model({ resources, targets: [target("preview")], edges: [condition] });
  const prod = model({ mode: "prod", resources, targets: [target("released")], edges: [condition] });
  const connection = aggregateConnections(dev, [prod])[0]!;
  const result = presentConnectionHover(connection, { dev: indexModel(dev), prod: indexModel(prod) });
  assert.deepEqual(result.details, [
    { text: 'Matches "preview".', kind: "detail", modes: ["dev"] },
    { text: 'Matches "released".', kind: "detail", modes: ["prod"] },
  ]);
  assert.deepEqual(result.to, { id: target("released").ref, kind: "Workflow", label: "reports" });
});

test("stable endpoint ids preserve differing target titles and catalog kinds across environments", () => {
  const declaration: ModelTarget = {
    ref: "lambda:caller", kind: "lambda", id: "caller", role: "http", title: "/preview/graphql", origins: [], constructId: "Caller", constructIdPinned: false,
    lanes: { deploy: "both", origin: "declared", local: true, cloud: true, dev: true, prod: true },
    compute: { kind: "lambda", implementation: "typescript", packaging: "zip", architecture: "arm64", memorySize: 512, timeoutSeconds: 30, logRetentionDays: 7, subnet: "none" },
    placement: { kind: "outside", reason: "Outside the VPC" }, environment: [], secrets: [], access: [], requirements: 0, outputs: [],
  };
  const resource: ModelResource = { id: "resource:setting", path: ["setting"], kind: "input", absent: false };
  const binding = edge("env", { to: resource.id, label: "SETTING" });
  const dev = model({ resources: [resource], targets: [declaration], edges: [binding] });
  const prod = model({ mode: "prod", resources: [{ ...resource, kind: "secret" }], targets: [{ ...declaration, title: "/graphql" }], edges: [binding] });
  const result = presentConnectionHover(aggregateConnections(dev, [prod])[0]!, { dev: indexModel(dev), prod: indexModel(prod) });
  assert.deepEqual(result.from, { id: declaration.ref, kind: "HTTP Lambda", label: "/preview/graphql", variants: [
    { mode: "dev", label: "/preview/graphql", kind: "HTTP Lambda" }, { mode: "prod", label: "/graphql", kind: "HTTP Lambda" },
  ] });
  assert.deepEqual(result.to, { id: resource.id, kind: "Input", label: "setting", variants: [
    { mode: "dev", label: "setting", kind: "Input" }, { mode: "prod", label: "setting", kind: "Secret" },
  ] });
  const same = { ...prod, resources: [resource], targets: [declaration] };
  const matching = presentConnectionHover(aggregateConnections(dev, [same])[0]!, { dev: indexModel(dev), prod: indexModel(same) });
  assert.equal(matching.from.variants, undefined);
  assert.equal(matching.to.variants, undefined);
  const absent = { ...prod, resources: [{ ...resource, kind: "secret" as const, absent: true }], targets: [] };
  const missing = presentConnectionHover(aggregateConnections(dev, [absent])[0]!, { dev: indexModel(dev), prod: indexModel(absent) });
  assert.equal(missing.from.variants, undefined, "an absent target never becomes an invented second title");
  assert.equal(missing.to.variants, undefined, "a ghost catalog entry never becomes an invented second kind");
});

test("per-environment native scopes and IAM summaries stay attached to their actual member", () => {
  const resources = hoverResources.map(resource => resource.kind === "member" ? { ...resource, typeText: "s3.IBucket" } : resource);
  const permissions = (action: string) => ({ kind: "iam" as const, operation: "Read bucket", state: "planned" as const, notes: [], grants: [{ principal: "Lambda role", policy: "Identity policy" as const, actions: [action], scope: "bucket" }] });
  const first = hoverEdge("grant", "first", { permissionContext: { kind: "native", method: "grantRead", arguments: ["dev/*"] }, authorization: permissions("s3:GetObject") });
  const second = hoverEdge("grant", "second", { permissionContext: { kind: "native", method: "grantRead", arguments: ["reports/*"] }, authorization: permissions("s3:GetObject") });
  const pair = hoverPair([first, second], [{ ...first, permissionContext: { kind: "native", method: "grantRead", arguments: ["prod/*"] }, authorization: permissions("s3:ListBucket") }, second], resources);
  const result = presentConnectionHover(pair.connection, pair.indexes);
  assert.deepEqual(result.rows[0]?.details, [
    { text: "Object scope: dev/*", kind: "detail", modes: ["dev"] },
    { text: "IAM: s3:GetObject", kind: "permission", modes: ["dev"] },
    { text: "Object scope: prod/*", kind: "detail", modes: ["prod"] },
    { text: "IAM: s3:ListBucket", kind: "permission", modes: ["prod"] },
  ]);
  assert.deepEqual(result.rows[1]?.details, [{ text: "Object scope: reports/*", kind: "detail" }, { text: "IAM: s3:GetObject", kind: "permission" }]);
  assert.deepEqual(result.details, []);
  const common = hoverPair([first, second], [first, second], resources);
  assert.deepEqual(presentConnectionHover(common.connection, common.indexes).details, [{ text: "IAM: s3:GetObject", kind: "permission" }]);
});

test("native permission subtypes and workflow integrations retain operational details in structured hovers", () => {
  const contexts: NonNullable<ModelEdge["permissionContext"]>[] = [
    { kind: "database", connection: "direct", readers: true },
    { kind: "native", method: "grantRead", arguments: [] },
    { kind: "secret", delivery: "arn" }, { kind: "secret", delivery: "startup" },
    { kind: "step", target: "task", callback: true },
    { kind: "integration", service: "table", operations: ["get", "update"] },
    { kind: "integration", service: "queue", operations: ["send"] },
    { kind: "integration", service: "topic", operations: ["publish"] },
    { kind: "integration", service: "eventBus", operations: ["put"] },
    { kind: "integration", service: "httpConnection", operations: ["request"] },
    { kind: "trigger", adapter: "sqs" }, { kind: "trigger-dlq", adapter: "sns" },
    { kind: "subscription", protocol: "sqs" }, { kind: "failure" },
  ];
  for (const context of contexts) {
    const relation = context.kind === "database" ? "database" : context.kind === "step" ? "step" : context.kind === "integration" ? "integration" : context.kind === "trigger" ? "trigger" : context.kind === "secret" ? "secret" : "grant";
    const connection = hoverEdge(relation, "first", { permissionContext: context, sourceConstruct: context.kind === "trigger" ? "cdk.aws_sqs.Queue" : undefined });
    const pair = hoverPair([connection], [connection]);
    const expected = presentRelationship(connection, pair.indexes.dev);
    const result = presentConnectionHover(pair.connection, pair.indexes);
    assert.equal(result.title, expected.title, context.kind);
    assert.deepEqual(result.details.map(detail => detail.text), [...expected.lines, ...expected.notes], context.kind);
    assert.ok(result.details.every(detail => detail.modes === undefined), context.kind);
  }
});
