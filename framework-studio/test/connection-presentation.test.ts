import assert from "./support/assert";
import { test } from "node:test";
import type { DeploymentInputEntry, InputRequirement } from "../shared/deployment-inputs";
import type { ModeModel, ModelEdge, ModelResource, SourceLocation } from "../shared/model";
import { withConnectionAuthorizations } from "../shared/permissions";
import { aggregateConnections } from "../src/connections";
import { presentConnection, presentRelationship } from "../src/connection-presentation";
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
  assert.equal(result.title, "Connects to PostgreSQL");
  assert.deepEqual(result.lines, ["Framework supplies connection settings, private networking and IAM login."]);
  assert.deepEqual(result.notes, ["IAM: rds-db:connect"]);
  const local = withConnectionAuthorizations(model({ edges: [{ ...database, to: "local:postgres" }], localServices: [{
    id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image: "postgres:16", volumes: [], source, enabled: true,
  }] }));
  const localResult = presentRelationship(local.edges[0]!, indexModel(local));
  assert.equal(localResult.title, "Connects to PostgreSQL");
  assert.deepEqual(localResult.lines, ["Framework supplies the local connection settings."]);
  assert.deepEqual(localResult.notes, [], "Compose database access carries no AWS IAM grant");
  const directReaders = { ...database, permissionContext: { kind: "database", connection: "direct", readers: true } } as const;
  const direct = presentRelationship(directReaders, indexModel(cloud));
  assert.equal(direct.title, "Connects directly to PostgreSQL");
  assert.ok(direct.lines.includes("Includes writer and reader connections."), "readers retain writer access without claiming replicas exist");
  const localReaders = presentRelationship({ ...directReaders, to: "local:postgres" }, indexModel(local));
  assert.ok(localReaders.lines.includes("Writer and reader connections share the local database."));
});

test("managed database ownership is described from destination metadata", () => {
  const database: ModelResource = { id: "resource:data", path: ["storage", "database"], kind: "member", absent: false, frameworkManaged: "database" };
  const connection = edge("contains", { label: "Database in stack", detail: "This stack declares the application's framework-managed database." });
  const result = presentRelationship(connection, indexModel(model({ resources: [database] })));
  assert.equal(result.title, "Provides the application database", "the owning declaration may provide an externally managed retained database");
  assert.deepEqual(result.lines, []);
  assert.equal(presentRelationship(connection, indexModel(model({ resources: [{ ...database, frameworkManaged: undefined }] }))).title, "Contains: storage.database");
});

test("local replay names its purpose once and native triggers identify the actual CDK construct", () => {
  const index = indexModel(model());
  const replay = presentRelationship(edge("localReplay", { label: "Local replay", detail: "localReplay: true captures AWS invocations. Production invokes the handler directly." }), index);
  assert.equal(replay.title, "Local replay: AWS invocations");
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
  assert.equal(result.title, "Reads 3 environment values");
  assert.deepEqual(result.lines, names);
  assert.equal(result.homogeneous, true);
});

test("mixed connections name each purpose and classify delivery independently of grant relations", () => {
  const current = model({ edges: [
    edge("env", { id: "0", label: "QUEUE_URL" }),
    edge("grant", { id: "1", label: "grantSendMessages()", permissionContext: { kind: "native", method: "grantSendMessages", arguments: [] } }),
  ] });
  const result = presentConnection(aggregateConnections(current)[0]!, "dev", indexModel(current));
  assert.equal(result.title, "1 environment value · 1 resource grant");
  assert.equal(result.homogeneous, false);
  assert.ok(result.lines[0]?.startsWith("Reads:"));
  const delivery = model({ edges: [edge("grant", { id: "0", permissionContext: { kind: "failure" } }),
    edge("grant", { id: "1", permissionContext: { kind: "trigger-dlq", adapter: "sns" } })] });
  assert.equal(presentConnection(aggregateConnections(delivery)[0]!, "dev", indexModel(delivery)).title, "2 failure destinations");
});

test("forty relationships have a bounded preview with missing requirements beyond the preview preserved", () => {
  const edges = Array.from({ length: 40 }, (_, i) => edge("env", { id: String(i).padStart(2, "0"), label: `VALUE_${i}`,
    ...(i === 1 || i === 29 || i === 39 ? { inputRequirement: requirement("missing") } : {}),
  }));
  const current = model({ edges });
  const result = presentConnection(aggregateConnections(current)[0]!, "dev", indexModel(current));
  assert.equal(result.title, "Reads 40 environment values");
  assert.equal(result.lines.length, 6);
  assert.deepEqual(result.lines.slice(0, 4), ["VALUE_0", "VALUE_1 — required value missing", "VALUE_2", "VALUE_3"]);
  assert.deepEqual(result.lines.slice(4), ["+36 more", "2 more required values missing."]);
});

test("many distinct purposes have a bounded title and retain their full member count", () => {
  const relations = ["env", "grant", "database", "localReplay", "trigger", "startsWorkflow", "integration", "contains"] as const;
  const current = model({ edges: relations.map((relation, i) => edge(relation, { id: String(i) })) });
  const result = presentConnection(aggregateConnections(current)[0]!, "dev", indexModel(current));
  assert.equal(result.title.split(" · ").length, 3, "at most two purpose names plus the remaining connection count");
  assert.match(result.title, /6 other connections$/);
  assert.equal(result.lines.length, 5);
  assert.equal(result.lines[4], "+4 more");
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
  assert.equal(development.title, "Reads 3 environment values");
  assert.equal(production.title, development.title);
  const single = aggregateConnections({ ...dev, edges: [shared] }, [{ ...prod, edges: [prod.edges[0]!] }])[0]!;
  assert.equal(presentConnection(single, "prod", indexModel(prod)).title, "Reads: PROD_VALUE");
});
