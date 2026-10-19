import type { Snapshot } from "./model";
import type { TriggerAdapterMetadata } from "./triggers";

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
  for (const mode of ["dev", "prod"] as const) {
    const field = snapshot.models[mode].resources.find((item) => item.id === resource);
    if (!field || field.absent) return `${mode === "dev" ? "Development" : "Production"} graph does not contain this resource.`;
    const stack = snapshot.models[mode].resources.find((item) => item.id === capability.stack);
    if (stack?.stackUsage?.status === "unreferenced") return "Stack is not added to the CDK app.";
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
