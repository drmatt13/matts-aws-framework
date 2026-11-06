import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { codingTaskActive, type CodingTask, type CodingTaskRequest } from "../shared/agent-runtime";
import { agentTasksApi, type CodingEventPage } from "./agent-tasks-api";
import { mergeCodingEvents } from "./coding-presentation";
import { codingTaskSelectionKey, OPEN_CODING_TASK_EVENT, type CodingTaskNavigation } from "./coding-task-navigation";
const eventKey = (id: string | undefined) => ["coding-task-events", id] as const;
const proposalKey = (id: string | undefined, digest: string | undefined) => ["coding-task-proposal", id, digest] as const;

/** Browser observation is disposable. Closing a panel never cancels durable work. */
export function useCodingTasks(visible: boolean, repository: string) {
  const client = useQueryClient(), storageKey = codingTaskSelectionKey(repository);
  const taskListKey = ["coding-tasks", repository] as const;
  const [selected, select] = useState<string | undefined>(() => { try { return localStorage.getItem(storageKey) ?? undefined; } catch { return undefined; } });
  const [problem, setProblem] = useState<string>();
  const [pending, setPending] = useState<string>();
  const action = useRef(false);
  const list = useQuery({ queryKey: taskListKey, queryFn: ({ signal }) => agentTasksApi.list(signal), enabled: visible, retry: false, refetchInterval: visible ? 5000 : false, refetchOnWindowFocus: false });
  useEffect(() => {
    if (!list.data) return;
    if (!selected || !list.data.tasks.some(task => task.id === selected)) select(list.data.tasks[0]?.id);
  }, [list.data, selected]);
  useEffect(() => { try { if (selected) localStorage.setItem(storageKey, selected); else localStorage.removeItem(storageKey); } catch { /* Selection remains session-local when storage is unavailable. */ } }, [selected, storageKey]);
  useEffect(() => {
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<CodingTaskNavigation>).detail;
      if (detail?.repository === repository && detail.task?.id) select(detail.task.id);
    };
    window.addEventListener(OPEN_CODING_TASK_EVENT, reveal);
    return () => window.removeEventListener(OPEN_CODING_TASK_EVENT, reveal);
  }, [repository]);
  const events = useQuery({
    queryKey: eventKey(selected), enabled: visible && !!selected, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const before = client.getQueryData<CodingEventPage>(eventKey(selected));
      const next = await agentTasksApi.events(selected!, before?.events.at(-1)?.seq ?? 0, signal);
      return { task: next.task, events: mergeCodingEvents(before?.events ?? [], next.events) };
    },
    refetchInterval: query => visible && (!query.state.data || codingTaskActive(query.state.data.task) || query.state.data.task.runtimeActivation?.status === "starting" || (query.state.data.events.at(-1)?.seq ?? 0) < query.state.data.task.lastSeq) ? 1000 : false,
  });
  const listed = list.data?.tasks.find(task => task.id === selected);
  const observed = events.data?.task;
  const task = observed && observed.id === selected && (!listed || observed.lastSeq >= listed.lastSeq) ? observed : listed;
  const proposal = useQuery({ queryKey: proposalKey(selected, task?.proposalDigest), queryFn: ({ signal }) => agentTasksApi.proposal(selected!, signal), enabled: visible && !!selected && !!task?.proposalDigest, retry: false, refetchOnWindowFocus: false });
  const accept = (updated: CodingTask) => {
    client.setQueryData<{ tasks: readonly CodingTask[] }>(taskListKey, previous => ({ tasks: [updated, ...(previous?.tasks ?? []).filter(item => item.id !== updated.id)] }));
    client.setQueryData<CodingEventPage>(eventKey(updated.id), previous => ({ task: updated, events: previous?.events ?? [] }));
    select(updated.id);
    void client.invalidateQueries({ queryKey: eventKey(updated.id) });
  };
  const run = async (name: string, execute: () => Promise<CodingTask>) => {
    if (action.current) return false;
    action.current = true; setPending(name); setProblem(undefined);
    try { accept(await execute()); return true; }
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); return false; }
    finally { action.current = false; setPending(undefined); }
  };
  return { list, selected, select, task, events, proposal, problem, pending,
    submit: (request: CodingTaskRequest) => run("Starting task", () => agentTasksApi.submit(request)),
    cancel: () => task && run("Cancelling task", () => agentTasksApi.cancel(task.id)),
    approve: () => task && proposal.data && run("Applying approved files", () => agentTasksApi.approve(task.id, proposal.data!.digest)),
    activate: () => task && proposal.data && run("Requesting Studio restart", () => agentTasksApi.activate(task.id, proposal.data!.digest)),
    reject: () => task && run("Rejecting proposal", () => agentTasksApi.reject(task.id)),
    resume: () => task && run("Resuming task", () => agentTasksApi.resume(task.id)),
    refresh: () => task && proposal.data && run("Refreshing candidate", () => agentTasksApi.refresh(task.id, proposal.data!.digest)),
    cleanup: () => task && run("Cleaning temporary task files", () => agentTasksApi.cleanup(task.id)),
    permission: (requestId: string, allow: boolean) => task && run("Answering permission request", () => agentTasksApi.permission(task.id, requestId, allow)),
    retry: () => { setProblem(undefined); void list.refetch(); if (selected) void events.refetch(); if (task?.proposalDigest) void proposal.refetch(); },
  };
}
