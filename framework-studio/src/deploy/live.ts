import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { DeployOverview, DiscoveryView, JobView, StackEventView } from "../../shared/deploy";
import { token } from "../http";
import { connectStudioEvents } from "../events";
import { matchesDeployment, type DeploymentDestination, type DeploymentScope } from "./context";

export { logs, useJobLog } from "../operations/live";

export interface LiveHandlers {
  readonly onJob?: (job: JobView) => void;
  readonly onEvent?: (deployment: string, event: StackEventView, context: { profile?: string; account?: string; region?: string }) => void;
}
const trailing = new WeakSet<Query>();

/** An event received during a read requires one more read after it settles. */
export function invalidateDeploymentQueries(client: QueryClient, predicate: (query: Query) => boolean = () => true) {
  const filters = { queryKey: ["deploy"], predicate };
  for (const query of client.getQueryCache().findAll(filters)) {
    if (!query.promise || query.state.fetchStatus !== "fetching" || trailing.has(query)) continue;
    trailing.add(query);
    void query.promise.catch(() => {}).then(() => {
      trailing.delete(query);
      if (client.getQueryCache().get(query.queryHash) === query)
        void client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
    });
  }
  void client.invalidateQueries(filters, { cancelRefetch: false });
}

function destinationMatches(query: Query, destination: DeploymentDestination) {
  if (!["status", "discover"].includes(String(query.queryKey[1]))) return true;
  const scope = query.queryKey[2] as DeploymentScope;
  const data = query.state.data as DiscoveryView | undefined;
  return matchesDeployment(scope, destination, data?.context.account, data?.context.region);
}

/** Mounted only by GlobalDeploymentObservations; pages own callbacks, never cache writes. */
export function useDeployLive(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = connectStudioEvents(token);
    const parse = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("deploy-job", event => {
      const job = parse<JobView>(event);
      client.setQueriesData<DeployOverview>({ queryKey: ["deploy", "overview"] }, overview => {
        const previous = overview?.jobs.find(entry => entry.id === job.id);
        if (!overview || previous && (previous.lastSeq > job.lastSeq || previous.status !== "running" && job.status === "running")) return overview;
        return { ...overview, jobs: [job, ...overview.jobs.filter(entry => entry.id !== job.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
      });
    });
    source.addEventListener("deploy-stacks", event => {
      const destination = parse<DeploymentDestination>(event);
      invalidateDeploymentQueries(client, query => ["status", "discover"].includes(String(query.queryKey[1])) && destinationMatches(query, destination));
    });
    source.addEventListener("deploy-changed", event => {
      const destination = parse<DeploymentDestination>(event);
      invalidateDeploymentQueries(client, query => destinationMatches(query, destination));
    });
    return () => source.close();
  }, [client]);
}

/** Page-specific reactions use the same transport without repeating cache updates. */
export function useDeployEvents(handlers: LiveHandlers): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const source = connectStudioEvents(token);
    const parse = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("deploy-job", event => current.current.onJob?.(parse<JobView>(event)));
    source.addEventListener("deploy-event", event => {
      const { deployment, stack, event: detail, profile, account, region } = parse<{ deployment: string; stack: string; event: Omit<StackEventView, "stack">; profile?: string; account?: string; region?: string }>(event);
      if (detail) current.current.onEvent?.(deployment, { ...detail, stack }, { profile, account, region });
    });
    return () => source.close();
  }, []);
}
