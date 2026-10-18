import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeployMode } from "../../../shared/deploy";
import { deployApi } from "../../deploy/api";
import { DeploymentBadge } from "../DeploymentBadge";
import { shortStack } from "./format";

/**
 * Deleting a deployment: first what AWS says it consists of and what deletion
 * leaves behind (read only), then the typed name. destroy:resources does the
 * deleting, importers first, and verifies each stack is gone.
 */
export function Teardown(props: {
  readonly deployment: string;
  readonly mode: DeployMode;
  readonly profile: string;
  readonly region?: string;
  readonly busy: string | undefined;
  readonly onClose: () => void;
  readonly onDelete: (options: { confirm: string; retainFailed: boolean }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [retainFailed, setRetainFailed] = useState(false);
  const { data, error, isPending } = useQuery({
    queryKey: ["deploy", "teardown", props.profile, props.deployment, props.mode],
    queryFn: () => deployApi.teardown(props.profile, props.deployment, props.mode, props.region),
    staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const plan = data?.ok ? data.value : undefined;
  const failed = plan?.stacks.some((stack) => stack.status === "DELETE_FAILED");

  return (
    <dialog ref={dialog} className={`preview teardown ${props.mode}`} aria-labelledby="teardown-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
      <header>
        <h2 id="teardown-title">Delete {props.deployment} <DeploymentBadge kind={props.mode} /></h2>
        {plan ? <p className="small muted">{plan.account} · {plan.region}</p> : null}
      </header>
      <div className="body">
        {isPending ? <p className="muted">Reading what {props.deployment} consists of…</p> : null}
        {error ? <p className="diagnostic">{error instanceof Error ? error.message : String(error)}</p> : null}
        {data && !data.ok ? <p className="diagnostic">{data.problem.message}</p> : null}
        {plan ? (
          <>
            <p className="plan-banner bad"><AlertOctagon size={15} aria-hidden /> Deleting removes these stacks and everything they created{plan.mode === "prod" ? ", including production data not kept below" : ""}. It cannot be undone.</p>
            <section aria-label="Deletion order">
              <h3 className="section-title">Deleted in this order</h3>
              <ol className="plain-list teardown-order">
                {plan.stacks.map((stack) => (
                  <li key={stack.name}>
                    <strong>{shortStack(stack.name, plan.deployment)}</strong> <span className="muted small">{stack.status.replaceAll("_", " ").toLowerCase()}</span>
                    {stack.terminationProtection ? <span className="flag warn"><Lock size={11} aria-hidden /> protection lifted on confirm</span> : null}
                    {stack.importedBy.length ? <span className="small muted"> · imported by {stack.importedBy.map((name) => shortStack(name, plan.deployment)).join(", ")}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
            {plan.remains.length ? (
              <section aria-label="What remains">
                <h3 className="section-title">Kept after deletion</h3>
                <ul className="plain-list">{plan.remains.map((item) => <li key={`${item.stack}/${item.logicalId}`}><code>{item.logicalId}</code> <span className="small muted">{item.type.replace(/^AWS::/, "")} · {item.policy === "Snapshot" ? "a final snapshot is kept" : "retained"}</span></li>)}</ul>
              </section>
            ) : null}
            {plan.secrets.length ? <p className="small">Managed secrets are kept, and reused if {plan.deployment} returns: {plan.secrets.join(", ")}.</p> : null}
            {plan.leftInPlace.length ? <p className="small muted">Left in place: {plan.leftInPlace.map((stack) => `${stack.name} (${stack.reason})`).join("; ")}.</p> : null}
            {failed ? (
              <label className="check-row small"><input type="checkbox" checked={retainFailed} onChange={(event) => setRetainFailed(event.target.checked)} /> Keep the resources CloudFormation could not delete last time, and delete the rest</label>
            ) : null}
          </>
        ) : null}
      </div>
      <footer>
        {plan ? (
          <label className="confirm-name">
            <span className="small">Type <code>{props.deployment}</code> to delete it.</span>
            <input value={typed} onChange={(event) => setTyped(event.target.value)} aria-label={`Type ${props.deployment} to delete it`} autoComplete="off" spellCheck={false} />
          </label>
        ) : <span className="reason">{props.busy ?? ""}</span>}
        <button className="quiet" onClick={props.onClose}>Cancel</button>
        <button className="primary danger" disabled={!plan || typed !== props.deployment || Boolean(props.busy)} onClick={() => props.onDelete({ confirm: typed, retainFailed })}>Delete {props.deployment}</button>
      </footer>
    </dialog>
  );
}

export function ServiceLogs(props: { readonly service: string; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { data, error, refetch, isFetching } = useQuery({ queryKey: ["deploy", "service-logs", props.service], queryFn: () => deployApi.serviceLogs(props.service), refetchInterval: 4000 });
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [data?.text]);
  return (
    <dialog ref={dialog} className="preview service-logs" aria-labelledby="logs-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
      <header><h2 id="logs-title">{props.service}</h2><p className="small muted">The container's last 300 lines, refreshed every few seconds.</p></header>
      <div className="body">
        {error ? <p className="diagnostic">{error instanceof Error ? error.message : String(error)}</p> : null}
        <pre ref={pre} className="job-log">{data?.text ?? "Reading…"}</pre>
      </div>
      <footer>
        <button className="quiet" onClick={() => void refetch()} disabled={isFetching}>Refresh</button>
        <button className="primary" onClick={props.onClose}>Close</button>
      </footer>
    </dialog>
  );
}
