import type { Snapshot } from "./model";
import type { TriggerAdapterMetadata, TriggerBinding, TriggerField } from "./triggers";

export interface TriggerProblem {
  readonly message: string;
  /** `form`: fix it in the form. `source`: change the stack or Lambda first. `warning`: allowed, with a consequence. `advice`: AWS guidance only. */
  readonly kind: "form" | "source" | "warning" | "advice";
  /** The option (or `id`, `accepts`, `resource`, `event`) it belongs to. */
  readonly field?: string;
}

export interface TriggerDraft {
  readonly event: string;
  readonly resource: string;
  readonly adapter: string;
  readonly id: string;
  /** The acknowledged handler contract, or "" before it is acknowledged. */
  readonly accepts: string;
  readonly options: Readonly<Record<string, unknown>>;
  /** Raw text the form could not parse, by option name. */
  readonly unparsed?: Readonly<Record<string, string>>;
}

export const blockingProblems = (problems: readonly TriggerProblem[]): readonly TriggerProblem[] => problems.filter((problem) => problem.kind === "form" || problem.kind === "source");
const adapterOf = (snapshot: Snapshot, kind: string) => snapshot.models.dev.triggerAdapters?.find((item) => item.kind === kind);

type Requirement = NonNullable<TriggerAdapterMetadata["requiredFacts"]>[number];
const applies = (requirement: Requirement | TriggerAdapterMetadata["nativeExclusive"], options: Readonly<Record<string, unknown>>): boolean => {
  if (!requirement?.option) return true;
  const value = options[requirement.option];
  if ("above" in requirement && requirement.above !== undefined) return typeof value === "number" && value > requirement.above;
  return value === requirement.equals;
};

export function triggerUnavailable(snapshot: Snapshot, resource: string, adapter: string, options: Readonly<Record<string, unknown>> = {}): string | undefined {
  const capability = snapshot.source.triggerCapabilities?.find((item) => item.resource === resource);
  const match = capability?.adapters.find((item) => item.kind === adapter);
  if (!capability || !match) return "Unknown public type; no compatible trigger adapter.";
  if (match.reason) return match.reason;
  const metadata = snapshot.models.dev.triggerAdapters?.find((item) => item.kind === adapter);
  for (const requirement of metadata?.requiredFacts ?? []) if (applies(requirement, options) && capability.facts?.[requirement.name] !== requirement.value) return capability.facts?.[requirement.name] === undefined ? "Resource configuration is unresolved; manual wiring review required." : requirement.reason;
  // A stack not yet constructed in the CDK app still qualifies: the trigger is
  // authored now, and the app adds the stack separately.
  for (const mode of ["dev", "prod"] as const) {
    const field = snapshot.models[mode].resources.find((item) => item.id === resource);
    if (!field || field.absent) return `${mode === "dev" ? "Development" : "Production"} graph does not contain this resource.`;
  }
  if (snapshot.source.cdkLinks.manualWiring.some((item) => item.resource === resource || resource.startsWith(`${item.resource}.`))) return "Manual wiring, review required.";
  if (metadata?.nativeExclusive && applies(metadata.nativeExclusive, options) && snapshot.source.cdkLinks.edges.some((edge) => edge.relation === "trigger" && edge.from === resource)) return metadata.nativeExclusive.reason;
  return undefined;
}

/** A source duration that must cover the event's timeout in both graphs; AWS's larger multiple is advice. */
export function triggerTiming(snapshot: Snapshot, binding: { readonly event: string; readonly resource: string; readonly adapter: string; readonly options: Readonly<Record<string, unknown>> }): { readonly problem?: string; readonly recommendation?: string } {
  const timing = snapshot.models.dev.triggerAdapters?.find((item) => item.kind === binding.adapter)?.timeoutFact;
  if (!timing) return {};
  const seconds = snapshot.source.triggerCapabilities?.find((item) => item.resource === binding.resource)?.facts?.[timing.name];
  if (typeof seconds !== "number") return { problem: `${timing.label} is unresolved; manual review required.` };
  const timeouts = Object.values(snapshot.models).map((model) => model.targets.find((target) => target.id === binding.event && target.role === "event")?.compute).map((compute) => compute?.kind === "lambda" ? compute.timeoutSeconds : undefined);
  if (timeouts.some((value) => value === undefined)) return { problem: "Select an existing event Lambda in both graphs." };
  const timeout = Math.max(...(timeouts as number[]));
  if (seconds < timeout) return { problem: `${timing.label} (${seconds}s) must be at least the function timeout (${timeout}s).` };
  const extra = timing.plusOption && typeof binding.options[timing.plusOption] === "number" ? binding.options[timing.plusOption] as number : 0;
  const recommended = timing.recommendedMultiple * timeout + extra;
  return seconds < recommended ? { recommendation: `AWS recommends at least ${recommended}s (${timing.recommendedMultiple}× the function timeout${timing.plusOption ? " plus the batching window" : ""}); this is ${seconds}s.` } : {};
}

/**
 * Whether this event Lambda can take a source at all: it exists in both graphs,
 * and local replay cannot answer a source that waits for the function's response.
 */
export function eventUnavailable(snapshot: Snapshot, event: string, adapter: string, options: Readonly<Record<string, unknown>> = {}): string | undefined {
  const targets = Object.values(snapshot.models).map((model) => model.targets.find((target) => target.id === event && target.role === "event"));
  if (targets.some((target) => !target)) return "Select an existing event Lambda in both graphs.";
  const metadata = adapterOf(snapshot, adapter);
  if (!metadata || metadata.replay || !targets.some((target) => target!.compute.kind === "lambda" && target!.compute.localReplay)) return undefined;
  const allowed = metadata.replayOperations ?? [];
  if (!allowed.length) return `${event} uses local replay, which cannot return the response ${metadata.label} waits for. Turn off local replay, or choose an asynchronous source.`;
  const chosen = metadata.exclusive ? options[metadata.exclusive] : undefined;
  if (chosen !== undefined && !allowed.includes(String(chosen))) return `${event} uses local replay; only ${allowed.join(", ")} can be replayed.`;
  return undefined;
}

function fieldProblem(field: TriggerField, value: unknown): string | undefined {
  if (value === undefined || value === "") return field.required ? `${field.kind === "enum" || field.kind === "resource" ? "Choose" : field.kind === "boolean" ? "Confirm" : "Enter"} ${field.label.toLowerCase()}.` : undefined;
  if (field.kind === "boolean" && field.required && value !== true) return `Confirm ${field.label.toLowerCase()}.`;
  const range = field.min !== undefined && field.max !== undefined ? ` from ${field.min} to ${field.max}` : "";
  switch (field.kind) {
    case "number": return typeof value === "number" && Number.isInteger(value) && value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity) ? undefined : `${field.label} must be a whole number${range}.`;
    case "enum": return typeof value === "string" && field.values?.includes(value) ? undefined : `Choose a valid ${field.label.toLowerCase()}.`;
    case "json": return value !== null && typeof value === "object" && Array.isArray(value) === !!field.array ? undefined : `${field.label} must be a JSON ${field.array ? "array" : "object"}.`;
    case "resource": return value !== null && typeof value === "object" && "$cdk" in value ? undefined : `Choose ${field.label.toLowerCase()}.`;
    case "boolean": return typeof value === "boolean" ? undefined : `${field.label} must be on or off.`;
    default: return typeof value === "string" ? undefined : `${field.label} must be text.`;
  }
}

/** Studio's mirror of the adapter validators people most often trip; the framework still validates everything at review. */
function adapterRules(kind: string, options: Readonly<Record<string, unknown>>): TriggerProblem[] {
  const problems: TriggerProblem[] = [];
  const add = (field: string, message: string) => problems.push({ kind: "form", field, message });
  if (Array.isArray(options.filters) && options.filters.length > 5) add("filters", "Use at most five filter patterns.");
  if (kind === "sqs" && Number(options.batchSize ?? 10) > 10 && Number(options.batchWindowSeconds ?? 0) < 1) add("batchWindowSeconds", "Batches over ten messages need a batch window of at least one second.");
  if (kind === "sns" && options.filterScope && !options.filterPolicy) add("filterScope", "A filter scope needs a subscription filter.");
  if (kind === "eventbridge" && options.eventPattern && typeof options.eventPattern === "object" && !Object.keys(options.eventPattern).length) add("eventPattern", "Match on at least a source or a detail type.");
  if (kind === "s3") {
    const types = Array.isArray(options.eventTypes) ? options.eventTypes : undefined;
    if (types && !types.length) add("eventTypes", "Choose at least one S3 event.");
    if (types && options.delivery === "eventbridge" && types.some((item) => item !== "s3:ObjectCreated:*" && item !== "s3:ObjectRemoved:*")) add("eventTypes", "EventBridge delivery supports Object created and Object removed only.");
    for (const name of ["prefix", "suffix"] as const) if (typeof options[name] === "string" && (options[name] as string).includes("*")) add(name, `The key ${name} is literal text; wildcards are not supported.`);
  }
  return problems;
}

/**
 * Every reason this trigger cannot be added yet, at once, plus consequences worth
 * knowing. `others` are the drafted bindings besides the one being edited.
 */
export function triggerProblems(snapshot: Snapshot, draft: TriggerDraft, others: readonly TriggerBinding[] = []): readonly TriggerProblem[] {
  const metadata = adapterOf(snapshot, draft.adapter);
  if (!draft.event) return [{ kind: "form", field: "event", message: "Choose an event Lambda." }];
  if (!metadata) return [{ kind: "form", field: "adapter", message: "Choose what triggers it." }];
  const resourceless = metadata.resourceless === true;
  if (!resourceless && !draft.resource) return [{ kind: "form", field: "resource", message: `Choose a ${metadata.label} resource.` }];
  const source: TriggerProblem[] = [], form: TriggerProblem[] = [], notes: TriggerProblem[] = [];
  const { options } = draft;
  const unavailable = resourceless ? undefined : triggerUnavailable(snapshot, draft.resource, draft.adapter, options);
  if (unavailable) source.push({ kind: "source", field: "resource", message: unavailable });
  const eventReason = eventUnavailable(snapshot, draft.event, draft.adapter, options);
  if (eventReason) source.push({ kind: "source", field: "event", message: eventReason });
  if (!resourceless) {
    const timing = triggerTiming(snapshot, { event: draft.event, resource: draft.resource, adapter: draft.adapter, options });
    if (timing.problem) source.push({ kind: "source", message: timing.problem });
    if (timing.recommendation) notes.push({ kind: "advice", message: timing.recommendation });
    const natives = snapshot.source.cdkLinks.edges.filter((edge) => edge.relation === "trigger" && edge.from === draft.resource);
    if (metadata.exclusive && options[metadata.exclusive] !== undefined && natives.some((edge) => edge.label === options[metadata.exclusive!])) source.push({ kind: "source", field: metadata.exclusive, message: `${String(options[metadata.exclusive])} is already wired natively in the stack; remove that wiring first or choose another.` });
    if (metadata.onePerEvent && natives.some((edge) => edge.to === `lambda:${draft.event}`)) source.push({ kind: "source", message: "This Lambda already has a native binding from this resource." });
  }
  for (const other of others) {
    const sameSource = resourceless ? other.adapter === draft.adapter : other.resource === draft.resource;
    if (!sameSource) continue;
    if (other.id === draft.id) form.push({ kind: "form", field: "id", message: "Another trigger on this source already uses this attachment id." });
    if (metadata.exclusive && other.adapter === draft.adapter && options[metadata.exclusive] !== undefined && other.options[metadata.exclusive] === options[metadata.exclusive]) form.push({ kind: "form", field: metadata.exclusive, message: `${String(options[metadata.exclusive])} is already used by another trigger.` });
    if (metadata.onePerEvent && other.event === draft.event && other.adapter === draft.adapter) source.push({ kind: "source", message: "This Lambda already has a trigger from this resource." });
  }
  for (const field of metadata.fields) {
    if (draft.unparsed?.[field.name] !== undefined) { form.push({ kind: "form", field: field.name, message: `${field.label} must be valid ${field.kind === "number" ? "number" : "JSON"}.` }); continue; }
    const problem = fieldProblem(field, options[field.name]);
    if (problem) { form.push({ kind: "form", field: field.name, message: problem }); continue; }
    const reference = field.kind === "resource" ? options[field.name] as { readonly path?: readonly string[] } | undefined : undefined;
    if (reference) {
      const candidate = snapshot.source.triggerCapabilities?.find((item) => item.resource === `resource:${reference.path?.join(".")}`);
      if (!candidate || !field.resourceType || !candidate.canonicalTypes.includes(`${field.resourceType.module}:${field.resourceType.name}`) || (field.resourceType.owned && !candidate.owned)) form.push({ kind: "form", field: field.name, message: `${field.label}: choose a compatible${field.resourceType?.owned ? " owned" : ""} resource.` });
    }
  }
  form.push(...adapterRules(draft.adapter, options));
  if (Object.keys(options).some((name) => !metadata.fields.some((field) => field.name === name))) form.push({ kind: "form", message: "Remove unsupported options." });
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(draft.id)) form.push({ kind: "form", field: "id", message: "Use a kebab-case attachment id, like sqs-trigger." });
  if (draft.accepts !== metadata.contract) form.push({ kind: "form", field: "accepts", message: "Confirm the handler accepts this event." });
  if (!resourceless) {
    const stackId = snapshot.source.triggerCapabilities?.find((item) => item.resource === draft.resource)?.stack;
    const stack = stackId ? snapshot.models.dev.resources.find((item) => item.id === stackId) : undefined;
    if (stack?.stackUsage?.status === "unreferenced") notes.unshift({ kind: "warning", message: `${stack.stackClass ?? stack.path.join(".")} is not added to the CDK app yet; synth fails until it is.` });
  }
  return [...source, ...form, ...notes];
}
