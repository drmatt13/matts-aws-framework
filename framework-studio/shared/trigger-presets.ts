import type { Snapshot } from "./model";
import type { TriggerAdapterMetadata, TriggerBinding, TriggerField } from "./triggers";
import { eventUnavailable, triggerUnavailable } from "./trigger-availability";

/**
 * Studio's guided defaults for the trigger form. Adapters stay generic: these
 * helpers read their metadata and the snapshot, so a new adapter works without
 * a case here; the few named cases only offer friendlier inputs.
 */
export interface TriggerContext {
  readonly event: string;
  readonly resource: string;
  readonly adapter: string;
  /** Drafted bindings besides the one being edited. */
  readonly others: readonly TriggerBinding[];
}

export interface Choice {
  readonly value: string;
  /** Why it cannot be chosen; `short` is the option suffix. */
  readonly reason?: string;
  readonly short?: string;
}

export const S3_BASIC_EVENTS = [{ value: "s3:ObjectCreated:*", label: "Object created" }, { value: "s3:ObjectRemoved:*", label: "Object removed" }] as const;

const adapterOf = (snapshot: Snapshot, kind: string): TriggerAdapterMetadata | undefined => snapshot.models.dev.triggerAdapters?.find((item) => item.kind === kind);

/** Fields shown up front, tuning folded away, and required yes/no fields that are really confirmations. */
export function fieldGroups(metadata: TriggerAdapterMetadata): { readonly basic: readonly TriggerField[]; readonly advanced: readonly TriggerField[]; readonly confirm: readonly TriggerField[] } {
  const confirm = metadata.fields.filter((field) => field.kind === "boolean" && field.required);
  return { basic: metadata.fields.filter((field) => !field.advanced && !confirm.includes(field)), advanced: metadata.fields.filter((field) => field.advanced && !confirm.includes(field)), confirm };
}

/** Each value of an enum option, marked when the source, the Lambda or another trigger rules it out. */
export function enumChoices(snapshot: Snapshot, field: TriggerField, context: TriggerContext): readonly Choice[] {
  const metadata = adapterOf(snapshot, context.adapter);
  const base = context.resource ? triggerUnavailable(snapshot, context.resource, context.adapter) : undefined;
  return (field.values ?? []).map((value): Choice => {
    if (metadata?.exclusive === field.name) {
      if (snapshot.source.cdkLinks.edges.some((edge) => edge.relation === "trigger" && edge.from === context.resource && edge.label === value)) return { value, short: "occupied", reason: `${value} is already wired natively in the stack.` };
      if (context.others.some((other) => other.resource === context.resource && other.adapter === context.adapter && other.options[field.name] === value)) return { value, short: "in use", reason: `${value} is already used by another trigger.` };
    }
    const replay = context.event ? eventUnavailable(snapshot, context.event, context.adapter, { [field.name]: value }) : undefined;
    if (replay && replay !== (context.event ? eventUnavailable(snapshot, context.event, context.adapter) : undefined)) return { value, short: "not replayable", reason: replay };
    const source = context.resource ? triggerUnavailable(snapshot, context.resource, context.adapter, { [field.name]: value }) : undefined;
    if (source && source !== base) return { value, short: "unavailable", reason: source };
    return { value };
  });
}

/** A stable kebab-case id no other trigger on this source uses. */
export function nextAttachmentId(snapshot: Snapshot, context: TriggerContext): string {
  const resourceless = adapterOf(snapshot, context.adapter)?.resourceless === true;
  const base = `${context.adapter}-trigger`;
  let id = base, count = 2;
  while (context.others.some((other) => (resourceless ? other.adapter === context.adapter : other.resource === context.resource) && other.id === id)) id = `${base}-${count++}`;
  return id;
}

/** What a new trigger starts with: declared defaults, then the first workable value of each required choice. */
export function initialOptions(snapshot: Snapshot, context: TriggerContext): Record<string, unknown> {
  const metadata = adapterOf(snapshot, context.adapter);
  const options: Record<string, unknown> = {};
  for (const field of metadata?.fields ?? []) if (field.default !== undefined) options[field.name] = structuredClone(field.default);
  for (const field of metadata?.fields ?? []) {
    if (field.kind !== "enum" || !field.required || options[field.name] !== undefined) continue;
    const first = enumChoices(snapshot, field, context).find((choice) => !choice.reason);
    if (first) options[field.name] = first.value;
  }
  // A bucket that already sends to EventBridge only supports the two wildcard events there.
  if (options.delivery === "eventbridge" && Array.isArray(options.eventTypes)) options.eventTypes = (options.eventTypes as string[]).filter((item) => S3_BASIC_EVENTS.some((basic) => basic.value === item));
  return options;
}

/** Source and detail type, when that is all a pattern says; undefined when it needs the JSON editor. */
export function eventPatternBasics(pattern: unknown): { readonly source: string; readonly detailType: string } | undefined {
  if (pattern === undefined) return { source: "", detailType: "" };
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return undefined;
  const object = pattern as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "source" && key !== "detailType")) return undefined;
  const list = (value: unknown): string | undefined => value === undefined ? "" : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : undefined;
  const source = list(object.source), detailType = list(object.detailType);
  return source === undefined || detailType === undefined ? undefined : { source, detailType };
}

export type ScheduleBasics =
  | { readonly kind: "rate"; readonly count: number; readonly unit: "minutes" | "hours" | "days" }
  | { readonly kind: "daily"; readonly time: string };

/** A repeating rate or a daily time, when that is what an expression says; undefined for anything else. */
export function scheduleBasics(expression: unknown): ScheduleBasics | undefined {
  if (typeof expression !== "string") return undefined;
  const rate = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(expression);
  if (rate) return { kind: "rate", count: Number(rate[1]), unit: `${rate[2]}s` as "minutes" | "hours" | "days" };
  const daily = /^cron\((\d{1,2}) (\d{1,2}) \* \* \? \*\)$/.exec(expression);
  if (daily && Number(daily[1]) < 60 && Number(daily[2]) < 24) return { kind: "daily", time: `${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}` };
  return undefined;
}

/** The expression EventBridge Scheduler expects, singular for a rate of one. */
export function scheduleExpression(basics: ScheduleBasics): string {
  if (basics.kind === "daily") {
    const [hours = "0", minutes = "0"] = basics.time.split(":");
    return `cron(${Number(minutes)} ${Number(hours)} * * ? *)`;
  }
  return basics.count === 1 ? `rate(1 ${basics.unit.slice(0, -1)})` : `rate(${basics.count} ${basics.unit})`;
}

/** Comma-separated sources and detail types as a CDK event pattern. */
export function eventPatternFrom(source: string, detailType: string): Record<string, string[]> {
  const split = (text: string) => text.split(",").map((item) => item.trim()).filter(Boolean);
  return { ...(split(source).length ? { source: split(source) } : {}), ...(split(detailType).length ? { detailType: split(detailType) } : {}) };
}
