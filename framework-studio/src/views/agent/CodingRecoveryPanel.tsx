import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodingRecoveryApproval, CodingSourceRecovery } from "../../../shared/agent-source-recovery";
import { agentTasksApi } from "../../agent-tasks-api";
import { Button } from "../../ui/Button";
import { Select, TextInput } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";

function RecoveryChoice({ recovery, busy, recover }: { readonly recovery: CodingSourceRecovery; readonly busy: boolean; readonly recover: (approval: CodingRecoveryApproval) => Promise<boolean> }) {
  const [approval, setApproval] = useState<CodingRecoveryApproval>("RESTORE SOURCE"), [confirmation, setConfirmation] = useState("");
  return <section aria-label={`Recovery ${recovery.id}`} className="grid gap-2">
    <p className="m-0 text-caption">Interrupted source integration: <code>{recovery.id}</code></p>
    <ul className="m-0 max-h-[160px] overflow-auto pl-5 text-caption">{recovery.files.map(file => <li key={file.path}><code className="wrap-anywhere">{file.path}</code> — {file.state === "original" ? "original source" : file.state === "written" ? "agent-written source" : "changed since integration"}</li>)}</ul>
    <label className="grid gap-1">Recovery action<Select value={approval} disabled={busy} onChange={event => { setApproval(event.target.value as CodingRecoveryApproval); setConfirmation(""); }}><option value="RESTORE SOURCE">Restore original source</option><option value="KEEP CURRENT SOURCE">Keep current source</option></Select></label>
    <p className="m-0 text-caption text-graphite">{approval === "RESTORE SOURCE" ? "Restores files still matching the agent’s writes. Later edits are preserved and may need manual recovery." : "Keeps the inspected files and releases the recovery block. This does not confirm validation or approval of the agent proposal."}</p>
    <label className="grid gap-1">Type {approval}<TextInput autoComplete="off" spellCheck={false} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
    <div><Button type="button" disabled={busy || confirmation !== approval} onClick={() => void recover(approval).then(ok => { if (ok) setConfirmation(""); })}>{approval === "RESTORE SOURCE" ? "Restore inspected source" : "Keep inspected source"}</Button></div>
  </section>;
}
export function CodingRecoveryPanel({ repository, visible }: { readonly repository: string; readonly visible: boolean }) {
  const client = useQueryClient(), key = ["coding-source-recovery", repository] as const;
  const state = useQuery({ queryKey: key, queryFn: ({ signal }) => agentTasksApi.recovery(signal), enabled: visible, retry: false, refetchOnWindowFocus: false, refetchInterval: visible ? 5000 : false });
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string>(), [problem, setProblem] = useState<string>();
  const recover = async (recovery: CodingSourceRecovery, approval: CodingRecoveryApproval) => {
    if (pending) return false;
    setPending(true); setProblem(undefined); setMessage(undefined);
    try {
      const result = await agentTasksApi.recover(recovery.id, approval, recovery.fingerprint);
      setMessage(result.message); await state.refetch();
      void client.invalidateQueries({ queryKey: ["coding-tasks", repository] }); void client.invalidateQueries({ queryKey: ["coding-task-events"] });
      return true;
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); await state.refetch(); return false; }
    finally { setPending(false); }
  };
  const coordination = state.data?.coordination;
  if (!state.error && !problem && !message && (!coordination || coordination.status === "ready") && !state.data?.recoveries.length) return null;
  return <section aria-label="Source recovery" className="grid gap-3 rounded-md border border-rule p-3">
    <h3 className="m-0 text-body font-semibold">Source recovery</h3>
    {state.error || problem ? <Notice role="alert">{problem ?? state.error?.message} <Button type="button" variant="link" disabled={pending} onClick={() => { setProblem(undefined); void state.refetch(); }}>Refresh recovery</Button></Notice> : null}
    {message ? <Notice>{message}</Notice> : null}
    {coordination && coordination.status !== "ready" ? <Notice tone="warning">{coordination.message ?? (coordination.status === "busy" ? "A source operation is in progress." : "Studio source writes are blocked until this recovery is resolved.")}</Notice> : null}
    {state.data?.recoveries.map(recovery => <RecoveryChoice key={`${recovery.id}:${recovery.fingerprint}`} recovery={recovery} busy={pending || coordination?.status === "busy"} recover={approval => recover(recovery, approval)} />)}
    {pending ? <p role="status" className="m-0 text-caption">Resolving source recovery…</p> : null}
  </section>;
}
