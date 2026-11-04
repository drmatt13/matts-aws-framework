import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DeployOverview, JobLogLine, JobView, StackEventView } from "../../shared/deploy";
import { token } from "../http";
import { connectStudioEvents } from "../events";
import { deployApi } from "./api";
import { LogStore } from "./log-store";
import { deploymentOverviewQuery } from "./queries";

/** Every job's log lines, shared by whatever shows them. */
export const logs = new LogStore();

/**
 * A job's log: what was missed is replayed from where the unbroken log ends,
 * on opening and whenever a gap appears; the rest arrives as events.
 */
export function useJobLog(id: string | undefined, lastSeq = 0): readonly JobLogLine[] {
  const version = useSyncExternalStore(logs.subscribe, logs.snapshot);
  const opened = useRef<string | undefined>(undefined);
  const fetching = useRef(new Set<string>());
  useEffect(() => {
    if (!id || fetching.current.has(id)) return;
    if (opened.current === id && !logs.incomplete(id) && logs.resumeAfter(id) >= lastSeq) return;
    opened.current = id;
    fetching.current.add(id);
    void deployApi.log(id, logs.resumeAfter(id))
      .then((result) => logs.add(id, result.lines))
      .catch(() => {})
      .finally(() => { fetching.current.delete(id); });
  }, [id, version, lastSeq]);
  return id ? logs.get(id) : [];
}

export interface LiveHandlers {
  readonly onConnectionChange?: () => void;
  readonly onJob?: (job: JobView) => void;
  readonly onEvent?: (deployment: string, event: StackEventView, context: { profile?: string; account?: string; region?: string }) => void;
}

/**
 * Keeps Deploy & Run's queries current from the studio's event stream:
 * jobs, their logs, CloudFormation progress, and changes an operation made.
 */
export function useDeployLive(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = connectStudioEvents(token);
    const parse = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("deploy-job", (event) => {
      const job = parse<JobView>(event);
      queryClient.setQueryData<DeployOverview>(deploymentOverviewQuery().queryKey, (overview) => overview && {
        ...overview, jobs: [job, ...overview.jobs.filter((entry) => entry.id !== job.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      });
    });
    source.addEventListener("deploy-log", (event) => {
      const { id, lines } = parse<{ id: string; lines: JobLogLine[] }>(event);
      logs.add(id, lines);
    });
    source.addEventListener("deploy-stacks", (event) => {
      const { deployment } = parse<{ deployment: string }>(event);
      void queryClient.invalidateQueries({ queryKey: ["deploy", "status"], predicate: (entry) => entry.queryKey.includes(deployment) });
    });
    source.addEventListener("deploy-changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["deploy"] });
    });
    source.addEventListener("aws-connections", () => {
      void queryClient.invalidateQueries({ queryKey: ["deploy"], refetchType: "none" });
    });
    source.addEventListener("open", () => {
      void queryClient.invalidateQueries({ queryKey: ["deploy"] });
    });
    return () => source.close();
  }, [queryClient]);
}

/** Page-specific reactions share the stream without repeating global cache/log writes. */
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
    source.addEventListener("aws-connections", () => current.current.onConnectionChange?.());
    return () => source.close();
  }, []);
}
