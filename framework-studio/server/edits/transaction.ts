import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ApplyResponse, HistoryState, PlanResponse, PreflightResult } from "../../shared/api";
import type { FieldFact, Lanes, ModelTarget, Placement } from "../../shared/model";
import { assertWritable, sha256 } from "../files";
import { STUDIO_SCRATCH } from "../inputs";
import type { SemanticPatch } from "../model/origin";
import type { SnapshotBuilder, StudioState } from "../snapshot";
import { fieldById } from "./fields";
import { planEdit, type EditIntent } from "./plan";

/**
 * Plans, writes, and takes back field edits — one at a time, and never over a
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

export type { ApplyResponse, HistoryState, PlanResponse };

export class EditError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}


interface StoredPlan {
  readonly response: PlanResponse;
  readonly revision: string;
  readonly file: string;
  readonly relativeFile: string;
  readonly beforeHash: string;
  readonly after: string;
  readonly afterHash: string;
  readonly forward: SemanticPatch;
  readonly inverse: SemanticPatch;
}

interface JournalEntry {
  readonly label: string;
  readonly target: string;
  readonly field: string;
  readonly file: string;
  readonly relativeFile: string;
  readonly before: string;
  readonly after: string;
  readonly forward: SemanticPatch;
  readonly inverse: SemanticPatch;
}


/** Replaces a file by renaming a sibling written outside the watched tree. */
export function writeAtomically(repositoryRoot: string, file: string, text: string): void {
  const directory = path.join(repositoryRoot, STUDIO_SCRATCH, "tmp");
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, text);
  try {
    if (existsSync(file)) chmodSync(temporary, statSync(file).mode);
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An editor or virus scanner holding the file open on Windows.
        if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function impactOf(target: ModelTarget, fieldId: string, after: PreflightResult): string[] {
  const notes: string[] = [];
  const lanesBefore = target.lanes;
  const lanesAfter = after.lanes;
  if (lanesAfter) {
    const lane = (lanes: Lanes) => [lanes.local ? "local" : null, lanes.dev ? "dev AWS" : null, lanes.prod ? "prod AWS" : null].filter(Boolean).join(", ") || "nowhere";
    if (lane(lanesBefore) !== lane(lanesAfter)) notes.push(`Runs in ${lane(lanesBefore)} → ${lane(lanesAfter)}.`);
    if (target.kind === "service" && lanesBefore.local !== lanesAfter.local) {
      notes.push("Changes which services docker-compose.services.yml runs locally: run framework:generate (npm run dev:containers runs it first).");
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
  private readonly undoStack: JournalEntry[] = [];
  private readonly redoStack: JournalEntry[] = [];
  /** Files this service wrote, by relative path, with what it wrote: so the watcher can tell them apart. */
  readonly ownWrites = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repositoryRoot: string,
    private readonly builder: SnapshotBuilder,
  ) {}

  /** Every plan is offered against one snapshot; a new snapshot expires them all. */
  expirePlans(): void {
    this.plans.clear();
  }

  history(): HistoryState {
    const undo = this.undoStack.at(-1);
    const redo = this.redoStack.at(-1);
    return { ...(undo ? { undo: undo.label } : {}), ...(redo ? { redo: redo.label } : {}) };
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

  plan(intent: EditIntent, baseRevision: string): Promise<PlanResponse> {
    return this.exclusive(async () => {
      const state = this.state();
      const { snapshot, evaluation } = state;
      if (baseRevision !== snapshot.revision) {
        throw new EditError(409, "The repository changed since this view was drawn. It has been refreshed; make the change again.");
      }
      const model = snapshot.currentMode === "prod" ? snapshot.models.prod : snapshot.models.dev;
      if (snapshot.models.dev.stale || snapshot.models.prod.stale || model.targets.length === 0) {
        throw new EditError(422, "The configuration does not load right now, so no change can be checked against it. Fix it in your editor first.");
      }
      const target = model.targets.find((candidate) => candidate.ref === intent.target);
      const field = fieldById(intent.field);
      const fact: FieldFact | undefined = model.fields[intent.target]?.find((candidate) => candidate.field === intent.field);
      if (!target || !field || !fact) throw new EditError(404, `${intent.target} has no field ${intent.field}.`);

      const outcome = planEdit({ repositoryRoot: this.repositoryRoot, origin: target.origins[0]!, field, fact, intent });
      if ("refused" in outcome) throw new EditError(422, outcome.refused);
      const planned = outcome.planned;
      assertWritable(this.repositoryRoot, planned.relativeFile);
      const preflight = await evaluation.preflight({ target: target.ref, field: field.id, patch: planned.forward });
      const ok = preflight.dev.ok && preflight.prod.ok;
      const current = snapshot.currentMode === "prod" ? preflight.prod : preflight.dev;
      const placementBefore = target.placement;
      const response: PlanResponse = {
        planId: randomUUID(),
        target: target.ref,
        field: field.id,
        summary: planned.summary,
        file: planned.relativeFile,
        diff: planned.diff,
        preflight,
        ok,
        impact: ok ? impactOf(target, field.id, current) : [],
        lanesBefore: target.lanes,
        placementBefore,
      };
      this.plans.set(response.planId, {
        response,
        revision: snapshot.revision,
        file: planned.file,
        relativeFile: planned.relativeFile,
        beforeHash: planned.beforeHash,
        after: planned.after,
        afterHash: planned.afterHash,
        forward: planned.forward,
        inverse: planned.inverse,
      });
      return response;
    });
  }

  apply(planId: string): Promise<ApplyResponse> {
    return this.exclusive(async () => {
      const plan = this.plans.get(planId);
      if (!plan) throw new EditError(410, "This preview has expired. The repository changed, or another edit was applied; preview it again.");
      if (!plan.response.ok) throw new EditError(422, "The framework refuses this change, so it cannot be written.");
      if (this.state().snapshot.revision !== plan.revision) {
        throw new EditError(409, "The repository changed since this preview. Preview it again.");
      }
      const file = assertWritable(this.repositoryRoot, plan.relativeFile);
      const before = readFileSync(file, "utf8");
      if (sha256(before) !== plan.beforeHash) {
        throw new EditError(409, `${plan.relativeFile} changed since this preview. Nothing was written; preview it again.`);
      }
      writeAtomically(this.repositoryRoot, file, plan.after);
      this.ownWrites.set(plan.relativeFile, plan.afterHash);
      this.plans.clear();
      const entry: JournalEntry = {
        label: `${plan.response.target} ${plan.response.summary}`,
        target: plan.response.target,
        field: plan.response.field,
        file,
        relativeFile: plan.relativeFile,
        before,
        after: plan.after,
        forward: plan.forward,
        inverse: plan.inverse,
      };
      return this.confirm(entry, plan.response.preflight, () => {
        this.undoStack.push(entry);
        this.redoStack.length = 0;
      });
    });
  }

  undo(): Promise<ApplyResponse> {
    return this.exclusive(() => this.replay("undo"));
  }

  redo(): Promise<ApplyResponse> {
    return this.exclusive(() => this.replay("redo"));
  }

  /** Writes a journal entry's other side, after checking the file is still the side it left. */
  private async replay(direction: "undo" | "redo"): Promise<ApplyResponse> {
    const stack = direction === "undo" ? this.undoStack : this.redoStack;
    const entry = stack.at(-1);
    if (!entry) throw new EditError(404, `Nothing to ${direction}.`);
    const [expected, replacement, patch] =
      direction === "undo" ? [entry.after, entry.before, entry.inverse] : [entry.before, entry.after, entry.forward];
    const current = readFileSync(entry.file, "utf8");
    if (sha256(current) !== sha256(expected)) {
      throw new EditError(409, `${entry.relativeFile} changed since that edit, so it cannot be ${direction === "undo" ? "undone" : "redone"} without overwriting the change. Use your editor or git.`);
    }
    const { evaluation } = this.state();
    const preflight = await evaluation.preflight({ target: entry.target, field: entry.field, patch });
    if (!preflight.dev.ok || !preflight.prod.ok) {
      const message = [...preflight.dev.diagnostics, ...preflight.prod.diagnostics].find((diagnostic) => diagnostic.severity === "error")?.message;
      throw new EditError(422, `The framework refuses to ${direction} this now: ${message}`);
    }
    assertWritable(this.repositoryRoot, entry.relativeFile);
    writeAtomically(this.repositoryRoot, entry.file, replacement);
    this.ownWrites.set(entry.relativeFile, sha256(replacement));
    this.plans.clear();
    const written: JournalEntry = { ...entry, before: expected, after: replacement };
    return this.confirm(written, preflight, () => {
      stack.pop();
      (direction === "undo" ? this.redoStack : this.undoStack).push(entry);
    });
  }

  /**
   * Re-evaluates from disk and holds the field to its prediction. On a
   * mismatch the write is reverted — only if the file still holds exactly what
   * was written, so a concurrent edit is never the thing that gets undone.
   */
  private async confirm(
    written: JournalEntry,
    predicted: { readonly dev: PreflightResult; readonly prod: PreflightResult },
    record: () => void,
  ): Promise<ApplyResponse> {
    const state = await this.builder.refresh();
    const mismatch = (["dev", "prod"] as const).flatMap((mode) => {
      const model = state.snapshot.models[mode];
      if (model.status === "error" && model.targets.length === 0) return [`the ${mode} configuration no longer loads`];
      const expected = predicted[mode].predicted?.effective;
      const actual = model.fields[written.target]?.find((fact) => fact.field === written.field)?.effective;
      return expected === actual ? [] : [`${mode} resolves ${JSON.stringify(actual)} where ${JSON.stringify(expected)} was predicted`];
    });
    if (mismatch.length === 0) {
      record();
      return { status: "applied", message: `Wrote ${written.relativeFile}.`, revision: state.snapshot.revision };
    }
    const now = readFileSync(written.file, "utf8");
    if (sha256(now) === sha256(written.after)) {
      writeAtomically(this.repositoryRoot, written.file, written.before);
      this.ownWrites.set(written.relativeFile, sha256(written.before));
      const reverted = await this.builder.refresh();
      return {
        status: "reverted",
        message: `The edit was written and then undone: ${mismatch.join("; ")}. ${written.relativeFile} is back as it was.`,
        revision: reverted.snapshot.revision,
      };
    }
    return {
      status: "unconfirmed",
      message: `The edit did not resolve as predicted (${mismatch.join("; ")}), and ${written.relativeFile} has changed since, so it was left alone.`,
      revision: state.snapshot.revision,
    };
  }
}
