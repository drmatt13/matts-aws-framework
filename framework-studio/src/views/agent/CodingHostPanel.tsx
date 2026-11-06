import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRuntimeUpgradeView } from "../../../shared/agent-runtime";
import { agentTasksApi } from "../../agent-tasks-api";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Surface";

const phases = { prepared: "Agent host restart prepared", draining: "Waiting for agent host work to finish", starting: "Starting the updated agent host", ready: "Agent host restarted", failed: "Agent host restart failed" } as const;
const activeIntent = (phase?: string) => phase === "prepared" || phase === "draining" || phase === "starting";
interface RestartRequest { readonly requestId: string; readonly replaceFailedRequestId?: string }
const requestIdValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);

/** Host lifecycle is explicit and separate from task approval and Studio restart. */
export function CodingHostPanel({ repository, visible, active }: { readonly repository: string; readonly visible: boolean; readonly active: boolean }) {
  const client = useQueryClient(), key = ["coding-runtime-upgrade", repository] as const;
  const storageKey = `aws-studio:agent-host-restart:v1:${repository}`;
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [problem, setProblem] = useState<string>();
  const running = useRef(false);
  const [request, setRequest] = useState<RestartRequest | undefined>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const value: unknown = requestIdValid(saved) ? { requestId: saved } : JSON.parse(saved);
        if (value && typeof value === "object" && "requestId" in value && requestIdValid(value.requestId)
          && (!("replaceFailedRequestId" in value) || requestIdValid(value.replaceFailedRequestId))) {
          return { requestId: value.requestId, ...("replaceFailedRequestId" in value ? { replaceFailedRequestId: value.replaceFailedRequestId as string } : {}) };
        }
      }
    } catch { /* In-memory retries still retain their request identity. */ }
    return undefined;
  });
  const state = useQuery({ queryKey: key, queryFn: ({ signal }) => agentTasksApi.runtimeUpgrade(signal), enabled: visible && open, retry: false, refetchOnWindowFocus: false,
    refetchInterval: query => visible && open && (activeIntent(query.state.data?.intent?.phase) || !!request) ? 1000 : false });
  const intent = state.data?.intent;
  const pendingCorrection = !!request?.replaceFailedRequestId && request.requestId !== intent?.requestId;
  useEffect(() => {
    if (pending || !intent || intent.phase !== "ready" && intent.phase !== "failed") return;
    if (request?.requestId === intent.requestId) {
      setRequest(undefined);
      setProblem(undefined);
      try { localStorage.removeItem(storageKey); } catch { /* The retained browser key is non-authoritative. */ }
    }
    if (intent.phase === "ready") {
      void client.invalidateQueries({ queryKey: ["coding-tasks", repository] });
      void client.invalidateQueries({ queryKey: ["coding-task-events"] });
    }
  }, [client, intent, pending, repository, request?.requestId, storageKey]);
  const restart = async (replaceFailed = false) => {
    if (running.current || active || activeIntent(intent?.phase) || state.isPending || state.error && !request) return;
    if (replaceFailed && (intent?.phase !== "failed" || request && request.replaceFailedRequestId !== intent.requestId)) return;
    if (!replaceFailed && pendingCorrection) return;
    running.current = true; setPending(true); setProblem(undefined);
    const next = request ?? (replaceFailed ? { requestId: crypto.randomUUID(), replaceFailedRequestId: intent!.requestId }
      : intent?.phase === "failed" ? { requestId: intent.requestId, ...(intent.replacesRequestId ? { replaceFailedRequestId: intent.replacesRequestId } : {}) }
      : { requestId: crypto.randomUUID() });
    setRequest(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep this identity in memory for retry. */ }
    try {
      const accepted = await agentTasksApi.restartHost(next.requestId, next.replaceFailedRequestId);
      client.setQueryData<AgentRuntimeUpgradeView>(key, { intent: accepted });
      void state.refetch();
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); void state.refetch(); }
    finally { running.current = false; setPending(false); }
  };
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="rounded-md border border-rule p-3">
    <summary className="cursor-pointer font-semibold">Agent host</summary>
    {open ? <section aria-label="Agent host controls" className="mt-3 grid gap-2">
      <p className="m-0 text-caption text-graphite">Restart the coding agent host to load its updated implementation. Finish or cancel active tasks first. Task history and proposals stay available. This is separate from restarting the Studio interface.</p>
      {state.isPending ? <p role="status" className="m-0 text-caption">Checking agent host restart state…</p> : null}
      {state.error || problem ? <Notice role="alert">{problem ?? state.error?.message} <Button type="button" variant="link" disabled={pending} onClick={() => { setProblem(undefined); void state.refetch(); }}>Refresh host state</Button></Notice> : null}
      {intent ? <Notice tone={intent.phase === "ready" ? "success" : intent.phase === "failed" ? "error" : "neutral"}><p role="status" className="m-0">{phases[intent.phase]}</p>{intent.error ? <p className="mb-0 mt-1">{intent.error}</p> : null}</Notice> : null}
      {active ? <p className="m-0 text-caption">A coding task is active. Finish or cancel it before restarting the host.</p> : null}
      <div><Button type="button" disabled={pending || active || activeIntent(intent?.phase) || state.isPending || !!state.error && !request || pendingCorrection} onClick={() => void restart()}>{pending || activeIntent(intent?.phase) ? "Restarting agent host…" : "Restart agent host"}</Button></div>
      {intent?.phase === "failed" ? <div>
        <Button type="button" disabled={pending || active || !!state.error && !request || !!request && request.replaceFailedRequestId !== intent.requestId} onClick={() => void restart(true)}>Restart from corrected source</Button>
        <p className="mb-0 mt-1 text-caption text-graphite">After saving a fix, this creates a new host version from current source and retains the previous failure record. Restart agent host retries the previous version. A disconnected corrected-source request keeps its identity when retried.</p>
      </div> : null}
    </section> : null}
  </details>;
}
