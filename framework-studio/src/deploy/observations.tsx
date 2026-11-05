import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DeployMode, DiscoveryView, JobView, StatusView } from "../../shared/deploy";
import { awsProfileCatalogQuery } from "../aws-profile-queries";
import { connectionGeneration } from "../connection-generations";
import { useStudio } from "../studio";
import { deploymentSourceRevision } from "../snapshot";
import { matchesDeployment, resolveDeploymentTarget, type DeploymentScope } from "./context";
import { invalidateDeploymentQueries, useDeployLive } from "./live";
import { AwsReadError, deploymentDiscoveryQuery, deploymentOverviewQuery, deploymentStatusQuery, previousDeploymentObservation, previousDeploymentOverview } from "./queries";

function useDeploymentSource() {
  const { response, live } = useStudio();
  return { repository: response.snapshot.repositoryRoot, sourceRevision: deploymentSourceRevision(response.snapshot.revision, live) };
}

/** Cache subscriptions only: activating and refreshing shared reads belongs to the owner below. */
export function useDeploymentOverview() {
  const source = useDeploymentSource();
  const client = useQueryClient();
  const current = useQuery({ ...deploymentOverviewQuery(false, source), enabled: false });
  const retained = !current.data ? previousDeploymentOverview(client, source.repository) : undefined;
  return { ...current, data: current.data ?? retained, isPlaceholderData: current.isPlaceholderData || Boolean(retained) };
}

export function useDeploymentObservation(mode?: DeployMode) {
  const studio = useStudio();
  const client = useQueryClient();
  const selectedMode = mode ?? studio.mode;
  const source = useDeploymentSource();
  const overviewQuery = useDeploymentOverview();
  const catalogQuery = useQuery({ ...awsProfileCatalogQuery(), enabled: false });
  const profile = studio.awsProfiles[selectedMode];
  const target = resolveDeploymentTarget(selectedMode, overviewQuery.data);
  const scope: DeploymentScope = {
    ...source, mode: selectedMode, profile, generation: connectionGeneration(studio.live, profile),
    deployment: target?.name, account: target?.account, region: target?.region,
  };
  const statusQuery = useQuery({ ...deploymentStatusQuery(scope), enabled: false });
  const discoveryQuery = useQuery({ ...deploymentDiscoveryQuery(scope), enabled: false });
  const availability = !profile ? "missing-profile" : catalogQuery.isError ? "catalog-error"
    : !catalogQuery.data ? "loading-profiles"
    : !catalogQuery.data.profiles.some(entry => entry.name === profile) ? "unavailable-profile" : "available";
  // A catalog transport failure makes availability unknown, rather than proving
  // that the saved profile vanished. Retain exact-context evidence as stale.
  const readable = availability === "available" || availability === "catalog-error";
  const retainedStatus = !statusQuery.data ? previousDeploymentObservation<StatusView>(client, scope, "status") : undefined;
  const retainedDiscovery = !discoveryQuery.data ? previousDeploymentObservation<DiscoveryView>(client, scope, "discover") : undefined;
  // Source-scoped queries still revalidate. The last exact-destination observation
  // remains evidence during that read and its errors, never a new confirmation.
  const status = readable ? statusQuery.data ?? retainedStatus : undefined;
  const discovery = status ?? (readable && !target ? discoveryQuery.data ?? retainedDiscovery : undefined);
  const retained = Boolean(target ? status && !statusQuery.data : discovery && !discoveryQuery.data);
  const error = target ? statusQuery.error : discoveryQuery.error;
  const problem = availability === "unavailable-profile"
    ? { kind: "profile" as const, message: `The saved profile “${profile}” is unavailable on this machine. Choose another profile.` }
    : catalogQuery.error ? { kind: "failed" as const, message: `AWS profile configuration could not be refreshed. ${catalogQuery.error.message}` }
    : error instanceof AwsReadError ? error.problem
    : error ? { kind: "failed" as const, message: error.message } : undefined;
  return { scope, target, profile, availability, overviewQuery, catalogQuery, statusQuery, discoveryQuery,
    status, discovery, problem, error, retained, contextKey: JSON.stringify(scope) };
}

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

export function deploymentPollInterval(active: boolean, failed: boolean, inProgress: boolean) {
  return failed ? 300_000 : inProgress ? 4000 : active ? 120_000 : 300_000;
}
function matchingJob(scope: DeploymentScope, job: JobView) {
  return job.status === "running" && !["local-watch", "local-client"].includes(job.kind)
    && Boolean(job.deployment && job.deployment === scope.deployment)
    && matchesDeployment(scope, { deployment: job.deployment, profile: typeof job.params.profile === "string" ? job.params.profile : undefined,
      region: typeof job.params.region === "string" ? job.params.region : undefined });
}

function ModeObserver({ mode, active, enabled }: { mode: DeployMode; active: boolean; enabled: boolean }) {
  const observation = useDeploymentObservation(mode);
  const client = useQueryClient();
  const studio = useStudio();
  const { scope, availability, target, overviewQuery } = observation;
  const allowed = enabled && availability === "available" && Boolean(overviewQuery.data);
  const busy = overviewQuery.data?.jobs.some(job => matchingJob(scope, job)) ?? false;
  const otherMode = mode === "dev" ? "prod" : "dev";
  // When neither mode has a target and both share a profile, one account
  // discovery (and one interval) serves both cache subscriptions.
  const ownsDiscovery = active || studio.awsProfiles[otherMode] !== scope.profile
    || Boolean(resolveDeploymentTarget(otherMode, overviewQuery.data));
  useQuery({ ...deploymentStatusQuery(scope), enabled: allowed && Boolean(target),
    refetchOnWindowFocus: true, refetchOnReconnect: true, refetchIntervalInBackground: false,
    refetchInterval: query => deploymentPollInterval(active, query.state.status === "error", busy || query.state.data?.detail?.state.kind === "in-progress"),
  });
  useQuery({ ...deploymentDiscoveryQuery(scope), enabled: allowed && !target && ownsDiscovery,
    refetchOnWindowFocus: true, refetchOnReconnect: true, refetchIntervalInBackground: false,
    refetchInterval: query => deploymentPollInterval(active, query.state.status === "error", false),
  });
  const previousProfile = useRef(scope.profile);
  const profileRefreshPending = useRef(false);
  useEffect(() => {
    if (previousProfile.current !== scope.profile) profileRefreshPending.current = true;
    previousProfile.current = scope.profile;
    if (!allowed || (!target && !ownsDiscovery) || (!active && !profileRefreshPending.current)) return;
    // Promotion revalidates stale evidence; re-association always revalidates.
    const staleTime = profileRefreshPending.current ? 0 : 20_000;
    profileRefreshPending.current = false;
    if (target) void client.fetchQuery({ ...deploymentStatusQuery(scope), staleTime }).catch(() => {});
    else void client.fetchQuery({ ...deploymentDiscoveryQuery(scope), staleTime }).catch(() => {});
  }, [client, active, allowed, observation.contextKey]);
  return null;
}

/** One persistent owner; source rendering and navigation never await AWS. */
export function GlobalDeploymentObservations() {
  const { mode, live } = useStudio();
  const client = useQueryClient();
  const source = useDeploymentSource();
  const visible = useVisible();
  useQuery({ ...deploymentOverviewQuery(false, source), enabled: visible, refetchOnWindowFocus: true, refetchOnReconnect: true });
  useQuery({ ...awsProfileCatalogQuery(), enabled: visible, refetchOnWindowFocus: true, refetchOnReconnect: true });
  const active = useDeploymentObservation();
  const [backgroundReady, setBackgroundReady] = useState(false);
  const settled = active.availability === "missing-profile" || active.availability === "unavailable-profile" || active.availability === "catalog-error"
    || (active.target ? active.statusQuery.isFetched : active.discoveryQuery.isFetched);
  useEffect(() => {
    if (!visible || backgroundReady) return;
    if (settled) { setBackgroundReady(true); return; }
    const timer = window.setTimeout(() => setBackgroundReady(true), 5000);
    return () => window.clearTimeout(timer);
  }, [visible, settled, backgroundReady]);
  useEffect(() => {
    if (live.reconnectRevision || live.awsConnectionRevision)
      invalidateDeploymentQueries(client, query => query.queryKey[1] === "overview");
  }, [client, live.reconnectRevision, live.awsConnectionRevision]);
  useDeployLive();
  return <>
    <ModeObserver mode="dev" active={mode === "dev"} enabled={visible && (mode === "dev" || backgroundReady)} />
    <ModeObserver mode="prod" active={mode === "prod"} enabled={visible && (mode === "prod" || backgroundReady)} />
  </>;
}

/** Explicit user refresh bypasses completed host caches and shares pending Query promises. */
export function useRefreshDeployment() {
  const client = useQueryClient();
  const { scope, target, availability } = useDeploymentObservation();
  const source = useDeploymentSource();
  return () => Promise.allSettled([
    client.fetchQuery({ ...deploymentOverviewQuery(true, source), staleTime: 0 }),
    client.fetchQuery({ ...awsProfileCatalogQuery(), staleTime: 0 }),
    ...(scope.profile && availability === "available" ? [target
      ? client.fetchQuery({ ...deploymentStatusQuery(scope, true), staleTime: 0 })
      : client.fetchQuery({ ...deploymentDiscoveryQuery(scope, true), staleTime: 0 })] : []),
  ]);
}
