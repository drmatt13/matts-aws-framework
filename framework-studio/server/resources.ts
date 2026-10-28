import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { ResourceApply, ResourceDetails, ResourceIntent, ResourcePlan } from "../shared/resources";
import type { Mode, ModelResource } from "../shared/model";
import { EvaluatorPool } from "./evaluator/pool";
import { EditError, writeAtomically, writeSourceChange } from "./edits/io";
import { diffOf } from "./edits/plan";
import { hashEditableFiles, sha256, toRelative } from "./files";
import type { SnapshotBuilder, StudioState } from "./snapshot";
import { assertResourceFile, consumesResource, planResourceSource, resourceTypeErrors } from "./resources-source";
import { inputText, selectedDeploymentInput } from "./deployment-inputs";
import { SourceJournal } from "./edits/journal";

interface Change { file: string; before: string; after: string }
interface Plan { response: ResourcePlan; revision: string; hashes: Record<string, string>; changes: readonly Change[] }
interface ResourceChanges { resource: string; nextResource: string; changes: readonly Change[] }

export function readResourceIntent(body: unknown): ResourceIntent {
  const intent = (body as { intent?: unknown } | undefined)?.intent as Record<string, unknown> | undefined;
  const modes = intent?.modes as Record<string, Record<string, unknown> | undefined> | undefined;
  const modeIntent = (value: Record<string, unknown> | undefined) => !!value && Object.keys(value).every((key) => ["present", "required", "default"].includes(key))
    && typeof value.present === "boolean" && typeof value.required === "boolean" && (value.default === null || typeof value.default === "string");
  if (!modes || typeof modes !== "object" || Object.keys(modes).some((mode) => mode !== "dev" && mode !== "prod") || !modeIntent(modes.dev) || !modeIntent(modes.prod)) throw new EditError(400, "A resource edit states its presence, requirement and default for Development and Production.");
  if (!intent || typeof intent.resource !== "string" || !["input", "secret"].includes(String(intent.kind)) || typeof intent.group !== "string" || !intent.requirements || typeof intent.requirements !== "object" || Array.isArray(intent.requirements) || Object.values(intent.requirements).some((value) => value !== "required" && value !== "optional")) throw new EditError(400, "A resource edit names its kind, group, default and workload requirements.");
  return intent as unknown as ResourceIntent;
}

/** Selected .env values are returned directly to the inspector, never to an evaluator,
 * snapshot, cache, diff, disk journal or server log. Only declarations authorize a key. */
export class ResourceService {
  private readonly plans = new Map<string, Plan>();
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
    // An input declared `.only()` the other graph is still one declaration, edited from either graph.
    const declared = (graph: typeof model) => graph.resources.find((resource) => resource.id === id && !resource.absent);
    const entry = declared(model) ?? declared(state.snapshot.models[mode === "dev" ? "prod" : "dev"]);
    if (model.stale) throw new EditError(422, "The resource declaration is unavailable. Refresh after fixing the configuration.");
    if (!entry || !entry.fromEnv || (entry.kind !== "input" && entry.kind !== "secret")) throw new EditError(404, "Select a defined authored input or secret.");
    if (!state.built.catalog.has(entry.path.join("."))) throw new EditError(422, "The resource declaration could not be located in source.");
    return entry;
  }
  expirePlans(): void { this.plans.clear(); }
  details(id: string, mode: Mode): ResourceDetails {
    const resource = this.resource(id, mode);
    const file = selectedDeploymentInput(this.root, mode);
    const text = inputText(this.root, file);
    const values = text === undefined ? {} : parseEnv(text);
    const value = values[resource.fromEnv!];
    // Configuration presence (even NAME=) is distinct from the framework's non-blank requirement.
    const consumers = this.state().snapshot.models[mode].targets.filter((target) => consumesResource(target, id)).map((target) => ({ target: target.ref, title: target.title, rules: target.requirementRules ?? [] }));
    return { file, inputFile: { exists: text !== undefined, hash: sha256(text ?? "") }, configured: value !== undefined, ...(value !== undefined ? { value } : {}), consumers };
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
      const diagnostics = await this.validate(candidate.overrides);
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
  private async validate(overrides: Record<string, string>): Promise<ResourcePlan["diagnostics"]> {
    const pool = new EvaluatorPool(this.root, undefined, this.builder.evaluators);
    try {
      const evaluation = await pool.evaluate(overrides);
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
      return this.write(entry);
    });
  }
  private async write(entry: ResourceChanges): Promise<ResourceApply> {
    const changes = entry.changes;
    for (const change of changes) {
      assertResourceFile(this.root, change.file);
      if (sha256(readFileSync(change.file, "utf8")) !== sha256(change.before)) throw new EditError(409, `${toRelative(this.root, change.file)} changed. Nothing was written.`);
    }
    const written: Change[] = [];
    const journal = new SourceJournal(this.root);
    const journalId = journal.begin("Resource configuration", changes, "resource");
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
      journal.finish(journalId, "complete");
      this.expirePlans();
      return { status: "applied", message: "Wrote resource configuration.", resource: entry.nextResource, revision: state.snapshot.revision };
    } catch {
      let conflicted = false;
      for (const change of written.reverse()) {
        try {
          assertResourceFile(this.root, change.file);
          writeSourceChange(this.root, change.file, change.after, change.before);
          this.ownWrites.set(toRelative(this.root, change.file), sha256(change.before));
        } catch { conflicted = true; }
      }
      journal.finish(journalId, conflicted ? "conflicted" : "restored");
      const state = await this.builder.refresh().catch(() => undefined);
      this.expirePlans();
      const message = conflicted ? "The resource edit could not be confirmed. Concurrent edits were preserved; review the changed files." : "The resource edit was reverted because it could not be confirmed.";
      return { status: conflicted ? "unconfirmed" : "reverted", message: `${message}${state ? "" : " The snapshot could not be refreshed; refresh Studio after resolving the failure."}`, resource: entry.resource, revision: state?.snapshot.revision ?? this.state().snapshot.revision };
    }
  }
}
