import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-invocation binding isolation.
 *
 * A deployed Lambda and an isolated container each have their own process
 * environment, so their descriptors are simply theirs. The local dev server is
 * the case that needs this: it runs many handlers *in one process*, with cached
 * modules, so `process.env` is shared and a descriptor written there would leak
 * one caller's bindings into another's — including into a handler that declared
 * no binding at all and should fail.
 *
 * The generic executor supplies an invocation-scoped map with the same names
 * and the same descriptor schema. The reader below treats that map as
 * authoritative *including its absences*: inside a scope, a name the map does
 * not carry is missing, and is never recovered from `process.env`. That is the
 * whole point — a missing binding must fail in local development exactly as it
 * would in AWS.
 *
 * This is configuration isolation, not a new handler API: nothing a handler
 * writes changes, and no global environment is mutated between requests.
 */
const storage = new AsyncLocalStorage<Readonly<Record<string, string>>>();

/**
 * Runs `body` with exactly these invocation variables visible.
 *
 * Resolution happens at invocation time rather than at module load, so a cached
 * handler module retains no caller's bindings between requests.
 */
export function withInvocationEnvironment<Result>(
  environment: Readonly<Record<string, string>>,
  body: () => Result,
): Result {
  return storage.run({ ...environment }, body);
}

/** Whether the caller is inside a scoped invocation environment. */
export function hasInvocationEnvironment(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * One invocation variable, from the scoped map when there is one.
 *
 * Deliberately not a merge. Falling back to `process.env` for a name the scope
 * omits is exactly the leak this exists to prevent.
 */
export function readInvocationVariable(name: string): string | undefined {
  const scoped = storage.getStore();
  if (scoped) return scoped[name];
  return process.env[name];
}
