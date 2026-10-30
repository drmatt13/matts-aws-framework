import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  ApplyResponse,
  BatchPlanResponse,
  CommentReviewOptions,
  DraftEdit,
  CommandResult,
  SnapshotEvent,
  SnapshotResponse,
} from "../shared/api";
import type { ResourceDetails, ResourceIntent, ResourcePlan, ResourceApply } from "../shared/resources";
import type { Mode } from "../shared/model";
import type { InfrastructureState } from "../shared/infrastructure";
import type { DeploymentInputDetails, DeploymentInputEdit, DeploymentInputPlan } from "../shared/deployment-inputs";
import { STUDIO_PROTOCOL_VERSION, studioProtocolProblem } from "../shared/protocol";
import type { SourceWatchState } from "../shared/watch";
import type { WebSocketDefaults } from "../shared/websockets";
import { connectStudioEvents } from "./events";

/**
 * The studio's server, from the page's side.
 *
 * The session token arrives in the page itself, which no other origin can
 * read, and goes back on every call.
 */

export const token = document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const problem = body === undefined ? undefined : studioProtocolProblem(document.querySelector<HTMLMetaElement>('meta[name="studio-protocol"]')?.content);
  if (problem) throw new ApiError(409, problem);
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: { "x-studio-token": token, "x-studio-protocol": STUDIO_PROTOCOL_VERSION, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => {
    throw new ApiError(response.ok ? 502 : response.status, "Studio returned an invalid API response. Restart npm run studio in this checkout, reload the page, and retry the operation.");
  })) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? response.statusText);
  return payload as T;
}

async function callInfrastructure(path: string, body?: unknown): Promise<InfrastructureState> {
  const state = await call<InfrastructureState>(path, body);
  // An older server can serve the SPA's HTML for an unknown GET API route with status 200.
  if (!["dev", "prod"].includes(state.mode) || !["empty", "running", "ready", "failed"].includes(state.status) || typeof state.stale !== "boolean") {
    throw new ApiError(404, "The infrastructure endpoint is unavailable in the running Studio server.");
  }
  return state;
}

export const api = {
  sourceRecovery: () => call<readonly import("../shared/source-recovery").SourceRecovery[]>("/source-recovery"),
  restoreSource: (id: string, approval: string) => call<readonly import("../shared/source-recovery").SourceRecovery[]>("/source-recovery/restore", { id, approval }),
  keepSource: (id: string, fingerprint: string, approval: string) => call<readonly import("../shared/source-recovery").SourceRecovery[]>("/source-recovery/keep", { id, fingerprint, approval }),
  refreshSource: () => call<{ revision: string }>("/snapshot/refresh", {}),
  snapshot: () => call<SnapshotResponse>("/snapshot"),
  createDeploymentInput: (mode: Mode) => call<{ file: string; created: boolean }>("/deployment-inputs/create", { mode }),
  inputDetails: (mode: Mode, signal?: AbortSignal) => call<DeploymentInputDetails>(`/deployment-inputs/details?mode=${mode}`, undefined, signal),
  revealInput: (mode: Mode, name: string) => call<{ readonly name: string; readonly value: string }>(`/deployment-inputs/value?mode=${mode}&name=${encodeURIComponent(name)}`),
  inputPlan: (mode: Mode, edits: readonly DeploymentInputEdit[], hash: string, revision: string) => call<DeploymentInputPlan>("/deployment-inputs/plan", { mode, edits, hash, revision }),
  inputApply: (planId: string) => call<ApplyResponse>("/deployment-inputs/apply", { planId }),
  infrastructure: (mode: Mode) => callInfrastructure(`/infrastructure?mode=${mode}`),
  synthesize: (mode: Mode, profile?: string) => callInfrastructure("/infrastructure/synthesize", { mode, ...(profile ? { profile } : {}) }),
  planBatch: (edits: readonly DraftEdit[], revision: string, options?: CommentReviewOptions) => call<BatchPlanResponse>("/edits/batch/plan", { edits, revision, ...(options ? { options } : {}) }),
  applyBatch: (planId: string) => call<ApplyResponse>("/edits/batch/apply", { planId }),
  resourceDetails: (id: string, mode: Mode, signal?: AbortSignal) => call<ResourceDetails>(`/resources/details?id=${encodeURIComponent(id)}&mode=${mode}`, undefined, signal),
  resourcePlan: (intent: ResourceIntent, revision: string, mode: Mode) => call<ResourcePlan>("/resources/plan", { intent, revision, mode }),
  resourceApply: (planId: string) => call<ResourceApply>("/resources/apply", { planId }),
  refreshCdkLinks: () => call<{ edges: number; files: number }>("/cdk-links/refresh", {}),
  command: (name: string, confirmed = false) => call<CommandResult>(`/commands/${encodeURIComponent(name)}`, { confirmed }),
  webSocketDefaults: () => call<WebSocketDefaults>("/websockets/defaults"),
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
  readonly sourceWatch?: SourceWatchState;
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
    const source = connectStudioEvents(token);
    source.addEventListener("hello", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data || "{}") as { sourceWatch?: SourceWatchState };
      setState(current => ({ ...current, connected: true, sourceWatch: data.sourceWatch }));
      // Events can be missed while the browser is disconnected. Re-read on every
      // reconnect; dirty drafts retain their baseline and expose a source conflict.
      void queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });
    source.addEventListener("source-watch", event => {
      const sourceWatch = JSON.parse((event as MessageEvent<string>).data) as SourceWatchState;
      setState(current => ({ ...current, sourceWatch }));
    });
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
      void queryClient.invalidateQueries({ queryKey: ["infrastructure"] });
      if (data.external.length > 0) reportExternal.current(data.external);
    });
    source.addEventListener("infrastructure", () => void queryClient.invalidateQueries({ queryKey: ["infrastructure"] }));
    source.addEventListener("database-history", () => void queryClient.invalidateQueries({ queryKey: ["snapshot"] }));
    source.addEventListener("error", () => setState((current) => ({ ...current, connected: false })));
    return () => source.close();
  }, [queryClient]);
  return state;
}
