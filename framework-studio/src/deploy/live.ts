import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { DeployOverview, JobView, StackEventView } from "../../shared/deploy";
import { token } from "../http";
import { connectStudioEvents } from "../events";
import { deploymentOverviewQuery } from "./queries";

export { logs, useJobLog } from "../operations/live";

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
  useDeployLive();
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
