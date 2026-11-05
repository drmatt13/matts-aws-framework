import { lazy, memo, Suspense, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobView } from "../../shared/operations";
import { OPEN_ACTIVITY_EVENT } from "../activity";
import { operationsApi } from "../operations/api";
import { useOperationsLive } from "../operations/live";
import { operationsQuery } from "../operations/queries";
import { Activity } from "./deploy/Activity";
import { useDockerStart, useDockerStatus } from "../machine/docker";
import { dockerPresence } from "../../shared/machine";
import { useAgentChat } from "../agent-chat";
const AgentPanel = lazy(() => import("../sightline/AgentViews").then(module => ({ default: module.AgentViews })));

const NO_JOBS: readonly JobView[] = [];
const selectJobs = (overview: { jobs: readonly JobView[] }) => overview.jobs;

/** Route-independent state and subscriptions; navigation does not render this tray. */
export const GlobalActivity = memo(function GlobalActivity() {
  const queryClient = useQueryClient();
  const docker = useDockerStatus();
  const { start, starting } = useDockerStart();
  const overview = useQuery({
    ...operationsQuery(),
    select: selectJobs,
    staleTime: 30_000,
    refetchInterval: query => query.state.data?.jobs.some(job => job.kind === "docker-start" && job.status === "running") ? 1000 : 30_000,
    retry: false,
    notifyOnChangeProps: ["data", "error", "isPending"],
  });
  useOperationsLive();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"activity" | "agent">("activity");
  const [agentVisited, setAgentVisited] = useState(false);
  const [conversationVisible, setConversationVisible] = useState(true);
  const agentVisible = open && mode === "agent";
  const chat = useAgentChat(agentVisible && conversationVisible);
  const [selected, setSelected] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const reveal = (event: Event) => {
      const job = (event as CustomEvent<unknown>).detail;
      if (typeof job !== "string") return;
      setSelected(job);
      setMode("activity");
      setOpen(true);
      // A durable acceptance response can arrive while the live stream is disconnected.
      void queryClient.invalidateQueries({ queryKey: operationsQuery().queryKey });
    };
    window.addEventListener(OPEN_ACTIVITY_EVENT, reveal);
    return () => window.removeEventListener(OPEN_ACTIVITY_EVENT, reveal);
  }, [queryClient]);
  const toggle = useCallback(() => setOpen(value => !value), []);
  const startDocker = useCallback(async () => {
    setActionError(undefined);
    try {
      setSelected((await start()).id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setMode("activity");
      setOpen(true);
    }
  }, [start]);
  const cancel = useCallback(async (id: string) => {
    setActionError(undefined);
    try {
      const job = await operationsApi.cancel(id);
      queryClient.setQueryData<{ jobs: readonly JobView[] }>(operationsQuery().queryKey, current => {
        const observed = current?.jobs.find(entry => entry.id === id);
        const latest = observed && (observed.lastSeq > job.lastSeq || observed.status !== "running" && job.status === "running")
          ? { ...observed, cancelRequested: job.cancelRequested }
          : job;
        return { jobs: [latest, ...(current?.jobs ?? []).filter(entry => entry.id !== id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [queryClient]);

  return <Activity
    jobs={overview.data ?? NO_JOBS}
    docker={dockerPresence({ status: docker.status, problem: docker.error, starting })}
    onStartDocker={startDocker}
    // A failed read is already the status this reports.
    onCheckDocker={() => docker.refresh().catch(() => undefined)}
    selected={selected}
    onSelect={setSelected}
    open={open}
    onToggle={toggle}
    mode={mode}
    onModeChange={value => { setMode(value); if (value === "agent") setAgentVisited(true); }}
    agent={agentVisited ? <Suspense fallback={<p role="status" className="m-auto text-caption text-graphite">Opening agent…</p>}><AgentPanel chat={chat} visible={agentVisible} onConversationVisibilityChange={setConversationVisible} /></Suspense> : <></>}
    agentPending={chat.pending}
    agentUnread={chat.unread}
    agentSummary={chat.pending ? `${chat.provider === "codex" ? "Codex" : "Claude"} is thinking…` : chat.unread ? chat.problem ? "Response needs attention" : "Reply ready" : chat.messages.length ? "Continue your conversation" : "A question, an idea, a next step"}
    onCancel={cancel}
    loading={overview.isPending}
    problem={overview.error?.message}
    retrying={retrying}
    onRetry={() => {
      setRetrying(true);
      void overview.refetch().finally(() => setRetrying(false));
    }}
    actionError={actionError}
  />;
});
