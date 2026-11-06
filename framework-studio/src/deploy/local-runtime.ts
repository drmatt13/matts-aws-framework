import { queryOptions, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { JobView, LocalRunView } from "../../shared/deploy";
import { openActivity } from "../activity";
import { call } from "../http";
import { operationsQuery } from "../operations/queries";
import { useStudio } from "../studio";
import { deployApi } from "./api";
import { useDeploymentObservation } from "./observations";
import { deploymentPresence } from "./presence";
import { localRuntimeMatches, mergeLocalRuntime, runtimePresentation, runtimeStartEligibility } from "./local-runtime-state";

const LOCAL_KINDS = new Set(["local-start", "local-stop", "local-restart", "local-attach-watch"]);
export const localRuntimeQuery = (repository: string, force = false) => queryOptions({
  // A checkout has one Compose project, independently of the selected AWS mode.
  queryKey: ["deploy", "local", repository],
  queryFn: ({ signal }) => call<LocalRunView>(`/deploy/local${force ? "?force=1" : ""}`, undefined, signal),
  staleTime: 3000, retry: false, refetchOnWindowFocus: "always", refetchOnReconnect: "always",
  structuralSharing: (previous, next) => mergeLocalRuntime(previous as LocalRunView | undefined, next as LocalRunView),
});

function rememberJob(client: QueryClient, job: JobView) {
  client.setQueryData<{ jobs: JobView[] }>(operationsQuery().queryKey, current => {
    const known = current?.jobs.find(entry => entry.id === job.id);
    return { jobs: [known && (known.lastSeq > job.lastSeq || known.status !== "running") ? known : job,
      ...(current?.jobs ?? []).filter(entry => entry.id !== job.id)] };
  });
}

export function useLocalRuntime() {
  const client = useQueryClient();
  const studio = useStudio();
  const observation = useDeploymentObservation("dev");
  const repository = studio.response.snapshot.repositoryRoot;
  const operations = useQuery({ ...operationsQuery(), enabled: false });
  const jobs = (operations.data?.jobs ?? []).filter(job => LOCAL_KINDS.has(job.kind));
  const job = jobs.find(job => job.status === "running") ?? [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const local = useQuery({ ...localRuntimeQuery(repository), refetchInterval: job?.status === "running" ? 2000 : 5000,
    refetchIntervalInBackground: false });
  const mutation = useMutation({ mutationKey: ["deploy", "local-action", repository], gcTime: 0, retry: false,
    mutationFn: async (kind: "local-start" | "local-stop") => {
      const status = observation.status;
      const params = kind === "local-stop" ? {} : { deployment: observation.target?.name, profile: observation.profile,
        account: status?.context.account, region: status?.context.region, mode: "dev", export: true };
      const accepted = await deployApi.operate(kind, params);
      rememberJob(client, accepted);
      openActivity(accepted.id);
      await client.invalidateQueries({ queryKey: localRuntimeQuery(repository).queryKey });
      return accepted;
    },
  });
  const submissions = useMutationState({ filters: { mutationKey: ["deploy", "local-action", repository], status: "pending" },
    select: entry => entry.state.variables as "local-start" | "local-stop" });
  const context = JSON.stringify({ ...observation.scope, sourceRevision: undefined });
  useEffect(() => { mutation.reset(); }, [context]);
  const version = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next = job ? `${job.id}:${job.status}` : "";
    if (version.current !== next) {
      version.current = next;
      void client.invalidateQueries({ queryKey: localRuntimeQuery(repository).queryKey });
    }
  }, [client, repository, job?.id, job?.status]);
  const status = observation.status;
  const destination = { deployment: observation.target?.name, profile: observation.profile,
    account: status?.context.account, region: status?.context.region };
  const problem = local.error?.message ?? local.data?.observationProblem;
  const matches = localRuntimeMatches(local.data, destination);
  const presence = deploymentPresence({ ...observation, fetching: observation.statusQuery.isFetching });
  const attention = observation.problem?.message ?? (status && (presence.state !== "deployed" || status.detail?.local?.compatible !== true)
    ? status.detail?.local?.problem ?? "The development deployment needs attention. Stop local runtime before deploying the required changes."
    : undefined);
  const state = runtimePresentation({ local: local.data, problem, job,
    submitting: submissions.at(-1), matches, attention });
  const operationsKnown = Boolean(operations.data && !operations.error);
  const operationProblem = operations.error?.message;
  const work = operations.data?.jobs.find(entry => !["local-watch", "local-client"].includes(entry.kind)
    && (entry.status === "running" || entry.execution === "lost" || entry.outcome === "uncertain"));
  const eligibility = runtimeStartEligibility({ ...observation, fetching: observation.statusQuery.isFetching,
    local: local.data, localProblem: problem, operationsKnown, operationProblem, work });
  return { ...state, matches, local: local.data, job, destination, blocker: eligibility.message, problem, attention,
    operationsKnown, operationProblem, startHint: eligibility.hint,
    canStart: !eligibility.blocked && !state.active && !state.busy,
    error: mutation.error?.message, checking: local.isFetching,
    start: () => mutation.mutateAsync("local-start"), stop: () => mutation.mutateAsync("local-stop"),
    refresh: async () => { mutation.reset(); await Promise.all([
      client.fetchQuery({ ...localRuntimeQuery(repository, true), staleTime: 0 }),
      client.fetchQuery({ ...operationsQuery(), staleTime: 0 }),
      observation.profile && observation.target ? observation.statusQuery.refetch() : Promise.resolve(),
    ]); },
  };
}
