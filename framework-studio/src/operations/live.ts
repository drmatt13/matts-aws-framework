import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JobLogLine, JobView } from "../../shared/operations";
import { token } from "../http";
import { connectStudioEvents } from "../events";
import { operationsApi } from "./api";
import { operationsQuery } from "./queries";
import { LogStore } from "./log-store";
import { replayOperationLog } from "./replay";

export const logs = new LogStore();

export function useOperationLog(id: string | undefined, lastSeq = 0) {
  const version = useSyncExternalStore(logs.subscribe, logs.snapshot);
  const opened = useRef<string | undefined>(undefined);
  const fetching = useRef(new Set<string>());
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [retryVersion, setRetryVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(() => { opened.current = undefined; setFailure(undefined); setRetrying(true); setRetryVersion(value => value + 1); }, []);
  useEffect(() => {
    if (!id) return;
    const source = connectStudioEvents(token);
    source.addEventListener("open", retry);
    return () => source.close();
  }, [id, retry]);
  useEffect(() => {
    if (!id || fetching.current.has(id) || failure?.id === id) return;
    if (opened.current === id && !logs.incomplete(id) && logs.resumeAfter(id) >= lastSeq) return;
    opened.current = id;
    fetching.current.add(id);
    void replayOperationLog(logs, id, lastSeq, operationsApi.log)
      .catch(error => setFailure({ id, message: error instanceof Error ? error.message : "Unable to read the operation log." }))
      .finally(() => { fetching.current.delete(id); setRetrying(false); setRetryVersion(value => value + 1); });
  }, [id, version, lastSeq, retryVersion, failure]);
  return { lines: id ? logs.get(id) : [], problem: failure?.id === id ? failure?.message : undefined, retrying, retry };
}

/** Compatibility for consumers interested only in lines. */
export function useJobLog(id: string | undefined, lastSeq = 0): readonly JobLogLine[] {
  return useOperationLog(id, lastSeq).lines;
}

export function useOperationsLive(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = connectStudioEvents(token);
    const parse = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("operation-job", event => {
      const job = parse<JobView>(event);
      client.setQueryData<{ jobs: JobView[] }>(operationsQuery().queryKey, overview => ({
        jobs: [job, ...(overview?.jobs ?? []).filter(entry => entry.id !== job.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      }));
    });
    source.addEventListener("operation-log", event => {
      const { id, lines } = parse<{ id: string; lines: JobLogLine[] }>(event);
      logs.add(id, lines);
    });
    source.addEventListener("open", () => { void client.invalidateQueries({ queryKey: operationsQuery().queryKey }); });
    return () => source.close();
  }, [client]);
}
