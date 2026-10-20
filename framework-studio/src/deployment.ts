import type { Lanes, Mode, ModelEdge, Snapshot } from "../shared/model";
import type { ModelIndex } from "./lookup";

/** The same deployment facts used by map nodes, without constructing a scene. */
export function connectionDisabledEndpoints(index: ModelIndex, mode: Mode, edge: Pick<ModelEdge, "from" | "to">): readonly string[] {
  const enabled = (id: string): boolean => {
    const local = index.localServices.get(id);
    if (local) return local.enabled;
    const route = index.routes.get(id);
    const target = index.targets.get(route?.target ?? id);
    if (target) return environments(target.lanes)[mode];
    const resource = index.resources.get(id);
    if (!resource) return false;
    // Stack members share their owning stack's representation in the map.
    const representative = resource.kind === "member" && resource.parent ? index.resources.get(resource.parent) ?? resource : resource;
    return !representative.absent;
  };
  return [...new Set([edge.from, edge.to])].filter((id) => !enabled(id));
}

/** Two environments. Local and AWS are execution locations within development. */
export interface Availability { readonly dev: boolean; readonly prod: boolean }
export type DeploymentBadgeKind = "dev" | "prod" | "off";

export const DEPLOYMENT_BADGES = {
  dev: { label: "Dev", description: "Development only", color: "#78d1ce", background: "#163331", paths: ["M9 3h6", "M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3", "M8 14h8"] },
  prod: { label: "Prod", description: "Production only", color: "#b7a8ff", background: "#302746", paths: ["m12 2 10 10-10 10L2 12Z", "m8 14 4-6 4 6"] },
  off: { label: "Off", description: "Not enabled in development or production", color: "#9aa3b0", background: "#282d35", paths: ["M8 5v14", "M16 5v14"] },
} as const;

/** Friendly labels; edit intents still carry the framework's original tokens. */
export function deploymentSettingLabel(value: string, webSocketApi?: boolean): string {
  if (webSocketApi !== undefined) {
    if (value === "both") return webSocketApi ? "Dev + Prod" : "Dev only";
    if (value === "cloud-only") return webSocketApi ? "Dev + Prod (AWS execution)" : "Off (API disabled)";
  }
  return ({ both: "Dev + Prod", "local-only": "Dev only", "cloud-only": "Prod only", none: "Off" } as Readonly<Record<string, string>>)[value] ?? value;
}

export function environments(lanes: Lanes): Availability {
  return { dev: lanes.local || lanes.dev, prod: lanes.prod };
}

export function availabilityBadge(availability: Availability): DeploymentBadgeKind | undefined {
  if (availability.dev && availability.prod) return undefined;
  if (availability.prod) return "prod";
  if (availability.dev) return "dev";
  return "off";
}

export function deploymentBadge(lanes: Lanes): DeploymentBadgeKind | undefined {
  return availabilityBadge(environments(lanes));
}

export function developmentLocation(lanes: Lanes): string {
  return lanes.local && lanes.dev ? "Your machine + AWS" : lanes.local ? "On your machine" : lanes.dev ? "In AWS" : "Not enabled";
}

export function deploymentSummary(lanes: Lanes): string {
  const { dev, prod } = environments(lanes);
  if (dev && prod) return "Runs in development and production.";
  if (prod) return "Runs in production only.";
  if (dev) return "Runs in development only.";
  return "Not enabled in either environment.";
}

/** Catalog entries carry mode-specific absence rather than workload deployment settings. */
export function catalogAvailability(models: Snapshot["models"]): Readonly<Record<string, Availability>> {
  const result: Record<string, Availability> = {};
  for (const mode of ["dev", "prod"] as const) for (const resource of models[mode].resources) {
    result[resource.id] = { ...(result[resource.id] ?? { dev: false, prod: false }), [mode]: !resource.absent };
  }
  return result;
}
