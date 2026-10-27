import assert from "./support/assert";
import { test } from "node:test";
import { projectModel } from "../server/model/project";
import type { FrameworkConfig } from "@repo/framework/config";
import type { ModeModel, ModelEdge, ModelResource, ModelTarget, Snapshot, SourceIndex } from "../shared/model";
import type { TriggerCapability } from "../shared/triggers";
import { accessConnectionExists, configuredAccessOptions } from "../src/access-options";

const base = (): ModeModel => projectModel({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
  http: { "/caller": { directory: "/lambda_functions/caller", methods: ["GET"] } }, webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {} } as FrameworkConfig, { mode: "prod" });
const caller = base().targets[0]!;
const model = (extra: Partial<ModeModel> = {}): ModeModel => ({ ...base(), resources: [], edges: [], ...extra });
const source = (capabilities: readonly TriggerCapability[] = []): SourceIndex => ({ entities: {}, editability: {}, catalog: {}, links: {}, problems: [],
  cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, triggerCapabilities: capabilities });
const snapshot = (dev: ModeModel, prod = dev, capabilities: readonly TriggerCapability[] = []): Pick<Snapshot, "models" | "source"> => ({ models: { dev, prod }, source: source(capabilities) });
const resource = (path: string, extra: Partial<ModelResource> = {}): ModelResource => ({ id: `resource:${path}`, path: path.split("."), kind: "member", absent: false, ...extra });
const capability = (path: string, type: string): TriggerCapability => ({ resource: `resource:${path}`, stack: `resource:${path.split(".")[0]}`, name: path.split(".").at(-1)!,
  location: { file: "stack.ts", line: 1, column: 1, start: 0, end: 10 }, owned: true, adapters: [], canonicalTypes: [type] });
const target = (ref: string, kind: ModelTarget["kind"], extra: Partial<ModelTarget> = {}): ModelTarget => ({ ...caller, ref, id: ref.split(":")[1]!, title: ref.split(":")[1]!, kind, role: kind === "lambda" ? "event" : kind, ...extra });
const edge = (relation: ModelEdge["relation"], to: string, context?: ModelEdge["permissionContext"]): ModelEdge => ({
  id: `${relation}:${caller.ref}->${to}`, relation, from: caller.ref, to, label: "authored label", provenance: "declared", permissionContext: context,
});

test("configured grant choices use canonical CDK types, service names and artwork", () => {
  const cases = [
    ["data.uploads", "aws-s3:IBucket", "bucket", "grantReadWrite"],
    ["data.jobs", "aws-sqs:Queue", "queue", "grantSendMessages"],
    ["data.records", "aws-dynamodb:TableV2", "table", "grantReadData"],
    ["data.notifications", "aws-sns:ITopic", "topic", "grantPublish"],
    ["data.events", "aws-events:IEventBus", "bus", "grantPutEventsTo"],
  ] as const;
  const current = model({ resources: cases.map(([path]) => resource(path)) });
  const options = configuredAccessOptions(caller, snapshot(current, current, cases.map(([path, type]) => capability(path, type))));
  assert.equal(options.length, cases.length);
  for (const [path, , icon, method] of cases) {
    const option = options.find(option => option.id === `resource:${path}`)!;
    assert.equal(option.title, path);
    assert.equal(option.icon, icon);
    assert.match(option.subtitle, /^Amazon /);
    const grant = option.actions.find(action => action.id === method)!;
    assert.deepEqual(grant.edit, { kind: "connection", target: caller.ref, connection: "grant", enabled: true, destination: `resource:${path}`, grant: method });
    assert.equal(grant.scope, icon === "bucket");
  }
});

test("unsupported native services explain source ownership without inferring permissions from names", () => {
  const resources = [resource("data.secret", { typeText: "ISecret" }), resource("data.looksLikeBucket", { typeText: "Bucket" }), resource("data.count", { typeText: "number" })];
  const current = model({ resources });
  const options = configuredAccessOptions(caller, snapshot(current, current, [capability("data.secret", "aws-secretsmanager:ISecret")]));
  assert.deepEqual(options.map(option => option.id), ["resource:data.secret"]);
  assert.equal(options[0]!.subtitle, "AWS Secrets Manager");
  assert.equal(options[0]!.reason, "Configure access to this resource in source.");
  assert.deepEqual(options[0]!.actions, []);
});

test("uninstantiated stack resources cannot offer an executable-looking grant", () => {
  const current = model({ resources: [resource("unused", { kind: "stack", stackUsage: { status: "unreferenced", sites: [] } }), resource("unused.bucket")] });
  const option = configuredAccessOptions(caller, snapshot(current, current, [capability("unused.bucket", "aws-s3:Bucket")]))[0]!;
  assert.equal(option.reason, "Add this stack to the CDK app before granting access.");
});

test("both modes contribute destinations and existing cloud permissions", () => {
  const queue = resource("data.jobs", { absent: true });
  const workflow = target("workflow:nightly", "workflow");
  const dev = model({ mode: "dev", resources: [queue] });
  const prod = model({ resources: [{ ...queue, absent: false }], targets: [caller, workflow],
    edges: [edge("startsWorkflow", workflow.ref), edge("grant", queue.id, { kind: "native", method: "grantSendMessages", arguments: [] })] });
  const options = configuredAccessOptions(caller, snapshot(dev, prod, [capability("data.jobs", "aws-sqs:Queue")]));
  assert.equal(options.filter(option => option.id === queue.id).length, 1);
  const queueOption = options.find(option => option.id === queue.id)!;
  assert.equal(queueOption.actions.find(action => action.id === "grantSendMessages")!.existing, true);
  assert.equal(queueOption.reason, undefined, "consume permission is still available");
  const workflowOption = options.find(option => option.id === workflow.ref)!;
  assert.equal(workflowOption.reason, "Already configured.");
  assert.equal(workflowOption.actions[0]!.existing, true);
});

test("native duplicate matching retains method, exact scope and destination", () => {
  const bucket = resource("data.uploads");
  const current = model({ resources: [bucket], edges: [edge("grant", bucket.id, { kind: "native", method: "grantRead", arguments: ["uploads/*"] })] });
  const state = snapshot(current, current, [capability("data.uploads", "aws-s3:Bucket")]);
  const option = configuredAccessOptions(caller, state)[0]!;
  const action = option.actions.find(action => action.id === "grantRead")!;
  assert.equal(action.reason, undefined, "other object scopes remain selectable");
  assert.equal(accessConnectionExists({ ...action.edit, scope: "uploads/*" }, state), true);
  assert.equal(accessConnectionExists({ ...action.edit, scope: "other/*" }, state), false);
  assert.equal(accessConnectionExists({ ...action.edit, scope: "" }, state), false);
  assert.equal(accessConnectionExists({ ...action.edit, grant: "grantWrite", scope: "uploads/*" }, state), false);
});

test("invocations target declared workloads and tools are offered only to agents", () => {
  const task = target("task:worker", "task"), workflow = target("workflow:nightly", "workflow"), agent = target("agent:assistant", "agent"), tool = target("lambda:lookup", "lambda", { role: "tool" });
  const current = model({ targets: [caller, task, workflow, agent, tool] });
  const state = snapshot(current);
  const options = configuredAccessOptions(caller, state);
  assert.deepEqual(options.map(option => option.actions[0]!.edit.connection).sort(), ["invokesAgent", "runsTask", "startsWorkflow"]);
  const agentOptions = configuredAccessOptions(agent, state);
  assert.equal(agentOptions.some(option => option.id === agent.ref), false, "self invocation is not suggested");
  assert.equal(agentOptions.find(option => option.id === tool.ref)?.actions[0]?.edit.connection, "tool");
  assert.deepEqual(configuredAccessOptions(workflow, state), [], "workflow steps use their own editor");
});

test("database connection follows managed database and event replay eligibility", () => {
  const database = resource("data.database", { frameworkManaged: "database" });
  const current = model({ resources: [database], managedDatabase: { id: "application", resource: database.id, networkId: "application", subnet: "isolated", engine: "postgres", databaseName: "app", settings: {} as never, authored: {} } });
  const state = snapshot(model({ mode: "dev" }), current);
  const option = configuredAccessOptions(caller, state)[0]!;
  assert.equal(option.id, database.id);
  assert.equal(option.actions[0]!.edit.connection, "database");
  assert.equal(option.reason, undefined);
  assert.deepEqual(configuredAccessOptions(target("agent:assistant", "agent"), state), []);
  const event = target("lambda:event", "lambda");
  assert.match(configuredAccessOptions(event, state)[0]!.reason!, /Enable local replay/);
  assert.equal(configuredAccessOptions({ ...event, compute: { ...caller.compute, localReplay: true } as ModelTarget["compute"] }, state)[0]!.reason, undefined);
  const connected = snapshot(model({ mode: "dev" }), { ...current, edges: [edge("database", database.id)] });
  assert.equal(configuredAccessOptions(caller, connected)[0]!.reason, "Already configured.");
});

test("user-pool identifiers are one managed option, absent for agents and tools", () => {
  const pool = resource("identity.pool");
  const current = model({ resources: [pool] }), state = snapshot(current, current, [capability("identity.pool", "aws-cognito:IUserPool")]);
  const options = configuredAccessOptions(caller, state);
  assert.equal(options.length, 1);
  assert.equal(options[0]!.id, "framework:userPool");
  assert.equal(options[0]!.actions[0]!.edit.connection, "userPool");
  assert.deepEqual(configuredAccessOptions(target("agent:assistant", "agent"), state), []);
  assert.deepEqual(configuredAccessOptions(target("lambda:tool", "lambda", { role: "tool" }), state), []);
  assert.deepEqual(configuredAccessOptions(caller, snapshot(model())), []);
});

test("input and secret delivery produce framework edits while allowing multiple variable mappings", () => {
  const input = resource("config.region", { kind: "input", fromEnv: "REGION" }), secret = resource("token", { kind: "secret", fromEnv: "API_TOKEN" });
  const current = model({ resources: [input, secret], targets: [{ ...caller, environment: [{ name: "REGION", value: { kind: "reference", resource: input.id, display: "region" } }] }] });
  const state = snapshot(current);
  const options = configuredAccessOptions(caller, state);
  assert.equal(options.find(option => option.id === input.id)!.actions[0]!.variable, true);
  assert.equal(options.find(option => option.id === input.id)!.reason, undefined);
  assert.equal(options.find(option => option.id === secret.id)!.actions[0]!.label, "Read secret");
  const taskOptions = configuredAccessOptions(target("task:worker", "task"), state);
  assert.equal(taskOptions.find(option => option.id === secret.id)!.actions[0]!.label, "Load secret at startup");
  const edit = options.find(option => option.id === input.id)!.actions[0]!.edit;
  assert.equal(accessConnectionExists({ ...edit, variable: "REGION" }, state), true);
  assert.equal(accessConnectionExists({ ...edit, variable: "ALTERNATE_REGION" }, state), false);
});

test("permission catalog prioritizes usable services and calls before secrets and inputs", () => {
  const current = model({ targets: [caller, target("workflow:zWorkflow", "workflow")], resources: [
    resource("aInput", { kind: "input" }), resource("bSecret", { kind: "secret" }), resource("zStorage.bucket"), resource("aUnused", { kind: "stack", stackUsage: { status: "unreferenced", sites: [] } }), resource("aUnused.bucket"),
  ] });
  const options = configuredAccessOptions(caller, snapshot(current, current, [capability("zStorage.bucket", "aws-s3:Bucket"), capability("aUnused.bucket", "aws-s3:Bucket")]));
  assert.deepEqual(options.map(option => option.id), ["resource:zStorage.bucket", "workflow:zWorkflow", "resource:bSecret", "resource:aInput", "resource:aUnused.bucket"]);
});

test("destination-filtered access preserves complete catalog eligibility and actions across modes", () => {
  const database = resource("data.database", { frameworkManaged: "database" });
  const current = model({
    targets: [caller, target("task:worker", "task"), target("workflow:nightly", "workflow"), target("agent:assistant", "agent"), target("lambda:lookup", "lambda", { role: "tool" })],
    resources: [resource("data.queue"), resource("data.bucket"), resource("identity.pool"), resource("region", { kind: "input" }), resource("token", { kind: "secret" }), database],
    edges: [edge("grant", "resource:data.queue", { kind: "native", method: "grantSendMessages", arguments: [] })],
    managedDatabase: { id: "application", resource: database.id, networkId: "application", subnet: "isolated", engine: "postgres", databaseName: "app", settings: {} as never, authored: {} },
  });
  const dev = model({ mode: "dev", resources: [resource("devOnly", { kind: "input" })] });
  const state = snapshot(dev, current, [capability("data.queue", "aws-sqs:Queue"), capability("data.bucket", "aws-s3:Bucket"), capability("identity.pool", "aws-cognito:IUserPool")]);
  for (const consumer of current.targets) {
    const all = configuredAccessOptions(consumer, state);
    for (const id of [...current.targets.map(item => item.ref), ...current.resources.map(item => item.id), "resource:devOnly", "framework:userPool", "resource:missing"])
      assert.deepEqual(configuredAccessOptions(consumer, state, id), all.filter(option => option.id === id), `${consumer.ref} → ${id}`);
  }
});

test("destination-filtered access skips unrelated resource action generation", () => {
  const selected = resource("data.queue"), unrelated = resource("data.other");
  const unrelatedCapability = { ...capability("data.other", "aws-s3:Bucket"), get canonicalTypes(): readonly string[] { throw new Error("Unrelated resource types must not be read for a fixed destination"); } };
  const current = model({ resources: [selected, unrelated] });
  const state = snapshot(current, current, [capability("data.queue", "aws-sqs:Queue"), unrelatedCapability]);
  assert.equal(configuredAccessOptions(caller, state, selected.id)[0]?.id, selected.id);
  assert.deepEqual(configuredAccessOptions(caller, state, "resource:missing"), []);
});
