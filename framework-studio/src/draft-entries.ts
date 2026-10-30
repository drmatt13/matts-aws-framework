import type { DraftEdit, EditIntent, LiteralValue } from "../shared/api";
import type { Mode, ModelResource, Snapshot } from "../shared/model";
import { inputModeIntents, type ResourceIntent } from "../shared/resources";
import type { DeploymentInputEdit } from "../shared/deployment-inputs";
import type { FailureDestinationSettings, TriggerBinding } from "../shared/triggers";
import type { ClientEnvironmentMappings } from "../shared/client-environment";
import type { DatabasePlacementEdit } from "../shared/managed-database";
import type { DatabaseSettingsInput } from "@repo/framework/config/database";
import type { CreationKind, CreationRequest } from "../shared/creation";
import type { NetworkSettings, PlacementEdit } from "../shared/networks";

export interface EnvironmentEdit extends DeploymentInputEdit { readonly key: string; readonly original?: string }
export interface EnvironmentEntry { readonly kind: "environment"; readonly key: string; readonly mode: Mode; readonly hash: string; readonly edits: readonly EnvironmentEdit[]; readonly error?: string }
/** One graph's column of the input settings. An empty default means none. */
export interface ResourceModeForm {
  readonly present: boolean;
  readonly required: boolean;
  readonly default: string;
  readonly value?: string;
}
export interface ResourceForm {
  readonly secret: boolean;
  readonly fromEnv?: string | null;
  readonly modes: Readonly<Record<Mode, ResourceModeForm>>;
  readonly group: string;
  readonly requirements: ResourceIntent["requirements"];
}
export interface FieldEntry { readonly kind: "field"; readonly key: string; readonly raw: LiteralValue | undefined; readonly intent: EditIntent; readonly error?: string }
export interface RouteEntry { readonly kind: "route"; readonly key: string; readonly route: string; readonly value: string; readonly error?: string }
export interface DescriptionEntry { readonly kind: "description"; readonly key: string; readonly entity: string; readonly value: string; readonly error?: string }
export interface TagsEntry { readonly kind: "tags"; readonly key: string; readonly entity: string; readonly tags: Readonly<Record<string, string>>; readonly error?: string }
export interface RenameEntry { readonly kind: "rename"; readonly key: string; readonly entity: string; readonly name: string; readonly error?: string }
export interface DisplayNameEntry { readonly kind: "displayName"; readonly key: string; readonly entity: string; readonly value: string | null; readonly error?: string }
export type NameEntry = RenameEntry | DisplayNameEntry;
export interface ResourceEntry { readonly kind: "resource"; readonly key: string; readonly intent: ResourceIntent; readonly form: ResourceForm; readonly count: number; readonly error?: string }
export interface TriggerEntry { readonly kind: "triggers"; readonly key: string; readonly event: string; readonly bindings: readonly TriggerBinding[]; readonly error?: string }
export interface NativeEntry { readonly kind: "native"; readonly key: string; readonly edge: string; readonly error?: string }
export interface FailureEntry { readonly kind: "failure"; readonly key: string; readonly event: string; readonly value: FailureDestinationSettings | null; readonly error?: string }
export interface ClientMappingEntry { readonly kind: "clientEnvironment"; readonly key: string; readonly mappings: ClientEnvironmentMappings; readonly count: number; readonly error?: string }
export interface CreationEntry { readonly kind: "create"; readonly key: "create"; readonly resourceKind: CreationKind; readonly form: Readonly<Record<string, string | number | boolean>>; readonly request?: CreationRequest; readonly error?: string; readonly inputSettings?: { readonly defaultValue: string; readonly choices: string; readonly linkedToEnv: boolean; readonly value: string } }
export interface PlacementEntry { readonly kind: "placement"; readonly key: string; readonly edit: PlacementEdit; readonly error?: string }
export interface NetworkEntry { readonly kind: "network"; readonly key: string; readonly network: string; readonly settings: NetworkSettings; readonly error?: string }
export interface NetworkRemovalEntry { readonly kind: "removeNetwork"; readonly key: string; readonly network: string; readonly error?: string }
export interface DatabaseEntry { readonly kind: "database"; readonly key: string; readonly database: string; readonly settings: DatabaseSettingsInput; readonly error?: string }
export interface DatabasePlacementEntry { readonly kind: "databasePlacement"; readonly key: string; readonly edit: DatabasePlacementEdit; readonly error?: string }
export interface OperationEntry { readonly kind: "operation"; readonly key: string; readonly operation: Extract<DraftEdit, { kind: "deploy" | "implementation" | "connection" | "removeWorkload" | "identityPolicy" }>; readonly error?: string }
export type DraftEntry =
  | NameEntry | OperationEntry | TagsEntry | DatabasePlacementEntry | DatabaseEntry
  | NetworkRemovalEntry | PlacementEntry | NetworkEntry | CreationEntry | FieldEntry
  | RouteEntry | DescriptionEntry | ResourceEntry | EnvironmentEntry | TriggerEntry
  | NativeEntry | FailureEntry | ClientMappingEntry;

export function initialResourceForm(resource: ModelResource): ResourceForm {
  const modes = inputModeIntents(resource);
  const column = (mode: Mode): ResourceModeForm => ({ present: modes[mode].present, required: modes[mode].required, default: modes[mode].default ?? "", ...(resource.fromEnv ? {} : { value: modes[mode].value ?? resource.authoredValue ?? "" }) });
  return { secret: resource.kind === "secret", fromEnv: resource.fromEnv ?? null, modes: { dev: column("dev"), prod: column("prod") }, group: resource.path.length > 1 ? resource.path[0]! : "", requirements: {} };
}

/** Normalize authored form values without reading private environment contents. */
export function normalizeResourceEntry(
  snapshot: Snapshot,
  mode: Mode,
  resource: ModelResource,
  form: ResourceForm,
  codeRenamePending: boolean,
): ResourceEntry | undefined {
  const requirements: Record<string, "required" | "optional"> = {};
  for (const [target, policy] of Object.entries(form.requirements)) {
    const rules = snapshot.models[mode].targets.find((item) => item.ref === target)?.requirementRules?.filter((rule) => rule.require.includes(resource.id)) ?? [];
    if (policy === "optional" ? rules.length > 0 : !rules.some((rule) => !rule.when)) requirements[target] = policy;
  }
  // A graph that does not hold the input keeps nothing for it, and a secret keeps no default.
  const fromEnv = form.fromEnv === undefined ? resource.fromEnv ?? null : form.fromEnv;
  const linked = fromEnv !== null;
  const column = ({ present, required, default: fallback, value }: ResourceModeForm) => ({ present, required: present && linked && required,
    default: present && linked && !form.secret && fallback.trim() ? fallback : null,
    ...(!linked && !form.secret ? { value: present ? value ?? fallback : null } : {}) });
  const intent: ResourceIntent = { resource: resource.id, kind: form.secret ? "secret" : "input", fromEnv, modes: { dev: column(form.modes.dev), prod: column(form.modes.prod) }, group: form.group.trim(), requirements };
  const saved = inputModeIntents(resource);
  const settings = (["dev", "prod"] as const).reduce((sum, mode) => sum + Number(intent.modes[mode].present !== saved[mode].present) + Number(intent.modes[mode].required !== saved[mode].required) + Number(intent.modes[mode].default !== saved[mode].default) + Number((intent.modes[mode].value ?? null) !== (saved[mode].value ?? null)), 0);
  const count = settings + Number(fromEnv !== (resource.fromEnv ?? null)) + Number(intent.kind !== resource.kind) + Number(intent.group !== (resource.path.length > 1 ? resource.path[0] : "")) + Object.keys(requirements).length;
  const missingValue = !linked && (["dev", "prod"] as const).some(mode => intent.modes[mode].present && !intent.modes[mode].value?.trim());
  const invalidValue = !linked && resource.values && (["dev", "prod"] as const).some(mode => intent.modes[mode].present && !resource.values!.includes(intent.modes[mode].value ?? ""));
  const reparenting = intent.group !== (resource.path.length > 1 ? resource.path[0] : "");
  const error = reparenting && codeRenamePending ? "Apply or discard the code rename before moving this input to another group." : !intent.modes.dev.present && !intent.modes.prod.present ? "Keep this input in at least one environment." : form.secret && !linked ? "Secrets require an environment-file link." : linked && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(fromEnv) ? "Use a SCREAMING_SNAKE_CASE environment variable name." : missingValue ? "Enter a value for each environment that holds this input." : invalidValue ? "Choose one of the allowed values for each environment." : intent.group && !/^[A-Za-z_$][\w$]*$/.test(intent.group) ? "Use a single valid group name." : undefined;
  return count ? { kind: "resource", key: `resource:${resource.id}`, form: { ...form, requirements }, intent, count, ...(error ? { error } : {}) } : undefined;
}

/** Convert a staged source edit to the existing batch protocol; private sessions stay separate. */
export function toDraftEdit(entry: DraftEntry): DraftEdit {
  if (entry.kind === "rename") return { kind: "rename", entity: entry.entity, name: entry.name.trim() };
  if (entry.kind === "displayName") return { kind: "displayName", entity: entry.entity, value: entry.value };
  if (entry.kind === "resource") return { kind: "resourceConfig", intent: entry.intent };
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
}
