import { usePublishSightline } from "../sightline/bridge";
import { useDockerStatus, useDockerStart } from "../machine/docker";
import { withDockerStatus, unavailableDockerStatus } from "../../shared/machine";
import { AwsReadError, deploymentOverviewQuery, deploymentPlansQuery } from "../deploy/queries";
import { cx } from "../ui/classes";
import { PageToolbar, pageBodyClasses, pageTitleClasses, documentProseClasses } from "./DocumentUI";
import { buttonClasses } from "../ui/Button";
import { Notice } from "../ui/Surface";
import { ToastNotice } from "../ui/ToastNotice";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  JobView,
  OperationKind,
  OperationRequest,
  PlanSummaryView,
  PlanView,
  StackEventView,
} from "../../shared/deploy";
import { deploymentFindings, type Action } from "../../shared/deploy-findings";
import { ApiError } from "../http";
import { deployApi } from "../deploy/api";
import { useDeployEvents } from "../deploy/live";
import { useDeploymentObservation, useRefreshDeployment } from "../deploy/observations";
import { openActivity } from "../activity";
import { AccountBar } from "./deploy/AccountBar";
import { Detail } from "./deploy/Detail";
import { PlanReview } from "./deploy/PlanReview";
import type { RailRow } from "./deploy/Rail";
import { Teardown } from "./deploy/Teardown";
import { KeepDeployedName } from "./deploy/KeepDeployedName";
import { useStudio } from "../studio";
import { openAwsProfileConfiguration } from "../aws-profile-queries";
import { useLocalRuntime } from "../deploy/local-runtime";
import { developmentMutationBlocker, runtimeActionRequiresOff } from "../deploy/dev-lifecycle";
import { operationsQuery } from "../operations/queries";
import type { RuntimeMutationGate } from "./deploy/RuntimeMutationNotice";

function DeployState({ title, machine, children }: {
  readonly title: string;
  readonly machine?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <PageToolbar appearance="plain" className="flex flex-wrap items-center justify-between gap-3">
        <h1 className={pageTitleClasses}>{title}</h1>
        {machine ? <div className="ml-auto min-w-0 max-w-full">{machine}</div> : null}
      </PageToolbar>
      <div className={cx(pageBodyClasses, "grid auto-rows-max gap-3")}>{children}</div>
    </>
  );
}

/**
 * Deploy & Run follows the global source mode and its associated AWS profile.
 *
 * Every read goes through the repository's own deploy:status; every change is
 * an operation the studio server runs as a job, whose progress streams below.
 */
export function Deploy() {
  const { mode: declarationMode } = useStudio();
  const observation = useDeploymentObservation();
  const { profile, overviewQuery, statusQuery, discoveryQuery, status, discovery, problem, target } = observation;
  const connectionKey = observation.contextKey;
  const refreshDeployment = useRefreshDeployment();
  const currentConnection = useRef(connectionKey);
  currentConnection.current = connectionKey;
  const queryClient = useQueryClient();
  const machineQuery = useDockerStatus();
  const dockerStart = useDockerStart();
  const runtime = useLocalRuntime();
  const runtimeOperations = useQuery({ ...operationsQuery(), enabled: false });
  const overview = overviewQuery.data ? withDockerStatus(overviewQuery.data, machineQuery.status ?? unavailableDockerStatus("Checking Docker…")) : undefined;
  const refreshInFlight = useRef(false);
  const [review, setReview] = useState<{ key: string; currentSource: boolean }>();
  const reviewKey = review?.key;
  const reviewCurrentSource = review?.currentSource ?? false;
  const synthesizeButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const [preparing, setPreparing] = useState<string>();
  const preparingConnection = useRef<string | undefined>(undefined);
  const [teardown, setTeardown] = useState<{
    deployment: string;
    mode: "dev" | "prod";
    region?: string;
  }>();
  const teardownButton = useRef<HTMLButtonElement | null>(null);
  const [keepName, setKeepName] = useState<{ stage: string; mode: "dev" | "prod"; deployAs: string }>();
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: "refuse" | "info" }[]>([]);
  const [liveEvents, setLiveEvents] = useState<Record<string, StackEventView[]>>({});
  const startedHere = useRef(new Set<string>());
  const startedConnections = useRef(new Map<string, string>());
  /** What to do once a job this page started succeeds: one operation after another. */
  const afterSuccess = useRef(new Map<string, () => void>());

  const toast = useCallback((text: string, tone: "refuse" | "info" = "refuse") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 7000);
  }, []);
  const runtimeBlocker = developmentMutationBlocker({ mode: "dev", local: runtime.local,
    problem: runtime.problem, operationsKnown: Boolean(runtimeOperations.data) && !runtimeOperations.error,
    job: runtime.job, submitting: runtime.busy });
  const runtimeGate: RuntimeMutationGate | undefined = runtimeBlocker ? {
    reason: runtime.error ? `${runtime.error} ${runtimeBlocker}` : runtimeBlocker,
    action: runtime.busy ? "Waiting for local runtime…" : runtime.active ? "Stop local runtime" : "Check again",
    disabled: runtime.busy || (!runtime.active && runtime.checking),
    onAction: () => {
      const work = runtime.active ? runtime.stop() : Promise.all([
        runtime.refresh(), queryClient.fetchQuery({ ...operationsQuery(), staleTime: 0 }),
      ]);
      void work.catch(error => toast(error instanceof Error ? error.message : String(error)));
    },
  } : undefined;

  useEffect(() => {
    setReview(undefined);
    setTeardown(undefined);
    // Follow-up actions must not acquire a new actor after their starting context changes.
    afterSuccess.current.clear();
  }, [connectionKey]);

  const jobs = overview?.jobs ?? [];
  const runningFor = (name: string | undefined) =>
    jobs.find(
      (job) =>
        job.status === "running" &&
        job.deployment === name &&
        job.kind !== "local-watch" &&
        job.kind !== "local-client",
    );

  const selectedName = target?.name;
  const selectedContext = status?.context ?? discovery?.context;

  const rows: RailRow[] = useMemo(() => {
    const targets = overview?.targets ?? [];
    // The selected target as its own status read it (its pinned region); the others as discovery saw them.
    const repository = targets.map((target): RailRow =>
      status && target.name === status.deployment
        ? {
            name: target.name,
            mode: target.mode,
            section: "repository",
            target,
            match: status.targets.find((entry) => entry.name === target.name),
            deployment: status.detail,
          }
        : {
            name: target.name,
            mode: target.mode,
            section: "repository",
            target,
            match: discovery?.targets.find((entry) => entry.name === target.name),
            deployment: discovery?.deployments.find((entry) => entry.name === target.name),
          },
    );
    const others = (discovery?.deployments ?? [])
      .filter((entry) => !targets.some((target) => target.name === entry.name))
      .map((deployment): RailRow => ({
        name: deployment.name,
        mode: deployment.mode,
        section: "discovered",
        deployment,
      }));
    return [...repository, ...others];
  }, [overview?.targets, discovery, status]);
  const row = rows.find((entry) => entry.name === selectedName);
  const plansQuery = useQuery(deploymentPlansQuery());
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: deploymentPlansQuery().queryKey });
  }, [queryClient, observation.scope.sourceRevision]);
  const driftQuery = useQuery({
    queryKey: ["deploy", "drift", selectedContext?.account, selectedContext?.region, row?.name, connectionKey],
    queryFn: () => deployApi.drift(row!.name, selectedContext?.account, selectedContext?.region),
    enabled: Boolean(row && selectedContext),
  });

  useDeployEvents({
    onJob: (job) => {
      if (job.status === "running") return;
      const then = afterSuccess.current.get(job.id);
      afterSuccess.current.delete(job.id);
      if (then && job.status === "succeeded") then();
      if (startedHere.current.has(job.id) && job.status === "failed")
        toast(`${job.title} failed: ${job.summary ?? "see Activity"}`);
      if (
        startedHere.current.has(job.id) &&
        job.status === "succeeded" &&
        job.summary &&
        job.summary !== "Done." &&
        job.kind !== "deploy-plan"
      )
        toast(job.summary, "info");
    },
    onEvent: (deployment, event, destination) => {
      if (!destination.account || !destination.region || !destination.profile) return;
      const key = [destination.profile, destination.account, destination.region, deployment].join(
        "|",
      );
      setLiveEvents((current) => ({
        ...current,
        [key]: [event, ...(current[key] ?? []).filter((entry) => entry.id !== event.id)].slice(
          0,
          100,
        ),
      }));
    },
  });

  const operate = useCallback(
    async (
      kind: OperationKind,
      params: Record<string, string | boolean | undefined>,
    ): Promise<JobView | undefined> => {
      try {
        const capturedConnection = currentConnection.current;
        const job = kind === "docker-start" ? await dockerStart.start() : await deployApi.operate(kind, params);
        startedHere.current.add(job.id);
        startedConnections.current.set(job.id, capturedConnection);
        openActivity(job.id);
        // The live stream may already have reported this job further along: keep that.
        queryClient.setQueryData(
          deploymentOverviewQuery(false, { repository: observation.scope.repository, sourceRevision: observation.scope.sourceRevision }).queryKey,
          (current: typeof overview) =>
            current &&
            (current.jobs.some((entry) => entry.id === job.id)
              ? current
              : { ...current, jobs: [job, ...current.jobs] }),
        );
        return job;
      } catch (error) {
        toast(error instanceof ApiError || error instanceof Error ? error.message : String(error));
        return undefined;
      }
    },
    [queryClient, toast, dockerStart.start, observation.scope.repository, observation.scope.sourceRevision],
  );

  const sameDestination = (plan: PlanSummaryView) => plan.deployment === selectedName
    && plan.mode === declarationMode && plan.profile === profile
    && plan.account === selectedContext?.account && plan.region === selectedContext?.region;
  const destinationPlans = [...(plansQuery.data ?? [])].filter(sameDestination)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.key.localeCompare(a.key));
  // Applying the newest generation supersedes earlier proposals; it must never
  // promote an older pending artifact back into the current slot.
  const latestPlan = destinationPlans.find(plan => plan.status !== "unfinished") ?? destinationPlans[0];
  const currentPlan = latestPlan && !latestPlan.applied ? latestPlan : undefined;
  const pending = preparing === connectionKey;
  const activeJob = runningFor(selectedName);

  const synthesize = async () => {
    if (!row || !profile || preparingConnection.current === connectionKey || activeJob) return;
    const connection = connectionKey;
    preparingConnection.current = connection;
    setPreparing(connection);
    try {
      await operate("deploy-plan", { deployment: row.name, profile, review: "template" });
    } finally {
      if (preparingConnection.current === connection) preparingConnection.current = undefined;
      setPreparing(current => current === connection ? undefined : current);
    }
  };

  const refreshAll = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    // Fetch through the query cache so pending/errors are observable and a failed
    // refresh keeps the last successful evidence on screen.
    await Promise.allSettled([
      machineQuery.refresh(),
      refreshDeployment(),
      queryClient.fetchQuery({ ...deploymentPlansQuery(), staleTime: 0 }),
    ]);
    refreshInFlight.current = false;
  };

  // Until AWS has answered (or refused), nothing is said about what it holds.
  const awsKnown = Boolean(discovery || problem);
  const findings = useMemo(
    () =>
      row && overview && awsKnown
        ? deploymentFindings({
            // The selected deployment as its own status read it (in its pinned region), else as discovery saw it.
            name: row.name,
            target: row.target,
            match: status ? status.targets.find((entry) => entry.name === row.name) : row.match,
            deployment: status ? status.detail : row.deployment,
            detail: status?.detail,
            context: selectedContext,
            profile,
            appId: overview.targets.find((target) => target.appId)?.appId,
            problem,
            profileKind: overview.profiles.find((entry) => entry.name === profile)?.kind,
            local: runtime.local ?? overview.local,
            plans: plansQuery.data ?? [],
            jobs,
          })
        : [],
    [
      row,
      overview,
      awsKnown,
      status,
      discovery,
      selectedContext,
      profile,
      problem,
      plansQuery.data,
      jobs,
      runtime.local,
    ],
  );
  const planFinding = (finding: typeof findings[number]) => ["PLAN_WAITING", "PLAN_EXPIRED", "PLAN_UNFINISHED"].includes(finding.code);
  const shownFindings = findings.map(finding => ({
    ...finding,
    actions: finding.actions.filter(action => action.id !== "deploy" && action.id !== "plan"),
  }));
  const visibleFindings = shownFindings.filter(finding => !planFinding(finding)
    || finding.actions.some(action => action.plan === currentPlan?.key));
  const earlierFindings = shownFindings.filter(finding => planFinding(finding)
    && !finding.actions.some(action => action.plan === currentPlan?.key));
  const blocked = !profile || !selectedContext || !awsKnown || Boolean(problem)
    || findings.some(finding => finding.severity === "blocking" && finding.scope !== "local" && finding.code !== "OPERATION_UNVERIFIED");

  const act = (action: Action, trigger?: HTMLButtonElement) => {
    if (!row || !profile) return;
    if (row.mode === "dev" && runtimeGate && runtimeActionRequiresOff(action.id)) {
      toast(runtimeGate.reason);
      return;
    }
    const name = row.name;
    switch (action.id) {
      case "sign-in":
        openAwsProfileConfiguration();
        break;
      case "refresh":
        refreshAll();
        break;
      case "deploy":
        void synthesize();
        break;
      case "plan":
        void synthesize();
        break;
      case "review-plan":
        reviewButton.current = trigger ?? synthesizeButton.current;
        setReview(action.plan ? { key: action.plan, currentSource: action.plan === currentPlan?.key && currentPlan.synthesis !== undefined } : undefined);
        break;
      case "discard-plan":
        void operate("deploy-discard", { plan: action.plan, profile });
        break;
      case "export":
        void operate("export", { deployment: name, profile });
        break;
      case "start":
        void operate("local-start", { deployment: name, profile });
        break;
      case "start-exported":
        void operate("local-start", { deployment: name, profile, export: true });
        break;
      case "stop":
        void operate("local-stop", {});
        break;
      case "apply-changes":
        void operate("local-restart", { profile });
        break;
      case "resume-watch":
        void operate("local-attach-watch", { profile });
        break;
      case "start-docker":
        void operate("docker-start", {});
        break;
      case "delete":
        teardownButton.current = trigger ?? null;
        setTeardown({ deployment: name, mode: row.mode, region: selectedContext?.region ?? row.target?.region });
        break;
      case "deploy-as":
        if (row.target?.stage && action.deployAs) setKeepName({ stage: row.target.stage, mode: row.mode, deployAs: action.deployAs });
        break;
    }
  };

  const remedy = (request: OperationRequest) => void operate(request.kind, { ...request.params });

  const events = useMemo(() => {
    if (!row) return [];
    const merged = new Map<string, StackEventView>();
    const key = [profile, selectedContext?.account, selectedContext?.region, row.name].join("|");
    for (const event of [...(liveEvents[key] ?? []), ...(status?.detail?.events ?? [])])
      if (!merged.has(event.id)) merged.set(event.id, event);
    return [...merged.values()].sort((a, b) => b.time.localeCompare(a.time));
  }, [row, liveEvents, status, profile, selectedContext]);

  const reviewBusy = reviewKey
    ? runningFor(plansQuery.data?.find((plan) => plan.key === reviewKey)?.deployment)?.title
    : undefined;

  usePublishSightline("deploy", () => ({
    availability: overviewQuery.error ? "error" : overview ? "available" : "loading",
    target: target ? { name: target.name, mode: target.mode, region: target.region } : undefined,
    reviewKey, findings: { availability: awsKnown ? "available" : "not-loaded",
      entries: findings.map(finding => ({ code: finding.code, severity: finding.severity, scope: finding.scope })) },
    running: jobs.filter(job => job.status === "running" && job.deployment === selectedName)
      .map(job => ({ id: job.id, kind: job.kind, status: job.status })),
  }));
  const observationError = observation.error instanceof AwsReadError ? undefined : observation.error;
  const readError = overviewQuery.error ?? observation.catalogQuery.error ?? observationError ?? plansQuery.error;
  const readNotice = status && statusQuery.error
    ? `Deployment evidence is stale. ${statusQuery.error.message}`
    : observation.availability === "unavailable-profile" ? problem?.message : undefined;
  if (overviewQuery.error && !overview)
    return (
      <DeployState title="Deploy & Run could not be read">
        <Notice className="flex flex-wrap items-center justify-between gap-3" role="alert">
          <p className={documentProseClasses}>
            {overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : String(overviewQuery.error)}
          </p>
          <button
            className={buttonClasses({ variant: "quiet", size: "regular" })}
            disabled={overviewQuery.isFetching}
            onClick={() => void refreshDeployment()}
          >
            {overviewQuery.isFetching ? "Retrying…" : "Try again"}
          </button>
        </Notice>
      </DeployState>
    );
  if (!overview)
    return (
      <DeployState title="Deploy & Run">
        <Notice tone="neutral" role="status">Reading this machine and its AWS profiles…</Notice>
      </DeployState>
    );

  const machine = <AccountBar prerequisites={overview.prerequisites} onRemedy={remedy} dockerStarting={dockerStart.starting} />;
  const readFeedback = readError || readNotice ? (
    <Notice className="flex flex-wrap items-center justify-between gap-3" role="alert">
      <span>{readError ? `Some information could not be refreshed. ${readError.message}` : readNotice}</span>
      {readError ? (
        <button className={buttonClasses({ variant: "quiet", size: "regular" })}
          disabled={overviewQuery.isFetching || discoveryQuery.isFetching || statusQuery.isFetching}
          onClick={() => void refreshAll()}>
          {overviewQuery.isFetching || discoveryQuery.isFetching || statusQuery.isFetching ? "Retrying…" : "Try again"}
        </button>
      ) : null}
    </Notice>
  ) : null;

  return (
    <div className="h-full min-h-0 vp-900:h-auto">
      <div className="min-h-0 min-w-0 overflow-auto">
        {overview.profiles.length === 0 ? (
          <DeployState title="No AWS profiles on this machine" machine={machine}>
            {readFeedback}
            <Notice tone="neutral">
              <p className={documentProseClasses}>
                Studio reads AWS through named profiles in ~/.aws/config. Create one with{" "}
                <code>aws configure sso</code> (or <code>aws configure</code>). Studio checks for changes in the background.
              </p>
            </Notice>
          </DeployState>
        ) : (
          <>
            {row ? (
              <Detail
                row={row}
                context={selectedContext}
                inspectionScope={observation.scope}
                runtimeGate={row.mode === "dev" ? runtimeGate : undefined}
                status={status}
                record={discovery?.records[row.name]}
                findings={visibleFindings}
                awsKnown={awsKnown}
                connectionMissing={!profile}
                onChooseConnection={openAwsProfileConfiguration}
                earlierFindings={earlierFindings}
                events={events}
                drift={driftQuery.data}
                onAction={act}
                busy={activeJob?.title ?? (pending ? "Synthesis" : undefined)}
                deploymentStale={Boolean(problem)}
                machine={machine}
                notice={readFeedback}
                actions={(
                  <div aria-label="Deployment actions">
                    <button ref={synthesizeButton} className={buttonClasses({ variant: "quiet", size: "regular" })}
                      disabled={blocked || pending || Boolean(activeJob)}
                      onClick={() => void synthesize()}>
                      {pending || activeJob?.kind === "deploy-plan" ? "Synthesizing…" : "Synthesize"}
                    </button>
                  </div>
                )}
              />
            ) : (
              <DeployState title="Deploy & Run" machine={machine}>
                {readFeedback}
                <Notice tone="neutral">
                  No {declarationMode === "dev" ? "development" : "production"} deployment is declared in this repository.
                </Notice>
              </DeployState>
            )}
          </>
        )}
      </div>
      {reviewKey ? (
        <PlanReview
          key={reviewKey}
          planKey={reviewKey}
          busy={reviewBusy}
          currentSource={reviewCurrentSource}
          runtimeGate={runtimeGate}
          returnFocusRef={reviewButton}
          onClose={() => setReview(undefined)}
          onApply={(plan: PlanView, confirm) => {
            if (plan.identity.mode === "dev" && runtimeGate) return;
            setReview(undefined);
            void operate("deploy-apply", {
              plan: plan.key,
              profile,
              ...(reviewCurrentSource ? { currentSource: true } : {}),
              ...(confirm ? { confirm } : {}),
            });
          }}
          onDiscard={(plan) => {
            setReview(undefined);
            void operate("deploy-discard", { plan: plan.key, profile });
          }}
          onReplan={(plan, createSecrets) => {
            setReview(undefined);
            if (plan.result) {
              void operate("deploy-plan", {
                deployment: plan.identity.deployment,
                profile,
                review: plan.review,
              });
              return;
            }
            void operate("deploy-discard", {
              plan: plan.key,
              profile,
            }).then((job) => {
              if (job && startedConnections.current.get(job.id) === currentConnection.current)
                afterSuccess.current.set(
                  job.id,
                  () =>
                    void operate("deploy-plan", {
                      deployment: plan.identity.deployment,
                      profile,
                      review: plan.review,
                      ...(createSecrets ? { createSecrets: true } : {}),
                    }),
                );
            });
          }}
        />
      ) : null}
      {keepName ? (
        <KeepDeployedName
          stage={keepName.stage}
          mode={keepName.mode}
          deployAs={keepName.deployAs}
          onClose={() => setKeepName(undefined)}
        />
      ) : null}
      {teardown && profile ? (
        <Teardown
          deployment={teardown.deployment}
          mode={teardown.mode}
          profile={profile}
          region={teardown.region}
          busy={runningFor(teardown.deployment)?.title}
          runtimeGate={teardown.mode === "dev" ? runtimeGate : undefined}
          returnFocusRef={teardownButton}
          onClose={() => setTeardown(undefined)}
          onDelete={({ confirm, retainFailed, review }) => {
            if (teardown.mode === "dev" && runtimeGate) return;
            const target = teardown;
            setTeardown(undefined);
            void operate("destroy", {
              deployment: target.deployment,
              mode: target.mode,
              profile,
              confirm,
              review,
              ...(target.region ? { region: target.region } : {}),
              ...(retainFailed ? { retainFailed: true } : {}),
            });
          }}
        />
      ) : null}
      <div
        className="fixed bottom-4 left-4 z-30 grid max-w-[min(460px,calc(100vw-32px))] gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((entry) => (
          <ToastNotice
            key={entry.id}
            text={entry.text}
            tone={entry.tone}
            onDismiss={() => setToasts((current) => current.filter((item) => item.id !== entry.id))}
          />
        ))}
      </div>
    </div>
  );
}
