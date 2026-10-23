import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import type { SourceRecovery } from "../../shared/source-recovery";

export function SourceRecoveryPanel({ initial, problem }: { readonly initial?: readonly SourceRecovery[]; readonly problem?: string }) {
  const query = useQueryClient();
  const recovery = useQuery({ queryKey: ["source-recovery"], queryFn: api.sourceRecovery, initialData: initial, enabled: initial !== undefined, refetchInterval: initial === undefined ? false : 10_000, retry: false });
  const [approval, setApproval] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  if (!problem && !recovery.error && !recovery.data?.length && !error) return null;
  return <section className="source-watch-warning" aria-label="Source recovery" role="status">
    <strong>Source recovery needs attention</strong>
    {problem || recovery.error || error ? <p className="reason">{problem ?? error ?? (recovery.error as Error).message}</p> : null}
    {recovery.data?.map(record => <details key={record.id} open><summary>{record.label} · interrupted source transaction</summary>
      <p>Restore only files that still match the reviewed transaction. Later user edits are preserved and remain listed for manual reconciliation. No database or AWS operation runs.</p>
      <ul>{record.files.map(file => <li key={file.file}><code>{file.file}</code> · {file.state}</li>)}</ul>
      <label>Recovery confirmation<input aria-label="Source recovery confirmation" value={approval} disabled={busy} onChange={event => setApproval(event.target.value)} /></label>
      <button className="quiet" disabled={busy || approval !== "RESTORE SOURCE"} onClick={() => { setBusy(true); void api.restoreSource(record.id, approval).then(data => { query.setQueryData(["source-recovery"], data); setApproval(""); setError(undefined); return query.invalidateQueries({ queryKey: ["snapshot"] }); }).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); }}>Restore matching source files</button>
      <p>To retain the current files instead, review their states above and type KEEP CURRENT SOURCE. Both configuration modes and implementation artifacts are revalidated before completing recovery.</p>
      <button className="quiet" disabled={busy || approval !== "KEEP CURRENT SOURCE"} onClick={() => { setBusy(true); void api.keepSource(record.id, record.fingerprint, approval).then(data => { query.setQueryData(["source-recovery"], data); setApproval(""); setError(undefined); return query.invalidateQueries({ queryKey: ["snapshot"] }); }).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); }}>Keep current source and complete recovery</button>
    </details>)}
  </section>;
}
