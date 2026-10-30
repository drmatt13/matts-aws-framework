import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { SnapshotEvent, SnapshotResponse } from "../shared/api";
import type { SourceWatchState } from "../shared/watch";
import { call, ApiError, token } from "./http";
import { connectStudioEvents } from "./events";

export const snapshotQueryKey = ["snapshot"] as const;

export function useSnapshot() {
  return useQuery({
    queryKey: snapshotQueryKey,
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
      void queryClient.invalidateQueries({ queryKey: snapshotQueryKey });
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
      void queryClient.invalidateQueries({ queryKey: snapshotQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["infrastructure"] });
      if (data.external.length > 0) reportExternal.current(data.external);
    });
    source.addEventListener("infrastructure", () => void queryClient.invalidateQueries({ queryKey: ["infrastructure"] }));
    source.addEventListener("database-history", () => void queryClient.invalidateQueries({ queryKey: snapshotQueryKey }));
    source.addEventListener("error", () => setState((current) => ({ ...current, connected: false })));
    return () => source.close();
  }, [queryClient]);
  return state;
}
