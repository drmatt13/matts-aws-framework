import {
  isResourceReference, isResourceValueReference, isResourceAbsent, isUnresolvedTokenString,
  resolveResourceFromEnv, type ResourceReference, type ResourceEnvironmentReaders,
  type StringResourceReference, type AnyResourceCatalog,
} from "./resources";

/** Browser-safe deployment policy shared by configuration, projections and tools.
 * Lanes provide concrete inputs; normalization never reads environment values.
 */

/**
 * The two lanes a target can run in.
 *
 * Not to be confused with `CloudMode`, which is *which* cloud graph is being
 * built. This axis is per-target and authored; that one is per-deployment.
 */
export type DeployScope = "cloud" | "local";

export const DEV_GRAPH_ROLES: ReadonlySet<string> = new Set(["event", "webSocket", "webSocketAuthorizer"]);

export const DEPLOY_SETTINGS = [
  "both",
  "cloud-only",
  "local-only",
  "none",
] as const;

/**
 * Where a target runs, as one token.
 *
 * The value is the whole answer — there is no precedence between a general
 * setting and a per-scope override to reason about, and no way to write
 * something that reads like local is on while it is off.
 *
 * @default "both"
 * @example "local-only"
 */
export type DeployToken = (typeof DEPLOY_SETTINGS)[number];
export interface DeployCondition<Catalog = AnyResourceCatalog> {
  readonly resource: StringResourceReference<Catalog>;
  readonly equals: string;
}
/** A deployment token, or both lanes gated by one non-secret input comparison. */
export type DeploySetting<Catalog = AnyResourceCatalog> = DeployToken | { readonly when: DeployCondition<Catalog> };
export interface DeployInputs {
  readonly holds: (condition: DeployCondition, origin: string) => boolean;
}
export type DeployLane = DeployInputs | "unconditioned";

export function deployInputsFrom(readers: ResourceEnvironmentReaders): DeployInputs {
  return { holds(condition, origin) {
    const value = resolveResourceFromEnv(condition.resource as ResourceReference, readers, origin);
    if (typeof value === "string" && isUnresolvedTokenString(value)) throw new Error(`${origin} deploy.when requires a concrete input, not a CDK token.`);
    return value !== undefined && value === condition.equals;
  } };
}

export function deployKey(setting: DeploySetting): string {
  return typeof setting === "string" ? setting : JSON.stringify([setting.when.resource.path, setting.when.equals]);
}

export function assertDeploySetting(setting: DeploySetting, origin: string): void {
  if (typeof setting === "string" && DEPLOY_SETTINGS.includes(setting)) return;
  const when = typeof setting === "object" && setting !== null ? setting.when : undefined;
  const selector = when?.resource;
  if (!when || Object.keys(setting).some(key => key !== "when") || Object.keys(when).some(key => !["resource", "equals"].includes(key)) || !isResourceReference(selector) || selector.kind !== "string" || (!selector.fromEnv && !isResourceValueReference(selector)) || selector.secretArn || selector.secretField || isResourceAbsent(selector)) {
    throw new Error(`${origin} deploy must be a deploy token or { when: { resource: a declared string input, equals: "value" } }. Secrets, stack members and absent inputs cannot select deployment.`);
  }
  if (typeof when.equals !== "string" || !when.equals.trim() || when.equals !== when.equals.trim()) throw new Error(`${origin} deploy.when.equals must be a non-empty, trimmed string.`);
  if (selector.values && !selector.values.includes(when.equals)) throw new Error(`${origin} deploy.when.equals must be one of the input's declared values.`);
}

/** Can every possible active lane of caller also reach destination? */
export function deployFits(caller: DeploySetting, destination: DeploySetting): boolean {
  if (caller === "none") return true;
  if (typeof destination !== "string" && deployKey(caller) !== deployKey(destination)) return false;
  return (["local", "cloud"] as const).every(scope => !isDeploySettingEnabled(caller, scope, "unconditioned") || isDeploySettingEnabled(destination, scope, "unconditioned"));
}

/** Pure preview of a token/condition's possible lanes; inputs resolve separately. */
export function deployLanes(role: string, setting: DeploySetting): { local: boolean; cloud: boolean; dev: boolean; prod: boolean } {
  const local = isDeploySettingEnabled(setting, "local", "unconditioned");
  const cloud = isDeploySettingEnabled(setting, "cloud", "unconditioned");
  return { local, cloud, dev: cloud && DEV_GRAPH_ROLES.has(role), prod: cloud };
}

/** The deploy toggle, read without needing the config a target came from. */
export function isDeploySettingEnabled(
  setting: DeploySetting,
  scope: DeployScope,
  inputs?: DeployLane,
  origin = "Conditional deployment",
): boolean {
  if (typeof setting !== "string") {
    if (inputs === "unconditioned") return true;
    if (!inputs) throw new Error("Conditional deployment requires explicit deployment inputs (or unconditioned for a declaration superset).");
    return inputs.holds(setting.when, origin);
  }
  return setting === "both" || setting === `${scope}-only`;
}
