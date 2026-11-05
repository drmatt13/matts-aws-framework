import { queryOptions, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { DockerStatusView } from "../../shared/machine";
import { unavailableDockerStatus } from "../../shared/machine";
import type { JobView } from "../../shared/operations";
import { call, token } from "../http";
import { connectStudioEvents } from "../events";
import { deployApi } from "../deploy/api";
import { operationsQuery } from "../operations/queries";

const START_KEY = ["machine", "docker-start"];
const starts = new WeakMap<QueryClient, Promise<JobView>>();

export function newerDockerStatus(previous: unknown, next: unknown): DockerStatusView {
  const before = previous as DockerStatusView | undefined, after = next as DockerStatusView;
  return before && before.observedAt > after.observedAt ? before : after;
}

export const dockerStatusQuery = (force = false) => queryOptions({
  queryKey: ["machine", "docker"], queryFn: () => call<DockerStatusView>(`/machine/docker${force ? "?force=1" : ""}`),
  staleTime: 5000, retry: false, refetchOnWindowFocus: false, structuralSharing: newerDockerStatus,
});

export function refreshDocker(client: QueryClient) {
  return client.fetchQuery({ ...dockerStatusQuery(true), staleTime: 0 });
}

export function useDockerStatus() {
  const client = useQueryClient();
  const query = useQuery(dockerStatusQuery());
  return { ...query, status: query.error ? unavailableDockerStatus("Docker status is unavailable. Check again.") : query.data,
    refresh: () => refreshDocker(client) };
}

async function startDocker(client: QueryClient): Promise<JobView> {
  const pending = starts.get(client);
  if (pending) return pending;
  const request = (async () => {
    const operations = await client.fetchQuery({ ...operationsQuery(), staleTime: 0 });
    const running = operations.jobs.find(job => job.kind === "docker-start" && job.status === "running");
    if (running) return running;
    const job = await deployApi.operate("docker-start", {});
    client.setQueryData<{ jobs: JobView[] }>(operationsQuery().queryKey, current => {
      const known = current?.jobs.find(entry => entry.id === job.id);
      return { jobs: [known ?? job, ...(current?.jobs ?? []).filter(entry => entry.id !== job.id)] };
    });
    return job;
  })().finally(() => { starts.delete(client); });
  starts.set(client, request);
  return request;
}

/** All entry points share admission, pending state and the normal operation projection. */
export function useDockerStart() {
  const client = useQueryClient();
  const operations = useQuery({ ...operationsQuery(), staleTime: 30_000, retry: false });
  const mutation = useMutation({ mutationKey: START_KEY, gcTime: 0, mutationFn: () => startDocker(client) });
  const submissions = useMutationState({ filters: { mutationKey: START_KEY }, select: entry => entry.state });
  const jobs = operations.data?.jobs.filter(job => job.kind === "docker-start") ?? [];
  const running = jobs.find(job => job.status === "running");
  const job = running ?? [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const submitting = submissions.some(entry => entry.status === "pending");
  return { start: mutation.mutateAsync, starting: submitting || Boolean(running), job,
    error: submissions.at(-1)?.error, submitting };
}

/** Shell owns refresh policy; consumers share data without adding polling loops. */
export function GlobalDockerStatus() {
  const client = useQueryClient();
  useQuery({ ...dockerStatusQuery(true), refetchInterval: 5000, refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always", refetchOnReconnect: "always" });
  const operations = useQuery({ ...operationsQuery(), enabled: false });
  const versions = useRef(new Map<string, string>());
  useEffect(() => {
    let settled = false;
    for (const job of operations.data?.jobs ?? []) {
      if (job.kind !== "docker-start") continue;
      const before = versions.current.get(job.id);
      versions.current.set(job.id, job.status);
      if (job.status !== "running" && before !== job.status) settled = true;
    }
    if (settled) void refreshDocker(client).catch(() => {});
  }, [client, operations.data]);
  useEffect(() => {
    const source = connectStudioEvents(token);
    source.addEventListener("machine-docker", event => {
      const status = JSON.parse((event as MessageEvent<string>).data) as DockerStatusView;
      client.setQueryData(dockerStatusQuery().queryKey, previous => newerDockerStatus(previous, status));
    });
    source.addEventListener("open", () => { void refreshDocker(client).catch(() => {}); });
    return () => source.close();
  }, [client]);
  return null;
}
