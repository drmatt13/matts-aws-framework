import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  ApplyResponse,
  BatchPlanResponse,
  DraftEdit,
  CommandResult,
  EditIntent,
  PlanResponse,
  SnapshotEvent,
  SnapshotResponse,
} from "../shared/api";
import type { ResourceDetails, ResourceIntent, ResourcePlan, ResourceApply } from "../shared/resources";
import type { Mode } from "../shared/model";

/**
 * The studio's server, from the page's side.
 *
 * The session token arrives in the page itself, which no other origin can
 * read, and goes back on every call.
 */

const token = document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: { "x-studio-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? response.statusText);
  return payload as T;
}

export const api = {
  snapshot: () => call<SnapshotResponse>("/snapshot"),
  planBatch: (edits: readonly DraftEdit[], revision: string) => call<BatchPlanResponse>("/edits/batch/plan", { edits, revision }),
  applyBatch: (planId: string) => call<ApplyResponse>("/edits/batch/apply", { planId }),
  resourceDetails: (id: string, mode: Mode, signal?: AbortSignal) => call<ResourceDetails>(`/resources/details?id=${encodeURIComponent(id)}&mode=${mode}`, undefined, signal),
  resourcePlan: (intent: ResourceIntent, revision: string, mode: Mode) => call<ResourcePlan>("/resources/plan", { intent, revision, mode }),
  resourceApply: (planId: string) => call<ResourceApply>("/resources/apply", { planId }),
  resourceHistory: (direction: "undo" | "redo") => call<ResourceApply>(`/resources/${direction}`, {}),
  planRoute: (route: string, value: string, revision: string) => call<PlanResponse>("/routes/plan", { route, value, revision }),
  refreshCdkLinks: () => call<{ edges: number; files: number }>("/cdk-links/refresh", {}),
  plan: (intent: EditIntent, revision: string) => call<PlanResponse>("/edits/plan", { intent, revision }),
  apply: (planId: string) => call<ApplyResponse>("/edits/apply", { planId }),
  undo: () => call<ApplyResponse>("/edits/undo", {}),
  redo: () => call<ApplyResponse>("/edits/redo", {}),
  command: (name: string, confirmed = false) => call<CommandResult>(`/commands/${encodeURIComponent(name)}`, { confirmed }),
};

export function useSnapshot() {
  return useQuery({
    queryKey: ["snapshot"],
    queryFn: () => call<SnapshotResponse>("/snapshot"),
    staleTime: Number.POSITIVE_INFINITY,
    retry: (count, error) => error instanceof ApiError && error.status === 503 && count < 60,
    retryDelay: 1000,
  });
}

export interface LiveState {
  readonly connected: boolean;
  readonly evaluating: boolean;
  readonly running: string | null;
}

/** Keeps the snapshot current, and reports files changed outside the studio. */
export function useLiveUpdates(onExternal: (files: readonly string[]) => void): LiveState {
  const queryClient = useQueryClient();
  const reportExternal = useRef(onExternal);
  reportExternal.current = onExternal;
  const [state, setState] = useState<LiveState>({ connected: false, evaluating: false, running: null });
  useEffect(() => {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.addEventListener("hello", () => setState((current) => ({ ...current, connected: true })));
    source.addEventListener("status", (event) => {
      const { evaluating } = JSON.parse((event as MessageEvent<string>).data) as { evaluating: boolean };
      setState((current) => ({ ...current, evaluating }));
    });
    source.addEventListener("command", (event) => {
      const { name, running } = JSON.parse((event as MessageEvent<string>).data) as { name: string; running: boolean };
      setState((current) => ({ ...current, running: running ? name : null }));
    });
    source.addEventListener("snapshot", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as SnapshotEvent;
      void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
      if (data.external.length > 0) reportExternal.current(data.external);
    });
    source.onerror = () => setState((current) => ({ ...current, connected: false }));
    return () => source.close();
  }, [queryClient]);
  return state;
}
