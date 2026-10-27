import assert from "./support/assert";
import { test } from "node:test";
import { projectModel } from "../server/model/project";
import type { FrameworkConfig } from "@repo/framework/config";
import type { ModeModel, ModelEdge, ModelResource, ModelTarget, SourceIndex, SourceLocation } from "../shared/model";
import { withConnectionAuthorizations } from "../shared/permissions";
import { accessDestination, removalForConnection, targetAccess } from "../src/access";

const base = projectModel({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: { "/caller": { directory: "/lambda_functions/caller", methods: ["GET"] } }, webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {} } as FrameworkConfig, { mode: "prod" });
const target = (ref = "lambda:caller", kind: ModelTarget["kind"] = "lambda", extra: Partial<ModelTarget> = {}): ModelTarget => ({ ...base.targets[0]!, ref, id: ref.split(":")[1]!, title: ref.split(":")[1]!, kind, role: kind === "lambda" ? "http" : kind, ...extra });
const edge = (relation: ModelEdge["relation"], extra: Partial<ModelEdge> = {}): ModelEdge => ({ id: "link", relation, from: "lambda:caller", to: "resource:store.bucket", provenance: "declared", label: "Authored display label", ...extra });
const bucket: ModelResource = { id: "resource:store.bucket", path: ["store", "bucket"], kind: "member", typeText: "s3.Bucket", absent: false };
const location: SourceLocation = { file: "workloads.ts", line: 1, column: 1, start: 0, end: 1000 };
const source = (extra: Partial<SourceIndex> = {}): SourceIndex => ({ cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, entities: { "lambda:caller": { origin: 'http["/caller"]', key: location, value: location } }, editability: {}, links: {}, catalog: {}, problems: [],
  triggerCapabilities: [{ resource: bucket.id, stack: "store", name: "bucket", location, owned: true, canonicalTypes: ["aws-s3:Bucket"], adapters: [] }], ...extra });
const model = (edges: readonly ModelEdge[], targets: readonly ModelTarget[] = [target()], extra: Partial<ModeModel> = {}) => withConnectionAuthorizations({ ...base, edges, targets, resources: [bucket], ...extra });

test("a pull trigger belongs to the consumer role despite pointing toward it", () => {
  const pull = edge("trigger", { from: "resource:jobs.queue", to: "lambda:caller", permissionContext: { kind: "trigger", adapter: "sqs" } });
  const built = model([pull], [target()], { resources: [{ id: pull.from, path: ["jobs", "queue"], kind: "member", typeText: "sqs.Queue", absent: false }] });
  const access = targetAccess(built.targets[0]!, built, source());
  assert.equal(access.owned.length, 1);
  assert.equal(access.incoming.length, 0);
  assert.equal(access.owned[0]!.destination.title, "jobs.queue");
  assert.equal(access.owned[0]!.destination.icon, "queue");
  assert.equal(access.owned[0]!.operation, "Consume queue messages");
  assert.equal(access.owned[0]!.remove, undefined, "trigger-derived grants must be edited with the trigger");
});

test("API Gateway permission is incoming and retains its API identity", () => {
  const route = base.routes[0]!;
  const built = model([edge("routes", { from: route.id, to: "lambda:caller", label: "/api/caller" })]);
  const access = targetAccess(built.targets[0]!, built, source());
  assert.equal(access.owned.length, 0);
  assert.equal(access.incoming.length, 1);
  assert.equal(access.incoming[0]!.destination.title, "HTTP API");
  assert.equal(access.incoming[0]!.destination.icon, "gateway");
  assert.equal(access.incoming[0]!.destination.id, "gateway:http");
  assert.equal(access.incoming[0]!.operation, "Invoke function");
  assert.equal(access.incoming[0]!.remove, undefined);
});

test("callback permissions are split by receiving role without leaking another role's grants", () => {
  const link = edge("step", { from: "workflow:process", to: "task:worker", permissionContext: { kind: "step", target: "task", callback: true } });
  const built = model([link], [target("workflow:process", "workflow"), target("task:worker", "task")]);
  const process = targetAccess(built.targets[0]!, built);
  const worker = targetAccess(built.targets[1]!, built);
  assert.equal(process.owned[0]!.authorization.grants.every(grant => grant.principalEntity === "workflow:process"), true);
  assert.equal(process.incoming[0]!.operation, "Complete workflow callback");
  assert.equal(worker.owned[0]!.operation, "Complete workflow callback");
  assert.deepEqual(worker.owned[0]!.authorization.grants.flatMap(grant => grant.actions ?? []), ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"]);
  assert.equal(worker.owned[0]!.remove, undefined);
  assert.equal(worker.incoming[0]!.authorization.grants.some(grant => grant.actions?.includes("iam:PassRole")), true);
});

test("local connections and token invocation follow capability direction and do not become IAM grants", () => {
  const call = edge("invokesAgent", { to: "agent:assistant" });
  const local = edge("database", { id: "local", to: "local:postgres", permissionContext: { kind: "database", connection: "application", readers: false } });
  const built = model([call, local], [target(), target("agent:assistant", "agent", { auth: true })]);
  const caller = targetAccess(built.targets[0]!, built, source());
  assert.deepEqual(caller.owned.map(item => item.authorization.kind), ["user-token", "local"]);
  assert.equal(caller.owned[0]!.remove?.connection, "invokesAgent");
  assert.equal(targetAccess(built.targets[1]!, built).incoming[0]!.authorization.kind, "user-token");
});

test("explicit policies remain owned without inventing a self destination or removal", () => {
  const built = model([], [target(undefined, undefined, { access: [{ actions: ["s3:GetObject"], resources: ["arn:aws:s3:::example/*"] }] })]);
  const item = targetAccess(built.targets[0]!, built, source()).owned[0]!;
  assert.equal(item.destination.title, "IAM policy");
  assert.equal(item.destination.id, undefined);
  assert.equal(item.remove, undefined);
  const otherMode = { ...built, mode: "dev" as const, targets: [{ ...built.targets[0]!, authorizations: built.targets[0]!.authorizations!.map(item => ({ ...item, authorization: { ...item.authorization, state: "not-built" as const } })) }] };
  assert.equal(targetAccess(otherMode.targets[0]!, otherMode).owned[0]!.id, item.id);
});

test("native removals preserve exact method and scope, refusing ambiguous or unrepresentable arguments", () => {
  for (const args of [[], ["tenant/*"], ["*"]]) {
    const grant = edge("grant", { permissionContext: { kind: "native", method: "grantRead", arguments: args } });
    const built = model([grant]);
    const item = targetAccess(built.targets[0]!, built, source()).owned[0]!;
    assert.equal(item.operation, "Read bucket objects");
    assert.deepEqual(item.remove, { kind: "connection", target: "lambda:caller", connection: "grant", enabled: false, destination: bucket.id, grant: "grantRead", scope: args[0] ?? "" });
  }
  for (const args of [[""], ["tenant/*", "other/*"], [{ computed: true }], ["bad\nscope"]]) {
    const grant = edge("grant", { permissionContext: { kind: "native", method: "grantRead", arguments: args } });
    assert.equal(removalForConnection(target(), grant, model([grant]), source()), undefined);
  }
  const grant = edge("grant", { permissionContext: { kind: "native", method: "grantRead", arguments: [] } });
  assert.equal(removalForConnection(target(), grant, model([grant, { ...grant, id: "duplicate" }]), source()), undefined);
  assert.equal(removalForConnection(target(), grant, model([grant]), source({ triggerCapabilities: [] })), undefined);
  assert.equal(removalForConnection(target(), { ...grant, provenance: "source" }, model([grant]), source()), undefined);
  assert.equal(removalForConnection(target(), { ...grant, permissionContext: undefined }, model([grant]), source()), undefined);
});

test("only supported explicit call and tool bindings offer removal", () => {
  for (const [relation, kind] of [["runsTask", "task"], ["startsWorkflow", "workflow"], ["invokesAgent", "agent"]] as const) {
    const call = edge(relation, { to: `${kind}:other` });
    const built = model([call], [target(), target(call.to, kind)]);
    assert.equal(removalForConnection(built.targets[0]!, call, built, source())?.connection, relation);
    assert.equal(removalForConnection(built.targets[0]!, { ...call, provenance: "derived" }, built, source()), undefined);
    assert.equal(removalForConnection(built.targets[0]!, call, built), undefined);
  }
  const agent = target("agent:assistant", "agent"), tool = target("lambda:tool", "lambda", { role: "tool" });
  const link = edge("usesTool", { from: agent.ref, to: tool.ref });
  const built = model([link], [agent, tool]);
  const indexed = source({ entities: { [agent.ref]: { origin: 'agents["assistant"]', key: location, value: location } } });
  assert.equal(removalForConnection(agent, link, built, indexed)?.connection, "tool");
  assert.equal(removalForConnection(tool, link, built, indexed), undefined);
});

test("input removal requires the exact declared variable and supported delivery shape", () => {
  const input: ModelResource = { id: "resource:input", path: ["input"], kind: "input", absent: false };
  const caller = target(undefined, undefined, { environment: [{ name: "REGION", value: { kind: "reference", resource: input.id, display: "resources.input" } }] });
  const link = edge("env", { to: input.id, label: "REGION" });
  const built = model([link], [caller], { resources: [input] });
  assert.equal(removalForConnection(caller, link, built, source())?.variable, "REGION");
  assert.equal(removalForConnection(caller, { ...link, label: "OTHER" }, built, source()), undefined);
  assert.equal(removalForConnection(caller, { ...link, provenance: "derived" }, built, source()), undefined);
  const native = model([link], [caller], { resources: [{ ...input, kind: "member" }] });
  assert.equal(removalForConnection(caller, link, native, source()), undefined);
  const secret: ModelResource = { ...input, kind: "secret" };
  const container = target("task:worker", "task", { secrets: [{ name: "TOKEN", resource: secret.id, display: "resources.input.value" }] });
  const startup = edge("secret", { from: container.ref, to: secret.id, label: "TOKEN" });
  const secretModel = model([startup], [container], { resources: [secret] });
  const indexed = source({ entities: { [container.ref]: { origin: 'tasks["worker"]', key: location, value: location } } });
  assert.equal(removalForConnection(container, startup, secretModel, indexed)?.variable, "TOKEN");
});

test("database and user-pool removal require literal evidence within the consumer declaration", () => {
  const setting = { field: "database" as const, value: true as const, source: { ...location, start: 20, end: 40 } };
  const link = edge("database", { permissionContext: { kind: "database", connection: "application", readers: false }, bindingSetting: setting });
  const built = model([link]);
  assert.equal(removalForConnection(target(), link, built, source())?.connection, "database");
  assert.equal(removalForConnection(target(), { ...link, bindingSetting: undefined }, built, source()), undefined);
  assert.equal(removalForConnection(target(), { ...link, bindingSetting: undefined, evidence: [{ role: "declared", location: setting.source, excerpt: "database: true" }] }, built, source()), undefined, "display excerpts do not prove editability");
  assert.equal(removalForConnection(target(), { ...link, bindingSetting: { ...setting, source: { ...setting.source, file: "shared.ts" } } }, built, source()), undefined);
  assert.equal(removalForConnection(target(), { ...link, permissionContext: { kind: "database", connection: "direct", readers: false } }, built, source()), undefined);
  const caller = target(undefined, undefined, { userPool: true, environment: [{ name: "USER_POOL_ID", via: "userPool", value: { kind: "reference", resource: "resource:cognito.userPoolId", display: "resources.cognito.userPoolId" } }] });
  const pool = edge("env", { to: "resource:cognito.userPoolId", label: "USER_POOL_ID", provenance: "derived", bindingSetting: { ...setting, field: "userPool" } });
  assert.equal(removalForConnection(caller, pool, model([pool], [caller]), source())?.connection, "userPool");
  assert.equal(removalForConnection({ ...caller, role: "tool" }, pool, model([pool], [caller]), source()), undefined);
});

test("destination presentation uses established framework service artwork", () => {
  const built = model([], [target("workflow:invoice", "workflow")]);
  assert.deepEqual(accessDestination("workflow:invoice", built), { id: "workflow:invoice", title: "invoice", icon: "workflow", subtitle: "Workflow" });
  assert.equal(accessDestination(bucket.id, built).icon, "bucket");
  assert.equal(accessDestination("missing", built).id, undefined);
});
