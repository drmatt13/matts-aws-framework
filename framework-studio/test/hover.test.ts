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

let builder: SnapshotBuilder;
let snapshot: Snapshot;

before(async () => {
  builder = new SnapshotBuilder(path.resolve(__dirname, "..", ".."));
  snapshot = (await builder.refresh()).snapshot;
});
after(async () => { await builder.dispose(); });

const indexes = () => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) });

function sceneOf(mode: Mode): Scene {
  return buildScene(snapshot.models[mode], { webSocketApi: snapshot.webSocketApi, resourceAvailability: catalogAvailability(snapshot.models), layoutModels: Object.values(snapshot.models) });
}

function factsOf(id: string, mode: Mode = "dev"): HoverFacts {
  const node = sceneOf(mode).nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `${id} stands in the ${mode} landscape`);
  return nodeHoverFacts(node, indexes());
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

test("a workload deployed to one environment shows only that label", () => {
  assert.deepEqual(labels(factsOf("lambda:ws-authorizer")), ["dev: Your machine + AWS Lambda · outside the VPC"]);
  assert.deepEqual(labels(factsOf("task:db-migrate")), ["prod: Amazon ECS · public subnet"]);
  assert.deepEqual(labels(factsOf("local:postgres")), ["dev: Your machine · Docker Compose"]);
  assert.equal(factsOf("task:db-migrate").notDeployed, undefined);
});

test("a route follows its target's lanes and names the front door it deploys behind", () => {
  assert.deepEqual(labels(factsOf("route:http:/sign-out")), ["dev: Your machine", "prod: API Gateway HTTP API"]);
  assert.deepEqual(labels(factsOf("route:ws:$connect")), ["dev: Your machine + API Gateway WebSocket API"]);
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
  assert.deepEqual(labels(factsOf("framework-stack:HttpApiGatewayStack")), ["prod: CloudFormation stack"]);
  assert.equal(factsOf("resource:openaiApiKey").frameworkManaged, false);
  assert.deepEqual(labels(factsOf("resource:openaiApiKey")), ["dev: AWS Secrets Manager", "prod: AWS Secrets Manager"]);
  const index = indexes();
  for (const node of sceneOf("prod").nodes.filter((candidate) => candidate.entity !== "resource")) assert.equal(nodeHoverFacts(node, index).frameworkManaged, false, node.id);
});

test("an item no environment deploys gives its specific reason", () => {
  assert.deepEqual(factsOf("resource:referenceExamples"), { places: [], notDeployed: "Not added to the CDK app", frameworkManaged: false });
  assert.deepEqual(factsOf("envfile:dev"), { places: [], notDeployed: "Local file · cdk-app/.env.dev", frameworkManaged: false });
  assert.deepEqual(factsOf("resource:langgraph.modelProvider"), { places: [], notDeployed: "CDK input, not deployed", frameworkManaged: false });
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
  assert.deepEqual(propHoverFacts(snapshot.models), { places: [{ env: "prod", where: "AWS VPC" }], frameworkManaged: true });
  const unbuilt = { ...snapshot.models, prod: { ...snapshot.models.prod, network: { ...snapshot.models.prod.network!, builtInProd: false } } };
  assert.deepEqual(propHoverFacts(unbuilt), { places: [], notDeployed: "Not built: nothing is placed in the VPC", frameworkManaged: true });
});
