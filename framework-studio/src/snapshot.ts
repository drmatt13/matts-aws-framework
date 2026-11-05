import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { SnapshotEvent, SnapshotResponse } from "../shared/api";
import type { SourceWatchState } from "../shared/watch";
import type { AwsConnectionObservation } from "../shared/aws-connections";
import { call, ApiError, token } from "./http";
import { connectStudioEvents } from "./events";
import { advanceConnectionGeneration, connectionGeneration, type AwsConnectionGeneration } from "./connection-generations";
import { awsProfileIdentityQuery } from "./aws-profile-queries";

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
  readonly awsConnectionRevision?: number;
  readonly awsConnectionGeneration?: AwsConnectionGeneration;
  readonly sourcePublicationRevision?: string;
  readonly sourcePublicationBaseRevision?: string;
  readonly reconnectRevision?: number;
}

/** Every consumer resolves the same source identity, including a newly mounted page. */
export function deploymentSourceRevision(responseRevision: string, live: Pick<LiveState, "sourcePublicationRevision" | "sourcePublicationBaseRevision">): string {
  const publication = live.sourcePublicationRevision;
  return publication && (responseRevision === live.sourcePublicationBaseRevision || responseRevision === publication)
    ? publication : responseRevision;
}

/** Keeps the snapshot current, and reports files changed outside the studio. */
export function useLiveUpdates(onExternal: (files: readonly string[]) => void, currentSnapshotRevision?: string): LiveState {
  const queryClient = useQueryClient();
  const reportExternal = useRef(onExternal);
  const welcomed = useRef(false);
  const generations = useRef<AwsConnectionGeneration | undefined>(undefined);
  const snapshotRevision = useRef(currentSnapshotRevision);
  snapshotRevision.current = currentSnapshotRevision;
  reportExternal.current = onExternal;
  const [state, setState] = useState<LiveState>({ connected: false, evaluating: false, running: null });
  useEffect(() => {
    const source = connectStudioEvents(token);
    const invalidateConnections = (profiles: readonly string[]) => {
      // Events can arrive in one React batch. Advance the coordination ref now,
      // keeping cache effects outside React's replayable state updater.
      const previousGeneration = generations.current;
      const nextGeneration = advanceConnectionGeneration(previousGeneration, profiles);
      generations.current = nextGeneration;
      setState(current => ({
        ...current,
        awsConnectionRevision: (current.awsConnectionRevision ?? 0) + 1,
        awsConnectionGeneration: nextGeneration,
      }));
      const identities = {
        queryKey: ["aws-connections", "identity"],
        predicate: (query: { queryKey: readonly unknown[] }) => !profiles.length || profiles.includes(String(query.queryKey[2])),
      };
      // Cancel old Query-owned checks before resetting their evidence. New checks
      // use a new generation; late explicit checks can only fill their old key.
      const previousChecks = queryClient.getQueriesData<AwsConnectionObservation>(identities)
        .filter(([key, previous]) => previous && key[3] === connectionGeneration({ awsConnectionGeneration: previousGeneration }, previous.profile));
      void queryClient.cancelQueries(identities);
      const unchecked = (previous: AwsConnectionObservation): AwsConnectionObservation => ({
        ...previous, state: "unchecked", lastKnownIdentity: previous.identity ?? previous.lastKnownIdentity,
        identity: undefined, problem: undefined, credentialExpiration: undefined,
      });
      queryClient.setQueriesData<AwsConnectionObservation>(identities, previous => previous && unchecked(previous));
      // Retain only historical identity for the same profile. A stale seed is
      // readable by the passive configuration dialog but cannot verify a new
      // generation or suppress an active profile menu's identity check.
      for (const [, previous] of previousChecks) if (previous) {
        const generation = connectionGeneration({ awsConnectionGeneration: nextGeneration }, previous.profile);
        queryClient.setQueryData(awsProfileIdentityQuery(previous.profile, generation).queryKey, unchecked(previous), { updatedAt: 0 });
      }
      void queryClient.invalidateQueries({ ...identities, refetchType: "none" });
      void queryClient.invalidateQueries({ queryKey: ["aws-connections", "catalog"] });
    };
    source.addEventListener("hello", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data || "{}") as { sourceWatch?: SourceWatchState };
      setState(current => ({ ...current, connected: true, sourceWatch: data.sourceWatch }));
      if (welcomed.current) {
        // Authentication events may have been missed during disconnection.
        invalidateConnections([]);
        setState(current => ({ ...current, reconnectRevision: (current.reconnectRevision ?? 0) + 1 }));
      }
      welcomed.current = true;
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
      const publicationBaseRevision = snapshotRevision.current;
      if (data.revision) setState(current => ({
        ...current, sourcePublicationRevision: data.revision, sourcePublicationBaseRevision: publicationBaseRevision,
      }));
      void queryClient.invalidateQueries({ queryKey: snapshotQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["infrastructure"] });
      if (data.external.length > 0) reportExternal.current(data.external);
    });
    source.addEventListener("infrastructure", () => void queryClient.invalidateQueries({ queryKey: ["infrastructure"] }));
    source.addEventListener("database-history", () => void queryClient.invalidateQueries({ queryKey: snapshotQueryKey }));
    source.addEventListener("aws-connections", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data || "{}") as { profiles?: readonly string[] };
      invalidateConnections(data.profiles ?? []);
    });
    source.addEventListener("error", () => setState((current) => ({ ...current, connected: false })));
    return () => source.close();
  }, [queryClient]);
  return state;
}
