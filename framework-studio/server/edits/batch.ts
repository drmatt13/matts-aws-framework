import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { locateConfigSource } from "../../../packages/framework/scripts/config-source";
import type { ApplyResponse, BatchPlanResponse, DraftEdit } from "../../shared/api";
import type { ModeModel } from "../../shared/model";
import { EvaluatorPool } from "../evaluator/pool";
import { assertWritable, hashEditableFiles, sha256, toRelative } from "../files";
import type { SnapshotBuilder, StudioState } from "../snapshot";
import { SourceFiles } from "../source";
import { fieldById } from "./fields";
import { EditError, writeAtomically } from "./io";
import { diffOf, planEdit } from "./plan";
import { formatLiteral } from "./splice";
import type { RouteChange } from "./route";

interface Change { readonly file: string; readonly before: string; readonly after: string }
export interface BatchJournal {
  readonly kind: "batch";
  readonly label: string;
  readonly changes: readonly Change[];
  readonly edits: readonly DraftEdit[];
  readonly routes: readonly RouteChange[];
}
interface StoredBatch extends BatchJournal { readonly response: BatchPlanResponse; readonly revision: string; readonly hashes: Record<string, string> }
const identity = (model: ModeModel) => JSON.stringify(model.targets.map((target) => [target.ref, target.constructId]).sort((a, b) => a[0]!.localeCompare(b[0]!)));

/** Composes the existing literal splices in memory, then validates the final source once.
 * Its journal is owned by EditService, alongside the existing single-edit journal. */
export class BatchEditor {
  private readonly plans = new Map<string, StoredBatch>();
  constructor(private readonly root: string, private readonly builder: SnapshotBuilder, private readonly ownWrites: Map<string, string>) {}
  expirePlans(): void { this.plans.clear(); }
  private state(): StudioState {
    if (!this.builder.current) throw new EditError(503, "The configuration has not loaded yet.");
    return this.builder.current;
  }
  private unchanged(revision: string, hashes: Record<string, string>): void {
    if (this.state().snapshot.revision !== revision || JSON.stringify(hashEditableFiles(this.root)) !== JSON.stringify(hashes)) throw new EditError(409, "Source files changed during this editing session. Your draft is preserved; discard it to load the latest configuration.");
  }
  async plan(edits: readonly DraftEdit[], revision: string): Promise<BatchPlanResponse> {
    const state = this.state();
    const hashes = hashEditableFiles(this.root);
    this.unchanged(revision, state.snapshot.files);
    if (!edits.length || edits.length > 100) throw new EditError(400, "Review between 1 and 100 setting changes together.");
    if (Object.values(state.snapshot.models).some((model) => model.stale || model.status === "error")) throw new EditError(422, "Fix configuration errors before reviewing changes.");
    const model = state.snapshot.models[state.snapshot.currentMode];
    const overrides = new Map<string, string>();
    const seen = new Set<string>();
    const summaries: string[] = [];
    for (const edit of edits) {
      const key = edit.kind === "field" ? `${edit.intent.target}:${edit.intent.field}` : edit.route;
      if (seen.has(key)) throw new EditError(400, "A draft can change each setting only once.");
      seen.add(key);
      if (edit.kind !== "field") continue;
      const { intent } = edit;
      const field = fieldById(intent.field);
      const fact = model.fields[intent.target]?.find((fact) => fact.field === intent.field);
      const origin = model.defaults?.find((group) => group.ref === intent.target)?.origin ?? model.targets.find((target) => target.ref === intent.target)?.origins[0];
      if (!field || !fact || !origin) throw new EditError(404, `${intent.target} has no editable setting ${intent.field}.`);
      const result = planEdit({ repositoryRoot: this.root, origin, field, fact, intent, files: new SourceFiles(overrides) });
      if ("refused" in result) throw new EditError(422, result.refused);
      assertWritable(this.root, result.planned.relativeFile);
      overrides.set(result.planned.file, result.planned.after);
      summaries.push(`${intent.target} — ${result.planned.summary}`);
    }
    // Rename all public keys together, after field splices, so aliases can swap paths
    // without rejecting a temporary duplicate or losing a preceding field edit.
    const files = new SourceFiles(overrides);
    const located = locateConfigSource(path.join(this.root, "framework.config.ts"), { repositoryRoot: this.root, host: files.host() });
    const replacements = new Map<string, { start: number; end: number; value: string }[]>();
    const routes: RouteChange[] = [];
    for (const edit of edits) {
      if (edit.kind !== "route") continue;
      const route = model.routes.find((route) => route.id === edit.route);
      if (!route || route.kind !== "http") throw new EditError(404, "Select an HTTP Lambda route.");
      if (!edit.value.startsWith("/") || edit.value.trim() !== edit.value || /[\r\n\0]/.test(edit.value)) throw new EditError(422, "A route must start with / and have no surrounding whitespace.");
      const entry = located.sections.http.find((entry) => entry.key === route.path);
      if (!entry) throw new EditError(422, "This route could not be located in source.");
      const quote = files.text(entry.file)[entry.keySpan.start];
      if (quote !== '"' && quote !== "'") throw new EditError(422, "Computed route keys must be edited in source.");
      const list = replacements.get(entry.file) ?? [];
      list.push({ start: entry.keySpan.start, end: entry.keySpan.end, value: formatLiteral(edit.value, quote) });
      replacements.set(entry.file, list);
      routes.push({ before: route.path, after: edit.value, target: route.target });
      summaries.push(`Route: ${route.path} → ${edit.value}`);
    }
    for (const [file, edits] of replacements) {
      assertWritable(this.root, toRelative(this.root, file));
      let text = files.text(file);
      for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
      overrides.set(file, text);
    }
    const changes = [...overrides].map(([file, after]) => ({ file, before: readFileSync(file, "utf8"), after })).filter((change) => change.before !== change.after);
    if (!changes.length) throw new EditError(422, "This draft has no source changes.");
    const checked = await this.validate(Object.fromEntries(overrides), state, routes);
    this.unchanged(revision, hashes);
    const response: BatchPlanResponse = {
      planId: randomUUID(), summaries,
      changes: changes.map(({ file, before, after }) => ({ file: toRelative(this.root, file), diff: diffOf(toRelative(this.root, file), before, after) })),
      preflight: checked.preflight, ok: checked.preflight.dev.ok && checked.preflight.prod.ok,
      impact: ["Applies this complete draft as one undoable change. Individual workload overrides remain in place when shared defaults change.",
        ...(routes.length ? ["Public route paths change; Lambda target and construct identities are preserved. Regenerate the API contract and update callers before deployment."] : []),
        "Compose Watch may restart local workloads after the source files are written. Deployment is a separate action."],
    };
    this.plans.set(response.planId, { kind: "batch", label: `${edits.length} inspector changes`, response, revision, hashes, changes, edits, routes });
    return response;
  }
  private async validate(overrides: Record<string, string>, state: StudioState, routes: readonly RouteChange[]) {
    const pool = new EvaluatorPool(this.root);
    try {
      const models = await pool.evaluate(state.snapshot.webSocketApi, overrides);
      const verdict = (model: ModeModel) => {
        const diagnostics = [...model.diagnostics];
        if (identity(model) !== identity(state.snapshot.models[model.mode])) diagnostics.push({ severity: "error", stage: "validate", message: "An inspector edit must preserve workload target and construct identities." });
        for (const route of routes) if (!model.routes.some((item) => item.kind === "http" && item.path === route.after && item.target === route.target)) diagnostics.push({ severity: "error", stage: "validate", message: `Route ${route.after} must still reach ${route.target}.` });
        return { mode: model.mode, ok: !diagnostics.some((item) => item.severity === "error"), diagnostics };
      };
      return { models, preflight: { dev: verdict(models.dev), prod: verdict(models.prod) } };
    } finally { await pool.dispose(); }
  }
  async apply(planId: string, record: (entry: BatchJournal) => void): Promise<ApplyResponse> {
    const plan = this.plans.get(planId);
    if (!plan) throw new EditError(410, "This review expired. Your draft is preserved; review it again.");
    if (!plan.response.ok) throw new EditError(422, "Fix the rejected settings before applying this draft.");
    this.unchanged(plan.revision, plan.hashes);
    return this.write(plan, false, () => record(plan));
  }
  replay(entry: BatchJournal, inverse: boolean, record: () => void): Promise<ApplyResponse> { return this.write(entry, inverse, record); }
  private async write(entry: BatchJournal, inverse: boolean, record: () => void): Promise<ApplyResponse> {
    const state = this.state();
    const hashes = hashEditableFiles(this.root);
    const changes = entry.changes.map((change) => inverse ? { ...change, before: change.after, after: change.before } : change);
    for (const change of changes) {
      assertWritable(this.root, toRelative(this.root, change.file));
      if (readFileSync(change.file, "utf8") !== change.before) throw new EditError(409, `${toRelative(this.root, change.file)} changed. Your draft is preserved; no files were written.`);
    }
    const routes = entry.routes.map((route) => inverse ? { ...route, before: route.after, after: route.before } : route);
    const checked = await this.validate(Object.fromEntries(changes.map((change) => [change.file, change.after])), state, routes);
    if (!checked.preflight.dev.ok || !checked.preflight.prod.ok) throw new EditError(422, "The complete draft no longer validates. Review the current configuration before trying again.");
    this.unchanged(state.snapshot.revision, hashes);
    const written: Change[] = [];
    try {
      for (const change of changes) {
        if (readFileSync(change.file, "utf8") !== change.before) throw new Error("A source file changed while applying the draft.");
        writeAtomically(this.root, change.file, change.after);
        written.push(change);
        this.ownWrites.set(toRelative(this.root, change.file), sha256(change.after));
      }
      const actual = await this.builder.refresh();
      for (const mode of ["dev", "prod"] as const) {
        const model = actual.snapshot.models[mode];
        const expected = checked.models[mode];
        if (model.stale || model.status === "error" || identity(model) !== identity(expected)) throw new Error(`The ${mode} configuration did not match the review.`);
        for (const edit of entry.edits) {
          if (edit.kind !== "field") continue;
          const field = (model: ModeModel) => model.fields[edit.intent.target]?.find((fact) => fact.field === edit.intent.field);
          if (JSON.stringify([field(model)?.authored, field(model)?.effective]) !== JSON.stringify([field(expected)?.authored, field(expected)?.effective])) throw new Error(`The setting ${edit.intent.field} did not match the review.`);
        }
        for (const route of routes) if (!model.routes.some((item) => item.path === route.after && item.target === route.target)) throw new Error("A route did not match the review.");
      }
      record(); this.expirePlans();
      return { status: "applied", message: `Applied all ${entry.edits.length} changes.`, revision: actual.snapshot.revision };
    } catch (error) {
      let conflicted = false;
      for (const change of written.reverse()) {
        if (readFileSync(change.file, "utf8") !== change.after) { conflicted = true; continue; }
        writeAtomically(this.root, change.file, change.before);
        this.ownWrites.set(toRelative(this.root, change.file), sha256(change.before));
      }
      const actual = await this.builder.refresh(); this.expirePlans();
      return { status: conflicted ? "unconfirmed" : "reverted", message: `${error instanceof Error ? error.message : "The draft could not be applied."} ${conflicted ? "Concurrent edits were preserved; inspect the affected files." : "The source was restored."} Your draft is preserved.`, revision: actual.snapshot.revision };
    }
  }
}
