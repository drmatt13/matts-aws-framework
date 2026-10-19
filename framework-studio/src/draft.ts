import type { ApplyResponse, BatchPlanResponse, DraftEdit, EditIntent, LiteralValue } from "../shared/api";
import type { FieldFact, Mode, ModelResource, Snapshot } from "../shared/model";
import type { ResourceApply, ResourceIntent, ResourcePlan } from "../shared/resources";
import type { DeploymentInputEdit, DeploymentInputPlan } from "../shared/deployment-inputs";
import { descriptionError } from "../shared/descriptions";
import { triggerBindingsEqual, type TriggerBinding } from "../shared/triggers";

export type Review = { readonly kind: "batch"; readonly plan: BatchPlanResponse } | { readonly kind: "resource"; readonly plan: ResourcePlan } | { readonly kind: "environment"; readonly plan: DeploymentInputPlan };
export interface EnvironmentEdit extends DeploymentInputEdit { readonly key: string; readonly original?: string }
interface EnvironmentEntry { readonly kind: "environment"; readonly key: string; readonly mode: Mode; readonly hash: string; readonly edits: readonly EnvironmentEdit[]; readonly error?: string }
export interface ResourceForm { readonly required?: boolean; readonly secret: boolean; readonly hasDefault: boolean; readonly fallback: string; readonly group: string; readonly requirements: ResourceIntent["requirements"] }
interface FieldEntry { readonly kind: "field"; readonly key: string; readonly raw: LiteralValue | undefined; readonly intent: EditIntent; readonly error?: string }
interface RouteEntry { readonly kind: "route"; readonly key: string; readonly route: string; readonly value: string; readonly error?: string }
interface DescriptionEntry { readonly kind: "description"; readonly key: string; readonly entity: string; readonly value: string; readonly error?: string }
interface ResourceEntry { readonly kind: "resource"; readonly key: string; readonly intent: ResourceIntent; readonly form: ResourceForm; readonly count: number; readonly error?: string }
interface TriggerEntry { readonly kind: "triggers"; readonly key: string; readonly event: string; readonly bindings: readonly TriggerBinding[]; readonly error?: string }
export type DraftEntry = FieldEntry | RouteEntry | DescriptionEntry | ResourceEntry | EnvironmentEntry | TriggerEntry;
export interface DraftState {
  readonly baseline: Snapshot;
  readonly latest: Snapshot;
  readonly selected: string | undefined;
  readonly mode: Mode;
  readonly entries: readonly DraftEntry[];
  readonly reviewOpen: boolean;
  readonly review?: Review;
  readonly pendingNavigation: boolean;
  readonly busy?: "review" | "apply";
  readonly error?: string;
}
export interface DraftTransport {
  planBatch(edits: readonly DraftEdit[], revision: string): Promise<BatchPlanResponse>;
  resourcePlan(intent: ResourceIntent, revision: string, mode: Mode): Promise<ResourcePlan>;
  applyBatch(id: string): Promise<ApplyResponse>;
  resourceApply(id: string): Promise<ResourceApply>;
  inputPlan(mode: Mode, edits: readonly DeploymentInputEdit[], hash: string, revision: string): Promise<DeploymentInputPlan>;
  inputApply(id: string): Promise<ApplyResponse>;
  snapshot(): Promise<Snapshot>;
}
export const fieldKey = (target: string, field: string) => `field:${target}:${field}`;
export const initialResourceForm = (resource: ModelResource): ResourceForm => ({ secret: resource.kind === "secret", hasDefault: resource.default !== undefined, fallback: resource.default ?? "", group: resource.path.length > 1 ? resource.path[0]! : "", requirements: {} });

/** One in-memory inspector transaction. Only edited dotenv values enter this store;
 * they are never persisted to storage or included in graph snapshots.
 * React controls, navigation guards and tests all use these same transitions. */
export class InspectorDraft {
  private state: DraftState;
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  private navigation: { proceed: () => void; cancel: () => void } | undefined;
  constructor(snapshot: Snapshot, selected: string | undefined, mode: Mode, private readonly transport: DraftTransport) {
    this.state = { baseline: snapshot, latest: snapshot, selected, mode, entries: [], reviewOpen: false, pendingNavigation: false };
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.state;
  get count(): number { return this.state.entries.reduce((sum, entry) => sum + (entry.kind === "resource" ? entry.count : entry.kind === "environment" ? entry.edits.length : 1), 0); }
  get dirty(): boolean { return this.count > 0; }
  get conflict(): boolean { return this.dirty && this.state.baseline.revision !== this.state.latest.revision; }
  get invalid(): boolean { return this.state.entries.some((entry) => !!entry.error); }
  private publish(state: DraftState): void { this.state = state; this.listeners.forEach((listener) => listener()); }
  sync(snapshot: Snapshot, selected: string | undefined, mode: Mode): void {
    if (this.state.latest === snapshot && this.state.selected === selected && this.state.mode === mode) return;
    if (this.dirty || this.state.busy) { this.publish({ ...this.state, latest: snapshot }); return; }
    this.publish({ baseline: snapshot, latest: snapshot, selected, mode, entries: [], reviewOpen: false, pendingNavigation: false });
  }
  private put(key: string, entry: DraftEntry | undefined): void {
    ++this.serial;
    this.publish({ ...this.state, entries: [...this.state.entries.filter((item) => item.key !== key), ...(entry ? [entry] : [])], reviewOpen: false, review: undefined, error: undefined, busy: undefined });
    if (!this.dirty && this.state.baseline !== this.state.latest) this.publish({ ...this.state, baseline: this.state.latest });
  }
  field(target: string, fact: FieldFact): FieldEntry | undefined { return this.state.entries.find((entry): entry is FieldEntry => entry.kind === "field" && entry.key === fieldKey(target, fact.field)); }
  value(target: string, fact: FieldFact): LiteralValue | undefined {
    const entry = this.field(target, fact);
    return entry ? entry.raw : fact.authored ?? undefined;
  }
  inherited(fact: FieldFact, visited: ReadonlySet<string> = new Set()): LiteralValue | undefined {
    const from = fact.inherited?.from;
    const match = from && /^defaults\.([^.]+)\.(.+)$/.exec(from);
    if (match) {
      const target = `defaults:${match[1]}`;
      const field = `defaults.${match[1]}.${match[2]}`;
      const parent = this.state.baseline.models[this.state.mode].fields[target]?.find((item) => item.field === field);
      if (parent && !visited.has(field)) return this.effective(target, parent, new Set([...visited, field]));
    }
    return fact.inherited?.value;
  }
  effective(target: string, fact: FieldFact, visited: ReadonlySet<string> = new Set()): LiteralValue {
    const entry = this.field(target, fact);
    if (entry && !entry.error && !entry.intent.inherit) return entry.intent.value!;
    if (entry?.intent.inherit || fact.authored === undefined) return this.inherited(fact, visited) ?? fact.effective;
    return fact.effective;
  }
  setField(target: string, fact: FieldFact, raw: LiteralValue | undefined): void {
    const key = fieldKey(target, fact.field);
    let value: LiteralValue | undefined = raw;
    let error: string | undefined;
    if (raw === undefined) {
      if (!fact.inherited) error = `${fact.label} is required.`;
    } else if (fact.domain.kind === "number") {
      value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isSafeInteger(value) || value < fact.domain.min || value > fact.domain.max) error = `Enter a whole number from ${fact.domain.min} to ${fact.domain.max} ${fact.domain.unit}.`;
    } else {
      value = fact.domain.values.find((option) => String(option) === String(raw));
      if (value === undefined) error = `Choose a valid ${fact.label.toLowerCase()}.`;
    }
    const same = !error && value === fact.authored;
    this.put(key, same ? undefined : { kind: "field", key, raw, intent: raw === undefined ? { target, field: fact.field, inherit: true } : { target, field: fact.field, value }, ...(error ? { error } : {}) });
  }
  toggleField(target: string, fact: FieldFact): void {
    const next = this.effective(target, fact) !== true;
    // A second flip restores an originally inherited setting rather than creating
    // an override. A staged parent default can still be explicitly overridden.
    const restoring = this.field(target, fact) && next === fact.effective && (fact.authored !== undefined || this.inherited(fact) === fact.effective);
    const supportsFalse = fact.domain.kind === "enum" && fact.domain.values.includes(false);
    this.setField(target, fact, restoring ? fact.authored ?? undefined : !next && !supportsFalse ? undefined : next);
  }
  route(id: string): string {
    return this.state.entries.find((entry): entry is RouteEntry => entry.kind === "route" && entry.route === id)?.value ?? this.state.baseline.models[this.state.mode].routes.find((route) => route.id === id)?.path ?? "";
  }
  setRoute(id: string, value: string): void {
    const baseline = this.state.baseline.models[this.state.mode].routes.find((route) => route.id === id)?.path;
    const error = !value.startsWith("/") || value.trim() !== value || /[\r\n\0]/.test(value) ? "Use a path beginning with / and no surrounding whitespace." : undefined;
    this.put(`route:${id}`, value === baseline ? undefined : { kind: "route", key: `route:${id}`, route: id, value, ...(error ? { error } : {}) });
  }
  triggers(event: string): readonly TriggerBinding[] {
    return this.state.entries.find((entry): entry is TriggerEntry => entry.kind === "triggers" && entry.event === event)?.bindings ?? this.state.baseline.models[this.state.mode].triggers?.filter((binding) => binding.event === event) ?? [];
  }
  setTriggers(event: string, bindings: readonly TriggerBinding[], error?: string): void {
    const baseline = this.state.baseline.models[this.state.mode].triggers?.filter((binding) => binding.event === event) ?? [];
    this.put(`triggers:${event}`, !error && triggerBindingsEqual(bindings, baseline) ? undefined : { kind: "triggers", key: `triggers:${event}`, event, bindings, ...(error ? { error } : {}) });
  }
  description(entity: string): string {
    return this.state.entries.find((entry): entry is DescriptionEntry => entry.kind === "description" && entry.entity === entity)?.value ?? this.state.baseline.descriptions.values[entity] ?? "";
  }
  setDescription(entity: string, value: string): void {
    const key = `description:${entity}`;
    const error = descriptionError(value);
    this.put(key, value === (this.state.baseline.descriptions.values[entity] ?? "") ? undefined : { kind: "description", key, entity, value, ...(error ? { error } : {}) });
  }
  resourceForm(resource: ModelResource): ResourceForm { return this.state.entries.find((entry): entry is ResourceEntry => entry.kind === "resource" && entry.intent.resource === resource.id)?.form ?? initialResourceForm(resource); }
  setResource(resource: ModelResource, form: ResourceForm): void {
    const requirements: Record<string, "required" | "optional"> = {};
    for (const [target, policy] of Object.entries(form.requirements)) {
      const rules = this.state.baseline.models[this.state.mode].targets.find((item) => item.ref === target)?.requirementRules?.filter((rule) => rule.require.includes(resource.id)) ?? [];
      if (policy === "optional" ? rules.length > 0 : !rules.some((rule) => !rule.when)) requirements[target] = policy;
    }
    const intent: ResourceIntent = { resource: resource.id, required: form.required ?? !!resource.required, kind: form.secret ? "secret" : "input", default: form.secret || !form.hasDefault ? null : form.fallback, group: form.group.trim(), requirements };
    const count = Number(intent.required !== !!resource.required) + Number(intent.kind !== resource.kind) + Number(intent.default !== (resource.default ?? null)) + Number(intent.group !== (resource.path.length > 1 ? resource.path[0] : "")) + Object.keys(requirements).length;
    const error = !form.secret && form.hasDefault && !form.fallback.trim() ? "Enter a default value or turn Default value off." : intent.group && !/^[A-Za-z_$][\w$]*$/.test(intent.group) ? "Use a single valid group name." : undefined;
    this.put(`resource:${resource.id}`, count ? { kind: "resource", key: `resource:${resource.id}`, form: { ...form, requirements }, intent, count, ...(error ? { error } : {}) } : undefined);
  }
  environment(mode: Mode): EnvironmentEntry | undefined { return this.state.entries.find((entry): entry is EnvironmentEntry => entry.kind === "environment" && entry.mode === mode); }
  setEnvironment(mode: Mode, hash: string, edits: readonly EnvironmentEdit[], existingNames: readonly string[]): void {
    const changed = edits.filter((edit) => edit.create || edit.value !== edit.original);
    const names = new Set<string>();
    let error: string | undefined;
    for (const edit of changed) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(edit.name)) error = "Enter a variable name using letters, digits and underscores, starting with a letter or underscore.";
      else if (names.has(edit.name) || (edit.create && existingNames.includes(edit.name))) error = "Each environment variable must have a unique name.";
      else if (edit.value.includes("\0")) error = "Environment values cannot contain null characters.";
      else if (edit.name === "PROD_DEPLOYMENT" && edit.value !== String(mode === "prod")) error = "PROD_DEPLOYMENT must match the environment file's mode.";
      names.add(edit.name);
    }
    const key = `environment:${mode}`;
    this.put(key, changed.length ? { kind: "environment", key, mode, hash, edits: changed, ...(error ? { error } : {}) } : undefined);
  }
  requestNavigation(proceed: () => void, cancel = () => {}): void {
    if (this.state.busy === "apply") { cancel(); return; }
    if (!this.dirty) { proceed(); return; }
    this.navigation?.cancel();
    if (this.state.busy === "review") ++this.serial;
    this.navigation = { proceed, cancel };
    this.publish({ ...this.state, pendingNavigation: true, reviewOpen: false, review: undefined, busy: undefined });
  }
  keepEditing(): void {
    const navigation = this.navigation; this.navigation = undefined;
    this.publish({ ...this.state, pendingNavigation: false }); navigation?.cancel();
  }
  discard(): void {
    this.keepEditing(); ++this.serial;
    this.publish({ baseline: this.state.latest, latest: this.state.latest, selected: this.state.selected, mode: this.state.mode, entries: [], reviewOpen: false, pendingNavigation: false });
  }
  discardAndContinue(): void {
    const navigation = this.navigation; this.navigation = undefined;
    this.discard(); navigation?.proceed();
  }
  backToEditing(): void {
    if (this.state.busy === "apply") return;
    ++this.serial;
    this.publish({ ...this.state, reviewOpen: false, review: undefined, busy: undefined });
  }
  async review(): Promise<void> {
    this.keepEditing();
    if (!this.dirty || this.state.busy) return;
    if (this.conflict || this.invalid) { this.publish({ ...this.state, error: this.conflict ? "Source files changed while you were editing. Your draft is preserved. Discard it to load the latest configuration." : "Fix the highlighted values before reviewing." }); return; }
    const serial = ++this.serial;
    const state = this.state;
    this.publish({ ...state, reviewOpen: true, review: undefined, busy: "review", error: undefined });
    try {
      const resource = state.entries.find((entry): entry is ResourceEntry => entry.kind === "resource");
      const environment = state.entries.find((entry): entry is EnvironmentEntry => entry.kind === "environment");
      if ((resource || environment) && state.entries.length !== 1) throw new Error("Review this configuration in its own inspector session.");
      const review: Review = environment
        ? { kind: "environment", plan: await this.transport.inputPlan(environment.mode, environment.edits.map(({ name, value, create }) => ({ name, value, ...(create ? { create } : {}) })), environment.hash, state.baseline.revision) }
        : resource
        ? { kind: "resource", plan: await this.transport.resourcePlan(resource.intent, state.baseline.revision, state.mode) }
        : { kind: "batch", plan: await this.transport.planBatch(state.entries.map((entry): DraftEdit => {
          if (entry.kind === "field") return { kind: "field", intent: entry.intent };
          if (entry.kind === "description") return { kind: "description", entity: entry.entity, value: entry.value };
          if (entry.kind === "route") return { kind: "route", route: entry.route, value: entry.value };
          if (entry.kind === "triggers") return { kind: "triggers", event: entry.event, bindings: entry.bindings };
          throw new Error("Review this configuration in its own inspector session.");
        }), state.baseline.revision) };
      if (serial === this.serial) this.publish({ ...this.state, busy: undefined, review });
    } catch (error) { if (serial === this.serial) this.publish({ ...this.state, busy: undefined, error: error instanceof Error ? error.message : String(error) }); }
  }
  async apply(): Promise<ApplyResponse | ResourceApply | undefined> {
    const review = this.state.review;
    if (!review?.plan.ok || this.state.busy || this.invalid || this.conflict) return;
    this.publish({ ...this.state, busy: "apply", error: undefined });
    try {
      const result = await (review.kind === "batch" ? this.transport.applyBatch(review.plan.planId) : review.kind === "environment" ? this.transport.inputApply(review.plan.planId) : this.transport.resourceApply(review.plan.planId));
      if (result.status !== "applied") throw new Error(result.message);
      const latest = await this.transport.snapshot().catch(() => this.state.latest);
      ++this.serial;
      this.publish({ baseline: latest, latest, selected: this.state.selected, mode: this.state.mode, entries: [], reviewOpen: false, pendingNavigation: false });
      return result;
    } catch (error) {
      this.publish({ ...this.state, busy: undefined, reviewOpen: false, review: undefined, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
}

export function protectBeforeUnload(event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">, dirty: boolean): void {
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
}
