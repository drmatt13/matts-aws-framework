import { resolveLambdaTarget, type FrameworkConfig, type ResolvedLambdaTarget } from "@repo/framework/config";

/**
 * `resolveLambdaTarget`, asked once per Lambda of an evaluated config.
 *
 * The framework normalizes the whole config on every call, and one projection
 * asks about each Lambda a dozen times: every field, every shared default, its
 * compute and its placement. The studio never changes an evaluated config in
 * place — preflight's `applyPatch` copies along the patched path — so an
 * answer keyed on the config object cannot go stale.
 */

const answers = new WeakMap<FrameworkConfig, Map<string, ResolvedLambdaTarget>>();

export function lambdaSpec(config: FrameworkConfig, id: string): ResolvedLambdaTarget {
  let specs = answers.get(config);
  if (!specs) answers.set(config, (specs = new Map()));
  let spec = specs.get(id);
  if (!spec) specs.set(id, (spec = resolveLambdaTarget(config, id)));
  return spec;
}
