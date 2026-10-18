import type { InputRequirement } from "../shared/deployment-inputs";
import type { Mode, ModeModel, ModelResource } from "../shared/model";

/** Resolve presence and conditional requirements privately, then discard values.
 * The public result contains names and reasons only, including for selectors. */
export function inputRequirements(model: ModeModel, values: Record<string, string | undefined>, mode: Mode, file: string, readable = true): ReadonlyMap<string, InputRequirement> {
  const resources = new Map(model.resources.map((resource) => [resource.id, resource]));
  const reasons = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>();
  const need = (id: string, reason: string, target?: string) => {
    const list = reasons.get(id) ?? new Set<string>(); list.add(reason); reasons.set(id, list);
    if (target) { const ids = consumers.get(id) ?? new Set<string>(); ids.add(target); consumers.set(id, ids); }
  };
  const valueOf = (resource: ModelResource | undefined) => {
    if (!resource || resource.absent || !resource.fromEnv) return undefined;
    const value = values[resource.fromEnv]?.trim() || (resource.kind === "input" ? resource.default?.trim() : undefined);
    return resource.values?.find((allowed) => allowed.toLowerCase() === value?.toLowerCase()) ?? value;
  };
  for (const resource of resources.values()) if (resource.required) need(resource.id, "Marked required in the resource declaration.");
  for (const target of model.targets) {
    const active = mode === "dev" ? target.lanes.dev || target.lanes.local : target.lanes.prod;
    if (!active) continue;
    for (const rule of target.requirementRules ?? []) {
      if (rule.when) {
        const selector = resources.get(rule.when.resource);
        const current = valueOf(selector);
        if (current === undefined) {
          need(rule.when.resource, `Needed to evaluate the requirement for ${target.title}.`, target.ref);
          continue;
        }
        if (current !== rule.when.equals) continue;
      }
      for (const id of rule.require) need(id, `Required by ${target.title}.${rule.message ? ` ${rule.message}` : ""}`, target.ref);
    }
  }
  return new Map([...resources.values()].filter((resource) => resource.fromEnv && ["input", "secret"].includes(resource.kind)).map((resource) => {
    const required = reasons.has(resource.id);
    const configured = !!values[resource.fromEnv!]?.trim();
    const defaulted = resource.kind === "input" && !!resource.default?.trim();
    const status = !readable || model.stale || resource.absent ? "unknown" : configured ? "configured" : defaulted ? "default" : required ? "missing" : "optional";
    return [resource.id, { resource: resource.id, name: resource.fromEnv!, mode, file, required, status, reasons: [...(reasons.get(resource.id) ?? [])], consumers: [...(consumers.get(resource.id) ?? [])] }];
  }));
}
