/**
 * The `deploy` vocabulary, in the one module that imports nothing.
 *
 * Split out of `index.ts` for the same reason `conventions.ts` was: something
 * that cannot import the barrel still needs these names. `workflows.ts` is the
 * browser-safe leaf the barrel itself imports, so a workflow entry could only
 * describe its own `deploy` field by hand-writing the union — which is exactly
 * how the two drifted apart before this file existed.
 *
 * Public names are re-exported from `index.ts`; `isDeploySettingEnabled` is not,
 * because reading the token is the framework's job rather than a caller's.
 */

/**
 * The two lanes a target can run in.
 *
 * Not to be confused with `CloudMode`, which is *which* cloud graph is being
 * built. This axis is per-target and authored; that one is per-deployment.
 */
export type DeployScope = "cloud" | "local";

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
export type DeploySetting = (typeof DEPLOY_SETTINGS)[number];

/** The deploy toggle, read without needing the config a target came from. */
export function isDeploySettingEnabled(
  setting: DeploySetting,
  scope: DeployScope,
): boolean {
  return setting === "both" || setting === `${scope}-only`;
}
