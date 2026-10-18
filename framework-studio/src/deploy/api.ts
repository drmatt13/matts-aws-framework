import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  AwsProblem, DeployMode, DeployOverview, DeployPreferences, DiscoveryView, DriftView, JobLogLine, JobView, OperationKind,
  PlanSummaryView, PlanView, StackEventView, StatusView, TeardownPlanView,
} from "../../shared/deploy";
import { call, token } from "../api";

/**
 * Deploy & Run, from the page's side: typed reads of /api/deploy, one way to
 * start an operation, and the live events that keep both current.
 */

export type Observation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: AwsProblem };

const query = (values: Record<string, string | undefined | boolean>) => {
  const entries = Object.entries(values).filter((entry): entry is [string, string | true] => entry[1] !== undefined && entry[1] !== false && entry[1] !== "");
  return entries.length ? `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(value === true ? "1" : value)}`).join("&")}` : "";
};

export const deployApi = {
  overview: (force = false) => call<DeployOverview>(`/deploy/overview${query({ force })}`),
  discover: (profile: string, force = false) => call<Observation<DiscoveryView>>(`/deploy/discover${query({ profile, force })}`),
  status: (profile: string, deployment: string, force = false) => call<Observation<StatusView>>(`/deploy/status${query({ profile, deployment, force })}`),
  teardown: (profile: string, deployment: string, mode: DeployMode, region?: string) => call<Observation<TeardownPlanView>>(`/deploy/teardown${query({ profile, deployment, mode, region })}`),
  plans: () => call<PlanSummaryView[]>("/deploy/plans"),
  plan: (key: string) => call<PlanView>(`/deploy/plans/${encodeURIComponent(key)}`),
  drift: (deployment: string) => call<DriftView | null>(`/deploy/drift${query({ deployment })}`),
  operate: (kind: OperationKind, params: Record<string, string | boolean | undefined>) => call<JobView>("/deploy/operations", { kind, params }),
  cancel: (id: string) => call<JobView>(`/deploy/jobs/${encodeURIComponent(id)}/cancel`, {}),
  log: (id: string, after = 0) => call<{ lines: JobLogLine[]; job: JobView }>(`/deploy/jobs/${encodeURIComponent(id)}/log${query({ after: after ? String(after) : undefined })}`),
  serviceLogs: (service: string) => call<{ text: string }>(`/deploy/local/logs${query({ service })}`),
  preferences: (patch: { profile?: string; deployment?: string }) => call<DeployPreferences>("/deploy/preferences", patch),
};

/** Every job's log lines as they arrive, shared by whatever shows them. */
class LogStore {
  private readonly lines = new Map<string, JobLogLine[]>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  get(id: string): readonly JobLogLine[] {
    return this.lines.get(id) ?? [];
  }

  last(id: string): number {
    return this.lines.get(id)?.at(-1)?.seq ?? 0;
  }

  add(id: string, incoming: readonly JobLogLine[]): void {
    const current = this.lines.get(id) ?? [];
    const after = current.at(-1)?.seq ?? 0;
    const fresh = incoming.filter((line) => line.seq > after);
    if (!fresh.length) return;
    this.lines.set(id, [...current, ...fresh].slice(-5000));
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export const logs = new LogStore();

/** A job's log: what was missed is fetched once, the rest arrives as events. */
export function useJobLog(id: string | undefined): readonly JobLogLine[] {
  useSyncExternalStore(logs.subscribe, logs.snapshot);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void deployApi.log(id, logs.last(id)).then((result) => { if (!cancelled) logs.add(id, result.lines); }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);
  return id ? logs.get(id) : [];
}

export interface LiveHandlers {
  readonly onJob?: (job: JobView) => void;
  readonly onEvent?: (deployment: string, event: StackEventView) => void;
}

/**
 * Keeps Deploy & Run's queries current from the studio's event stream:
 * jobs, their logs, CloudFormation progress, and changes an operation made.
 */
export function useDeployLive(handlers: LiveHandlers = {}): void {
  const queryClient = useQueryClient();
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    const parse = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("deploy-job", (event) => {
      const job = parse<JobView>(event);
      queryClient.setQueryData<DeployOverview>(["deploy", "overview"], (overview) => overview && {
        ...overview, jobs: [job, ...overview.jobs.filter((entry) => entry.id !== job.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      });
      current.current.onJob?.(job);
    });
    source.addEventListener("deploy-log", (event) => {
      const { id, lines } = parse<{ id: string; lines: JobLogLine[] }>(event);
      logs.add(id, lines);
    });
    source.addEventListener("deploy-stacks", (event) => {
      const { deployment } = parse<{ deployment: string }>(event);
      void queryClient.invalidateQueries({ queryKey: ["deploy", "status"], predicate: (entry) => entry.queryKey.includes(deployment) });
    });
    source.addEventListener("deploy-event", (event) => {
      const { deployment, stack, event: detail } = parse<{ deployment: string; stack: string; event: Omit<StackEventView, "stack"> }>(event);
      if (detail) current.current.onEvent?.(deployment, { ...detail, stack });
    });
    source.addEventListener("deploy-changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["deploy"] });
    });
    return () => source.close();
  }, [queryClient]);
}
