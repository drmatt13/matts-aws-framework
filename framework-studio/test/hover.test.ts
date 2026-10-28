import { gatewayModels } from "../shared/gateways";
import assert from "./support/assert";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Mode, ModeModel, ModelResource, Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { catalogAvailability } from "../src/deployment";
import { indexModel } from "../src/lookup";
import { buildScene, kindText, type Scene } from "../src/scene/build";
import { groupHoverDetails, groupHoverEntries, groupHoverLines, nodeHoverFacts, propHoverFacts, type HoverFacts } from "../src/scene/hover";

/**
 * The hover label says where each environment deploys an item and whether the
 * framework owns it. It reads both models, so the Dev/Prod switch never changes it.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");
let builder: SnapshotBuilder;
let snapshot: Snapshot;

before(async () => {
  builder = new SnapshotBuilder(repositoryRoot);
  snapshot = (await builder.refresh()).snapshot;
});
after(async () => { await builder.dispose(); });

const indexes = (models: Readonly<Record<Mode, ModeModel>> = snapshot.models) => ({ dev: indexModel(models.dev), prod: indexModel(models.prod) });

function sceneOf(mode: Mode): Scene {
  return buildScene(snapshot.models[mode], { resourceAvailability: catalogAvailability(snapshot.models), layoutModels: Object.values(snapshot.models) });
}

function factsOf(id: string, mode: Mode = "dev", models?: Readonly<Record<Mode, ModeModel>>): HoverFacts {
  const scene = sceneOf(mode);
  const node = scene.nodes.find((candidate) => candidate.id === (scene.representatives[id] ?? id));
  if (id.startsWith("route:")) return nodeHoverFacts({ ...scene.nodes[0]!, id, entity: "route" }, indexes(models));
  assert.ok(node, `${id} stands in the ${mode} landscape`);
  return nodeHoverFacts(node, indexes(models));
}

const WEB_SOCKET_ROLES = new Set(["webSocket", "webSocketAuthorizer"]);

/** Pin an explicitly dev-only workload without depending on this machine’s input files. */
function webSocketInDevelopmentOnly(): Record<Mode, ModeModel> {
  const pin = (mode: Mode): ModeModel => ({ ...snapshot.models[mode], targets: snapshot.models[mode].targets.map((target) =>
    WEB_SOCKET_ROLES.has(target.role) ? { ...target, lanes: { ...target.lanes, ...(mode === "dev" ? { dev: true } : { prod: false }) } } : target) });
  return { dev: pin("dev"), prod: pin("prod") };
}

const labels = (facts: HoverFacts) => facts.places.map((place) => `${place.env}: ${place.where}`);

test("the label is the same whichever environment the map shows", () => {
  const prod = new Map(sceneOf("prod").nodes.map((node) => [node.id, node]));
  const shared = sceneOf("dev").nodes.filter((node) => prod.has(node.id));
  assert.ok(shared.length > 20);
  for (const node of shared) assert.deepEqual(nodeHoverFacts(node, indexes()), nodeHoverFacts(prod.get(node.id)!, indexes()), node.id);
});

test("a workload deployed to both environments shows a Dev label and a Prod label", () => {
  assert.deepEqual(labels(factsOf("lambda:sign-out")), ["dev: Your machine", "prod: AWS Lambda · outside the VPC"]);
  assert.deepEqual(labels(factsOf("lambda:graphql-api")), ["dev: Your machine", "prod: AWS Lambda · private subnet"]);
  assert.deepEqual(labels(factsOf("lambda:cognito-post-confirmation-trigger")), ["dev: Your machine + AWS Lambda · private subnet", "prod: AWS Lambda · private subnet"]);
});

test("unconditional WebSocket handlers are deployed in both AWS graphs", () => {
  for (const mode of ["dev", "prod"] as const) for (const target of snapshot.models[mode].targets.filter(item => WEB_SOCKET_ROLES.has(item.role))) assert.equal(target.lanes[mode], true);
});

test("a workload deployed to one environment shows only that label", () => {
  assert.deepEqual(labels(factsOf("lambda:ws-authorizer", "dev", webSocketInDevelopmentOnly())), ["dev: Your machine + AWS Lambda · outside the VPC"]);
  assert.deepEqual(labels(factsOf("task:db-migrate")), ["prod: Amazon ECS · public subnet"]);
  assert.deepEqual(labels(factsOf("local:postgres")), ["dev: Your machine · Docker Compose"]);
  assert.equal(factsOf("task:db-migrate").notDeployed, undefined);
});

test("a route follows its target's lanes and names the front door it deploys behind", () => {
  assert.deepEqual(labels(factsOf("route:http:/sign-out")), ["dev: Your machine", "prod: API Gateway HTTP API"]);
  assert.deepEqual(labels(factsOf("route:ws:$connect", "dev", webSocketInDevelopmentOnly())), ["dev: Your machine + API Gateway WebSocket API"]);
  assert.deepEqual(labels(factsOf("route:agent:/chat/example")), ["dev: Your machine", "prod: AgentCore Runtime"]);
});

test("containers, workflows and agents name their AWS service", () => {
  assert.equal(factsOf("task:invocation-test-task").places[1]?.where, "Amazon ECS · public subnet");
  assert.equal(factsOf("workflow:invocation-test-workflow").places[1]?.where, "AWS Step Functions");
  assert.equal(factsOf("agent:example-agent").places[1]?.where, "AgentCore Runtime");
});

test("framework-managed resources are flagged and application declarations are not", () => {
  assert.deepEqual(factsOf("resource:rds.database"), { places: [{ env: "prod", where: "Amazon RDS · isolated subnet" }], frameworkManaged: true });
  assert.deepEqual(labels(factsOf("resource:rds")), ["prod: CloudFormation stack"]);
  assert.equal(factsOf("resource:rds").frameworkManaged, true);
  assert.deepEqual(labels(factsOf("framework-stack:DevLambdaReplayStack")), ["dev: CloudFormation stack"]);
  assert.deepEqual(labels(factsOf("gateway:http")), ["dev: Your machine", "prod: API Gateway HTTP API"]);
  assert.equal(factsOf("resource:openaiApiKey").frameworkManaged, false);
  assert.deepEqual(labels(factsOf("resource:openaiApiKey")), ["dev: AWS Secrets Manager", "prod: AWS Secrets Manager"]);
  const index = indexes();
  for (const node of sceneOf("prod").nodes.filter((candidate) => candidate.entity !== "resource" && candidate.entity !== "gateway")) assert.equal(nodeHoverFacts(node, index).frameworkManaged, false, node.id);
});

test("an item no environment deploys gives its specific reason", () => {
  assert.deepEqual(factsOf("resource:referenceExamples"), { places: [], notDeployed: "Not added to the CDK app", frameworkManaged: false });
});

test("an environment file lights only the environment it belongs to", () => {
  for (const mode of ["dev", "prod"] as const) {
    const file = snapshot.models[mode].resources.find((resource) => resource.id === `envfile:${mode}`)!.deploymentFile!;
    assert.deepEqual(factsOf(`envfile:${mode}`), { places: [{ env: mode, where: `Local file · ${file.path}` }], frameworkManaged: false });
    // Each graph carries both files; the other environment's file never lights this one's pill.
    assert.deepEqual(factsOf(`envfile:${mode}`, mode === "dev" ? "prod" : "dev"), factsOf(`envfile:${mode}`));
  }
});

test("an input or input group lights every environment whose graph declares it", () => {
  const modes = ["dev", "prod"] as const;
  const inputs = snapshot.models.dev.resources.filter((resource) => resource.kind === "input" || resource.kind === "group");
  assert.ok(inputs.length > 0);
  for (const resource of inputs) {
    const held = modes.filter((mode) => snapshot.models[mode].resources.some((candidate) => candidate.id === resource.id && !candidate.absent));
    const facts = factsOf(resource.id);
    assert.deepEqual(facts.places.map((place) => place.env), held, resource.id);
    assert.equal(facts.notDeployed, undefined, resource.id);
  }
  const modelProvider = factsOf("resource:langgraph.modelProvider");
  assert.ok(modelProvider.places.length > 0, "a declared input is no longer shown as deployed nowhere");
});

test("a type line never repeats the name above it, and names the catalog entry a stack's class name hides", () => {
  for (const mode of ["dev", "prod"] as const) {
    const scene = sceneOf(mode);
    for (const node of scene.nodes) assert.notEqual(node.kindLabel.split(", ").slice(1).join(", "), node.label, `${mode} ${node.id}`);
    const type = (id: string) => { const node = scene.nodes.find(candidate => candidate.id === id)!; return kindText(node.kindLabel, node.label); };
    assert.equal(type("resource:rds"), "Stack · resources.rds");
    assert.equal(type("resource:cognito"), "Stack · resources.cognito");
    assert.equal(type("framework-stack:DevLambdaReplayStack"), "Stack", "a framework stack has no catalog entry to name");
    assert.equal(type("resource:rds.database"), "Framework-managed Amazon RDS · resources.rds.database");
    assert.equal(type("resource:openaiApiKey"), "Secret · OPENAI_API_KEY");
    // The same fixtures stand in every VPC under the same names; the type line tells them apart.
    for (const prop of scene.props) {
      const network = snapshot.models[mode].networks!.find(candidate => prop.id.startsWith(`prop:vpc:${candidate.id}:`))!;
      const vpc = `${network.name ?? network.id} VPC`;
      const endpoint = prop.id.split(":endpoint:")[1];
      assert.equal(kindText(prop.kindLabel ?? ""), endpoint ? `${network.gatewayEndpoints.includes(endpoint) ? "Gateway" : "Interface"} endpoint · ${vpc}` : vpc, prop.id);
    }
    assert.ok(scene.props.some(prop => prop.id.includes(":endpoint:")), "the sweep reaches an endpoint");
  }
});

test("an input group's hover counts its entries per graph and names what reads them and what they feed", () => {
  assert.deepEqual(factsOf("resource:langgraph"), { places: [{ env: "dev", where: "4 inputs · cdk-app/.env.dev" }, { env: "prod", where: "4 inputs · cdk-app/.env.prod" }], frameworkManaged: false });
  assert.deepEqual(factsOf("resource:client").places, [{ env: "dev", where: "4 inputs · cdk-app/.env.dev" }], "development-only URLs light only Dev");
  const model = snapshot.models.dev;
  const group = (id: string, from = model) => from.resources.find((resource) => resource.id === id)!;
  assert.deepEqual(groupHoverLines(group("resource:langgraph"), model, indexModel(model)), {
    lines: ["Read by example-agent."], notes: [] });
  assert.deepEqual(groupHoverLines(group("resource:client"), model, indexModel(model)).lines,
    ["Maps apiPort, webSocketPort and webSocketTesterPort into client-app/.env."]);
  // Missing states now belong to entry details across both graphs, not selected-mode prose.
  const missing = { ...model, resources: model.resources.map((resource) => resource.id === "resource:langgraph.openaiModelId" ? { ...resource, inputRequirement: { ...resource.inputRequirement!, required: true, status: "missing" as const } } : resource) };
  assert.deepEqual(groupHoverLines(group("resource:langgraph", missing), missing, indexModel(missing)).notes, []);
});

test("group hover entries keep individual availability across mixed and nested declarations", () => {
  const group = snapshot.models.dev.resources.find(resource => resource.id === "resource:langgraph")!;
  const dev = snapshot.models.dev;
  const prod = { ...snapshot.models.prod, resources: snapshot.models.prod.resources.map(resource => resource.id === `${group.id}.modelProvider` ? { ...resource, absent: true } : resource) };
  const prodOnly = { id: `${group.id}.nested.key`, parent: `${group.id}.nested`, path: [...group.path, "nested", "key"], kind: "secret" as const, absent: false };
  const entries = groupHoverEntries(group, indexes({ dev, prod: { ...prod, resources: [...prod.resources, prodOnly] } }));
  assert.deepEqual(entries.find(entry => entry.label === "modelProvider")?.availability, { dev: true, prod: false });
  assert.deepEqual(entries.find(entry => entry.label === "openaiModelId")?.availability, { dev: true, prod: true });
  // Its unlit Dev pill says it is undeclared there, so its only status needs no environment qualifier.
  assert.deepEqual(entries.at(-1), { id: prodOnly.id, label: "nested.key", availability: { dev: false, prod: true }, details: [
    { text: "Value status unavailable.", kind: "detail" },
  ] });
  assert.deepEqual(groupHoverEntries(group, indexes({ dev: { ...dev, resources: [] }, prod: { ...prod, resources: [] } })), []);
});

const groupFixture = { id: "resource:settings", kind: "group", path: ["settings"], absent: false } as const;
function inputFixture(name: string, mode: Mode, status: "configured" | "default" | "missing" | "optional" | "unknown", extra: Partial<ModelResource> = {}): ModelResource {
  const resource = `${groupFixture.id}.${name}`;
  return {
    id: resource, kind: "input", path: ["settings", ...name.split(".")], parent: name.includes(".") ? `${groupFixture.id}.${name.slice(0, name.lastIndexOf("."))}` : groupFixture.id,
    fromEnv: name.toUpperCase().replaceAll(".", "_"),
    default: "DEFAULT_VALUE_MUST_NEVER_APPEAR_IN_A_TOOLTIP",
    inputRequirement: { resource, name: name.toUpperCase().replaceAll(".", "_"), mode, file: `cdk-app/.env.${mode}`, required: status === "missing", status, reasons: ["PRIVATE_REQUIREMENT_REASON_MUST_NOT_BE_PROJECTED"] },
    ...extra,
    absent: extra.absent ?? false,
  };
}
function groupIndexes(dev: readonly ModelResource[], prod: readonly ModelResource[]) {
  return indexes({ dev: { ...snapshot.models.dev, resources: [groupFixture, ...dev] }, prod: { ...snapshot.models.prod, resources: [groupFixture, ...prod] } });
}

test("group statuses retain differences across both environments without projecting input values", () => {
  const index = groupIndexes(
    [inputFixture("provider", "dev", "configured"), inputFixture("model", "dev", "default"), inputFixture("optional", "dev", "optional"), inputFixture("nested.secret", "dev", "configured", { kind: "secret", absent: true })],
    [inputFixture("provider", "prod", "missing"), inputFixture("model", "prod", "unknown"), inputFixture("optional", "prod", "configured"), inputFixture("nested.secret", "prod", "configured", { kind: "secret" })],
  );
  const entries = groupHoverEntries(groupFixture, index);
  assert.deepEqual(entries.find(entry => entry.label === "provider")?.details, [{ text: "Required value missing: PROVIDER · cdk-app/.env.prod", kind: "detail", tone: "warning", modes: ["prod"] }]);
  assert.deepEqual(entries.find(entry => entry.label === "model")?.details, [
    { text: "Uses the declaration default.", kind: "detail", modes: ["dev"] },
    { text: "Value status unavailable.", kind: "detail", modes: ["prod"] },
  ]);
  assert.deepEqual(entries.find(entry => entry.label === "optional")?.details, [{ text: "Not set · optional.", kind: "detail", modes: ["dev"] }]);
  assert.deepEqual(entries.find(entry => entry.label === "nested.secret"), { id: "resource:settings.nested.secret", label: "nested.secret", availability: { dev: false, prod: true } }, "absence is the unlit pill, not a repeated sentence");
  assert.deepEqual(groupHoverDetails(groupFixture, index), []);
  assert.doesNotMatch(JSON.stringify(entries), /DEFAULT_VALUE_MUST_NEVER|PRIVATE_REQUIREMENT_REASON/);
});

test("shared group statuses appear once while environment-specific exceptions stay with their entry", () => {
  const index = groupIndexes(
    [inputFixture("first", "dev", "default"), inputFixture("second", "dev", "default")],
    [inputFixture("first", "prod", "default"), inputFixture("second", "prod", "missing")],
  );
  assert.deepEqual(groupHoverDetails(groupFixture, index), [{ text: "Every entry uses its declaration default.", kind: "detail", modes: ["dev"] }]);
  const entries = groupHoverEntries(groupFixture, index);
  assert.deepEqual(entries[0]!.details, [{ text: "Uses the declaration default.", kind: "detail", modes: ["prod"] }]);
  assert.deepEqual(entries[1]!.details, [{ text: "Required value missing: SECOND · cdk-app/.env.prod", kind: "detail", tone: "warning", modes: ["prod"] }]);
  const both = groupIndexes(
    [inputFixture("first", "dev", "default"), inputFixture("second", "dev", "default")],
    [inputFixture("first", "prod", "default"), inputFixture("second", "prod", "default")],
  );
  assert.ok(groupHoverEntries(groupFixture, both).every(entry => !entry.details));
  assert.deepEqual(groupHoverDetails(groupFixture, both), [{ text: "Every entry uses its declaration default.", kind: "detail" }], "a status every environment shares needs no qualifier");
  const developmentOnly = groupIndexes([inputFixture("first", "dev", "default"), inputFixture("second", "dev", "optional")], []);
  assert.deepEqual(groupHoverEntries(groupFixture, developmentOnly).map(entry => entry.details), [
    [{ text: "Uses the declaration default.", kind: "detail" }],
    [{ text: "Not set · optional.", kind: "detail" }],
  ], "a single-environment group's statuses are not qualified by the only environment that declares it");
});

test("empty groups and shared unset, absent or unverified states stay explicit without repeated prose", () => {
  assert.deepEqual(groupHoverDetails(groupFixture, groupIndexes([], [])), []);
  const states = [
    { status: "optional" as const, text: "Every entry is unset and optional.", extra: {} },
    { status: "unknown" as const, text: "Value status is unavailable for every entry.", extra: {} },
    // Unlit pills already say that no entry is declared.
    { status: "configured" as const, text: undefined, extra: { absent: true } },
  ];
  for (const { status, text, extra } of states) {
    const index = groupIndexes([inputFixture("a", "dev", status, extra), inputFixture("b", "dev", status, extra)], [inputFixture("a", "prod", status, extra), inputFixture("b", "prod", status, extra)]);
    assert.deepEqual(groupHoverDetails(groupFixture, index), text ? [{ text, kind: "detail" }] : []);
    assert.ok(groupHoverEntries(groupFixture, index).every(entry => !entry.details));
  }
});

test("every resource's pills follow the graphs that hold it, whatever its kind", () => {
  const modes = ["dev", "prod"] as const;
  const seen = new Set<string>();
  for (const mode of modes) for (const node of sceneOf(mode).nodes.filter((candidate) => candidate.entity === "resource")) {
    // A stack nothing in the CDK app references is held by its graph but deployed by neither.
    const deployed = modes.filter((each) => {
      const resource = snapshot.models[each].resources.find((candidate) => candidate.id === node.id);
      return !!resource && !resource.absent && !(resource.kind === "stack" && resource.stackUsage?.status === "unreferenced");
    });
    assert.deepEqual(factsOf(node.id, mode).places.map((place) => place.env), deployed, `${mode}: ${node.id}`);
    seen.add(snapshot.models[mode].resources.find((candidate) => candidate.id === node.id)?.kind ?? "?");
  }
  for (const kind of ["stack", "member", "secret", "input", "group", "envFile"]) assert.ok(seen.has(kind), `the sweep reaches a ${kind}`);
});

test("a workload no environment deploys has no environment labels and no extra reason", () => {
  const off = (mode: Mode): ModeModel => ({ ...snapshot.models[mode], targets: snapshot.models[mode].targets.map((target) =>
    target.ref === "lambda:sign-out" ? { ...target, lanes: { ...target.lanes, local: false, cloud: false, dev: false, prod: false } } : target) });
  const node = sceneOf("dev").nodes.find((candidate) => candidate.id === "lambda:sign-out")!;
  assert.deepEqual(nodeHoverFacts(node, { dev: indexModel(off("dev")), prod: indexModel(off("prod")) }), { places: [], frameworkManaged: false });
  // The same holds for a target one environment's graph no longer holds.
  const gone = (mode: Mode): ModeModel => ({ ...snapshot.models[mode], targets: snapshot.models[mode].targets.filter((target) => target.ref !== "lambda:sign-out") });
  assert.deepEqual(nodeHoverFacts(node, { dev: indexModel(gone("dev")), prod: indexModel(gone("prod")) }), { places: [], frameworkManaged: false });
});

test("every node has facts, and network fixtures are framework-managed and follow whether production builds the VPC", () => {
  const index = indexes();
  for (const mode of ["dev", "prod"] as const) for (const node of sceneOf(mode).nodes) {
    const facts = nodeHoverFacts(node, index);
    assert.ok(facts.places.every((place) => place.where.length > 0), `${mode} ${node.id}`);
    assert.ok(!facts.notDeployed || facts.places.length === 0, `${mode} ${node.id}: a reason only when nothing deploys it`);
  }
  assert.deepEqual(propHoverFacts(snapshot.models, "prop:vpc:application:internet-gateway"), { places: [{ env: "prod", where: "AWS VPC" }], frameworkManaged: true });
  const unbuilt = { ...snapshot.models, prod: { ...snapshot.models.prod, networks: [{ ...snapshot.models.prod.networks![0]!, builtInProd: false }] } };
  assert.deepEqual(propHoverFacts(unbuilt, "prop:vpc:application:internet-gateway"), { places: [], notDeployed: "Not built: nothing is placed in the VPC", frameworkManaged: true });
});
