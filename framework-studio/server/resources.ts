import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { ResourceApply, ResourceDetails, ResourceIntent, ResourcePlan } from "../shared/resources";
import type { HistoryState } from "../shared/api";
import type { Mode, ModelResource } from "../shared/model";
import { EvaluatorPool } from "./evaluator/pool";
import { EditError, writeAtomically } from "./edits/transaction";
import { diffOf } from "./edits/plan";
import { hashEditableFiles, sha256, toRelative } from "./files";
import type { SnapshotBuilder, StudioState } from "./snapshot";
import { assertResourceFile, consumesResource, planResourceSource, resourceTypeErrors } from "./resources-source";

interface Change { file: string; before: string; after: string }
interface Plan { response: ResourcePlan; revision: string; hashes: Record<string, string>; changes: readonly Change[] }
interface Journal { resource: string; nextResource: string; changes: readonly Change[] }

export function readResourceIntent(body: unknown): ResourceIntent {
  const intent = (body as { intent?: unknown } | undefined)?.intent as Record<string, unknown> | undefined;
  if (!intent || typeof intent.resource !== "string" || !["input", "secret"].includes(String(intent.kind)) || typeof intent.group !== "string" || !(intent.default === null || typeof intent.default === "string") || !intent.requirements || typeof intent.requirements !== "object" || Array.isArray(intent.requirements) || Object.values(intent.requirements).some((value) => value !== "required" && value !== "optional")) throw new EditError(400, "A resource edit names its kind, group, default and workload requirements.");
  return intent as unknown as ResourceIntent;
}

/** Selected .env values are returned directly to the inspector, never to an evaluator,
 * snapshot, cache, diff, disk journal or server log. Only declarations authorize a key. */
export class ResourceService {
  private readonly plans = new Map<string, Plan>();
  private readonly undoStack: Journal[] = [];
  private readonly redoStack: Journal[] = [];
  readonly ownWrites = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly builder: SnapshotBuilder) {}
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }
  private state(): StudioState {
    if (!this.builder.current) throw new EditError(503, "The repository has not loaded yet.");
    return this.builder.current;
  }
  private resource(id: string, mode: Mode): ModelResource {
    const state = this.state();
    const model = state.snapshot.models[mode];
    const entry = model.resources.find((resource) => resource.id === id);
    if (model.stale) throw new EditError(422, "The resource declaration is unavailable. Refresh after fixing the configuration.");
    if (!entry || entry.absent || !entry.fromEnv || (entry.kind !== "input" && entry.kind !== "secret")) throw new EditError(404, "Select a defined authored input or secret.");
    if (!state.built.catalog.has(entry.path.join("."))) throw new EditError(422, "The resource declaration could not be located in source.");
    return entry;
  }
  history(): HistoryState {
    return { ...(this.undoStack.length ? { undo: "Undo resource configuration" } : {}), ...(this.redoStack.length ? { redo: "Redo resource configuration" } : {}) };
  }
  expirePlans(): void { this.plans.clear(); }
  details(id: string, mode: Mode): ResourceDetails {
    const resource = this.resource(id, mode);
    const file = path.join(this.root, "cdk-app", ".env");
    const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    const value = values[resource.fromEnv!];
    // Configuration presence (even NAME=) is distinct from the framework's non-blank requirement.
    const consumers = this.state().snapshot.models[mode].targets.filter((target) => consumesResource(target, id)).map((target) => ({ target: target.ref, title: target.title, rules: target.requirementRules ?? [] }));
    return { configured: value !== undefined, ...(value !== undefined ? { value } : {}), consumers, history: this.history() };
  }
  plan(intent: ResourceIntent, revision: string, mode: Mode): Promise<ResourcePlan> {
    return this.exclusive(async () => {
      const state = this.state();
      if (state.snapshot.revision !== revision) throw new EditError(409, "The repository changed. Preview this edit again.");
      const resource = this.resource(intent.resource, mode);
      if ([state.snapshot.models.dev, state.snapshot.models.prod].some((model) => model.stale || model.status === "error")) throw new EditError(422, "Fix the configuration errors before editing resources.");
      const hashes = hashEditableFiles(this.root);
      if (JSON.stringify(hashes) !== JSON.stringify(state.snapshot.files)) throw new EditError(409, "The source changed since this view. Wait for refresh and preview again.");
      let candidate;
      try { candidate = planResourceSource(this.root, state, resource, intent); }
      catch (error) { throw new EditError(422, error instanceof Error ? error.message : "This resource cannot be edited here."); }
      const changes = Object.entries(candidate.overrides).map(([file, after]) => {
        assertResourceFile(this.root, file);
        return { file, before: readFileSync(file, "utf8"), after };
      });
      const diagnostics = await this.validate(candidate.overrides, state.snapshot.webSocketApi);
      const response: ResourcePlan = {
        planId: randomUUID(), resource: resource.id, nextResource: candidate.nextResource,
        ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"), diagnostics,
        changes: changes.map((change) => ({ file: toRelative(this.root, change.file), diff: diffOf(toRelative(this.root, change.file), change.before, change.after) })),
      };
      this.plans.set(response.planId, { response, revision, hashes, changes });
      // A candidate is valid only against the source captured when planning began.
      if (this.state().snapshot.revision !== revision || JSON.stringify(hashEditableFiles(this.root)) !== JSON.stringify(hashes) || changes.some((change) => readFileSync(change.file, "utf8") !== change.before)) { this.plans.delete(response.planId); throw new EditError(409, "The repository changed during validation. Preview again."); }
      return response;
    });
  }
  private async validate(overrides: Record<string, string>, webSocketApi: boolean): Promise<ResourcePlan["diagnostics"]> {
    const pool = new EvaluatorPool(this.root);
    try {
      const evaluation = await pool.evaluate(webSocketApi, overrides);
      const diagnostics = [evaluation.dev, evaluation.prod].flatMap((model) => model.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${model.mode}: ${diagnostic.message}` })));
      if (!diagnostics.some((diagnostic) => diagnostic.severity === "error")) diagnostics.push(...resourceTypeErrors(this.root, overrides).map((message) => ({ severity: "error" as const, stage: "validate" as const, message })));
      return diagnostics;
    } finally { await pool.dispose(); }
  }
  apply(planId: string): Promise<ResourceApply> {
    return this.exclusive(async () => {
      const plan = this.plans.get(planId);
      if (!plan) throw new EditError(410, "This resource preview expired. Preview again.");
      if (!plan.response.ok) throw new EditError(422, "The framework refuses this resource change.");
      if (this.state().snapshot.revision !== plan.revision || JSON.stringify(hashEditableFiles(this.root)) !== JSON.stringify(plan.hashes)) throw new EditError(409, "The configuration changed since preview. Nothing was written.");
      const entry = { resource: plan.response.resource, nextResource: plan.response.nextResource, changes: plan.changes };
      return this.write(entry, false, () => { this.undoStack.push(entry); this.redoStack.length = 0; });
    });
  }
  replay(direction: "undo" | "redo"): Promise<ResourceApply> {
    return this.exclusive(async () => {
      const stack = direction === "undo" ? this.undoStack : this.redoStack;
      const entry = stack.at(-1);
      if (!entry) throw new EditError(404, `No resource configuration to ${direction}.`);
      const inverse = direction === "undo";
      const overrides = Object.fromEntries(entry.changes.map((change) => [change.file, inverse ? change.before : change.after]));
      const diagnostics = await this.validate(overrides, this.state().snapshot.webSocketApi);
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new EditError(422, `This resource edit cannot be ${direction === "undo" ? "undone" : "redone"} against the current configuration.`);
      return this.write(entry, inverse, () => { stack.pop(); (inverse ? this.redoStack : this.undoStack).push(entry); });
    });
  }
  private async write(entry: Journal, inverse: boolean, record: () => void): Promise<ResourceApply> {
    const changes = entry.changes.map((change) => inverse ? { ...change, before: change.after, after: change.before } : change);
    for (const change of changes) {
      assertResourceFile(this.root, change.file);
      if (sha256(readFileSync(change.file, "utf8")) !== sha256(change.before)) throw new EditError(409, `${toRelative(this.root, change.file)} changed. Nothing was written.`);
    }
    const written: Change[] = [];
    try {
      for (const change of changes) {
        // Recheck immediately before each write; never clobber an intervening editor save.
        if (readFileSync(change.file, "utf8") !== change.before) throw new Error("A file changed during the resource edit.");
        writeAtomically(this.root, change.file, change.after);
        written.push(change);
        this.ownWrites.set(toRelative(this.root, change.file), sha256(change.after));
      }
      const state = await this.builder.refresh();
      if ([state.snapshot.models.dev, state.snapshot.models.prod].some((model) => model.stale || model.status === "error")) throw new Error("The written configuration did not validate.");
      record();
      this.expirePlans();
      return { status: "applied", message: "Wrote resource configuration.", resource: inverse ? entry.resource : entry.nextResource, revision: state.snapshot.revision, history: this.history() };
    } catch {
      let conflicted = false;
      for (const change of written.reverse()) {
        if (readFileSync(change.file, "utf8") === change.after) {
          writeAtomically(this.root, change.file, change.before);
          this.ownWrites.set(toRelative(this.root, change.file), sha256(change.before));
        } else conflicted = true;
      }
      const state = await this.builder.refresh();
      this.expirePlans();
      return { status: conflicted ? "unconfirmed" : "reverted", message: conflicted ? "The resource edit could not be confirmed. Concurrent edits were preserved; review the changed files." : "The resource edit was reverted because it could not be confirmed.", resource: inverse ? entry.nextResource : entry.resource, revision: state.snapshot.revision, history: this.history() };
    }
  }
}
