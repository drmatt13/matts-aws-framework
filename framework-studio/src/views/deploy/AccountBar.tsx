import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { Select } from "../../ui/FormControls";
import { workspaceToolbarClasses } from "../../ui/Surface";

import { AlertTriangle, Check, ChevronDown, CircleDashed, LogIn, RefreshCw, X } from "lucide-react";
import { useId, useState } from "react";
import type { AccountContext, AwsProblem, AwsProfileInfo, OperationRequest, PrerequisiteView } from "../../../shared/deploy";
import { callerName } from "./format";

/**
 * The account in play: a profile chosen here resolves, through the AWS CLI, to
 * the caller, account and region everything below is read from. A profile's
 * name never implies a mode.
 */
export function AccountBar(props: {
  readonly profiles: readonly AwsProfileInfo[];
  readonly profile: string | undefined;
  readonly onProfile: (name: string) => void;
  readonly context?: AccountContext;
  readonly problem?: AwsProblem;
  readonly loading: boolean;
  readonly readError?: string;
  readonly scopeNotice?: string;
  readonly onRefresh: () => void;
  readonly onSignIn?: () => void;
  readonly prerequisites: readonly PrerequisiteView[];
  readonly onRemedy: (request: OperationRequest) => void;
}) {
  const selected = props.profiles.find((entry) => entry.name === props.profile);
  const [showReady, setShowReady] = useState(false);
  const readyId = useId();
  const ready = props.prerequisites.filter((item) => item.status === "ok");
  const attention = props.prerequisites.filter((item) => item.status !== "ok");
  return (
    <header className={cx(workspaceToolbarClasses, "grid gap-2")} aria-label="AWS account">
      <div className={"grid min-h-8 min-w-0 grid-cols-[minmax(200px,280px)_minmax(0,1fr)_auto] items-center gap-3 vp-900:grid-cols-[minmax(0,1fr)_auto]"}>
        <label className={"grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 [&>span]:whitespace-nowrap [&_select]:w-full [&_select]:min-w-0 vp-420:grid-cols-[minmax(0,1fr)] vp-420:gap-1"}>
          <span className={"text-caption text-graphite"}>AWS profile</span>
          <Select value={props.profile ?? ""} onChange={(event) => props.onProfile(event.target.value)} aria-label="AWS profile" title={selected?.region ? `Profile default region: ${selected.region}. A deployment's pinned region takes precedence.` : undefined}>
            {!props.profile ? <option value="">Choose a profile</option> : null}
            {props.profiles.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name}</option>
            ))}
          </Select>
        </label>
        {props.problem ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-label text-refuse wrap-anywhere [&>svg]:flex-none vp-900:col-span-full vp-900:row-start-2" role="status">
            <AlertTriangle size={15} aria-hidden />
            <span>{props.problem.message}</span>
            {props.onSignIn && (props.problem.kind === "expired" || props.problem.kind === "no-credentials") && (selected?.kind === "sso" || selected?.kind === "login") ? (
              <button className={buttonClasses({ variant: "primary", size: "compact" })} onClick={props.onSignIn}><LogIn size={14} aria-hidden /> Sign in</button>
            ) : null}
          </span>
        ) : props.context ? (
          <span className={"flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-label wrap-anywhere vp-900:col-span-full vp-900:row-start-2"}>
            <span className={"inline-flex min-w-0 flex-wrap items-center gap-2"}><span className={"text-caption text-graphite"}>Account</span><strong className={"font-mono text-label font-medium"}>{props.context.account}</strong></span>
            <span className={"inline-flex min-w-0 flex-wrap items-center gap-2"}><span className={"text-caption text-graphite"}>Region</span><span>{props.context.region}</span></span>
            <span className={"inline-flex min-w-0 items-center gap-2 wrap-anywhere [&_svg]:flex-none text-graphite"} title={props.context.arn}><Check size={14} className={"text-accept"} aria-label="Signed in" />{callerName(props.context.arn)}</span>
          </span>
        ) : (
          <span className={"flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-label wrap-anywhere vp-900:col-span-full vp-900:row-start-2 text-graphite"} role="status">{props.profile ? (props.loading ? "Resolving the account…" : "AWS account unverified") : "Choose the profile whose account to inspect."}</span>
        )}
        <button className={cx(buttonClasses({ variant: "quiet", size: "regular" }), "min-w-[112px] vp-900:col-start-2 vp-900:row-start-1 vp-420:self-end")} onClick={props.onRefresh} disabled={props.loading} aria-label="Refresh" aria-busy={props.loading} title="Read AWS and this machine again">
          <RefreshCw size={14} className={props.loading ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden /> {props.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {props.readError ? <p className={"m-0 flex items-start gap-2 text-caption text-refuse wrap-anywhere [&>svg]:mt-0.5 [&>svg]:flex-none"} role="alert"><AlertTriangle size={14} aria-hidden /><span>Some information could not be refreshed. {props.readError} Try Refresh again.</span></p> : null}
      {props.scopeNotice ? <p className={"m-0 flex items-start gap-2 text-caption text-refuse wrap-anywhere [&>svg]:mt-0.5 [&>svg]:flex-none"} role="status">{props.scopeNotice}</p> : null}
      {props.prerequisites.length ? <div className={"flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1"}>
        {ready.length ? <button className={"group/machine inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-caption text-graphite hover:text-ink"} aria-expanded={showReady} aria-controls={readyId} onClick={() => setShowReady(!showReady)}>
          <Check size={13} className={"text-accept"} aria-hidden />
          <span>This machine · {ready.length} {ready.length === 1 ? "check" : "checks"} passed</span>
          <ChevronDown size={13} className={"transition-transform duration-120 group-aria-expanded/machine:rotate-180"} aria-hidden />
        </button> : null}
        {attention.length ? <ul className={"m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0 text-caption"} aria-label="Machine issues">
          {attention.map((item) => (
            <li key={item.id} className={cx("inline-flex min-w-0 flex-wrap items-center gap-1 wrap-anywhere [&>svg]:flex-none", item.status === "fail" ? "text-refuse" : item.status === "warn" ? "text-local" : "text-graphite")} aria-label={`${item.label}: ${item.summary}`} title={item.detail ?? item.summary}>
              {item.status === "fail" ? <X size={13} aria-hidden /> : item.status === "warn" ? <AlertTriangle size={13} aria-hidden /> : <CircleDashed size={13} aria-hidden />}
              <span className={"text-inherit"}>{item.summary}</span>
              {item.remedy ? (
                <button className={cx(buttonClasses({ variant: "link", size: "regular" }), "text-caption")} onClick={() => props.onRemedy(item.remedy!)}>
                  {item.remedy.kind === "docker-start" ? "Start" : item.remedy.kind === "deps-install" ? "Install" : "Fix"}
                </button>
              ) : null}
            </li>
          ))}
        </ul> : null}
        <ul id={readyId} className={"m-0 grid flex-[1_1_100%] list-none grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-x-4 gap-y-2 border-t border-rule px-0 pt-2 pb-1 text-caption [&>li]:grid [&>li]:grid-cols-[auto_minmax(0,1fr)] [&>li]:gap-x-1 [&>li]:wrap-anywhere [&_svg]:self-center [&_strong]:font-medium [&_span]:col-start-2 [&_span]:text-graphite"} aria-label="Passed machine checks" hidden={!showReady || !ready.length}>
          {ready.map((item) => <li key={item.id} title={item.detail}><Check size={13} className={"text-accept"} aria-hidden /><strong>{item.label}</strong><span>{item.summary}</span></li>)}
        </ul>
      </div> : null}
    </header>
  );
}
