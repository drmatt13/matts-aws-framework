import { networkCreationProblem, unusedNetworkCidr, networkSettings, type NetworkSettings, type PlacementEdit } from "../shared/networks";
import type { ApplyResponse, BatchPlanResponse, DraftEdit, EditIntent, LiteralValue } from "../shared/api";
import type { FieldFact, Mode, ModelResource, Snapshot } from "../shared/model";
import { inputModeIntents, type ResourceApply, type ResourceIntent, type ResourcePlan } from "../shared/resources";
import type { DeploymentInputEdit, DeploymentInputPlan } from "../shared/deployment-inputs";
import { descriptionError } from "../shared/descriptions";
import { triggerBindingsEqual, type FailureDestinationSettings, type TriggerBinding } from "../shared/triggers";
import { CLIENT_ENVIRONMENT_ID, clientMappingsError, type ClientEnvironmentMappings } from "../shared/client-environment";
import { readDatabaseDraft, readDatabasePlacementDraft, type DatabasePlacementEdit } from "../shared/managed-database";
import type { DatabaseSettingsInput } from "@repo/framework/config/database";
import { validateTags } from "@repo/framework/config/tags";

import { CREATORS, creationDefaults, readCreationRequest, type CreationKind, type CreationRequest } from "../shared/creation";

export type Review = { readonly kind: "batch"; readonly plan: BatchPlanResponse } | { readonly kind: "resource"; readonly plan: ResourcePlan } | { readonly kind: "environment"; readonly plan: DeploymentInputPlan };
export interface EnvironmentEdit extends DeploymentInputEdit { readonly key: string; readonly original?: string }
interface EnvironmentEntry { readonly kind: "environment"; readonly key: string; readonly mode: Mode; readonly hash: string; readonly edits: readonly EnvironmentEdit[]; readonly error?: string }
/** One graph's column of the input settings. An empty default means none. */
export interface ResourceModeForm { readonly present: boolean; readonly required: boolean; readonly default: string }
export interface ResourceForm { readonly secret: boolean; readonly modes: Readonly<Record<Mode, ResourceModeForm>>; readonly group: string; readonly requirements: ResourceIntent["requirements"] }
interface FieldEntry { readonly kind: "field"; readonly key: string; readonly raw: LiteralValue | undefined; readonly intent: EditIntent; readonly error?: string }
interface RouteEntry { readonly kind: "route"; readonly key: string; readonly route: string; readonly value: string; readonly error?: string }
interface DescriptionEntry { readonly kind: "description"; readonly key: string; readonly entity: string; readonly value: string; readonly error?: string }
interface TagsEntry { readonly kind: "tags"; readonly key: string; readonly entity: string; readonly tags: Readonly<Record<string, string>>; readonly error?: string }
interface ResourceEntry { readonly kind: "resource"; readonly key: string; readonly intent: ResourceIntent; readonly form: ResourceForm; readonly count: number; readonly error?: string }
interface TriggerEntry { readonly kind: "triggers"; readonly key: string; readonly event: string; readonly bindings: readonly TriggerBinding[]; readonly error?: string }
interface NativeEntry { readonly kind: "native"; readonly key: string; readonly edge: string; readonly error?: string }
interface FailureEntry { readonly kind: "failure"; readonly key: string; readonly event: string; readonly value: FailureDestinationSettings | null; readonly error?: string }
interface ClientMappingEntry { readonly kind: "clientEnvironment"; readonly key: string; readonly mappings: ClientEnvironmentMappings; readonly count: number; readonly error?: string }
export interface CreationEntry { readonly kind: "create"; readonly key: "create"; readonly resourceKind: CreationKind; readonly form: Readonly<Record<string, string | number | boolean>>; readonly request?: CreationRequest; readonly error?: string; readonly inputSettings?: { readonly defaultValue: string; readonly choices: string } }
export interface PlacementEntry { readonly kind: "placement"; readonly key: string; readonly edit: PlacementEdit; readonly error?: string }
export interface NetworkEntry { readonly kind: "network"; readonly key: string; readonly network: string; readonly settings: NetworkSettings; readonly error?: string }
export interface NetworkRemovalEntry { readonly kind: "removeNetwork"; readonly key: string; readonly network: string; readonly error?: string }
export interface DatabaseEntry { readonly kind: "database"; readonly key: string; readonly database: string; readonly settings: DatabaseSettingsInput; readonly error?: string }
export interface DatabasePlacementEntry { readonly kind: "databasePlacement"; readonly key: string; readonly edit: DatabasePlacementEdit; readonly error?: string }
export interface OperationEntry { readonly kind: "operation"; readonly key: string; readonly operation: Extract<DraftEdit, { kind: "deploy" | "implementation" | "connection" | "removeWorkload" | "identityPolicy" }>; readonly error?: string }
export type DraftEntry = OperationEntry | TagsEntry | DatabasePlacementEntry | DatabaseEntry | NetworkRemovalEntry | PlacementEntry | NetworkEntry | CreationEntry | FieldEntry | RouteEntry | DescriptionEntry | ResourceEntry | EnvironmentEntry | TriggerEntry | NativeEntry | FailureEntry | ClientMappingEntry;
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
export function initialResourceForm(resource: ModelResource): ResourceForm {
  const modes = inputModeIntents(resource);
  const column = (mode: Mode): ResourceModeForm => ({ present: modes[mode].present, required: modes[mode].required, default: modes[mode].default ?? "" });
  return { secret: resource.kind === "secret", modes: { dev: column("dev"), prod: column("prod") }, group: resource.path.length > 1 ? resource.path[0]! : "", requirements: {} };
}

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
  get count(): number { return this.state.entries.reduce((sum, entry) => sum + (entry.kind === "resource" || entry.kind === "clientEnvironment" ? entry.count : entry.kind === "environment" ? entry.edits.length : 1), 0); }
  get dirty(): boolean { return this.count > 0; }
  get conflict(): boolean { return this.dirty && this.state.baseline.revision !== this.state.latest.revision; }
  get invalid(): boolean { return this.state.entries.some((entry) => !!entry.error); }
  reviewAgainstLatest(): void {
    if (this.state.busy || !this.conflict) return;
    if (this.state.entries.some(entry => entry.kind === "environment" || entry.kind === "resource")) { this.publish({ ...this.state, error: "The selected input file or catalog changed. Preserve your values, then reload that inspector before reviewing." }); return; }
    ++this.serial;
    this.publish({ ...this.state, baseline: this.state.latest, reviewOpen: false, review: undefined, error: undefined });
    void this.review();
  }
  private publish(state: DraftState): void { this.state = state; this.listeners.forEach((listener) => listener()); }
  sync(snapshot: Snapshot, selected: string | undefined, mode: Mode): void {
    if (this.state.latest === snapshot && this.state.selected === selected && this.state.mode === mode) return;
    if (this.dirty || this.state.busy) { this.publish({ ...this.state, latest: snapshot }); return; }
    this.publish({ baseline: snapshot, latest: snapshot, selected, mode, entries: [], reviewOpen: false, pendingNavigation: false });
  }
  private put(key: string, entry: DraftEntry | undefined): void {
    // An accepted write cannot be cancelled by a control still dispatching an
    // event. Keep the reviewed entries and busy state until the server answers.
    if (this.state.busy === "apply") return;
    ++this.serial;
    this.publish({ ...this.state, entries: [...this.state.entries.filter((item) => item.key !== key), ...(entry ? [entry] : [])], reviewOpen: false, review: undefined, error: undefined, busy: undefined });
    if (!this.dirty && this.state.baseline !== this.state.latest) this.publish({ ...this.state, baseline: this.state.latest });
  }
  stageOperation(operation: OperationEntry["operation"]): void {
    const key = `operation:${operation.kind}:${operation.target}:${operation.kind === "connection" ? JSON.stringify([operation.connection, operation.destination, operation.variable, operation.grant, operation.scope]) : ""}`;
    if (operation.kind === "deploy") {
      const saved = this.state.baseline.models[this.state.mode].targets.find(target => target.ref === operation.target)?.lanes;
      const original = saved?.when ? { when: { resource: saved.when.resource, equals: saved.when.equals } } : saved?.origin === "default" ? "inherit" : saved?.deploy;
      if (JSON.stringify(original) === JSON.stringify(operation.value)) { this.put(key, undefined); return; }
    }
    this.put(key, { kind: "operation", key, operation, ...(operation.kind === "deploy" && typeof operation.value !== "string" && !operation.value.when.equals.trim() ? { error: "Enter a matching value." } : {}) });
  }
  discardOperation(key: string): void {
    if (this.state.busy || !this.state.entries.some(entry => entry.key === key && entry.kind === "operation")) return;
    this.put(key, undefined);
  }
  placement(target: string): PlacementEdit | undefined {
    return this.state.entries.find((entry): entry is PlacementEntry => entry.kind === "placement" && entry.edit.target === target)?.edit;
  }
  setPlacement(edit: PlacementEdit): void {
    const base = this.state.baseline.models[this.state.mode].targets.find(target => target.ref === edit.target)?.placement;
    const unchanged = base?.kind === "vpc" ? base.networkId === edit.vpc && base.subnet === edit.subnet : edit.vpc === null && edit.subnet === "none";
    this.put(`placement:${edit.target}`, unchanged ? undefined : { kind: "placement", key: `placement:${edit.target}`, edit });
  }
  network(id: string): NetworkSettings | undefined {
    return this.state.entries.find((entry): entry is NetworkEntry => entry.kind === "network" && entry.network === id)?.settings
      ?? this.state.baseline.models[this.state.mode].networks?.filter(network => network.id === id).map(networkSettings)[0];
  }
  setNetwork(id: string, settings: NetworkSettings): void {
    let error: string | undefined;
    try { readCreationRequest({ kind: "vpc", id, description: "", ...settings }); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    const base = this.state.baseline.models[this.state.mode].networks?.find(network => network.id === id);
    if (base?.cidr !== settings.cidr) error ??= networkCreationProblem({ id, ...settings }, Object.values(this.state.baseline.models).flatMap(model => model.networks ?? []), true)?.message;
    this.put(`network:${id}`, base && JSON.stringify(networkSettings(base)) === JSON.stringify(settings) ? undefined : { kind: "network", key: `network:${id}`, network: id, settings, error });
  }
  removeNetwork(id: string): void {
    if (this.dirty) throw new Error("Apply or discard pending changes before removing a VPC.");
    this.put(`removeNetwork:${id}`, { kind: "removeNetwork", key: `removeNetwork:${id}`, network: id });
  }
  database(id: string): DatabaseSettingsInput | undefined {
    return this.state.entries.find((entry): entry is DatabaseEntry => entry.kind === "database" && entry.database === id)?.settings
      ?? this.state.baseline.models[this.state.mode].managedDatabase?.authored;
  }
  setDatabase(id: string, settings: DatabaseSettingsInput): void {
    let error: string | undefined;
    try { readDatabaseDraft({ kind: "database", database: id, settings }); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    const base = this.state.baseline.models[this.state.mode].managedDatabase;
    this.put(`database:${id}`, base?.id === id && JSON.stringify(base.authored) === JSON.stringify(settings) ? undefined : { kind: "database", key: `database:${id}`, database: id, settings, error });
  }
  databasePlacement(id: string): DatabasePlacementEdit | undefined {
    return this.state.entries.find((entry): entry is DatabasePlacementEntry => entry.kind === "databasePlacement" && entry.edit.database === id)?.edit;
  }
  setDatabasePlacement(edit: DatabasePlacementEdit): void {
    let error: string | undefined;
    try { readDatabasePlacementDraft(edit); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    if (!this.state.baseline.models[this.state.mode].networks?.some(network => network.id === edit.vpc)) error ??= "Select a registered VPC.";
    const base = this.state.baseline.models[this.state.mode].managedDatabase;
    this.put(`databasePlacement:${edit.database}`, base?.id === edit.database && base.networkId === edit.vpc && base.subnet === edit.subnet ? undefined : { kind: "databasePlacement", key: `databasePlacement:${edit.database}`, edit, error });
  }
  creation(): CreationEntry | undefined { return this.state.entries.find((entry): entry is CreationEntry => entry.kind === "create"); }
  beginCreation(kind: CreationKind): void {
    if (this.creation()?.resourceKind === kind) return;
    if (this.dirty) throw new Error("Apply or discard pending changes before starting another creation.");
    const form = creationDefaults(kind);
    const defaults = this.state.baseline.models[this.state.mode].fields;
    const inherit = (key: string, group: string, field: string) => {
      const value = defaults[`defaults:${group}`]?.find((fact) => fact.field === `defaults.${group}.${field}`)?.effective;
      const choices = CREATORS[kind].fields.find((field) => field.key === key)?.options;
      if (value !== undefined && (!choices || choices.includes(String(value)))) form[key] = value;
    };
    if (kind === "function" || kind === "route") {
      for (const key of ["runtime", "architecture", "subnet"] as const) inherit(key, "lambda", key);
      inherit("memory", "lambda", "memorySize"); inherit("timeout", "lambda", "timeoutSeconds");
    }
    if (kind === "service" || kind === "task") for (const key of ["architecture", "subnet"] as const) inherit(key, "container", key);
    if (kind === "vpc") {
      form.cidr = unusedNetworkCidr(Object.values(this.state.baseline.models).flatMap(model => model.networks ?? [])) ?? "";
    }
    this.setCreation(kind, form);
  }
  setCreation(resourceKind: CreationKind, form: CreationEntry["form"], errorOverride?: string): void {
    let request: CreationRequest | undefined;
    let error: string | undefined;
    try { request = readCreationRequest({ kind: resourceKind, ...form }); }
    catch (problem) { error = problem instanceof Error ? problem.message : String(problem); }
    error = errorOverride ?? error;
    // Keep parameter-only editor values outside the strict secret form/request.
    // The draft outlives the wizard when returning to the resource chooser.
    const inputSettings = resourceKind === "input" ? { defaultValue: String(form.defaultValue ?? ""), choices: String(form.choices ?? "") }
      : resourceKind === "secret" ? this.creation()?.inputSettings : undefined;
    this.put("create", { kind: "create", key: "create", resourceKind, form, request, error, ...(inputSettings ? { inputSettings } : {}) });
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
  /** The event's failure destination: staged, else declared; undefined when it has none. */
  failure(event: string): FailureDestinationSettings | undefined {
    const entry = this.state.entries.find((item): item is FailureEntry => item.kind === "failure" && item.event === event);
    if (entry) return entry.value ?? undefined;
    const declared = this.state.baseline.models[this.state.mode].failureDestinations?.find((item) => item.event === event);
    return declared && { destination: declared.destination, ...(declared.retryAttempts !== undefined ? { retryAttempts: declared.retryAttempts } : {}), ...(declared.maxEventAgeSeconds !== undefined ? { maxEventAgeSeconds: declared.maxEventAgeSeconds } : {}) };
  }
  setFailure(event: string, value: FailureDestinationSettings | null): void {
    const declared = this.state.baseline.models[this.state.mode].failureDestinations?.find((item) => item.event === event);
    const canonical = (item: FailureDestinationSettings | null | undefined) => item ? JSON.stringify([item.destination, item.retryAttempts ?? null, item.maxEventAgeSeconds ?? null]) : "";
    this.put(`failure:${event}`, canonical(value) === canonical(declared) ? undefined : { kind: "failure", key: `failure:${event}`, event, value });
  }
  /** A native trigger staged for deletion from its CDK stack file. */
  nativeRemoved(edge: string): boolean {
    return this.state.entries.some((entry) => entry.kind === "native" && entry.edge === edge);
  }
  removeNative(edge: string): void { this.put(`native:${edge}`, { kind: "native", key: `native:${edge}`, edge }); }
  restoreNative(edge: string): void { this.put(`native:${edge}`, undefined); }
  description(entity: string): string {
    return this.state.entries.find((entry): entry is DescriptionEntry => entry.kind === "description" && entry.entity === entity)?.value ?? this.state.baseline.descriptions.values[entity] ?? "";
  }
  tags(entity: string): Readonly<Record<string, string>> {
    return this.state.entries.find((entry): entry is TagsEntry => entry.kind === "tags" && entry.entity === entity)?.tags ?? this.state.baseline.models[this.state.mode].tagging?.[entity]?.authored ?? {};
  }
  changeTags(entity: string, tags: Readonly<Record<string, string>>, error?: string): void {
    try { validateTags(tags, `${entity}.tags`); } catch (reason) { error ??= reason instanceof Error ? reason.message : String(reason); }
    const base = this.state.baseline.models[this.state.mode].tagging?.[entity]?.authored ?? {};
    const signature = (value: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    this.put(`tags:${entity}`, !error && signature(tags) === signature(base) ? undefined : { kind: "tags", key: `tags:${entity}`, entity, tags, ...(error ? { error } : {}) });
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
    // A graph that does not hold the input keeps nothing for it, and a secret keeps no default.
    const column = ({ present, required, default: fallback }: ResourceModeForm) => ({ present, required: present && required, default: present && !form.secret && fallback.trim() ? fallback : null });
    const intent: ResourceIntent = { resource: resource.id, kind: form.secret ? "secret" : "input", modes: { dev: column(form.modes.dev), prod: column(form.modes.prod) }, group: form.group.trim(), requirements };
    const saved = inputModeIntents(resource);
    const settings = (["dev", "prod"] as const).reduce((sum, mode) => sum + Number(intent.modes[mode].present !== saved[mode].present) + Number(intent.modes[mode].required !== saved[mode].required) + Number(intent.modes[mode].default !== saved[mode].default), 0);
    const count = settings + Number(intent.kind !== resource.kind) + Number(intent.group !== (resource.path.length > 1 ? resource.path[0] : "")) + Object.keys(requirements).length;
    const error = !intent.modes.dev.present && !intent.modes.prod.present ? "Keep this input in at least one environment." : intent.group && !/^[A-Za-z_$][\w$]*$/.test(intent.group) ? "Use a single valid group name." : undefined;
    this.put(`resource:${resource.id}`, count ? { kind: "resource", key: `resource:${resource.id}`, form: { ...form, requirements }, intent, count, ...(error ? { error } : {}) } : undefined);
  }
  environment(mode: Mode): EnvironmentEntry | undefined { return this.state.entries.find((entry): entry is EnvironmentEntry => entry.kind === "environment" && entry.mode === mode); }
  clientMappings(): ClientEnvironmentMappings {
    return this.state.entries.find((entry): entry is ClientMappingEntry => entry.kind === "clientEnvironment")?.mappings
      ?? this.state.baseline.models[this.state.mode].resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment?.mappings ?? {};
  }
  setClientMappings(mappings: ClientEnvironmentMappings): void {
    const baseline = this.state.baseline.models[this.state.mode].resources.find((resource) => resource.id === CLIENT_ENVIRONMENT_ID)?.clientEnvironment?.mappings ?? {};
    const count = [...new Set([...Object.keys(baseline), ...Object.keys(mappings)])].filter((name) => JSON.stringify(baseline[name]) !== JSON.stringify(mappings[name])).length;
    const error = clientMappingsError(mappings);
    this.put("clientEnvironment", count ? { kind: "clientEnvironment", key: "clientEnvironment", mappings, count, ...(error ? { error } : {}) } : undefined);
  }
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
    if (this.state.busy === "apply") return;
    this.keepEditing(); ++this.serial;
    this.publish({ baseline: this.state.latest, latest: this.state.latest, selected: this.state.selected, mode: this.state.mode, entries: [], reviewOpen: false, pendingNavigation: false });
  }
  discardAndContinue(): void {
    if (this.state.busy === "apply") return;
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
          if (entry.kind === "operation") return entry.operation;
          if (entry.kind === "removeNetwork") return { kind: "removeNetwork", network: entry.network };
          if (entry.kind === "database") return { kind: "database", database: entry.database, settings: entry.settings };
          if (entry.kind === "databasePlacement") return entry.edit;
          if (entry.kind === "placement") return { kind: "placement", ...entry.edit };
          if (entry.kind === "network") return { kind: "network", network: entry.network, settings: entry.settings };
          if (entry.kind === "create" && entry.request) return { kind: "create", request: entry.request };
          if (entry.kind === "field") return { kind: "field", intent: entry.intent };
          if (entry.kind === "description") return { kind: "description", entity: entry.entity, value: entry.value };
          if (entry.kind === "tags") return { kind: "tags", entity: entry.entity, tags: entry.tags };
          if (entry.kind === "route") return { kind: "route", route: entry.route, value: entry.value };
          if (entry.kind === "triggers") return { kind: "triggers", event: entry.event, bindings: entry.bindings };
          if (entry.kind === "native") return { kind: "nativeTrigger", edge: entry.edge };
          if (entry.kind === "failure") return { kind: "onFailure", event: entry.event, value: entry.value };
          if (entry.kind === "clientEnvironment") return { kind: "clientEnvironment", mappings: entry.mappings };
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
