import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { defineFrameworkConfig, defineNetwork, runsTask, type FrameworkConfig } from "@repo/framework/config";
import type { Snapshot } from "../shared/model";
import { projectModel } from "../server/model/project";
import { SnapshotBuilder, type StudioState } from "../server/snapshot";

/**
 * The model is the framework's answers, reshaped. These tests hold it to the
 * real repository — where the relationships are known — and to small configs
 * whose lanes and placement can be predicted from the framework's rules alone.
 */

const repositoryRoot = path.resolve(__dirname, "..", "..");
let builder: SnapshotBuilder;
let state: StudioState;
let snapshot: Snapshot;

before(async () => {
  builder = new SnapshotBuilder(repositoryRoot);
  state = await builder.refresh();
  snapshot = state.snapshot;
});
after(() => builder.dispose());

test("both modes of the real repository evaluate without a diagnostic", () => {
  for (const mode of ["dev", "prod"] as const) {
    const model = snapshot.models[mode];
    assert.equal(model.status, "ok", JSON.stringify(model.diagnostics));
    assert.ok(model.targets.length > 0);
  }
});

test("relationships are the framework's, with their own relation", () => {
  const edges = snapshot.models.dev.edges;
  const has = (relation: string, from: string, to: string) =>
    edges.some((edge) => edge.relation === relation && edge.from === from && edge.to === to);
  assert.ok(has("routes", "route:http:/test/run-task", "lambda:test-run-task"));
  assert.ok(has("runsTask", "lambda:test-run-task", "task:invocation-test-task"));
  assert.ok(has("step", "workflow:invocation-test-workflow", "lambda:invocation-test-step"));
  assert.ok(has("usesTool", "agent:example-agent", "lambda:add-numbers"));
  assert.ok(has("database", "lambda:graphql-api", "resource:rds.database"));
  assert.ok(has("grant", "lambda:mfa", "resource:cognito.userPool"));
  assert.ok(has("integration", "workflow:capability-check", "resource:workflowFixtures.fixtureTable"));
  const userPool = edges.find((edge) => edge.from === "lambda:graphql-api" && edge.label === "USER_POOL_ID");
  assert.equal(userPool?.provenance, "derived", "handed by userPool: true, not written by the author");
});

test("lanes carry the framework's special rules", () => {
  const target = (ref: string) => snapshot.models.dev.targets.find((candidate) => candidate.ref === ref)!;
  const tool = target("lambda:add-numbers");
  assert.equal(tool.lanes.origin, "derived");
  assert.deepEqual(tool.lanes.derivedFrom, ["agent:example-agent"]);
  const event = target("lambda:cognito-pre-signup-trigger");
  assert.equal(event.lanes.origin, "aws-invoked");
  assert.equal(event.lanes.dev, true, "AWS invokes it, so the dev graph holds it");
  const service = target("service:example-service");
  assert.equal(service.lanes.deploy, "local-only");
  assert.deepEqual([service.lanes.local, service.lanes.dev, service.lanes.prod], [true, false, false]);
  const http = target("lambda:graphql-api");
  assert.deepEqual([http.lanes.local, http.lanes.dev, http.lanes.prod], [true, false, true]);
});

test("an absent catalog entry is absent in the graph that leaves it out, and only there", () => {
  const absent = (mode: "dev" | "prod", id: string) =>
    snapshot.models[mode].resources.find((resource) => resource.id === id)?.absent;
  assert.equal(absent("dev", "resource:rds"), true);
  assert.equal(absent("prod", "resource:rds"), false);
  assert.equal(absent("dev", "resource:workflowFixtures"), false);
  assert.equal(absent("prod", "resource:workflowFixtures"), true);
  assert.equal(snapshot.source.catalog["resource:rds"]?.condition, "PROD_DEPLOYMENT");
});

test("a stack's members come from its class, including ones nothing reads yet", () => {
  const bucket = snapshot.models.dev.resources.find((resource) => resource.id === "resource:referenceExamples.documentsBucket");
  assert.equal(bucket?.memberSource, "class");
  assert.equal(bucket?.typeText, "s3.Bucket");
  assert.ok(snapshot.source.links.referenceExamples?.[0]?.file.endsWith("reference-example-stack.ts"));
});

test("referenceExamples exposes source-backed CDK flow in both graphs", () => {
  for (const mode of ["dev", "prod"] as const) {
    const edges = snapshot.models[mode].edges.filter((edge) => edge.relation === "cdk");
    for (const [from, to, label] of [
      ["documentsBucket", "notificationsTopic", "EventBridge rule"],
      ["notificationsTopic", "processingQueue", "SNS subscription"],
      ["processingQueue", "deadLetterQueue", "Dead-letter queue"],
    ]) {
      const edge = edges.find((item) => item.from === `resource:referenceExamples.${from}` && item.to === `resource:referenceExamples.${to}`);
      assert.equal(edge?.label, label);
      assert.equal(edge?.provenance, "source");
      assert.ok(edge?.source?.file.endsWith("reference-example-stack.ts"));
    }
  }
  const cached = JSON.parse(readFileSync(path.join(repositoryRoot, ".cache/framework-studio/cdk-links.json"), "utf8"));
  assert.equal(cached.version, 1);
  assert.ok(cached.edges.length >= 3);
  assert.ok(Object.keys(cached.files).includes("cdk-app/lib/app/reference-example-stack.ts"));
});

test("every target and route is located, and its key is what the source writes there", () => {
  const model = snapshot.models.dev;
  assert.deepEqual(snapshot.source.problems, []);
  for (const entity of [...model.targets.map((target) => target.ref), ...model.routes.map((route) => route.id)]) {
    const source = snapshot.source.entities[entity];
    assert.ok(source, `${entity} has a source location`);
    const text = readFileSync(path.join(repositoryRoot, source.key.file), "utf8").slice(source.key.start, source.key.end);
    const key = /\["(.+?)"\]/.exec(source.origin)?.[1];
    const chain = source.origin.split("].")[1];
    assert.equal(text.replace(/^["']|["']$/g, ""), chain ?? key, entity);
  }
});

test("an editable literal is one the evaluated config agrees with", () => {
  const editability = snapshot.source.editability;
  assert.deepEqual(editability["service:example-service"]?.deploy, { kind: "literal", text: '"local-only"' });
  assert.deepEqual(editability["lambda:graphql-api"]?.["lambda.memorySize"], { kind: "literal", text: "512" });
  assert.deepEqual(editability["lambda:graphql-api"]?.deploy, { kind: "absent" });
  assert.deepEqual(editability["workflow:capability-check"]?.deploy, { kind: "literal", text: '"local-only"' });
  assert.equal(editability["lambda:add-numbers"]?.deploy, undefined, "a tool's lane is derived, never edited");
});

test("the projection follows the framework's rules on a config of its own", () => {
  // An isolated Lambda that runs a task reaches ECS only through its endpoint,
  // which the framework refuses to leave out.
  const config = defineFrameworkConfig({
    network: defineNetwork({ cidr: "10.0.0.0/16", zones: 2, interfaceEndpoints: ["ecs"] }),
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: {
      "/orders": {
        directory: "/lambda_functions/http_functions/orders",
        methods: ["POST"],
        subnet: "isolated",
        cloud: { bindings: [runsTask("rollup")] },
      },
    },
    webSocket: {},
    events: {},
    services: {},
    tasks: { rollup: { deploy: "both" } },
  }) as unknown as FrameworkConfig;
  const model = projectModel(config, { mode: "dev", webSocketApi: false });
  assert.equal(model.status, "ok");
  const orders = model.targets.find((target) => target.ref === "lambda:orders")!;
  assert.deepEqual(orders.placement.kind === "vpc" && [orders.placement.subnet, orders.placement.egress], [
    "isolated",
    { ipv4: false, ipv6: false },
  ]);
  assert.equal(orders.lanes.origin, "default");
  const task = model.targets.find((target) => target.ref === "task:rollup")!;
  assert.equal(task.placement.kind === "vpc" && task.placement.subnet, "public");
  assert.ok(model.edges.some((edge) => edge.relation === "runsTask" && edge.to === "task:rollup"));
  const subnet = model.fields["lambda:orders"]?.find((fact) => fact.field === "lambda.subnet");
  assert.deepEqual([subnet?.effective, subnet?.provenance, subnet?.authored], ["isolated", "declared on the entry", "isolated"]);
  assert.equal(model.network?.monthlyCost.interfaceEndpoints, 14.6);
});
