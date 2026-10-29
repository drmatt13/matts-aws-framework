import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { TextInput } from "../../ui/FormControls";

import { flagClasses, sectionTitleClasses, logClasses, planBannerClasses } from "./DeployUI";
import { dialogClasses, dialogHeaderClasses, dialogTitleClasses, dialogBodyClasses, dialogFooterClasses } from "../../inspector-ui";
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
  readonly onDelete: (options: { confirm: string; retainFailed: boolean; review: string }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [retainFailed, setRetainFailed] = useState(false);
  const [disableProtection, setDisableProtection] = useState(false);
  const { data, error, isPending } = useQuery({
    queryKey: ["deploy", "teardown", props.profile, props.region, props.deployment, props.mode, retainFailed, disableProtection],
    queryFn: () => deployApi.teardown(props.profile, props.deployment, props.mode, props.region, retainFailed, disableProtection),
    staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const plan = data?.ok ? data.value : undefined;
  useEffect(() => { setTyped(""); }, [plan?.key]);
  const failed = plan?.stacks.some((stack) => stack.status === "DELETE_FAILED");

  return (
    <dialog ref={dialog} data-ui="teardown" className={cx(dialogClasses(), "[&_code]:wrap-anywhere", props.mode === "prod" ? "border-t-4 border-t-prod" : "border-t-4 border-t-dev")} aria-labelledby="teardown-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
      <header className={dialogHeaderClasses}>
        <h2 className={cx(dialogTitleClasses, "flex flex-wrap items-center gap-2 wrap-anywhere")} id="teardown-title">Delete {props.deployment} <DeploymentBadge kind={props.mode} /></h2>
        {plan ? <p className={"text-caption text-graphite"}>{plan.account} · {plan.region}</p> : null}
      </header>
      <div className={dialogBodyClasses} aria-busy={isPending}>
        {isPending ? <p className={"text-graphite"} role="status">Reading what {props.deployment} consists of…</p> : null}
        {error ? <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} role="alert">{error instanceof Error ? error.message : String(error)}</p> : null}
        {data && !data.ok ? <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} role="alert">{data.problem.message}</p> : null}
        {plan ? (
          <>
            <p className={planBannerClasses("bad")}><AlertOctagon size={15} aria-hidden /> Deleting removes these stacks and everything they created{plan.mode === "prod" ? ", including production data not kept below" : ""}. It cannot be undone.</p>
            {plan.expiresAt ? <p className={"text-caption text-graphite"}>Fixed deletion scope, expires {new Date(plan.expiresAt).toLocaleString()}. Changes to deployed identities, policies or dependencies require another review.</p> : null}
            {plan.blockers?.map((message) => <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} role="alert" key={message}>{message}</p>)}
            {plan.warnings?.map((message) => <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} key={message}>{message}</p>)}
            <section aria-label="Deletion order">
              <h3 className={sectionTitleClasses}>Deleted in this order</h3>
              <ol className={"m-0 grid gap-1 pl-5 wrap-anywhere"}>
                {plan.stacks.map((stack) => (
                  <li key={stack.name}>
                    <strong>{shortStack(stack.name, plan.deployment)}</strong> <span className={"text-graphite text-caption"}>{stack.status.replaceAll("_", " ").toLowerCase()}</span>
                    {stack.id ? <details><summary className={"text-caption"}>Deployed stack identity</summary><code className={"text-caption"}>{stack.id}</code></details> : null}
                    {stack.terminationProtection ? <span data-ui="flag" className={flagClasses("warn")}><Lock size={11} aria-hidden /> termination protection enabled</span> : null}
                    {stack.importedBy.length ? <span className={"text-caption text-graphite"}> · imported by {stack.importedBy.map((name) => shortStack(name, plan.deployment)).join(", ")}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
            {plan.remains.length ? (
              <section aria-label="What remains">
                <h3 className={sectionTitleClasses}>Kept after deletion</h3>
                <ul className={"m-0 grid gap-1 pl-5 wrap-anywhere"}>{plan.remains.map((item) => <li key={`${item.stack}/${item.logicalId}`}><code>{item.logicalId}</code> <span className={"text-caption text-graphite"}>{item.type.replace(/^AWS::/, "")} · {item.policy === "Snapshot" ? "a final snapshot is kept" : "retained"}</span></li>)}</ul>
              </section>
            ) : null}
            {plan.secrets.length ? <p className={"text-caption"}>Managed secrets are kept, and reused if {plan.deployment} returns: {plan.secrets.join(", ")}.</p> : null}
            {plan.leftInPlace.length ? <p className={"text-caption text-graphite"}>Left in place: {plan.leftInPlace.map((stack) => `${stack.name} (${stack.reason})`).join("; ")}.</p> : null}
            {failed ? (
              <label className={"flex items-start gap-2 text-caption"}><TextInput type="checkbox" checked={retainFailed} onChange={(event) => setRetainFailed(event.target.checked)} /> Keep the resources CloudFormation could not delete last time, and delete the rest</label>
            ) : null}
            {failed ? <ul className={"text-caption"}>{plan.stacks.filter((stack) => stack.failedResources?.length).map((stack) => <li key={stack.name}>{stack.name}: {stack.failedResources!.join(", ")}</li>)}</ul> : null}
            {plan.stacks.some((stack) => stack.terminationProtection) ? <label className={"flex items-start gap-2 text-caption"}><TextInput type="checkbox" checked={disableProtection} onChange={(event) => setDisableProtection(event.target.checked)} /> Allow disabling termination protection on the protected stacks listed above. This creates a new deletion review.</label> : null}
          </>
        ) : null}
      </div>
      <footer className={dialogFooterClasses}>
        {plan ? (
          <label className={"grid min-w-0 flex-[1_1_100%] gap-2 wrap-anywhere [&_input]:w-full [&_input]:min-w-0 [&_input]:font-mono"}>
            <span className={"text-caption"}>Type <code>{props.deployment}</code> to delete it.</span>
            <TextInput value={typed} onChange={(event) => setTyped(event.target.value)} aria-label={`Type ${props.deployment} to delete it`} autoComplete="off" spellCheck={false} />
          </label>
        ) : <span className={"text-refuse wrap-anywhere"}>{props.busy ?? ""}</span>}
        <button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={props.onClose}>Cancel</button>
        <button data-variant="primary" className={buttonClasses({ variant: "primary", size: "regular", tone: "danger" })} disabled={!plan?.key || Boolean(plan.blockers?.length) || Boolean(plan.expiresAt && Date.parse(plan.expiresAt) < Date.now()) || typed !== props.deployment || Boolean(props.busy)} onClick={() => plan?.key && props.onDelete({ confirm: typed, retainFailed, review: plan.key })}>Delete {props.deployment}</button>
      </footer>
    </dialog>
  );
}

export function ServiceLogs(props: { readonly service: string; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { data, error, refetch, isFetching } = useQuery({ queryKey: ["deploy", "service-logs", props.service], queryFn: () => deployApi.serviceLogs(props.service), refetchInterval: 4000 });
  const pre = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => { if (pre.current && pinned.current) pre.current.scrollTop = pre.current.scrollHeight; }, [data?.text]);
  return (
    <dialog ref={dialog} className={dialogClasses()} aria-labelledby="logs-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
      <header className={dialogHeaderClasses}><h2 className={cx(dialogTitleClasses, "flex flex-wrap items-center gap-2 wrap-anywhere")} id="logs-title">{props.service}</h2><p className={"text-caption text-graphite"}>The container's last 300 lines, refreshed every few seconds.</p></header>
      <div className={dialogBodyClasses}>
        {error ? <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} role="alert">{error instanceof Error ? error.message : String(error)}</p> : null}
        <pre ref={pre} className={cx(logClasses, "max-h-[60vh] rounded-md border")} tabIndex={0} aria-label={`Logs for ${props.service}`} onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>{data?.text ?? (error ? "No logs available." : "Reading…")}</pre>
      </div>
      <footer className={dialogFooterClasses}>
        <button className={buttonClasses({ variant: "quiet", size: "regular" })} onClick={() => void refetch()} disabled={isFetching}>Refresh</button>
        <button data-variant="primary" className={buttonClasses({ variant: "primary", size: "regular" })} onClick={props.onClose}>Close</button>
      </footer>
    </dialog>
  );
}
