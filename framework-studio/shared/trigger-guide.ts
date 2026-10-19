import type { Snapshot, SourceLocation } from "./model";
import type { TriggerAdapterMetadata } from "./triggers";
import { eventUnavailable, triggerTiming, triggerUnavailable } from "./trigger-availability";

export interface GuideCandidate {
  readonly resource: string;
  readonly stack: string;
  readonly name: string;
  readonly location: SourceLocation;
  /** Why this field cannot be selected; absent when it can. */
  readonly reason?: string;
  /** Selectable, with a consequence worth knowing. */
  readonly warning?: string;
}

export interface TriggerGuide {
  readonly adapter: TriggerAdapterMetadata;
  readonly requirements: readonly string[];
  /** Field, constructor line and imports to add to a stack. */
  readonly snippet: string;
  /** How a stack not yet in the catalog joins it. */
  readonly catalogSnippet: string;
  readonly candidates: readonly GuideCandidate[];
}

function timeoutOf(snapshot: Snapshot, event: string): number | undefined {
  const seconds = Object.values(snapshot.models).map((model) => model.targets.find((target) => target.id === event && target.role === "event")?.compute).map((compute) => compute?.kind === "lambda" ? compute.timeoutSeconds : undefined);
  return seconds.every((value) => typeof value === "number") ? Math.max(...(seconds as number[])) : undefined;
}

/** Everything a developer needs to trigger an event from one service: rules, code, and fields that already qualify. */
export function triggerGuide(snapshot: Snapshot, kind: string, event?: string): TriggerGuide | undefined {
  const adapter = snapshot.models.dev.triggerAdapters?.find((item) => item.kind === kind);
  if (!adapter?.guide) return undefined;
  const { guide } = adapter;
  const timeout = event ? timeoutOf(snapshot, event) : undefined;
  const timing = adapter.timeoutFact && timeout !== undefined
    ? [`${event} times out after ${timeout}s, so the ${adapter.timeoutFact.label.toLowerCase()} must be at least ${timeout}s (AWS recommends ${adapter.timeoutFact.recommendedMultiple * timeout}s or more).`]
    : [];
  const candidates = (snapshot.source.triggerCapabilities ?? []).filter((item) => item.adapters.some((entry) => entry.kind === kind)).map((item): GuideCandidate => {
    const reason = triggerUnavailable(snapshot, item.resource, kind) ?? (event ? eventUnavailable(snapshot, event, kind) ?? triggerTiming(snapshot, { event, resource: item.resource, adapter: kind, options: {} }).problem : undefined);
    const stack = snapshot.models.dev.resources.find((resource) => resource.id === item.stack);
    const warning = stack?.stackUsage?.status === "unreferenced" ? "Stack not added to the CDK app yet" : undefined;
    return { resource: item.resource, stack: item.stack, name: item.name, location: item.location, ...(reason ? { reason } : {}), ...(warning ? { warning } : {}) };
  }).sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || a.stack.localeCompare(b.stack) || a.name.localeCompare(b.name));
  const snippet = [
    ...guide.imports, "",
    "// In your stack class",
    `public readonly ${guide.field}: ${guide.type};`, "",
    "// In its constructor, before linkResources(this, resources.<stack>)",
    `this.${guide.field} = ${guide.construct};`,
    ...(guide.setup ?? []),
  ].join("\n");
  const catalogSnippet = [
    "// framework-config/resources.ts — a stack joins the catalog once",
    "myStack: resource.stack<MyStack>(),", "",
    "// The stack's constructor, after its public fields are set",
    "linkResources(this, resources.myStack);",
  ].join("\n");
  return { adapter, requirements: [...guide.requirements, ...timing], snippet, catalogSnippet, candidates };
}

/** One entry per registered adapter, with how many fields can be used right now, or why none can for this event. */
export function triggerGuideSummary(snapshot: Snapshot, event?: string): readonly { readonly kind: string; readonly label: string; readonly usable: number; readonly resourceless?: true; readonly reason?: string }[] {
  return (snapshot.models.dev.triggerAdapters ?? []).map((adapter) => {
    const reason = event ? eventUnavailable(snapshot, event, adapter.kind) : undefined;
    // A resourceless adapter is always one choice: it brings its own source.
    const usable = reason ? 0 : adapter.resourceless ? 1 : triggerGuide(snapshot, adapter.kind, event)?.candidates.filter((item) => !item.reason).length ?? 0;
    return { kind: adapter.kind, label: adapter.label, usable, ...(adapter.resourceless ? { resourceless: true } : {}), ...(reason ? { reason } : {}) };
  });
}
