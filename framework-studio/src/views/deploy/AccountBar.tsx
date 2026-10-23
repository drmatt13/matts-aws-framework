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
    <header className="deploy-account workspace-toolbar" aria-label="AWS account">
      <div className="account-identity">
        <label className="profile-picker">
          <span className="small muted">AWS profile</span>
          <select value={props.profile ?? ""} onChange={(event) => props.onProfile(event.target.value)} aria-label="AWS profile">
            {!props.profile ? <option value="">Choose a profile</option> : null}
            {props.profiles.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.name}{entry.region ? ` · ${entry.region}` : ""}</option>
            ))}
          </select>
        </label>
        <span className="account-arrow" aria-hidden>→</span>
        {props.problem ? (
          <span className={`account-resolved problem ${props.problem.kind}`} role="status">
            <AlertTriangle size={15} aria-hidden />
            <span>{props.problem.message}</span>
            {props.onSignIn && (props.problem.kind === "expired" || props.problem.kind === "no-credentials") && (selected?.kind === "sso" || selected?.kind === "login") ? (
              <button className="primary compact" onClick={props.onSignIn}><LogIn size={14} aria-hidden /> Sign in</button>
            ) : null}
          </span>
        ) : props.context ? (
          <span className="account-resolved" title={props.context.arn}>
            <strong className="account-number">{props.context.account}</strong>
            <span className="account-sep">·</span>
            <span>{props.context.region}</span>
            <span className="account-sep">·</span>
            <span className="muted">{callerName(props.context.arn)}</span>
            <Check size={14} className="ok-mark" aria-label="Signed in" />
          </span>
        ) : (
          <span className="account-resolved muted">{props.profile ? (props.loading ? "Resolving the account…" : "") : "Choose the profile whose account to inspect."}</span>
        )}
        <span className="spacer" />
        <button className="quiet account-refresh" onClick={props.onRefresh} disabled={props.loading} aria-label="Refresh" aria-busy={props.loading} title="Read AWS and this machine again">
          <RefreshCw size={14} className={props.loading ? "spin" : undefined} aria-hidden /> {props.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {props.readError ? <p className="account-read-error" role="alert"><AlertTriangle size={14} aria-hidden /><span>Some information could not be refreshed. {props.readError} Try Refresh again.</span></p> : null}
      {props.prerequisites.length ? <div className="machine-health">
        {ready.length ? <button className="machine-checks-toggle" aria-expanded={showReady} aria-controls={readyId} onClick={() => setShowReady(!showReady)}>
          <Check size={13} className="ok-mark" aria-hidden />
          <span>This machine · {ready.length} {ready.length === 1 ? "check" : "checks"} passed</span>
          <ChevronDown size={13} className="machine-checks-chevron" aria-hidden />
        </button> : null}
        {attention.length ? <ul className="prerequisites" aria-label="Machine issues">
          {attention.map((item) => (
            <li key={item.id} className={`prerequisite ${item.status}`} aria-label={`${item.label}: ${item.summary}`} title={item.detail ?? item.summary}>
              {item.status === "fail" ? <X size={13} aria-hidden /> : item.status === "warn" ? <AlertTriangle size={13} aria-hidden /> : <CircleDashed size={13} aria-hidden />}
              <span className="prerequisite-summary">{item.summary}</span>
              {item.remedy ? (
                <button className="linkish small" onClick={() => props.onRemedy(item.remedy!)}>
                  {item.remedy.kind === "docker-start" ? "Start" : item.remedy.kind === "deps-install" ? "Install" : "Fix"}
                </button>
              ) : null}
            </li>
          ))}
        </ul> : null}
        <ul id={readyId} className="prerequisite-checks" aria-label="Passed machine checks" hidden={!showReady || !ready.length}>
          {ready.map((item) => <li key={item.id} title={item.detail}><Check size={13} className="ok-mark" aria-hidden /><strong>{item.label}</strong><span>{item.summary}</span></li>)}
        </ul>
      </div> : null}
    </header>
  );
}
