import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import type { TriggerBinding } from "../shared/triggers";
import { triggerUnavailable } from "../shared/trigger-availability";

const repository = path.resolve(__dirname, "../..");
let root: string, builder: SnapshotBuilder, edits: EditService;
let eventFile: string, stackFile: string;
const binding = (event = "first", operation = "preAuthentication", id = "before-auth"): TriggerBinding => ({ event, id, key: `identity.pool/${id}`, adapter: "cognito", resource: "resource:identity.pool", accepts: "cognito", options: { operation } });
before(async () => {
  const cache = path.join(repository, ".cache/framework-studio"); mkdirSync(cache, { recursive: true }); root = mkdtempSync(path.join(cache, "triggers-"));
  for (const directory of ["framework-config", "cdk-app/lib/framework", "cdk-app/bin", "node_modules/fixture-stack"]) mkdirSync(path.join(root, directory), { recursive: true });
  cpSync(path.join(repository, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "framework.config.ts"), 'import { defineFrameworkConfig } from "@repo/framework/config"; import { defaults } from "./framework-config/defaults"; import { resources } from "./framework-config/resources"; import { first } from "./framework-config/first"; import { second } from "./framework-config/second"; export default defineFrameworkConfig({ resources, defaults, http: [], webSocket: [], services: [], events: [first, second] });');
  writeFileSync(path.join(root, "framework-config/resources.ts"), 'import { defineResources, resource } from "@repo/framework/config"; import type * as Types from "../cdk-app/lib/barrel"; import type { Foreign } from "fixture-stack"; export const resources = defineResources({ identity: resource.stack<Types.Exported>(), foreign: resource.stack<Foreign>() });');
  stackFile = path.join(root, "cdk-app/lib/stacks.ts");
  writeFileSync(stackFile, `import { Stack } from "aws-cdk-lib";
import * as c from "aws-cdk-lib/aws-cognito";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { linkResources } from "./framework/framework-resources";
import { resources } from "../../framework-config/resources";
throw new Error("Stack source must never execute");
type PoolAlias = c.UserPool;
class UserPool extends Construct {}
export class Base extends Stack {
  public readonly pool: PoolAlias;
  public readonly imported: c.IUserPool;
  public readonly secret!: ISecret;
  public readonly text = "PRIVATE_SOURCE_SENTINEL";
  public readonly spoof!: UserPool;
  private internal!: c.UserPool;
  protected hidden!: c.UserPool;
  constructor(scope: Construct, id: string) { super(scope, id); this.pool = new c.UserPool(this, "Pool"); this.imported = c.UserPool.fromUserPoolId(this, "Imported", "us-east-1_fixture"); }
}
export class Derived extends Base { constructor(scope: Construct, id: string) { super(scope, id); linkResources(this, resources.identity); } }
`);
  writeFileSync(path.join(root, "cdk-app/lib/barrel.ts"), 'export { Derived as Exported } from "./stacks";');
  writeFileSync(path.join(root, "cdk-app/lib/framework/framework-resources.ts"), 'export function linkResources(scope: unknown, reference: unknown) {}');
  writeFileSync(path.join(root, "cdk-app/bin/main.ts"), 'import { App } from "aws-cdk-lib"; import { Derived } from "../lib/stacks"; import { Foreign } from "fixture-stack"; const app = new App(); new Derived(app, "Identity"); new Foreign(app, "Foreign");');
  writeFileSync(path.join(root, "cdk-app/cdk.json"), '{"app":"tsx bin/main.ts"}');
  writeFileSync(path.join(root, "node_modules/fixture-stack/package.json"), '{"name":"fixture-stack","types":"index.d.ts"}');
  writeFileSync(path.join(root, "node_modules/fixture-stack/index.d.ts"), 'import { Stack } from "aws-cdk-lib"; import { UserPool } from "aws-cdk-lib/aws-cognito"; export declare class Foreign extends Stack { public readonly pool: UserPool; }');
  eventFile = path.join(root, "framework-config/first.ts");
  writeFileSync(eventFile, 'export const first = { first: { directory: "/lambda_functions/first" } } as const;\n');
  writeFileSync(path.join(root, "framework-config/second.ts"), 'export const second = { second: { directory: "/lambda_functions/second" } } as const;\n');
  builder = new SnapshotBuilder(root); edits = new EditService(root, builder); await builder.refresh();
});
after(async () => { await builder?.dispose(); assert.ok(root.startsWith(path.join(repository, ".cache/framework-studio") + path.sep)); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test("semantic discovery resolves namespace reexports, aliases, inherited and third-party fields without execution", () => {
  const snapshot = builder.current!.snapshot;
  const capabilities = snapshot.source.triggerCapabilities!;
  assert.ok(capabilities.find((item) => item.resource === "resource:identity.pool")?.adapters.some((item) => item.kind === "cognito" && !item.reason));
  assert.ok(capabilities.find((item) => item.resource === "resource:foreign.pool")?.adapters.some((item) => item.kind === "cognito"));
  assert.match(triggerUnavailable(snapshot, "resource:identity.imported", "cognito")!, /Imported or immutable/);
  assert.ok(!capabilities.some((item) => ["secret", "text", "internal", "hidden", "region"].includes(item.name)));
  assert.equal(capabilities.find((item) => item.name === "spoof")?.adapters.length, 0, "a local class with a CDK-looking name is not a capability");
  assert.ok(!JSON.stringify(capabilities).includes("PRIVATE_SOURCE_SENTINEL"));
  assert.equal(triggerUnavailable(snapshot, "resource:identity.pool", "cognito"), undefined);
});

test("trigger additions, multi-file reassignment and removals preview both graphs and undo exact bytes", async () => {
  const originalFirst = readFileSync(eventFile, "utf8"), secondFile = path.join(root, "framework-config/second.ts"), originalSecond = readFileSync(secondFile, "utf8");
  const plan = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [binding()] }], builder.current!.snapshot.revision);
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(readFileSync(eventFile, "utf8"), originalFirst, "preview is offline");
  assert.ok(plan.impact.some((line) => line.includes("Handler contract acknowledged")));
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  for (const model of Object.values(builder.current!.snapshot.models)) assert.ok(model.edges.some((edge) => edge.relation === "trigger" && edge.to === "lambda:first" && edge.provenance === "declared"));
  const firstApplied = readFileSync(eventFile, "utf8");
  const move = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [] }, { kind: "triggers", event: "second", bindings: [binding("second")] }], builder.current!.snapshot.revision);
  assert.equal(move.ok, true, JSON.stringify(move.preflight));
  assert.equal(move.changes.length, 2);
  assert.equal((await edits.applyBatch(move.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.triggers?.[0]?.event, "second");
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(eventFile, "utf8"), firstApplied); assert.equal(readFileSync(secondFile, "utf8"), originalSecond);
  assert.equal((await edits.undo()).status, "applied");
  assert.equal(readFileSync(eventFile, "utf8"), originalFirst);
  assert.equal((await edits.redo()).status, "applied");
  const remove = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [] }], builder.current!.snapshot.revision);
  assert.equal((await edits.applyBatch(remove.planId)).status, "applied");
  assert.equal(builder.current!.snapshot.models.dev.triggers?.length, 0);
  await edits.undo(); await edits.undo();
});

test("duplicate slots, stale CDK source, unknown types and manual ownership cannot be applied", async () => {
  const duplicate = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [binding(), binding("first", "preAuthentication", "different-id")] }], builder.current!.snapshot.revision);
  assert.equal(duplicate.ok, false);
  await assert.rejects(edits.applyBatch(duplicate.planId), /rejected/);
  const before = readFileSync(stackFile, "utf8");
  const plan = await edits.planBatch([{ kind: "triggers", event: "first", bindings: [binding()] }], builder.current!.snapshot.revision);
  writeFileSync(stackFile, `${before}\n// concurrent source edit\n`);
  await assert.rejects(edits.applyBatch(plan.planId), /source changed/);
  writeFileSync(stackFile, before); await builder.refresh();
  await assert.rejects(edits.planBatch([{ kind: "triggers", event: "first", bindings: [{ ...binding(), resource: "resource:identity.spoof" }] }], builder.current!.snapshot.revision), /Unknown public type/);
  const snapshot = builder.current!.snapshot;
  assert.match(triggerUnavailable({ ...snapshot, source: { ...snapshot.source, cdkLinks: { ...snapshot.source.cdkLinks, manualWiring: [{ resource: "resource:identity.pool", source: snapshot.source.entities["resource:identity.pool"]!.key, reason: "Manual wiring, review required" }] } } }, "resource:identity.pool", "cognito")!, /Manual wiring/);
});
