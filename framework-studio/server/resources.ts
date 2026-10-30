import { parseEnv } from "node:util";
import type { ResourceApply, ResourceDetails, ResourceIntent, ResourcePlan } from "../shared/resources";
import type { Mode, ModelResource } from "../shared/model";
import { EditError } from "./edits/io";
import { BatchEditor } from "./edits/batch";
import { sha256 } from "./files";
import type { SnapshotBuilder, StudioState } from "./snapshot";
import { inputText, selectedDeploymentInput } from "./deployment-inputs";

export function readResourceIntent(body: unknown): ResourceIntent {
  const intent = (body as { intent?: unknown } | undefined)?.intent as Record<string, unknown> | undefined;
  const modes = intent?.modes as Record<string, Record<string, unknown> | undefined> | undefined;
  const modeIntent = (value: Record<string, unknown> | undefined) => !!value && Object.keys(value).every((key) => ["present", "required", "default", "value"].includes(key))
    && typeof value.present === "boolean" && typeof value.required === "boolean" && (value.default === null || typeof value.default === "string")
    && (value.value === undefined || value.value === null || typeof value.value === "string");
  if (!modes || typeof modes !== "object" || Object.keys(modes).some((mode) => mode !== "dev" && mode !== "prod") || !modeIntent(modes.dev) || !modeIntent(modes.prod)) throw new EditError(400, "A resource edit states its presence, requirement and default for Development and Production.");
  if (!intent || Object.keys(intent).some((key) => !["resource", "kind", "modes", "group", "requirements", "fromEnv"].includes(key)) || typeof intent.resource !== "string" || !["input", "secret"].includes(String(intent.kind)) || typeof intent.group !== "string" || !intent.requirements || typeof intent.requirements !== "object" || Array.isArray(intent.requirements) || Object.values(intent.requirements).some((value) => value !== "required" && value !== "optional")
    || (intent.fromEnv !== undefined && intent.fromEnv !== null && typeof intent.fromEnv !== "string") || (intent.kind === "secret" && intent.fromEnv === null)) throw new EditError(400, "A resource edit names its kind, input source, group, value or default and workload requirements.");
  return intent as unknown as ResourceIntent;
}

/** Selected .env values are returned directly to the inspector, never to an evaluator,
 * snapshot, cache, diff, disk journal or server log. Only declarations authorize a key. */
export class ResourceService {
  private readonly plans = new Map<string, ResourcePlan>();
  private readonly batches: BatchEditor;
  readonly ownWrites = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly builder: SnapshotBuilder) { this.batches = new BatchEditor(root, builder, this.ownWrites); }
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
    if (!entry || (entry.kind !== "input" && entry.kind !== "secret") || (!entry.fromEnv && entry.authoredValue === undefined)) throw new EditError(404, "Select a defined input parameter or secret.");
    if (!state.built.catalog.has(entry.path.join("."))) throw new EditError(422, "The resource declaration could not be located in source.");
    return entry;
  }
  expirePlans(): void { this.plans.clear(); this.batches.expirePlans(); }
  details(id: string, mode: Mode): ResourceDetails {
    const resource = this.resource(id, mode);
    if (!resource.fromEnv) {
      const policy = resource.modes?.[mode];
      const value = policy ? policy.value : resource.authoredValue;
      return { configured: value !== undefined, ...(value === undefined ? {} : { value }) };
    }
    const file = selectedDeploymentInput(this.root, mode);
    const text = inputText(this.root, file);
    const values = text === undefined ? {} : parseEnv(text);
    const value = values[resource.fromEnv!];
    // Configuration presence (even NAME=) is distinct from the framework's non-blank requirement.
    return { file, inputFile: { exists: text !== undefined, hash: sha256(text ?? "") }, configured: value !== undefined, ...(value !== undefined ? { value } : {}) };
  }
  plan(intent: ResourceIntent, revision: string, mode: Mode): Promise<ResourcePlan> {
    return this.exclusive(async () => {
      const resource = this.resource(intent.resource, mode);
      const batch = await this.batches.plan([{ kind: "resourceConfig", intent }], revision);
      const response: ResourcePlan = {
        planId: batch.planId, resource: resource.id, nextResource: batch.entityRemap?.[resource.id] ?? resource.id,
        ok: batch.ok, changes: batch.changes,
        diagnostics: [...batch.preflight.dev.diagnostics, ...batch.preflight.prod.diagnostics,
          ...(batch.renameIssues ?? []).map(issue => ({ severity: "error" as const, stage: "validate" as const, message: `${issue.source.file}:${issue.source.line}: ${issue.message}` }))],
      };
      this.plans.set(response.planId, response);
      return response;
    });
  }
  apply(planId: string): Promise<ResourceApply> {
    return this.exclusive(async () => {
      const plan = this.plans.get(planId);
      if (!plan) throw new EditError(410, "This resource preview expired. Preview again.");
      if (!plan.ok) throw new EditError(422, "The framework refuses this resource change.");
      const result = await this.batches.apply(planId);
      if (result.status === "applied") this.expirePlans();
      return { ...result, resource: result.status === "applied" ? plan.nextResource : plan.resource };
    });
  }
}
