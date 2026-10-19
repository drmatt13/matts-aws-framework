import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { defineFrameworkConfig, defineNetwork, defineResources, dynamodb, invokeLambda, resource, runsTask, sequence, startsWorkflow, trigger, workflow, type FrameworkConfig } from "@repo/framework/config";
import type { UserPool } from "aws-cdk-lib/aws-cognito";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { defaults } from "../../framework-config/defaults";
import type { Snapshot } from "../shared/model";
import { projectModel } from "../server/model/project";
import { SnapshotBuilder, type StudioState } from "../server/snapshot";
import { fieldEditability, SourceFiles } from "../server/source";
import { locateConfigSource } from "../../packages/framework/scripts/config-source";
import { ROOT_ENV_STACK_OUTPUTS } from "../../scripts/root-env-outputs";
import { withExportStacks } from "../server/source/export-stacks";

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

test("managed output stacks match the root exporter, reuse catalog ids, and carry only public symbolic outputs", () => {
  for (const model of Object.values(snapshot.models)) {
    const stacks = model.resources.filter((item) => item.kind === "stack" && item.stackOutputs?.length);
    assert.deepEqual(stacks.map((item) => item.stackClass).sort(), Object.keys(ROOT_ENV_STACK_OUTPUTS).sort());
    assert.equal(stacks.find((item) => item.stackClass === "CognitoStack")?.id, "resource:cognito");
    assert.equal(stacks.find((item) => item.stackClass === "RdsStack")?.id, "resource:rds");
    assert.equal(stacks.find((item) => item.stackClass === "DevLambdaReplayStack")?.absent, model.mode !== "dev");
    assert.equal(stacks.find((item) => item.stackClass === "FrontendWebsiteS3Stack")?.absent, model.mode !== "prod");
    assert.equal(stacks.find((item) => item.stackClass === "HttpApiGatewayStack")?.absent, model.mode !== "prod");
    const webSocketBuilt = model.targets.some((target) => (target.role === "webSocket" || target.role === "webSocketAuthorizer") && (model.mode === "dev" ? target.lanes.dev : target.lanes.prod));
    assert.equal(stacks.find((item) => item.stackClass === "WebSocketApiStack")?.absent, !webSocketBuilt);
    assert.ok(stacks.every((item) => item.frameworkManaged && snapshot.source.entities[item.id]?.key));
    assert.ok(!model.resources.some((item) => item.stackClass === "AsynchronousLambdaFunctionsStack" || item.stackClass === "EcsTasksStack"));
    assert.ok(!stacks.flatMap((item) => item.stackOutputs!).some((output) => output.name === "ReplayDeadLetterQueueUrl" || output.name === "FrontendWebsiteBucketArn"));
  }
});

test("declaring a displayed framework stack in the catalog reuses its resource id and clears the missing-catalog flag", () => {
  const model = snapshot.models.dev;
  const original = model.resources.find((item) => item.stackClass === "DevLambdaReplayStack")!;
  assert.equal(original.frameworkStack, true);
  const { frameworkStack: _origin, ...catalogFields } = original;
  const catalogEntry = { ...catalogFields, id: "resource:replay", path: ["replay"] };
  const projected = withExportStacks({ ...model, resources: model.resources.map((item) => item.id === original.id ? catalogEntry : item) }, state.built.exportStacks);
  const matches = projected.resources.filter((item) => item.stackClass === "DevLambdaReplayStack");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.id, "resource:replay");
  assert.equal(matches[0]!.frameworkStack, undefined);
  assert.equal(matches[0]!.stackUsage?.status, "referenced", "CDK construction is independent of catalog membership");
  assert.equal(model.resources.find((item) => item.stackClass === "RdsStack")?.frameworkStack, undefined, "a development-absent database is still declared in the catalog");
});

test("both modes of the real repository evaluate without a diagnostic", () => {
  for (const mode of ["dev", "prod"] as const) {
    const model = snapshot.models[mode];
    assert.equal(model.status, "ok", JSON.stringify(model.diagnostics));
    assert.ok(model.targets.length > 0);
  }
});

test("only replay-enabled event Lambdas connect to the replay stack, including catalog stack identities", () => {
  for (const model of Object.values(snapshot.models)) {
    const replay = model.resources.find((item) => item.stackClass === "DevLambdaReplayStack")!;
    const enabled = model.targets.filter((target) => target.role === "event" && target.compute.kind === "lambda" && target.compute.localReplay);
    const edges = model.edges.filter((edge) => edge.relation === "localReplay");
    assert.deepEqual(edges.map((edge) => edge.from).sort(), enabled.map((target) => target.ref).sort());
    assert.ok(edges.length > 0);
    assert.ok(edges.every((edge) => edge.to === replay.id && edge.provenance === "derived"));
    assert.equal(replay.absent, model.mode !== "dev");
    for (const target of model.targets) assert.equal(!!model.fields[target.ref]?.some((fact) => fact.field === "events.localReplay"), target.role === "event");
    const projected = withExportStacks({ ...model, resources: model.resources.map((item) => item.id === replay.id ? { ...item, id: "resource:replay", frameworkStack: undefined } : item) }, state.built.exportStacks);
    assert.equal(projected.edges.filter((edge) => edge.relation === "localReplay").length, edges.length);
    assert.ok(projected.edges.filter((edge) => edge.relation === "localReplay").every((edge) => edge.to === "resource:replay"));
  }
});

test("relationships are the framework's, with their own relation", () => {
  const edges = snapshot.models.dev.edges;
  const has = (relation: string, from: string, to: string) =>
    edges.some((edge) => edge.relation === relation && edge.from === from && edge.to === to);
  assert.ok(has("routes", "route:http:/graphql", "lambda:graphql-api"));
  assert.ok(has("usesTool", "agent:example-agent", "lambda:add-numbers"));
  assert.ok(has("database", "lambda:graphql-api", "local:postgres"));
  assert.ok(snapshot.models.prod.edges.some((edge) => edge.relation === "database" && edge.from === "lambda:graphql-api" && edge.to === "resource:rds.database"));
  assert.ok(has("grant", "lambda:mfa", "resource:cognito.userPool"));
  const userPool = edges.find((edge) => edge.from === "lambda:graphql-api" && edge.label === "USER_POOL_ID");
  assert.equal(userPool?.provenance, "derived", "handed by userPool: true, not written by the author");
});

test("read connections locate authored entries, field declarations, assignments and linking", () => {
  for (const model of Object.values(snapshot.models)) {
    const edge = model.edges.find((item) => item.from === "lambda:sign-out" && item.label === "TRUSTED_FRONTEND_ORIGINS")!;
    assert.ok(edge);
    const evidence = edge.evidence!;
    for (const [role, text] of [["declared", "TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv"], ["field", "public readonly trustedOriginsCsv: string"], ["assigned", "this.trustedOriginsCsv ="], ["linked", "linkResources(this, resources.cognito)"]] as const) {
      const item = evidence.find((item) => item.role === role)!;
      assert.ok(item?.excerpt?.includes(text), `${role}: ${JSON.stringify(evidence)}`);
      const line = readFileSync(path.join(repositoryRoot, item.location.file), "utf8").split("\n")[item.location.line - 1]!;
      assert.ok(line.includes(text));
    }
    const derived = model.edges.find((item) => item.from === "lambda:graphql-api" && item.label === "USER_POOL_ID")!;
    assert.ok(derived.evidence?.some((item) => item.role === "derived" && item.excerpt?.includes("userPool: true")));
    for (const item of model.edges.filter((edge) => ["env", "secret", "grant"].includes(edge.relation))) {
      assert.ok(item.evidence?.some((evidence) => evidence.role === "declared" || evidence.role === "derived"), item.id);
      assert.ok(item.evidence?.every((evidence) => evidence.location.file.endsWith(".ts") && !evidence.excerpt?.includes("\n")), item.id);
    }
  }
});

test("task, workflow and integration relationships come from an isolated config", () => {
  const catalog = defineResources({ data: resource.stack<{ readonly records: ITable }>() });
  const config = defineFrameworkConfig({
    resources: catalog, defaults, webSocket: [], services: [],
    http: [{ "/process": { directory: "/test/fixtures/caller", methods: ["POST"], cloud: { bindings: [runsTask("worker"), startsWorkflow("process")] } } }],
    events: [{ worker: { directory: "/test/fixtures/workload-handler" } }],
    tasks: [{ worker: { directory: "/test/fixtures/task-worker", deploy: "both" } }],
    workflows: [{ process: workflow(() => sequence(invokeLambda("worker"), dynamodb.put(catalog.data.records, { item: { pk: "example" } })), { timeoutSeconds: 60 }) }],
  });
  const model = projectModel(config as unknown as FrameworkConfig, { mode: "dev", webSocketApi: false });
  for (const [relation, from, to] of [
    ["runsTask", "lambda:caller", "task:worker"],
    ["startsWorkflow", "lambda:caller", "workflow:process"],
    ["step", "workflow:process", "lambda:worker"],
    ["integration", "workflow:process", "resource:data.records"],
  ]) assert.ok(model.edges.some((edge) => edge.relation === relation && edge.from === from && edge.to === to), relation);
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

test("the frontend workflow has its authenticated starter and both execution steps", () => {
  for (const model of Object.values(snapshot.models)) {
    const route = model.routes.find((route) => route.path === "/test/start-workflow");
    assert.equal(route?.target, "lambda:test-start-workflow");
    assert.equal(route?.auth, true);
    assert.equal(model.targets.find((target) => target.ref === route?.target)?.userPool, true);
    for (const [relation, from, to] of [
      ["startsWorkflow", "lambda:test-start-workflow", "workflow:invocation-test-workflow"],
      ["step", "workflow:invocation-test-workflow", "lambda:invocation-test-step"],
      ["step", "workflow:invocation-test-workflow", "task:invocation-test-task"],
    ]) assert.ok(model.edges.some((edge) => edge.relation === relation && edge.from === from && edge.to === to), `${model.mode}: ${relation}`);
  }
});

test("the frontend task starter invokes the shared task directly", () => {
  for (const model of Object.values(snapshot.models)) {
    const route = model.routes.find((route) => route.path === "/test/run-task");
    assert.equal(route?.target, "lambda:test-run-task");
    assert.equal(route?.auth, true);
    assert.equal(model.targets.find((target) => target.ref === route?.target)?.userPool, true);
    const bindings = model.edges.filter((edge) => edge.from === route?.target && ["runsTask", "startsWorkflow"].includes(edge.relation));
    assert.deepEqual(bindings.map((edge) => [edge.relation, edge.to]), [["runsTask", "task:invocation-test-task"]]);
    assert.equal(model.targets.filter((target) => target.ref === "task:invocation-test-task").length, 1);
  }
});

test("an absent catalog entry is absent in the graph that leaves it out, and only there", () => {
  const absent = (mode: "dev" | "prod", id: string) =>
    snapshot.models[mode].resources.find((resource) => resource.id === id)?.absent;
  assert.equal(absent("dev", "resource:rds"), true);
  assert.equal(absent("prod", "resource:rds"), false);
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
  assert.equal(cached.version, 2);
  assert.ok(cached.edges.length >= 3);
  assert.ok(Object.keys(cached.files).includes("cdk-app/lib/app/reference-example-stack.ts"));
});

test("the three native Cognito hooks connect the public pool to their events in both lenses", () => {
  for (const model of Object.values(snapshot.models)) {
    const hooks = model.edges.filter((edge) => edge.relation === "trigger");
    assert.deepEqual(hooks.map((edge) => [edge.from, edge.to, edge.label, edge.source?.line]).sort(), [
      ["resource:cognito.userPool", "lambda:cognito-pre-signup-trigger", "preSignUp", 215],
      ["resource:cognito.userPool", "lambda:cognito-custom-message", "customMessage", 216],
      ["resource:cognito.userPool", "lambda:cognito-post-confirmation-trigger", "postConfirmation", 217],
    ].sort());
    assert.ok(hooks.every((edge) => edge.evidence?.some((item) => item.role === "wired")));
  }
});

test("typed trigger descriptors normalize to declared resource-to-event edges with adapter metadata", () => {
  const catalog = defineResources({ identity: resource.stack<{ pool: UserPool }>() });
  const config = defineFrameworkConfig({ resources: catalog, defaults, http: [], webSocket: [], services: [], events: [{ event: { directory: "/test/fixtures/workload-handler", triggers: [trigger.cognito(catalog.identity.pool, { id: "signup", operation: "preSignUp", accepts: "cognito" })] } }] });
  for (const mode of ["dev", "prod"] as const) {
    const model = projectModel(config as unknown as FrameworkConfig, { mode, webSocketApi: false });
    const edge = model.edges.find((edge) => edge.relation === "trigger")!;
    assert.equal(edge.from, "resource:identity.pool");
    assert.equal(edge.to, "lambda:event");
    assert.equal(edge.provenance, "declared");
    assert.equal(edge.attachment, "identity.pool/signup");
    assert.equal(model.triggers?.[0]?.key, edge.attachment);
    assert.ok(model.triggerAdapters?.some((adapter) => adapter.kind === "cognito"));
  }
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
  assert.equal(editability["lambda:add-numbers"]?.deploy, undefined, "a tool's lane is derived, never edited");
});

test("shared defaults locate imported source and keep computed defaults read-only", () => {
  const group = "defaults:lambda";
  const fact = snapshot.models.dev.fields[group].find((fact) => fact.field === "defaults.lambda.bundling.minify")!;
  const source = snapshot.source.entities[group].value;
  assert.equal(source.file, "framework-config/defaults.ts");
  assert.equal(snapshot.source.editability[group][fact.field].kind, "literal");
  assert.ok(fact.usage!.inherited > 0);
  assert.equal(snapshot.models.dev.fields["defaults:webSocket"].find((fact) => fact.field.endsWith("timeoutSeconds"))!.effective, 3);
  assert.equal(snapshot.models.dev.fields["defaults:database"].find((fact) => fact.field.endsWith("maxConnections"))!.effective, 10);
  const file = path.join(repositoryRoot, source.file);
  const original = readFileSync(file, "utf8");
  assert.ok(original.includes("minify: true"));
  const files = new SourceFiles(new Map([[file, original.replace("minify: true", "minify: true && true")]]));
  assert.ok(state.built.located);
  const located = locateConfigSource(path.join(repositoryRoot, "framework.config.ts"), { repositoryRoot, host: files.host() });
  const result = fieldEditability(files, located, "defaults", fact);
  assert.equal(result.kind, "computed");
});

test("Lambda build details and editable fields distinguish TypeScript bundles from Dockerfile images", () => {
  const model = snapshot.models.dev;
  const node = model.targets.find((target) => target.ref === "lambda:graphql-api")!;
  assert.equal(node.compute.kind, "lambda");
  if (node.compute.kind !== "lambda") return;
  assert.equal(node.compute.implementation, "typescript");
  assert.equal(node.compute.runtime, "nodejs24");
  assert.equal(node.compute.handler, "lambdaHandler");
  assert.deepEqual(node.compute.bundling, { minify: true, sourceMap: false });
  const architecture = model.fields[node.ref]!.find((fact) => fact.field === "lambda.architecture")!;
  assert.equal(architecture.effective, "arm64");
  assert.equal(architecture.provenance, "defaults.lambda.architecture");
  const container = model.targets.find((target) => target.ref === "lambda:python-example")!;
  assert.equal(container.compute.kind === "lambda" && container.compute.implementation, "container");
  assert.ok(container.compute.kind === "lambda" && container.compute.runtime === undefined && container.compute.handler === undefined);
  assert.ok(model.fields[container.ref]!.some((fact) => fact.field === "lambda.architecture"));
  assert.ok(!model.fields[container.ref]!.some((fact) => fact.field === "lambda.runtime" || fact.field.startsWith("lambda.bundling.")));
});

test("Cognito event Lambda build settings are editable and an outdated registry has a distinct diagnostic", () => {
  const ref = "lambda:cognito-pre-signup-trigger";
  for (const field of ["lambda.architecture", "lambda.packaging", "lambda.runtime", "lambda.bundling.minify", "lambda.bundling.sourceMap", "lambda.logRetentionDays"]) {
    assert.deepEqual(snapshot.source.editability[ref]?.[field], { kind: "absent" }, field);
  }
  assert.equal(snapshot.source.entities[ref]?.key.file, "framework-config/events/cognito.ts");
  assert.ok(state.built.located);
  const fact = snapshot.models.dev.fields[ref]![0]!;
  const result = fieldEditability(new SourceFiles(), state.built.located, 'events["cognito-pre-signup-trigger"]', { ...fact, field: "lambda.unloadedSetting" });
  assert.equal(result.kind, "unsupported");
  if (result.kind === "unsupported") assert.match(result.reason, /Restart Studio/);
});

test("Lambda settings inherit section defaults and Python has no Node bundling controls", () => {
  const config = defineFrameworkConfig({
    defaults: {
      lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: { minify: true } },
      http: { architecture: "x86_64", runtime: "nodejs22", logRetentionDays: 14, bundling: { minify: false } },
    },
    http: {
      "/node": { directory: "/lambda_functions/http_functions/node", methods: ["POST"], bundling: { sourceMap: false } },
      "/python": { directory: "/lambda_functions/http_functions/python", methods: ["POST"], runtime: "python3.13", handler: "app.handle" },
    },
    webSocket: {}, events: {}, services: {}, tasks: {},
  }) as unknown as FrameworkConfig;
  const model = projectModel(config, { mode: "dev", webSocketApi: false });
  const facts = model.fields["lambda:node"]!;
  assert.equal(facts.find((fact) => fact.field === "lambda.architecture")?.provenance, "defaults.http.architecture");
  assert.equal(facts.find((fact) => fact.field === "lambda.runtime")?.effective, "nodejs22");
  assert.equal(facts.find((fact) => fact.field === "lambda.logRetentionDays")?.effective, 14);
  assert.equal(facts.find((fact) => fact.field === "lambda.bundling.minify")?.effective, false);
  const sourceMap = facts.find((fact) => fact.field === "lambda.bundling.sourceMap")!;
  assert.equal(sourceMap.effective, false);
  assert.deepEqual(sourceMap.inherited, { value: true, from: "the framework's default" });
  const python = model.targets.find((target) => target.ref === "lambda:python")!;
  assert.equal(python.compute.kind === "lambda" && python.compute.implementation, "python");
  assert.equal(python.compute.kind === "lambda" && python.compute.handler, "app.handle");
  assert.ok(!model.fields[python.ref]!.some((fact) => fact.field.startsWith("lambda.bundling.")));
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
