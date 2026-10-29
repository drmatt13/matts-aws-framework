import { cx } from "../ui/classes";
import { buttonClasses } from "../ui/Button";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobView, OperationKind, OperationRequest, PlanView, StackEventView } from "../../shared/deploy";
import { deploymentFindings, nextAction, type Action } from "../../shared/deploy-findings";
import { ApiError } from "../api";
import { deployApi, useDeployLive } from "../deploy/api";
import { AccountBar } from "./deploy/AccountBar";
import { Activity } from "./deploy/Activity";
import { Detail, type MoreAction } from "./deploy/Detail";
import { PlanReview } from "./deploy/PlanReview";
import { Rail, type RailRow } from "./deploy/Rail";
import { ServiceLogs, Teardown } from "./deploy/Teardown";
import { DeploymentIdentities, FrontendRelease } from "./deploy/FrontendRelease";
import { LifecycleDisclosure } from "./DataRetention";

/**
 * Deploy & Run: what this repository intends, what the chosen account holds,
 * and what this machine runs, side by side, with the next step offered.
 *
 * Every read goes through the repository's own deploy:status; every change is
 * an operation the studio server runs as a job, whose progress streams below.
 */
export function Deploy() {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery({ queryKey: ["deploy", "overview"], queryFn: () => deployApi.overview(), refetchInterval: 15_000 });
  const overview = overviewQuery.data;
  const [profile, setProfileState] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityJob, setActivityJob] = useState<string>();
  const [reviewKey, setReviewKey] = useState<string>();
  const [teardown, setTeardown] = useState<{ deployment: string; mode: "dev" | "prod"; region?: string }>();
  const [serviceLogs, setServiceLogs] = useState<string>();
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: "refuse" | "info" }[]>([]);
  const [liveEvents, setLiveEvents] = useState<Record<string, StackEventView[]>>({});
  const startedHere = useRef(new Set<string>());
  /** What to do once a job this page started succeeds: one operation after another. */
  const afterSuccess = useRef(new Map<string, () => void>());

  const toast = useCallback((text: string, tone: "refuse" | "info" = "refuse") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 7000);
  }, []);

  // The remembered profile and deployment, once the overview has them.
  useEffect(() => {
    if (!overview) return;
    setProfileState((current) => current ?? overview.preferences.profile ?? overview.profiles.find((entry) => entry.region)?.name ?? overview.profiles[0]?.name);
    setSelected((current) => current ?? overview.preferences.deployment ?? overview.targets[0]?.name);
  }, [overview]);

  const setProfile = (name: string) => {
    setProfileState(name);
    void deployApi.preferences({ profile: name, ...(selected ? { deployment: selected } : {}) }).catch(() => {});
  };

  const select = (name: string) => {
    setSelected(name);
    const remembered = overview?.preferences.profiles[name];
    if (remembered && remembered !== profile && overview?.profiles.some((entry) => entry.name === remembered)) setProfileState(remembered);
    void deployApi.preferences({ deployment: name, ...(remembered ?? profile ? { profile: remembered ?? profile } : {}) }).catch(() => {});
  };

  const jobs = overview?.jobs ?? [];
  const runningFor = (name: string | undefined) => jobs.find((job) => job.status === "running" && job.deployment === name && job.kind !== "local-watch" && job.kind !== "local-client");

  // Discovery (every deployment in the account) and the selected deployment's
  // status are read side by side: status carries a full discovery too, so the
  // page shows whichever answers first.
  const selectedName = selected ?? overview?.targets[0]?.name;
  // A target pinned to a region is read from that region, as deploying it would use.
  const selectedRegion = overview?.targets.find((target) => target.name === selectedName)?.region;
  const discoveryQuery = useQuery({
    queryKey: ["deploy", "discover", profile],
    queryFn: () => deployApi.discover(profile!),
    enabled: Boolean(profile),
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
  const busySelected = Boolean(runningFor(selectedName));
  const statusQuery = useQuery({
    queryKey: ["deploy", "status", profile, selectedName, selectedRegion],
    queryFn: () => deployApi.status(profile!, selectedName!, false, selectedRegion),
    enabled: Boolean(profile && selectedName),
    staleTime: 3_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      return busySelected || (data?.ok && data.value.detail?.state.kind === "in-progress") ? 4_000 : 60_000;
    },
  });
  const status = statusQuery.data?.ok ? statusQuery.data.value : undefined;
  const discovery = discoveryQuery.data?.ok ? discoveryQuery.data.value : status;
  const problem = statusQuery.data && !statusQuery.data.ok ? statusQuery.data.problem : !statusQuery.data && discoveryQuery.data && !discoveryQuery.data.ok ? discoveryQuery.data.problem : undefined;
  const selectedContext = status?.context ?? (selectedRegion && selectedRegion !== discovery?.context.region ? undefined : discovery?.context);

  const rows: RailRow[] = useMemo(() => {
    const targets = overview?.targets ?? [];
    // The selected target as its own status read it (its pinned region); the others as discovery saw them.
    const repository = targets.map((target): RailRow => (status && target.name === status.deployment ? {
      name: target.name, mode: target.mode, section: "repository", target,
      match: status.targets.find((entry) => entry.name === target.name), deployment: status.detail,
    } : {
      name: target.name, mode: target.mode, section: "repository", target,
      match: discovery?.targets.find((entry) => entry.name === target.name),
      deployment: discovery?.deployments.find((entry) => entry.name === target.name),
    }));
    const others = (discovery?.deployments ?? []).filter((entry) => !targets.some((target) => target.name === entry.name))
      .map((deployment): RailRow => ({ name: deployment.name, mode: deployment.mode, section: "discovered", deployment }));
    return [...repository, ...others];
  }, [overview?.targets, discovery, status]);
  const row = rows.find((entry) => entry.name === selectedName) ?? rows[0];
  const plansQuery = useQuery({ queryKey: ["deploy", "plans"], queryFn: () => deployApi.plans() });
  const driftQuery = useQuery({ queryKey: ["deploy", "drift", selectedContext?.account, selectedContext?.region, row?.name], queryFn: () => deployApi.drift(row!.name, selectedContext?.account, selectedContext?.region), enabled: Boolean(row && selectedContext) });

  useDeployLive({
    onJob: (job) => {
      if (job.status === "running") return;
      const then = afterSuccess.current.get(job.id);
      afterSuccess.current.delete(job.id);
      if (then && job.status === "succeeded") then();
      if (startedHere.current.has(job.id) && job.status === "succeeded" && job.kind === "deploy-plan" && job.planId) {
        const applied = job.params.autoApply && job.steps?.[1]?.status === "done";
        // Opened for review, unless another plan is already being reviewed: never swapped under the reader.
        if (!applied) setReviewKey((current) => current ?? job.planId);
      }
      if (startedHere.current.has(job.id) && job.status === "failed") toast(`${job.title} failed: ${job.summary ?? "see Activity"}`);
      if (startedHere.current.has(job.id) && job.status === "succeeded" && job.summary && job.summary !== "Done." && job.kind !== "deploy-plan") toast(job.summary, "info");
    },
    onEvent: (deployment, event, destination) => {
      if (!destination.account || !destination.region || !destination.profile) return;
      const key = [destination.profile, destination.account, destination.region, deployment].join("|");
      setLiveEvents((current) => ({ ...current, [key]: [event, ...(current[key] ?? []).filter((entry) => entry.id !== event.id)].slice(0, 100) }));
    },
  });

  const operate = useCallback(async (kind: OperationKind, params: Record<string, string | boolean | undefined>): Promise<JobView | undefined> => {
    try {
      const job = await deployApi.operate(kind, params);
      startedHere.current.add(job.id);
      setActivityJob(job.id);
      setActivityOpen(true);
      // The live stream may already have reported this job further along: keep that.
      queryClient.setQueryData(["deploy", "overview"], (current: typeof overview) => current && (current.jobs.some((entry) => entry.id === job.id) ? current : { ...current, jobs: [job, ...current.jobs] }));
      return job;
    } catch (error) {
      toast(error instanceof ApiError || error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }, [queryClient, toast]);

  const refreshAll = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    // Fetch through the query cache so pending/errors are observable and a failed
    // refresh keeps the last successful evidence on screen.
    await Promise.allSettled([
      queryClient.fetchQuery({ queryKey: ["deploy", "overview"], queryFn: () => deployApi.overview(true), staleTime: 0 }),
      ...(profile ? [queryClient.fetchQuery({ queryKey: ["deploy", "discover", profile], queryFn: () => deployApi.discover(profile, true), staleTime: 0 })] : []),
      ...(profile && row ? [queryClient.fetchQuery({ queryKey: ["deploy", "status", profile, row.name, row.target?.region], queryFn: () => deployApi.status(profile, row.name, true, row.target?.region), staleTime: 0 })] : []),
      queryClient.fetchQuery({ queryKey: ["deploy", "plans"], queryFn: () => deployApi.plans(), staleTime: 0 }),
    ]);
    refreshInFlight.current = false;
    setRefreshing(false);
  };

  // Until AWS has answered (or refused), nothing is said about what it holds.
  const awsKnown = Boolean(discovery || problem);
  const findings = useMemo(() => (row && overview && awsKnown ? deploymentFindings({
    // The selected deployment as its own status read it (in its pinned region), else as discovery saw it.
    name: row.name, target: row.target, match: status ? status.targets.find((entry) => entry.name === row.name) : row.match,
    deployment: status ? status.detail : row.deployment, detail: status?.detail,
    context: selectedContext, profile, problem,
    profileKind: overview.profiles.find((entry) => entry.name === profile)?.kind,
    local: overview.local, plans: plansQuery.data ?? [], jobs,
  }) : []), [row, overview, awsKnown, status, discovery, selectedContext, profile, problem, plansQuery.data, jobs]);
  const next = nextAction(findings);

  const act = (action: Action) => {
    if (!row || !profile) return;
    const name = row.name;
    switch (action.id) {
      case "sign-in": void operate("aws-login", { profile }); break;
      case "refresh": refreshAll(); break;
      case "deploy": void operate("deploy-plan", { deployment: name, profile, review: "template" }); break;
      case "plan": void operate("deploy-plan", { deployment: name, profile, review: "template" }); break;
      case "review-plan": setReviewKey(action.plan); break;
      case "discard-plan": void operate("deploy-discard", { plan: action.plan, profile }); break;
      case "export": void operate("export", { deployment: name, profile }); break;
      case "start": void operate("local-start", { deployment: name, profile }); break;
      case "start-exported": void operate("local-start", { deployment: name, profile, export: true }); break;
      case "stop": void operate("local-stop", {}); break;
      case "apply-changes": void operate("local-restart", { profile }); break;
      case "resume-watch": void operate("local-attach-watch", { profile }); break;
      case "start-docker": void operate("docker-start", {}); break;
      case "delete": setTeardown({ deployment: name, mode: row.mode, region: row.target?.region }); break;
    }
  };

  const more = (action: MoreAction) => {
    if (!row || !profile) return;
    if (action === "plan") void operate("deploy-plan", { deployment: row.name, profile, review: "template" });
    if (action === "change-sets") void operate("deploy-plan", { deployment: row.name, profile, review: "change-set" });
    if (action === "export") void operate("export", { deployment: row.name, profile });
    if (action === "drift") void operate("drift", { deployment: row.name, profile });
    if (action === "delete") setTeardown({ deployment: row.name, mode: row.mode, region: row.target?.region });
  };

  const remedy = (request: OperationRequest) => void operate(request.kind, { ...request.params });

  const events = useMemo(() => {
    if (!row) return [];
    const merged = new Map<string, StackEventView>();
    const key = [profile, selectedContext?.account, selectedContext?.region, row.name].join("|");
    for (const event of [...(liveEvents[key] ?? []), ...(status?.detail?.events ?? [])]) if (!merged.has(event.id)) merged.set(event.id, event);
    return [...merged.values()].sort((a, b) => b.time.localeCompare(a.time));
  }, [row, liveEvents, status, profile, selectedContext]);

  const reviewBusy = reviewKey ? runningFor(plansQuery.data?.find((plan) => plan.key === reviewKey)?.deployment)?.title : undefined;

  const readError = overviewQuery.error ?? discoveryQuery.error ?? statusQuery.error ?? plansQuery.error;
  if (overviewQuery.error && !overview) return <div className={"max-w-[640px] px-6 py-8 [&>h1]:mt-0 [&>h1]:mb-2.5 [&>h1]:font-condensed [&>h1]:text-[26px] [&>h1]:font-semibold"} role="alert"><h1>Deploy & Run could not be read</h1><p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"}>{overviewQuery.error instanceof Error ? overviewQuery.error.message : String(overviewQuery.error)}</p><button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={() => void overviewQuery.refetch()}>Try again</button></div>;
  if (!overview) return <p className={"px-6 py-20 text-center text-graphite"} role="status">Reading this machine and its AWS profiles…</p>;

  return (
    <div className={"grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] vp-900:h-auto"}>
      <AccountBar
        profiles={overview.profiles}
        profile={profile}
        onProfile={setProfile}
        context={selectedContext}
        problem={problem}
        loading={refreshing || overviewQuery.isFetching || discoveryQuery.isFetching || statusQuery.isFetching}
        readError={readError ? readError.message : undefined}
        scopeNotice={discoveryQuery.data && !discoveryQuery.data.ok && status ? "Account discovery in the profile's default region could not be read: " + discoveryQuery.data.problem.message + ". The selected deployment's observation below is separate." : undefined}
        onRefresh={refreshAll}
        onSignIn={() => profile && void operate("aws-login", { profile })}
        prerequisites={overview.prerequisites}
        onRemedy={remedy}
      />
      {overview.profiles.length === 0 ? (
        <div className={"max-w-[640px] px-6 py-8 [&>h1]:mt-0 [&>h1]:mb-2.5 [&>h1]:font-condensed [&>h1]:text-[26px] [&>h1]:font-semibold"}>
          <h1>No AWS profiles on this machine</h1>
          <p>Studio reads AWS through named profiles in ~/.aws/config. Create one with <code>aws configure sso</code> (or <code>aws configure</code>), then refresh.</p>
        </div>
      ) : (
        <div className={"grid min-h-0 grid-cols-[280px_minmax(0,1fr)] vp-900:grid-cols-1"}>
          <Rail rows={rows} unrecognized={discovery?.unrecognized ?? []} selected={row?.name} onSelect={select} known={Boolean(discovery)} local={overview.local} />
          {row ? (
            <Detail
              row={row}
              context={selectedContext}
              problem={problem}
              status={status}
              statusLoading={statusQuery.isFetching}
              record={discovery?.records[row.name]}
              findings={findings}
              awsKnown={awsKnown}
              next={next}
              local={overview.local}
              events={events}
              drift={driftQuery.data}
              busy={Boolean(runningFor(row.name))}
              onAction={act}
              onMore={more}
              onServiceLogs={setServiceLogs}
              frontend={<><DeploymentIdentities account={selectedContext?.account} region={selectedRegion ?? selectedContext?.region} onCreated={select} /><FrontendRelease key={[row.name, profile, selectedRegion ?? selectedContext?.region].join("|")} deployment={row.name} profile={profile} region={selectedRegion ?? selectedContext?.region} />{row.target && row.mode && profile && (selectedRegion ?? selectedContext?.region) ? <LifecycleDisclosure selection={{ deployment: row.name, mode: row.mode, profile, region: (selectedRegion ?? selectedContext?.region)! }} /> : null}</>}
            />
          ) : <p className={"px-6 py-20 text-center text-graphite"}>No deployments are declared in this repository.</p>}
        </div>
      )}
      <Activity
        jobs={jobs}
        selected={activityJob}
        onSelect={setActivityJob}
        open={activityOpen}
        onToggle={() => setActivityOpen(!activityOpen)}
        onCancel={(id) => void deployApi.cancel(id).catch((error) => toast(error instanceof Error ? error.message : String(error)))}
      />
      {reviewKey ? (
        <PlanReview
          key={reviewKey}
          planKey={reviewKey}
          busy={reviewBusy}
          onClose={() => setReviewKey(undefined)}
          onApply={(plan: PlanView, confirm) => { setReviewKey(undefined); void operate("deploy-apply", { plan: plan.key, profile: plan.profile ?? profile, ...(confirm ? { confirm } : {}) }); }}
          onDiscard={(plan) => { setReviewKey(undefined); void operate("deploy-discard", { plan: plan.key, profile: plan.profile ?? profile }); }}
          onReplan={(plan, createSecrets) => {
            setReviewKey(undefined);
            if (plan.result) { void operate("deploy-plan", { deployment: plan.identity.deployment, profile: plan.profile ?? profile, review: plan.review }); return; }
            void operate("deploy-discard", { plan: plan.key, profile: plan.profile ?? profile }).then((job) => {
              if (job) afterSuccess.current.set(job.id, () => void operate("deploy-plan", { deployment: plan.identity.deployment, profile: plan.profile ?? profile, review: plan.review, ...(createSecrets ? { createSecrets: true } : {}) }));
            });
          }}
        />
      ) : null}
      {teardown && profile ? (
        <Teardown
          deployment={teardown.deployment}
          mode={teardown.mode}
          profile={profile}
          region={teardown.region}
          busy={runningFor(teardown.deployment)?.title}
          onClose={() => setTeardown(undefined)}
          onDelete={({ confirm, retainFailed, review }) => {
            const target = teardown;
            setTeardown(undefined);
            void operate("destroy", { deployment: target.deployment, mode: target.mode, profile, confirm, review, ...(target.region ? { region: target.region } : {}), ...(retainFailed ? { retainFailed: true } : {}) });
          }}
        />
      ) : null}
      {serviceLogs ? <ServiceLogs service={serviceLogs} onClose={() => setServiceLogs(undefined)} /> : null}
      <div className={"fixed bottom-4 left-4 z-30 grid max-w-[min(460px,calc(100vw-32px))] gap-2"} role="status" aria-live="polite">
        {toasts.map((entry) => <div key={entry.id} className={cx("rounded-md px-4 py-3 text-step-minus1 text-sheet shadow-popover wrap-anywhere", entry.tone === "refuse" ? "bg-refuse" : "bg-ink")}>{entry.text}</div>)}
      </div>
    </div>
  );
}
