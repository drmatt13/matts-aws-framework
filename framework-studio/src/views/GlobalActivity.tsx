import { memo, useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeployOverview, JobView } from "../../shared/deploy";
import { OPEN_ACTIVITY_EVENT } from "../activity";
import { deployApi } from "../deploy/api";
import { useDeployLive } from "../deploy/live";
import { deploymentOverviewQuery } from "../deploy/queries";
import { Activity } from "./deploy/Activity";

const NO_JOBS: readonly JobView[] = [];
const selectJobs = (overview: DeployOverview) => overview.jobs;

/** Route-independent state and subscriptions; navigation does not render this tray. */
export const GlobalActivity = memo(function GlobalActivity() {
  const overview = useQuery({
    ...deploymentOverviewQuery(),
    select: selectJobs,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
    notifyOnChangeProps: ["data", "error", "isPending"],
  });
  useDeployLive();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [cancelError, setCancelError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const reveal = (event: Event) => {
      const job = (event as CustomEvent<unknown>).detail;
      if (typeof job !== "string") return;
      setSelected(job);
      setOpen(true);
    };
    window.addEventListener(OPEN_ACTIVITY_EVENT, reveal);
    return () => window.removeEventListener(OPEN_ACTIVITY_EVENT, reveal);
  }, []);
  const toggle = useCallback(() => setOpen(value => !value), []);
  const cancel = useCallback(async (id: string) => {
    setCancelError(undefined);
    try {
      await deployApi.cancel(id);
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return <Activity
    jobs={overview.data ?? NO_JOBS}
    selected={selected}
    onSelect={setSelected}
    open={open}
    onToggle={toggle}
    onCancel={cancel}
    loading={overview.isPending}
    problem={overview.error?.message}
    retrying={retrying}
    onRetry={() => {
      setRetrying(true);
      void overview.refetch().finally(() => setRetrying(false));
    }}
    cancelError={cancelError}
  />;
});
