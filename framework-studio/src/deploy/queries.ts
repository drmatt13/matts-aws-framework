import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { AwsProblem, DeployOverview, DiscoveryView, StatusView } from "../../shared/deploy";
import { ApiError } from "../http";
import { deployApi, type Observation } from "./api";
import { sameDeploymentObservation, type DeploymentScope } from "./context";

/** Last observed metadata survives source-only refreshes, including a consumer remount. */
export function previousDeploymentOverview(client: QueryClient, repository: string): DeployOverview | undefined {
  return client.getQueryCache().findAll({ queryKey: ["deploy", "overview"] })
    .filter(query => (query.queryKey[2] as { repository?: string } | undefined)?.repository === repository && query.state.data)
    .reverse()
    .sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt)[0]?.state.data as DeployOverview | undefined;
}

/** Cache reads only: never reuse evidence from a different actor or AWS destination. */
export function previousDeploymentObservation<T extends DiscoveryView | StatusView>(client: QueryClient, scope: DeploymentScope, kind: "status" | "discover"): T | undefined {
  return client.getQueryCache().findAll({ queryKey: ["deploy", kind] }).filter(query => {
    const previous = query.queryKey[2] as DeploymentScope | undefined;
    if (!previous || !query.state.data) return false;
    if (kind === "status") return sameDeploymentObservation(previous, scope);
    // An account inventory is deliberately shared by modes with no named target.
    return previous.repository === scope.repository && previous.profile === scope.profile
      && previous.generation === scope.generation && previous.region === scope.region;
  }).reverse().sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt)[0]?.state.data as T | undefined;
}

export class AwsReadError extends Error {
  constructor(readonly problem: AwsProblem) { super(problem.message); this.name = "AwsReadError"; }
}
export function observationValue<T>(observation: Observation<T>): T {
  if (!observation.ok) throw new AwsReadError(observation.problem);
  return observation.value;
}

/** One queue per QueryClient bounds AWS reads, including explicit refreshes. */
export class DeploymentReadQueue {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  async run<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal?.removeEventListener("abort", abort); this.running++; resolve(); };
      const abort = () => { const index = this.waiting.indexOf(start); if (index >= 0) this.waiting.splice(index, 1); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      if (signal?.aborted) { abort(); return; }
      if (this.running < 2) start();
      else { this.waiting.push(start); signal?.addEventListener("abort", abort, { once: true }); }
    });
    try { signal?.throwIfAborted(); return await read(); }
    finally { this.running--; this.waiting.shift()?.(); }
  }
}
const queues = new WeakMap<QueryClient, DeploymentReadQueue>();
function queue(client: QueryClient) {
  let value = queues.get(client);
  if (!value) { value = new DeploymentReadQueue(); queues.set(client, value); }
  return value;
}

export const deploymentReadPolicy = {
  staleTime: 20_000,
  gcTime: 10 * 60_000,
  retry: (count: number, error: Error) => count < 1 && (
    error instanceof AwsReadError ? error.problem.kind === "throttled"
      : !(error instanceof ApiError) || error.status >= 500
  ),
  retryDelay: () => 1500 + Math.random() * 500,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** Repository metadata shares one entry per published source revision. */
export const deploymentOverviewQuery = (force = false, source?: { repository: string; sourceRevision: string }) => queryOptions({
  queryKey: ["deploy", "overview", source] as const,
  queryFn: ({ signal }) => deployApi.overview(force, signal),
  staleTime: 60_000, gcTime: 10 * 60_000, retry: false,
  refetchOnWindowFocus: false, refetchOnReconnect: false,
});

export const deploymentDiscoveryQuery = (scope: DeploymentScope, force = false) => queryOptions({
  // An account inventory is independent of declaration mode and selected name.
  queryKey: ["deploy", "discover", {
    repository: scope.repository, sourceRevision: scope.sourceRevision,
    profile: scope.profile, generation: scope.generation, region: scope.region,
  }] as const,
  queryFn: ({ signal, client }) => queue(client).run(async () => {
    const value = observationValue(await deployApi.discover(scope.profile!, force, scope.region, signal));
    if (value.context.profile !== scope.profile || scope.region && value.context.region !== scope.region)
      throw new AwsReadError({ kind: "failed", message: "AWS returned an observation for another connection or region. Refresh this deployment." });
    return value;
  }, signal),
  ...deploymentReadPolicy,
});
export const deploymentStatusQuery = (scope: DeploymentScope, force = false) => queryOptions({
  queryKey: ["deploy", "status", scope] as const,
  queryFn: ({ signal, client }) => queue(client).run(async () => {
    const value = observationValue(await deployApi.status(scope.profile!, scope.deployment!, force, scope.region, signal));
    if (value.context.profile !== scope.profile || value.deployment !== scope.deployment || scope.region && value.context.region !== scope.region)
      throw new AwsReadError({ kind: "failed", message: "AWS returned an observation for another deployment context. Refresh this deployment." });
    return value;
  }, signal),
  ...deploymentReadPolicy,
});

export const deploymentPlansQuery = () => queryOptions({
  queryKey: ["deploy", "plans"],
  queryFn: () => deployApi.plans(),
});
