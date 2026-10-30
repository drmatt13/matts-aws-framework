import type {
  AwsProblem, DeployMode, DeployOverview, DeployPreferences, DiscoveryView, DriftView, JobLogLine, JobView, OperationKind,
  PlanSummaryView, PlanView, StackEventView, StatusView, TeardownPlanView,
} from "../../shared/deploy";
import { call } from "../http";

/**
 * Deploy & Run, from the page's side: typed reads of /api/deploy, one way to
 * start an operation. Query identity and event subscriptions have separate owners.
 */

export type Observation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: AwsProblem };

const query = (values: Record<string, string | undefined | boolean>) => {
  const entries = Object.entries(values).filter((entry): entry is [string, string | true] => entry[1] !== undefined && entry[1] !== false && entry[1] !== "");
  return entries.length ? `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(value === true ? "1" : value)}`).join("&")}` : "";
};

export const deployApi = {
  overview: (force = false) => call<DeployOverview>(`/deploy/overview${query({ force })}`),
  discover: (profile: string, force = false) => call<Observation<DiscoveryView>>(`/deploy/discover${query({ profile, force })}`),
  status: (profile: string, deployment: string, force = false, region?: string) => call<Observation<StatusView>>(`/deploy/status${query({ profile, deployment, region, force })}`),
  teardown: (profile: string, deployment: string, mode: DeployMode, region?: string, retainFailed = false, disableProtection = false) => call<Observation<TeardownPlanView>>(`/deploy/teardown${query({ profile, deployment, mode, region, retainFailed, disableProtection })}`),
  plans: () => call<PlanSummaryView[]>("/deploy/plans"),
  plan: (key: string) => call<PlanView>(`/deploy/plans/${encodeURIComponent(key)}`),
  drift: (deployment: string, account?: string, region?: string) => call<DriftView | null>(`/deploy/drift${query({ deployment, account, region })}`),
  operate: (kind: OperationKind, params: Record<string, string | boolean | undefined>) => call<JobView>("/deploy/operations", { kind, params }),
  cancel: (id: string) => call<JobView>(`/deploy/jobs/${encodeURIComponent(id)}/cancel`, {}),
  log: (id: string, after = 0) => call<{ lines: JobLogLine[]; job: JobView }>(`/deploy/jobs/${encodeURIComponent(id)}/log${query({ after: after ? String(after) : undefined })}`),
  serviceLogs: (service: string) => call<{ text: string }>(`/deploy/local/logs${query({ service })}`),
  preferences: (patch: { profile?: string; deployment?: string }) => call<DeployPreferences>("/deploy/preferences", patch),
};
