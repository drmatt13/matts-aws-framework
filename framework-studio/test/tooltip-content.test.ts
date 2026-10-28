import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "./support/assert";
import type { ModeModel, ModelEdge, ModelResource, ModelTarget, Relation } from "../shared/model";
import type { InputRequirement } from "../shared/deployment-inputs";
import type { PermissionContext } from "../shared/permissions";
import type { ConnectionGroup } from "../src/connections";
import { aggregateConnections } from "../src/connections";
import { presentConnectionHover } from "../src/connection-presentation";
import { indexModel } from "../src/lookup";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
let ConnectionTooltipContent: typeof import("../src/views/ConnectionHoverContent").ConnectionTooltipContent;
let HoverContent: typeof import("../src/views/ResourceHoverContent").HoverContent;
let HoverDetails: typeof import("../src/views/ResourceHoverContent").HoverDetails;
let HoverEntries: typeof import("../src/views/ResourceHoverContent").HoverEntries;
const applicationDom = new JSDOM("<!doctype html><html><body></body></html>");
before(async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: applicationDom.window.document });
  ({ ConnectionTooltipContent } = await import("../src/views/ConnectionHoverContent"));
  ({ HoverContent, HoverDetails, HoverEntries } = await import("../src/views/ResourceHoverContent"));
});
after(() => { applicationDom.window.close(); Reflect.deleteProperty(globalThis, "document"); });
const SECRET_SENTINEL = "AUTHORED_SECRET_VALUE_MUST_NOT_ENTER_TOOLTIP";
const caller: ModelTarget = {
  ref: "lambda:consumer", kind: "lambda", role: "http", id: "consumer", title: "/graphql", origins: [], constructId: "Consumer", constructIdPinned: false,
  lanes: { deploy: "both", origin: "declared", local: true, cloud: true, dev: true, prod: true },
  compute: { kind: "lambda", implementation: "typescript", packaging: "zip", architecture: "arm64", memorySize: 512, timeoutSeconds: 30, logRetentionDays: 7, subnet: "none" },
  placement: { kind: "outside", reason: "Outside the VPC" }, environment: [{ name: "PRIVATE_VALUE", value: { kind: "literal", value: SECRET_SENTINEL } }],
  secrets: [], access: [], requirements: 0, outputs: [],
};
const resources: readonly ModelResource[] = [
  { id: "resource:settings", path: ["settings"], kind: "stack", absent: false },
  ...["devOnly", "shared", "prodOnly", "disabled"].map(name => ({ id: `resource:settings.${name}`, parent: "resource:settings", path: ["settings", name], kind: "member" as const, absent: false })),
];
const graph = (mode: "dev" | "prod", edges: readonly ModelEdge[], extra: Partial<ModeModel> = {}): ModeModel => ({
  mode, status: "ok", targets: [caller], routes: [], resources, edges, workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0, ...extra,
});
const edge = (relation: Relation, id: string, extra: Partial<ModelEdge> = {}): ModelEdge => ({
  id, relation, from: caller.ref, to: `resource:settings.${id}`, label: `VALUE_${id}`, provenance: "declared", detail: SECRET_SENTINEL, ...extra,
});
const requirement = (status: InputRequirement["status"], mode: "dev" | "prod" = "dev"): InputRequirement => ({
  resource: "resource:settings.shared", name: "MODEL_ID", mode, file: `cdk-app/.env.${mode}`, required: true, status, reasons: [],
});
function fixture(devEdges: readonly ModelEdge[], prodEdges: readonly ModelEdge[], extra: { readonly dev?: Partial<ModeModel>; readonly prod?: Partial<ModeModel> } = {}) {
  const dev = graph("dev", devEdges, extra.dev), prod = graph("prod", prodEdges, extra.prod);
  return { connection: aggregateConnections(dev, [prod])[0]!, indexes: { dev: indexModel(dev), prod: indexModel(prod) } };
}
function documentOf(element: Parameters<typeof renderToStaticMarkup>[0]): Document {
  return new JSDOM(renderToStaticMarkup(element)).window.document;
}
function tooltip(pair: ReturnType<typeof fixture>, connection: ConnectionGroup = pair.connection, supply = false) {
  const content = presentConnectionHover(connection, pair.indexes);
  return { content, document: documentOf(createElement(ConnectionTooltipContent, { content, supply })) };
}
const memberRows = (document: Document) => [...document.querySelectorAll<HTMLLIElement>('ul[aria-label="Connection members"] > li')];
const pillCopy = (element: Element): string[] => [...element.querySelectorAll<HTMLElement>('.environment-pills > span')].map(pill => pill.textContent ?? "");

test("every relationship aggregation renders a separate accurate environment pair on each member", () => {
  const relations: readonly Relation[] = ["deployWhen", "contains", "routes", "authorizes", "env", "supplies", "maps", "secret", "grant", "database", "localReplay", "trigger", "runsTask", "startsWorkflow", "invokesAgent", "usesTool", "step", "integration", "completesCallback", "manageConnections", "cdk"];
  for (const relation of relations) {
    const devOnly = edge(relation, "devOnly"), shared = edge(relation, "shared"), prodOnly = edge(relation, "prodOnly"), disabled = edge(relation, "disabled");
    const pair = fixture([devOnly, shared, disabled], [prodOnly, shared, disabled]);
    const connection = { ...pair.connection, members: pair.connection.members.map(member => member.edge.id === "disabled" ? { ...member, availability: { dev: false, prod: false } } : member) };
    const { document, content } = tooltip(pair, connection);
    const rows = memberRows(document);
    assert.equal(rows.length, 4, relation);
    assert.equal(document.querySelector(".landscape-hover-tags"), null, `${relation}: no aggregate pair can obscure member differences`);
    for (const row of content.rows) {
      const at = content.rows.indexOf(row), rendered = rows[at]!;
      assert.ok(rendered.textContent?.includes(row.label), relation);
      const copy = pillCopy(rendered);
      assert.equal(copy.length, 2, relation);
      assert.equal(copy[0], row.availability.dev ? "Dev: connection enabled in development" : "Dev: connection not enabled", `${relation}: ${row.id}`);
      assert.equal(copy[1], row.availability.prod ? "Prod: connection enabled in production" : "Prod: connection not enabled", `${relation}: ${row.id}`);
      assert.equal(rendered.querySelectorAll(".environment-pills").length, 1, relation);
    }
    assert.ok(!document.body.textContent?.includes(SECRET_SENTINEL), relation);
  }
});

test("single connections keep one environment pair and separate endpoint names from their types", () => {
  for (const availability of ["both", "dev", "prod", "off"] as const) {
    const current = edge("env", "shared", { label: "FRONTEND_URL" });
    const pair = fixture(availability === "prod" ? [] : [current], availability === "dev" ? [] : [current]);
    const connection = availability === "off" ? { ...pair.connection, availability: { dev: false, prod: false } } : pair.connection;
    const { document } = tooltip(pair, connection);
    assert.equal(document.querySelectorAll(".landscape-hover-tags .environment-pills").length, 1);
    assert.equal(memberRows(document).length, 0);
    const endpoints = [...document.querySelectorAll("dl > div")];
    assert.deepEqual(endpoints.map(endpoint => endpoint.querySelector("dt")?.textContent), ["From", "To"]);
    assert.deepEqual([...endpoints[0]!.querySelectorAll("dd > span")].map(span => span.textContent), ["/graphql", "HTTP Lambda"]);
    assert.deepEqual([...endpoints[1]!.querySelectorAll("dd > span")].map(span => span.textContent), ["settings", "Stack"]);
    assert.equal(document.querySelector("strong")?.textContent, "Reads: FRONTEND_URL");
    assert.ok(!document.body.textContent?.includes("From HTTP Lambda:"), "types never crowd the From/To labels");
    assert.equal(pillCopy(document.body)[0]?.includes("not enabled"), availability === "prod" || availability === "off");
    assert.equal(pillCopy(document.body)[1]?.includes("not enabled"), availability === "dev" || availability === "off");
  }
});

test("repeated defaults have one shared explanation while supply pills describe the file", () => {
  const inputs = ["devOnly", "shared", "prodOnly", "disabled"].map(id => edge("supplies", id, { inputRequirement: requirement("default") }));
  const pair = fixture(inputs, inputs);
  const { document } = tooltip(pair, pair.connection, true);
  const copy = document.body.textContent ?? "";
  assert.equal(copy.split("Uses the declaration default.").length - 1, 1);
  assert.ok(copy.includes("Applies to every entry"));
  assert.ok(memberRows(document).every(row => !row.textContent?.includes("Uses the declaration default.")), "the common note is outside individual rows");
  assert.ok(pillCopy(memberRows(document)[0]!)[0]?.includes("supplied by this file in development"));
  assert.ok(pillCopy(memberRows(document)[0]!)[1]?.includes("supplied by this file in production"));
});

test("mixed environment labels and missing requirements stay explicit beside permission metadata", () => {
  const permissions = { kind: "iam" as const, operation: "Read", state: "planned" as const, notes: [], grants: [{ principal: "Lambda role", policy: "Identity policy" as const, actions: ["cognito-idp:AdminGetUser"], scope: "pool" }] };
  const dev = edge("env", "shared", { label: "DEV_POOL_ID", inputRequirement: requirement("missing"), authorization: permissions });
  const prod = { ...dev, label: "PROD_POOL_ID", inputRequirement: requirement("configured", "prod") };
  const { document } = tooltip(fixture([dev], [prod]));
  assert.equal(document.querySelector("strong")?.textContent, "Reads: environment value");
  const facts = [...document.querySelectorAll("p")];
  assert.ok(facts.some(fact => fact.textContent === "DevDEV_POOL_ID"));
  assert.ok(facts.some(fact => fact.textContent === "ProdPROD_POOL_ID"));
  assert.ok(facts.some(fact => fact.textContent === "DevRequired value missing."));
  const permission = facts.find(fact => fact.textContent?.includes("Permissions"));
  assert.ok(permission?.textContent?.includes("cognito-idp:AdminGetUser"));
  assert.ok(!permission?.textContent?.includes("Required value missing"), "permission evidence cannot swallow a missing-input warning");
});

test("conditional comparison literals remain qualified by their actual environment", () => {
  const condition = edge("deployWhen", "shared", { from: "resource:settings.shared", to: caller.ref });
  const target = (equals: string) => ({ ...caller, lanes: { ...caller.lanes, when: { resource: condition.from, equals, dev: "holds" as const, prod: "holds" as const } } });
  const pair = fixture([condition], [condition], { dev: { targets: [target("preview")] }, prod: { targets: [target("released")] } });
  const { document } = tooltip(pair);
  const facts = [...document.querySelectorAll("p")].map(fact => fact.textContent);
  assert.ok(facts.includes('DevMatches "preview".'));
  assert.ok(facts.includes('ProdMatches "released".'));
});

test("native permission subtypes render their operational facts without exposing raw source", () => {
  const cases: readonly { relation: Relation; context: PermissionContext; contains?: string }[] = [
    { relation: "database", context: { kind: "database", connection: "direct", readers: true }, contains: "Includes writer and reader connections." },
    { relation: "grant", context: { kind: "native", method: "grantRead", arguments: ["reports/*"] }, contains: "Object scope: reports/*" },
    { relation: "secret", context: { kind: "secret", delivery: "arn" } },
    { relation: "secret", context: { kind: "secret", delivery: "startup" } },
    { relation: "step", context: { kind: "step", target: "task", callback: true }, contains: "Waits for a workflow callback." },
    { relation: "integration", context: { kind: "integration", service: "table", operations: ["get", "update"] }, contains: "Operations: get, update" },
    { relation: "integration", context: { kind: "integration", service: "queue", operations: ["send"] } },
    { relation: "integration", context: { kind: "integration", service: "topic", operations: ["publish"] } },
    { relation: "integration", context: { kind: "integration", service: "eventBus", operations: ["put"] } },
    { relation: "integration", context: { kind: "integration", service: "httpConnection", operations: ["request"] } },
    { relation: "trigger", context: { kind: "trigger", adapter: "sqs" }, contains: "Defined by cdk.aws_sqs.Queue" },
    { relation: "grant", context: { kind: "trigger-dlq", adapter: "sns" } },
    { relation: "cdk", context: { kind: "subscription", protocol: "sqs" } },
    { relation: "grant", context: { kind: "failure" } },
  ];
  const typedResources = resources.map(resource => resource.kind === "member" ? { ...resource, typeText: "s3.IBucket" } : resource);
  for (const fixtureCase of cases) {
    const member = edge(fixtureCase.relation, "shared", { permissionContext: fixtureCase.context, sourceConstruct: fixtureCase.context.kind === "trigger" ? "cdk.aws_sqs.Queue" : undefined });
    const { document } = tooltip(fixture([member], [member], { dev: { resources: typedResources }, prod: { resources: typedResources } }));
    if (fixtureCase.contains) assert.ok(document.body.textContent?.includes(fixtureCase.contains), fixtureCase.context.kind);
    assert.ok(!document.body.textContent?.includes(SECRET_SENTINEL), fixtureCase.context.kind);
    assert.equal(document.querySelectorAll(".environment-pills").length, 1, fixtureCase.context.kind);
  }
});

test("long identifiers and all forty members remain present with warnings beyond the first screen", () => {
  const identifier = `SETTING_${"LONG_IDENTIFIER_".repeat(16)}`;
  const members = Array.from({ length: 40 }, (_, at) => edge("env", String(at).padStart(2, "0"), {
    to: "resource:settings.shared", label: at === 0 ? identifier : `SETTING_${at}`,
    ...(at === 39 ? { inputRequirement: requirement("missing") } : {}),
  }));
  const { document } = tooltip(fixture(members, members));
  const rows = memberRows(document);
  assert.equal(rows.length, 40);
  assert.ok(rows[0]?.textContent?.includes(identifier), "no identifier characters are removed from accessible content");
  assert.ok(rows.at(-1)?.textContent?.includes("SETTING_39"));
  assert.ok(rows.at(-1)?.textContent?.includes("Required value missing."));
  assert.equal(rows.reduce((count, row) => count + row.querySelectorAll(".environment-pills").length, 0), 40);
});

test("resource content retains descriptions, execution locations, source warnings and honest declaration language", () => {
  const { body } = documentOf(createElement(HoverContent, {
    title: "graphql-api", subtitle: "HTTP Lambda", description: "Serves the application's public GraphQL contract.", lines: [],
    facts: { places: [{ env: "dev", where: "Your machine" }, { env: "prod", where: "AWS Lambda · private subnet" }], frameworkManaged: true },
    warnings: ["The configured handler is missing.", "Select this resource to review implementation repairs."], showLocations: true,
  }));
  assert.ok(body.textContent?.includes("Serves the application's public GraphQL contract."));
  assert.ok(body.textContent?.includes("The configured handler is missing."));
  assert.ok(body.textContent?.includes("Framework-managed"));
  const locations = [...body.querySelectorAll("dl > div")];
  assert.deepEqual(locations.map(location => [location.querySelector("dt")?.textContent, location.querySelector("dd")?.textContent]), [["Dev", "Your machine"], ["Prod", "AWS Lambda · private subnet"]]);
  const declarations = documentOf(createElement(HoverEntries, { entries: [{ id: "input", label: "modelProvider", availability: { dev: true, prod: false } }] }));
  assert.deepEqual(pillCopy(declarations.body), ["Dev: declared in development", "Prod: not declared"]);
  const empty = documentOf(createElement(HoverContent, { title: "New resource", lines: [], emptyDescription: true }));
  assert.ok(empty.body.textContent?.includes("No description yet. Select it to write one."));
});

test("environment-qualified shared facts remain qualified and permission text has a separate label", () => {
  const document = documentOf(createElement(HoverDetails, { shared: true, details: [
    { text: "Uses the declaration default.", kind: "detail", modes: ["dev"] },
    { text: "IAM: s3:GetObject", kind: "permission", modes: ["prod"] },
  ] }));
  assert.ok(document.body.textContent?.includes("Applies to every entry"));
  const facts = [...document.querySelectorAll("p")].map(fact => fact.textContent);
  assert.deepEqual(facts, ["DevUses the declaration default.", "ProdPermissionss3:GetObject"]);
});
