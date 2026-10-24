import { gatewayModels } from "../shared/gateways";
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Mode, ModeModel, Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { catalogAvailability } from "../src/deployment";
import { indexModel } from "../src/lookup";
import { buildScene, type Scene } from "../src/scene/build";
import { nodeHoverFacts, propHoverFacts, type HoverFacts } from "../src/scene/hover";

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
