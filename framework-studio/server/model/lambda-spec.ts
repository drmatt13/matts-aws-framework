import { getLambdaTargets, resolveLambdaTarget, type FrameworkConfig, type ResolvedLambdaTarget } from "@repo/framework/config";

/**
 * Resolved Lambda settings shared by fields, compute and placement.
 *
 * The framework normalizes the whole config on every call, and one projection
 * asks about each Lambda a dozen times. A synchronous projection temporarily
 * installs a complete fresh batch and restores the previous state in finally.
 * Outside that scope, individual field helpers retain their existing memoization
 * for immutable evaluated configs. A new projection always refreshes its batch,
 * including when a caller has changed a config object in place.
 */

const answers = new WeakMap<FrameworkConfig, Map<string, ResolvedLambdaTarget>>();

/** Share fresh answers only for one synchronous projection, including nested calls. */
export function withLambdaSpecs<Result>(config: FrameworkConfig, run: () => Result): Result {
  const previous = answers.get(config);
  answers.set(config, new Map(getLambdaTargets(config).map(spec => [spec.id, spec] as const)));
  try { return run(); }
  finally {
    if (previous) answers.set(config, previous);
    else answers.delete(config);
  }
}

export function lambdaSpec(config: FrameworkConfig, id: string): ResolvedLambdaTarget {
  let specs = answers.get(config);
  if (!specs) answers.set(config, (specs = new Map()));
  let spec = specs.get(id);
  if (!spec) specs.set(id, (spec = resolveLambdaTarget(config, id)));
  return spec;
}
