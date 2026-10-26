import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApplyResponse, DraftEdit, PlanResponse, PreflightResult } from "../../shared/api";
import type { FieldFact, Lanes, ModelTarget, Placement } from "../../shared/model";
import { assertWritable, sha256 } from "../files";
import { EditError, writeAtomically, writeSourceChange } from "./io";
export { EditError, writeAtomically } from "./io";
import type { SnapshotBuilder, StudioState } from "../snapshot";
import { fieldById } from "./fields";
import { planEdit, type EditIntent } from "./plan";
import { planHttpRoute, validateHttpRoute, type RouteChange } from "./route";
import { BatchEditor } from "./batch";
import { SourceJournal } from "./journal";

/**
 * Plans and writes field edits — one at a time, and never over a
 * change somebody else made.
 *
 * A plan remembers the hash of the file it was computed against and the
 * snapshot revision it was offered from. Applying it checks both again: a file
 * edited in the meantime, or any refresh of the snapshot, expires the plan
 * rather than letting it overwrite. After the write the repository is evaluated
 * again from disk, and the field must resolve to what preflight predicted; if
 * it does not, the write is undone while the file still holds exactly what was
 * written.
 */

export type { ApplyResponse, PlanResponse };

type EditMeaning = { readonly kind: "field" } | { readonly kind: "route"; readonly change: RouteChange };

interface StoredPlan {
  readonly batchPlanId?: string;
  readonly response: PlanResponse;
  readonly revision: string;
  readonly file: string;
  readonly relativeFile: string;
  readonly beforeHash: string;
  readonly after: string;
  readonly afterHash: string;
  readonly edit: EditMeaning;
}

interface WrittenEdit {
  readonly target: string;
  readonly field: string;
  readonly file: string;
  readonly relativeFile: string;
  readonly before: string;
  readonly after: string;
  readonly edit: EditMeaning;
}


function impactOf(target: ModelTarget, fieldId: string, after: PreflightResult): string[] {
  const notes: string[] = [];
  if (fieldId === "http.auth") notes.push(after.predicted?.effective === true
    ? "The HTTP API requires a valid token from its configured Cognito user pool."
    : "The HTTP API admits requests without a user-pool token. Handler-side checks still run.");
  const lanesBefore = target.lanes;
  const lanesAfter = after.lanes;
  if (lanesAfter) {
    const lane = (lanes: Lanes) => [lanes.local ? "local" : null, lanes.dev ? "dev AWS" : null, lanes.prod ? "prod AWS" : null].filter(Boolean).join(", ") || "nowhere";
    if (lane(lanesBefore) !== lane(lanesAfter)) notes.push(`Runs in ${lane(lanesBefore)} → ${lane(lanesAfter)}.`);
    if (target.kind === "service" && lanesBefore.local !== lanesAfter.local) {
      notes.push("The reviewed generated Compose changes update which services run locally. Rebuild/start development separately after saving source.");
    }
  }
  if (fieldId.endsWith("subnet") && after.placement && JSON.stringify(target.placement) !== JSON.stringify(after.placement)) {
    const where = (placement: Placement) => (placement.kind === "vpc" ? `${placement.subnet} subnet` : placement.kind === "outside" ? "outside the VPC" : "managed");
    notes.push(`Production placement: ${where(target.placement)} → ${where(after.placement)}.`);
  }
  notes.push("Compose Watch restarts the local dev servers and the invocation runner when framework-config changes; local executions in flight are lost.");
  return notes;
}

export class EditService {
  private plans = new Map<string, StoredPlan>();
  /** Files this service wrote, by relative path, with what it wrote: so the watcher can tell them apart. */
  readonly ownWrites = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();
  private readonly batches: BatchEditor;

  constructor(
    private readonly repositoryRoot: string,
    private readonly builder: SnapshotBuilder,
    writeBatchFile = writeSourceChange,
  ) { this.batches = new BatchEditor(repositoryRoot, builder, this.ownWrites, writeBatchFile); }

  /** Every plan is offered against one snapshot; a new snapshot expires them all. */
  expirePlans(): void {
    this.plans.clear();
    this.batches.expirePlans();
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private state(): StudioState {
    const state = this.builder.current;
    if (!state) throw new EditError(503, "The studio has not evaluated the repository yet.");
    return state;
  }

  planBatch(edits: readonly DraftEdit[], revision: string) { return this.exclusive(() => this.batches.plan(edits, revision)); }
  applyBatch(planId: string): Promise<ApplyResponse> {
    return this.exclusive(() => this.batches.apply(planId).finally(() => this.plans.clear()));
  }

  plan(intent: EditIntent, baseRevision: string): Promise<PlanResponse> {
    return this.exclusive(async () => {
      if (intent.field === "events.localReplay") throw new EditError(422, "Use Review Changes for local replay so the configuration and handler wrapper are updated together.");
      const state = this.state();
      const { snapshot, evaluation } = state;
      if (baseRevision !== snapshot.revision) {
        throw new EditError(409, "The repository changed since this view was drawn. It has been refreshed; make the change again.");
      }
      const model = snapshot.models.dev;
      if (snapshot.models.dev.stale || snapshot.models.prod.stale || model.targets.length === 0) {
        throw new EditError(422, "The configuration does not load right now, so no change can be checked against it. Fix it in your editor first.");
      }
      const target = model.targets.find((candidate) => candidate.ref === intent.target);
      const defaults = model.defaults?.find((candidate) => candidate.ref === intent.target);
      const field = fieldById(intent.field);
      const fact: FieldFact | undefined = model.fields[intent.target]?.find((candidate) => candidate.field === intent.field);
      if ((!target && !defaults) || !field || !fact) throw new EditError(404, `${intent.target} has no field ${intent.field}.`);

      const outcome = planEdit({ repositoryRoot: this.repositoryRoot, origin: defaults?.origin ?? target!.origins[0]!, field, fact, intent });
      if ("refused" in outcome) throw new EditError(422, outcome.refused);
      const planned = outcome.planned;
      assertWritable(this.repositoryRoot, planned.relativeFile);
      if (sha256(readFileSync(planned.file, "utf8")) !== snapshot.files[planned.relativeFile]) throw new EditError(409, "The setting's source changed. Wait for refresh and preview again.");
      const preflight = await evaluation.preflight({ target: intent.target, field: field.id, patch: planned.forward });
      const batch = preflight.dev.ok && preflight.prod.ok ? await this.batches.plan([{ kind: "field", intent }], baseRevision) : undefined;
      const ok = preflight.dev.ok && preflight.prod.ok && (batch?.ok ?? true);
      const response: PlanResponse = {
        planId: randomUUID(),
        target: intent.target,
        field: field.id,
        summary: planned.summary,
        file: planned.relativeFile,
        diff: planned.diff,
        ...(batch ? { changes: batch.changes } : {}),
        preflight: batch ? { dev: { ...preflight.dev, ...batch.preflight.dev }, prod: { ...preflight.prod, ...batch.preflight.prod } } : preflight,
        ok,
        impact: ok ? target ? impactOf(target, field.id, preflight.dev) : [
          `${fact.usage?.inherited ?? 0} current workloads inherit this setting; ${fact.usage?.overridden ?? 0} have overrides.`,
          "Applies to matching workloads on every island and to future declarations. Individual overrides are preserved.",
          "Compose Watch restarts affected local workloads when the defaults file changes.",
        ] : [],
        ...(target ? { lanesBefore: target.lanes, placementBefore: target.placement } : {}),
      };
      this.plans.set(response.planId, {
        response,
        ...(batch ? { batchPlanId: batch.planId } : {}),
        revision: snapshot.revision,
        file: planned.file,
        relativeFile: planned.relativeFile,
        beforeHash: planned.beforeHash,
        after: planned.after,
        afterHash: planned.afterHash,
        edit: { kind: "field" },
      });
      return response;
    });
  }

  planRoute(id: string, nextPath: string, revision: string): Promise<PlanResponse> {
    return this.exclusive(async () => {
      const state = this.state();
      if (state.snapshot.revision !== revision) throw new EditError(409, "The repository changed. Preview this route again.");
      if ([state.snapshot.models.dev, state.snapshot.models.prod].some((model) => model.stale || model.status === "error")) throw new EditError(422, "Fix the configuration errors before editing routes.");
      let planned;
      try { planned = planHttpRoute(this.repositoryRoot, state, id, nextPath); }
      catch (error) { throw new EditError(422, error instanceof Error ? error.message : "The route cannot be renamed here."); }
      assertWritable(this.repositoryRoot, planned.relativeFile);
      const preflight = await validateHttpRoute(this.repositoryRoot, state, planned.file, planned.after, planned.change, this.builder.evaluators);
      if (this.state().snapshot.revision !== revision || sha256(readFileSync(planned.file, "utf8")) !== planned.beforeHash) throw new EditError(409, "The route changed while validating it. Preview again.");
      const target = state.snapshot.models.dev.targets.find((target) => target.ref === planned.change.target)!;
      const batch = preflight.dev.ok && preflight.prod.ok ? await this.batches.plan([{ kind: "route", route: id, value: nextPath }], revision) : undefined;
      const response: PlanResponse = {
        planId: randomUUID(), target: target.ref, field: "http.route", summary: `Route: ${planned.change.before} → ${nextPath}`,
        file: planned.relativeFile, diff: planned.diff, ...(batch ? { changes: batch.changes } : {}), preflight: batch ? { dev: { ...preflight.dev, ...batch.preflight.dev }, prod: { ...preflight.prod, ...batch.preflight.prod } } : preflight, ok: preflight.dev.ok && preflight.prod.ok && (batch?.ok ?? true),
        lanesBefore: target.lanes, placementBefore: target.placement,
        impact: [
          `Changes the browser path from /api${planned.change.before} to /api${nextPath} and the corresponding API Gateway route.`,
          "The Lambda target, handler and deployed construct identity are preserved.",
          "The generated browser API contract is included in the reviewed files. Update callers of the old path. Deployment is a separate action.",
        ],
      };
      this.plans.set(response.planId, { response, ...(batch ? { batchPlanId: batch.planId } : {}), revision, file: planned.file, relativeFile: planned.relativeFile, beforeHash: planned.beforeHash, after: planned.after, afterHash: planned.afterHash, edit: { kind: "route", change: planned.change } });
      return response;
    });
  }

  apply(planId: string): Promise<ApplyResponse> {
    return this.exclusive(async () => {
      if (new SourceJournal(this.repositoryRoot).pending().length) throw new EditError(409, "Resolve the interrupted source transaction in Source recovery before applying another edit.");
      const plan = this.plans.get(planId);
      if (!plan) throw new EditError(410, "This preview has expired. The repository changed, or another edit was applied; preview it again.");
      if (!plan.response.ok) throw new EditError(422, "The framework refuses this change, so it cannot be written.");
      if (this.state().snapshot.revision !== plan.revision) {
        throw new EditError(409, "The repository changed since this preview. Preview it again.");
      }
      if (plan.batchPlanId) return this.batches.apply(plan.batchPlanId).finally(() => this.plans.clear());
      const file = assertWritable(this.repositoryRoot, plan.relativeFile);
      const before = readFileSync(file, "utf8");
      if (sha256(before) !== plan.beforeHash) {
        throw new EditError(409, `${plan.relativeFile} changed since this preview. Nothing was written; preview it again.`);
      }
      writeAtomically(this.repositoryRoot, file, plan.after);
      this.ownWrites.set(plan.relativeFile, plan.afterHash);
      this.plans.clear();
      const entry: WrittenEdit = {
        target: plan.response.target,
        field: plan.response.field,
        file,
        relativeFile: plan.relativeFile,
        before,
        after: plan.after,
        edit: plan.edit,
      };
      return this.confirm(entry, plan.response.preflight);
    });
  }

  /**
   * Re-evaluates from disk and holds the field to its prediction. On a
   * mismatch the write is reverted — only if the file still holds exactly what
   * was written, so a concurrent edit is never the thing that gets undone.
   */
  private async confirm(
    written: WrittenEdit,
    predicted: { readonly dev: PreflightResult; readonly prod: PreflightResult },
  ): Promise<ApplyResponse> {
    let mismatch: string[];
    try {
      const state = await this.builder.refresh();
      mismatch = (["dev", "prod"] as const).flatMap((mode) => {
        const model = state.snapshot.models[mode];
        if (model.stale || model.status === "error") return [`the ${mode} configuration no longer validates`];
        if (written.edit.kind === "route") {
          const change = written.edit.change;
          return !model.routes.some((route) => route.kind === "http" && route.path === change.after && route.target === change.target)
            ? [`the ${mode} route did not reach the expected Lambda`] : [];
        }
        const expected = predicted[mode].predicted?.effective;
        const actual = model.fields[written.target]?.find((fact) => fact.field === written.field)?.effective;
        return expected === actual ? [] : [`${mode} resolves ${JSON.stringify(actual)} where ${JSON.stringify(expected)} was predicted`];
      });
      if (mismatch.length === 0) {
        return { status: "applied", message: `Wrote ${written.relativeFile}.`, revision: state.snapshot.revision };
      }
    } catch (error) { mismatch = [error instanceof Error ? error.message : String(error)]; }

    let restored = false;
    try {
      assertWritable(this.repositoryRoot, written.relativeFile);
      writeSourceChange(this.repositoryRoot, written.file, written.after, written.before);
      this.ownWrites.set(written.relativeFile, sha256(written.before));
      restored = true;
    } catch { /* A concurrent edit, deletion or failed restoration must remain unconfirmed. */ }
    const refreshed = await this.builder.refresh().catch(() => undefined);
    return {
      status: restored ? "reverted" : "unconfirmed",
      message: `The edit could not be confirmed (${mismatch.join("; ")}). ${restored ? `${written.relativeFile} is back as it was.` : `The source could not be safely restored; inspect ${written.relativeFile}. Concurrent edits were preserved.`}${refreshed ? "" : " The snapshot could not be refreshed; refresh Studio after resolving the failure."}`,
      revision: refreshed?.snapshot.revision ?? this.state().snapshot.revision,
    };
  }
}
