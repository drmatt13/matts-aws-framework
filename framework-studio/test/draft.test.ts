import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import type { BatchPlanResponse, DraftEdit } from "../shared/api";
import type { Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { InspectorDraft, initialResourceForm, protectBeforeUnload, type DraftTransport } from "../src/draft";

let builder: SnapshotBuilder;
let baseline: Snapshot;
before(async () => { builder = new SnapshotBuilder(path.resolve(__dirname, "../..")); baseline = (await builder.refresh()).snapshot; });
after(() => builder.dispose());
const target = "lambda:graphql-api";
const verdict = (mode: "dev" | "prod") => ({ mode, ok: true, diagnostics: [] });
function fixture() {
  const requests: (readonly DraftEdit[])[] = [];
  let resourceRequests = 0;
  let applies = 0;
  const transport: DraftTransport = {
    planBatch: async (edits) => { requests.push(edits); return { planId: "review", ok: true, summaries: edits.map((edit) => edit.kind === "tags" ? `tags ${edit.entity}` : edit.kind === "removeNetwork" ? `remove ${edit.network}` : edit.kind === "databasePlacement" ? `database placement ${edit.database}` : edit.kind === "database" ? `database ${edit.database}` : edit.kind === "placement" ? `placement ${edit.target}` : edit.kind === "network" ? `network ${edit.network}` : edit.kind === "create" ? "create resource" : edit.kind === "clientEnvironment" ? "client mappings" : edit.kind === "field" ? edit.intent.field : edit.kind === "description" ? edit.entity : edit.kind === "triggers" ? edit.event : edit.kind === "nativeTrigger" ? edit.edge : edit.kind === "onFailure" ? edit.event : edit.route), changes: [{ file: "settings.ts", diff: { unified: "combined diff", lines: [] } }], preflight: { dev: verdict("dev"), prod: verdict("prod") }, impact: [] }; },
    resourcePlan: async (intent) => { resourceRequests++; return { planId: "resource-review", ok: true, resource: intent.resource, nextResource: intent.resource, changes: [], diagnostics: [] }; },
    applyBatch: async () => { applies++; return { status: "applied", revision: "saved", message: "Applied all changes." }; },
    resourceApply: async () => { applies++; return { status: "applied", resource: "resource:updated", revision: "saved", message: "Applied resource changes.", history: {} }; },
    inputPlan: async (_mode, edits) => ({ planId: "input-review", ok: true, summaries: edits.map((edit) => edit.name), changes: [] }),
    inputApply: async () => { applies++; return { status: "applied", revision: "saved", message: "Saved inputs." }; },
    snapshot: async () => ({ ...baseline, revision: "saved" }),
  };
  const draft = new InspectorDraft(baseline, target, "dev", transport);
  const fact = (field: string) => baseline.models.dev.fields[target].find((fact) => fact.field === field)!;
  const change = () => draft.setField(target, fact("lambda.memorySize"), 768);
  return { draft, fact, change, requests, transport, resourceRequests: () => resourceRequests, applies: () => applies };
}

test("staging a toggle never opens a review or calls the preview API", () => {
  const { draft, fact, requests } = fixture();
  const minify = fact("lambda.bundling.minify");
  draft.setField(target, minify, false);
  assert.equal(draft.effective(target, minify), false);
  assert.equal(draft.count, 1);
  assert.equal(draft.getSnapshot().review, undefined);
  assert.equal(requests.length, 0);
});

test("client mapping drafts preserve the other environment, clear reverted toggles and guard navigation", async () => {
  const { draft, requests } = fixture();
  const baseline = draft.clientMappings();
  const next = { ...baseline, VITE_LOCAL_WS_URL: { ...baseline.VITE_LOCAL_WS_URL!, dev: { ...baseline.VITE_LOCAL_WS_URL!.dev, enabled: false } } };
  draft.setClientMappings(next);
  assert.equal(draft.count, 1);
  let navigated = false;
  draft.requestNavigation(() => { navigated = true; });
  assert.equal(navigated, false);
  draft.keepEditing();
  await draft.review();
  assert.equal(requests[0]![0]!.kind, "clientEnvironment");
  assert.deepEqual(draft.clientMappings().VITE_LOCAL_WS_URL!.prod, baseline.VITE_LOCAL_WS_URL!.prod);
  draft.backToEditing();
  draft.setClientMappings(baseline);
  assert.equal(draft.dirty, false);
});
test("five controls produce one complete review; backing out preserves the whole draft", async () => {
  const { draft, fact, requests } = fixture();
  for (const [field, value] of [["lambda.memorySize", 768], ["lambda.timeoutSeconds", 25], ["lambda.architecture", "x86_64"], ["lambda.logRetentionDays", 14], ["lambda.bundling.minify", false]] as const) draft.setField(target, fact(field), value);
  await draft.review();
  assert.equal(draft.count, 5);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].length, 5);
  assert.equal(draft.getSnapshot().review?.plan.changes.length, 1);
  draft.backToEditing();
  assert.equal(draft.count, 5);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
});
test("reverting fields and editing the same field through another control leaves no false dirty state", () => {
  const { draft, fact } = fixture();
  const memory = fact("lambda.memorySize");
  draft.setField(target, memory, 768);
  draft.setField(target, memory, "1024");
  assert.equal(draft.count, 1);
  assert.equal(draft.effective(target, memory), 1024);
  draft.setField(target, memory, memory.authored!);
  assert.equal(draft.dirty, false);
  const minify = fact("lambda.bundling.minify");
  draft.setField(target, minify, false);
  draft.setField(target, minify, minify.authored ?? undefined);
  assert.equal(draft.dirty, false);
});

test("flipping an inherited switch twice restores inheritance without leaving an override", () => {
  const { draft } = fixture();
  const parent = baseline.models.dev.fields["defaults:lambda"].find((fact) => fact.field === "defaults.lambda.bundling.minify")!;
  const child = baseline.models.dev.fields["defaults:http"].find((fact) => fact.field === "defaults.http.bundling.minify")!;
  assert.equal(child.authored, undefined);
  draft.toggleField("defaults:http", child); draft.toggleField("defaults:http", child);
  assert.equal(draft.dirty, false);
  draft.setField("defaults:lambda", parent, false);
  draft.toggleField("defaults:http", child);
  assert.equal(draft.effective("defaults:http", child), true);
  assert.equal(draft.count, 2);
});
test("switching nodes is guarded; Keep Editing preserves all values", () => {
  const { draft, change, fact } = fixture(); let navigated = false; let cancelled = false;
  change(); draft.setField(target, fact("lambda.timeoutSeconds"), 25);
  draft.requestNavigation(() => { navigated = true; }, () => { cancelled = true; });
  assert.equal(draft.getSnapshot().pendingNavigation, true);
  assert.equal(navigated, false);
  draft.keepEditing();
  assert.equal(cancelled, true);
  assert.equal(draft.count, 2);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
});
test("Discard and Continue completes the originally requested navigation", () => {
  const { draft, change } = fixture(); let destination = "A";
  change(); draft.requestNavigation(() => { destination = "B"; });
  draft.discardAndContinue();
  assert.equal(destination, "B"); assert.equal(draft.dirty, false); assert.equal(draft.getSnapshot().pendingNavigation, false);
});
test("Review Changes from the leave warning cancels navigation and reviews every pending edit", async () => {
  const { draft, change, fact, requests } = fixture(); let navigated = false;
  change(); draft.setField(target, fact("lambda.timeoutSeconds"), 25);
  draft.requestNavigation(() => { navigated = true; }); await draft.review();
  assert.equal(navigated, false); assert.equal(draft.getSnapshot().pendingNavigation, false);
  assert.equal(requests[0].length, 2); assert.equal(draft.count, 2); assert.ok(draft.getSnapshot().review);
});
test("Apply All uses one request, updates the baseline and permits navigation", async () => {
  const { draft, change, applies } = fixture(); change(); await draft.review(); await draft.apply();
  assert.equal(applies(), 1); assert.equal(draft.dirty, false); assert.equal(draft.getSnapshot().baseline.revision, "saved");
  let left = false; draft.requestNavigation(() => { left = true; }); assert.equal(left, true);
});
test("invalid numeric values stay inline and prevent review without losing valid edits", async () => {
  const { draft, fact, requests } = fixture();
  draft.setField(target, fact("lambda.memorySize"), "12"); draft.setField(target, fact("lambda.timeoutSeconds"), 25);
  assert.equal(draft.invalid, true); assert.match(draft.field(target, fact("lambda.memorySize"))!.error!, /whole number/);
  await draft.review(); assert.equal(requests.length, 0); assert.equal(draft.count, 2);
  draft.setField(target, fact("lambda.memorySize"), 768); await draft.review(); assert.equal(requests[0].length, 2);
});
test("framework-rejected combinations cannot be applied", async () => {
  const { draft, change, transport, applies } = fixture();
  const plan = transport.planBatch;
  transport.planBatch = async (...args) => ({ ...await plan(...args), ok: false } satisfies BatchPlanResponse);
  change(); await draft.review(); await draft.apply();
  assert.equal(applies(), 0); assert.equal(draft.count, 1);
});
test("a failed apply preserves every draft value and reports an actionable error", async () => {
  const { draft, change, fact, transport } = fixture(); change(); draft.setField(target, fact("lambda.timeoutSeconds"), 25);
  transport.applyBatch = async () => { throw new Error("The source changed. Review it again."); };
  await draft.review(); await draft.apply();
  assert.equal(draft.count, 2); assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
  assert.match(draft.getSnapshot().error!, /source changed/); assert.equal(draft.getSnapshot().review, undefined);
});
test("native browser-exit protection only cancels an exit with unsaved changes", () => {
  const { draft, change } = fixture();
  const exit = () => { let prevented = false; const event = { preventDefault: () => { prevented = true; }, returnValue: "original" }; protectBeforeUnload(event, draft.dirty); return { prevented, returnValue: event.returnValue }; };
  assert.equal(exit().prevented, false); change(); assert.deepEqual(exit(), { prevented: true, returnValue: "" }); draft.discard(); assert.equal(exit().prevented, false);
});
test("external source updates preserve the baseline and draft and block stale review/apply", async () => {
  const { draft, change, requests, fact } = fixture(); change();
  draft.sync({ ...baseline, revision: "external" }, target, "dev");
  assert.equal(draft.conflict, true); assert.equal(draft.getSnapshot().baseline, baseline);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
  await draft.review(); assert.equal(requests.length, 0);
  draft.discard(); assert.equal(draft.getSnapshot().baseline.revision, "external");
});
test("island default groups share a draft and inherited switches reflect staged parent defaults", () => {
  const { draft } = fixture();
  const all = baseline.models.dev.fields["defaults:lambda"].find((fact) => fact.field === "defaults.lambda.bundling.minify")!;
  const http = baseline.models.dev.fields["defaults:http"].find((fact) => fact.field === "defaults.http.bundling.minify")!;
  draft.setField("defaults:lambda", all, false);
  assert.equal(draft.effective("defaults:http", http), false);
  draft.setField("defaults:http", http, true); assert.equal(draft.count, 2);
  draft.setField("defaults:http", http, undefined); assert.equal(draft.count, 1); assert.equal(draft.effective("defaults:http", http), false);
});
test("resource fields use the same review and navigation session with meaningful dirty counts", async () => {
  const { draft, resourceRequests } = fixture();
  const resource = baseline.models.dev.resources.find((resource) => resource.kind === "input" && !resource.absent)!;
  const form = initialResourceForm(resource);
  draft.setResource(resource, { ...form, group: "draftGroup", secret: true });
  assert.ok(draft.count >= 2); assert.equal(resourceRequests(), 0);
  let left = false; draft.requestNavigation(() => { left = true; }); draft.keepEditing(); assert.equal(left, false);
  await draft.review(); assert.equal(resourceRequests(), 1); assert.equal(draft.getSnapshot().review?.kind, "resource");
  draft.backToEditing(); assert.equal(draft.resourceForm(resource).group, "draftGroup");
  draft.setResource(resource, form); assert.equal(draft.dirty, false);
});
test("a delayed preview cannot reopen after a discard or a newer edit", async () => {
  const { draft, change, transport } = fixture();
  const plan = transport.planBatch; let resolve!: () => void;
  transport.planBatch = async (...args) => { await new Promise<void>((done) => { resolve = done; }); return plan(...args); };
  change(); const pending = draft.review(); draft.discard(); resolve(); await pending;
  assert.equal(draft.dirty, false); assert.equal(draft.getSnapshot().review, undefined);
});

test("Back to Editing cancels a pending review without losing the draft or reopening later", async () => {
  const { draft, change, transport } = fixture();
  const plan = transport.planBatch; let finish!: () => void;
  transport.planBatch = async (...args) => { await new Promise<void>((resolve) => { finish = resolve; }); return plan(...args); };
  change(); const pending = draft.review();
  assert.equal(draft.getSnapshot().reviewOpen, true);
  assert.equal(draft.getSnapshot().busy, "review");
  draft.backToEditing(); finish(); await pending;
  assert.equal(draft.getSnapshot().reviewOpen, false);
  assert.equal(draft.getSnapshot().review, undefined);
  assert.equal(draft.getSnapshot().busy, undefined);
  assert.equal(draft.count, 1);
});
