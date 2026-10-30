import assert from "./support/assert";
import path from "node:path";
import { after, before, test } from "node:test";
import type { BatchPlanResponse, CommentReviewOptions, DraftEdit } from "../shared/api";
import type { Snapshot } from "../shared/model";
import { SnapshotBuilder } from "../server/snapshot";
import { InspectorDraft, initialResourceForm, protectBeforeUnload, type DraftTransport } from "../src/draft";
import { clientBindingFor } from "../shared/client-environment";

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
    planBatch: async (edits) => { requests.push(edits); resourceRequests += edits.filter(edit => edit.kind === "resourceConfig").length; return { planId: "review", ok: true, summaries: edits.map((edit) => edit.kind === "implementation" || edit.kind === "connection" || edit.kind === "removeWorkload" || edit.kind === "identityPolicy" ? `${edit.kind} ${edit.target}` : edit.kind === "tags" ? `tags ${edit.entity}` : edit.kind === "removeNetwork" ? `remove ${edit.network}` : edit.kind === "databasePlacement" ? `database placement ${edit.database}` : edit.kind === "database" ? `database ${edit.database}` : edit.kind === "placement" ? `placement ${edit.target}` : edit.kind === "network" ? `network ${edit.network}` : edit.kind === "create" ? "create resource" : edit.kind === "clientEnvironment" ? "client mappings" : edit.kind === "field" ? edit.intent.field : edit.kind === "description" || edit.kind === "rename" || edit.kind === "displayName" ? edit.entity : edit.kind === "resourceConfig" ? edit.intent.resource : edit.kind === "triggers" ? edit.event : edit.kind === "nativeTrigger" ? edit.edge : edit.kind === "onFailure" ? edit.event : edit.kind === "deploy" ? edit.target : edit.route), changes: [{ file: "settings.ts", diff: { unified: "combined diff", lines: [] } }], preflight: { dev: verdict("dev"), prod: verdict("prod") }, impact: [] }; },
    applyBatch: async () => { applies++; return { status: "applied", revision: "saved", message: "Applied all changes." }; },
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

test("client mapping drafts preserve untouched fields, clear reverted edits and guard navigation", async () => {
  const { draft, requests } = fixture();
  const baseline = draft.clientMappings();
  const next = { ...baseline, VITE_LOCAL_WS_URL: { dev: clientBindingFor(baseline.VITE_LOCAL_WS_URL!, "dev"), prod: { kind: "empty" as const } } };
  draft.setClientMappings(next);
  assert.equal(draft.count, 1);
  let navigated = false;
  draft.requestNavigation(() => { navigated = true; });
  assert.equal(navigated, false);
  draft.keepEditing();
  await draft.review();
  assert.equal(requests[0]![0]!.kind, "clientEnvironment");
  assert.deepEqual(draft.clientMappings().VITE_USER_POOL_ID, baseline.VITE_USER_POOL_ID);
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
test("an in-flight apply owns an immutable draft until it finishes", async () => {
  const { draft, change, fact, transport } = fixture();
  const apply = transport.applyBatch;
  let finish!: () => void;
  transport.applyBatch = async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return apply(...args); };
  change(); await draft.review();
  const pending = draft.apply();
  const applying = draft.getSnapshot();
  draft.setField(target, fact("lambda.memorySize"), 1536);
  draft.discard();
  draft.discardAndContinue();
  assert.equal(draft.getSnapshot(), applying, "editing and discard cannot invalidate an accepted source write");
  assert.equal(draft.getSnapshot().busy, "apply");
  let navigated = false;
  draft.requestNavigation(() => { navigated = true; });
  assert.equal(navigated, false);
  finish(); await pending;
  assert.equal(draft.dirty, false);
  assert.equal(draft.getSnapshot().baseline.revision, "saved");
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
test("explicit review against latest source preserves typed operations and replans once", async () => {
  const { draft, change, requests, fact } = fixture(); change();
  draft.stageOperation({ kind: "implementation", target });
  draft.sync({ ...baseline, revision: "external" }, target, "dev");
  draft.reviewAgainstLatest();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(draft.conflict, false);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
  assert.equal(requests.length, 1); assert.equal(requests[0]!.length, 2);
  assert.equal(draft.getSnapshot().review?.kind, "batch");
});
test("distinct variable and scoped grant operations retain separate draft entries", () => {
  const { draft } = fixture();
  for (const variable of ["FIRST", "SECOND"]) draft.stageOperation({ kind: "connection", target, connection: "resource", destination: "resource:openaiApiKey", variable, enabled: true });
  for (const scope of ["uploads/*", "reports/*"]) draft.stageOperation({ kind: "connection", target, connection: "grant", destination: "resource:uploads.bucket", grant: "grantRead", scope, enabled: true });
  assert.equal(draft.count, 4);
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
  const resource = baseline.models.dev.resources.find((resource) => resource.kind === "input" && resource.fromEnv && !resource.absent)!;
  const form = initialResourceForm(resource);
  draft.setResource(resource, { ...form, group: "draftGroup", secret: true });
  assert.ok(draft.count >= 2); assert.equal(resourceRequests(), 0);
  let left = false; draft.requestNavigation(() => { left = true; }); draft.keepEditing(); assert.equal(left, false);
  await draft.review(); assert.equal(resourceRequests(), 1); assert.equal(draft.getSnapshot().review?.kind, "batch");
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

const sourceComment = {
  id: "comment-memory", file: "framework-config/workloads/http.ts", line: 12, column: 3,
  text: "// Keep additional capacity during the migration.", resolution: "keep" as const,
  vscodeUrl: "vscode://file/workspace/framework-config/workloads/http.ts:12:3",
};
const settleReview = () => new Promise<void>(resolve => setImmediate(resolve));

test("comment choices replan the complete draft and prevent applying the previous preview", async () => {
  const { draft, change, transport, applies } = fixture();
  const requests: (CommentReviewOptions | undefined)[] = [];
  const plan = transport.planBatch;
  let finish: (() => void) | undefined;
  transport.planBatch = async (edits, revision, options) => {
    requests.push(options);
    const response = await plan(edits, revision, options);
    if (requests.length === 2) await new Promise<void>(resolve => { finish = resolve; });
    return { ...response, comments: [{ ...sourceComment, resolution: options?.comments?.[sourceComment.id] ?? "keep" }] };
  };
  change(); await draft.review();
  const initial = draft.getSnapshot().review;
  assert.ok(initial?.kind === "batch");
  assert.equal(initial.plan.comments?.[0]?.resolution, "keep");
  draft.setCommentResolution(sourceComment.id, "remove");
  await settleReview();
  assert.equal(draft.getSnapshot().busy, "review");
  await draft.apply(); assert.equal(applies(), 0, "a comment choice invalidates the previously accepted bytes");
  assert.deepEqual(requests[1]?.comments, { [sourceComment.id]: "remove" });
  finish!(); await settleReview();
  const removed = draft.getSnapshot().review;
  assert.ok(removed?.kind === "batch");
  assert.equal(removed.plan.comments?.[0]?.resolution, "remove");
  draft.setCommentResolution(sourceComment.id, "keep"); await settleReview();
  const kept = draft.getSnapshot().review;
  assert.ok(kept?.kind === "batch");
  assert.equal(kept.plan.comments?.[0]?.resolution, "keep");
  assert.equal(draft.count, 1, "comment handling belongs to the original source edit");
});

test("leaving a pending comment preview keeps typed values and ignores the late response", async () => {
  const { draft, change, fact, transport } = fixture();
  const plan = transport.planBatch;
  let finish!: () => void;
  let calls = 0;
  transport.planBatch = async (...args) => {
    const response = await plan(...args);
    if (++calls === 2) await new Promise<void>(resolve => { finish = resolve; });
    return { ...response, comments: [sourceComment] };
  };
  change(); await draft.review();
  draft.setCommentResolution(sourceComment.id, "remove"); await settleReview();
  draft.backToEditing(); finish(); await settleReview();
  assert.equal(draft.getSnapshot().reviewOpen, false);
  assert.equal(draft.getSnapshot().review, undefined);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
});

test("manual source retry fetches the current revision and keeps every typed edit", async () => {
  const { draft, change, fact, transport } = fixture();
  const plan = transport.planBatch;
  const revisions: string[] = [];
  const choices: (CommentReviewOptions | undefined)[] = [];
  let snapshots = 0;
  transport.planBatch = async (edits, revision, options) => {
    revisions.push(revision); choices.push(options);
    return { ...await plan(edits, revision, options), comments: [sourceComment] };
  };
  transport.snapshot = async () => { snapshots++; return { ...baseline, revision: "editor-saved" }; };
  change(); draft.setField(target, fact("lambda.timeoutSeconds"), 25); await draft.review();
  await draft.setCommentResolution(sourceComment.id, "remove");
  draft.sync({ ...baseline, revision: "editor-saved" }, target, "dev");
  await draft.refreshAndReview();
  assert.equal(snapshots, 1);
  assert.deepEqual(revisions, [baseline.revision, baseline.revision, "editor-saved"]);
  assert.deepEqual(choices[1]?.comments, { [sourceComment.id]: "remove" });
  assert.equal(choices[2], undefined, "editor changes reset comment deletion choices before the new review");
  assert.equal(draft.conflict, false);
  assert.equal(draft.getSnapshot().reviewOpen, true);
  assert.equal(draft.count, 2);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
  assert.equal(draft.value(target, fact("lambda.timeoutSeconds")), 25);
});

test("a failed source refresh preserves the draft and reports the error inside review", async () => {
  const { draft, change, fact, transport, applies } = fixture();
  change(); await draft.review();
  transport.snapshot = async () => { throw new Error("Studio could not reload source. Try again."); };
  await draft.refreshAndReview();
  assert.equal(draft.getSnapshot().baseline.revision, baseline.revision);
  assert.equal(draft.getSnapshot().reviewOpen, true);
  assert.match(draft.getSnapshot().error!, /could not reload source/);
  assert.equal(draft.value(target, fact("lambda.memorySize")), 768);
  await draft.apply(); assert.equal(applies(), 0, "a failed refresh must not leave the old review applicable");
});

test("comment choices cannot bypass source conflicts or compiler-directive resolution", async () => {
  const { draft, change, transport, requests, applies } = fixture();
  const plan = transport.planBatch;
  transport.planBatch = async (...args) => ({ ...await plan(...args), ok: false, comments: [{ ...sourceComment, manualReason: "Resolve this compiler directive in your editor." }] });
  change(); await draft.review();
  await draft.setCommentResolution(sourceComment.id, "remove");
  await draft.setCommentResolution("unrecognized-comment", "remove");
  assert.equal(requests.length, 1, "only ordinary comments in the accepted preview can be toggled");
  draft.sync({ ...baseline, revision: "external-edit" }, target, "dev");
  await draft.setCommentResolution(sourceComment.id, "keep");
  await draft.apply();
  assert.equal(requests.length, 1);
  assert.equal(applies(), 0);
});

test("code and display naming compose with input configuration, tags and description in one batch", async () => {
  const { draft, requests } = fixture();
  const entity = "resource:enableWebSocketApi";
  const resource = baseline.models.dev.resources.find(item => item.id === entity)!;
  draft.sync(baseline, entity, "dev");
  draft.setCodeName(entity, "allowWebSockets");
  draft.setDisplayName(entity, "WebSocket feature");
  draft.setDescription(entity, "Controls WebSocket deployment.");
  draft.changeTags(entity, { feature: "websockets" });
  const form = initialResourceForm(resource);
  draft.setResource(resource, { ...form, modes: { ...form.modes, dev: { ...form.modes.dev, value: "false" } } });
  assert.equal(draft.invalid, false);
  assert.equal(draft.codeName(entity), "allowWebSockets");
  assert.equal(draft.getSnapshot().baseline.models.dev.resources.find(item => item.id === entity)?.path.at(-1), "enableWebSocketApi");
  await draft.review();
  assert.deepEqual(requests[0].map(edit => edit.kind), ["rename", "displayName", "description", "tags", "resourceConfig"]);
});

test("canceling one rename restores its opening draft while preserving other staged settings", () => {
  const { draft } = fixture();
  const entity = "resource:enableWebSocketApi";
  draft.setCodeName(entity, "allowWebSockets");
  const checkpoint = [...draft.nameEntries(entity)];
  draft.setCodeName(entity, "anotherName");
  draft.setDisplayName(entity, "Another label");
  draft.setDescription(entity, "Keep this edit.");
  draft.restoreNameEntries(entity, checkpoint);
  assert.equal(draft.codeName(entity), "allowWebSockets");
  assert.equal(draft.displayName(entity), "");
  assert.equal(draft.description(entity), "Keep this edit.");
  assert.equal(draft.count, 2);
});

test("name validation catches collisions and multiple renames while display-only owners stay protected", async () => {
  const { draft, requests } = fixture();
  const entity = "resource:enableWebSocketApi";
  draft.setCodeName(entity, "bad name");
  assert.ok(draft.nameEntries(entity).some(entry => entry.error));
  await draft.review(); assert.equal(requests.length, 0);
  for (const invalid of ["enabled_flag", "$enabled", "_enabled", "1enabled"]) {
    draft.setCodeName(entity, invalid);
    assert.match(draft.nameEntries(entity)[0]!.error!, /only letters and digits/, invalid);
  }
  draft.setCodeName(entity, "class");
  assert.match(draft.nameEntries(entity)[0]!.error!, /reserved TypeScript identifier/);
  draft.setCodeName(entity, "allowWebSockets");
  const other = Object.entries(baseline.namingCapabilities!).find(([id, capability]) => id !== entity && capability.code)!;
  draft.setCodeName(other[0], "otherName");
  assert.match(draft.nameEntries(other[0])[0]!.error!, /one code rename/);
  draft.discard();
  draft.setCodeName("lambda:graphql-api", "api");
  assert.equal(draft.dirty, false);
  draft.setDisplayName("lambda:graphql-api", "x".repeat(121));
  assert.match(draft.nameEntries("lambda:graphql-api")[0]!.error!, /120/);
});
