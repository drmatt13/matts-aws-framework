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
export function useJobLog(id: string | undefined): readonly JobLogLine[] {
  const version = useSyncExternalStore(logs.subscribe, logs.snapshot);
  const opened = useRef<string | undefined>(undefined);
  const fetching = useRef(false);
  useEffect(() => {
    if (!id || fetching.current) return;
    if (opened.current === id && !logs.incomplete(id)) return;
    opened.current = id;
    fetching.current = true;
    void deployApi.log(id, logs.resumeAfter(id))
      .then((result) => logs.add(id, result.lines))
      .catch(() => {})
      .finally(() => { fetching.current = false; });
  }, [id, version]);
  return id ? logs.get(id) : [];
}

export interface LiveHandlers {
  readonly onJob?: (job: JobView) => void;
  readonly onEvent?: (deployment: string, event: StackEventView, context: { profile?: string; account?: string; region?: string }) => void;
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
    const source = connectStudioEvents(token);
    const parse = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("deploy-job", (event) => {
      const job = parse<JobView>(event);
      queryClient.setQueryData<DeployOverview>(deploymentOverviewQuery().queryKey, (overview) => overview && {
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
      const { deployment, stack, event: detail, profile, account, region } = parse<{ deployment: string; stack: string; event: Omit<StackEventView, "stack">; profile?: string; account?: string; region?: string }>(event);
      if (detail) current.current.onEvent?.(deployment, { ...detail, stack }, { profile, account, region });
    });
    source.addEventListener("deploy-changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["deploy"] });
    });
    return () => source.close();
  }, [queryClient]);
}
