import { AlertTriangle, Check, CircleDashed, LogIn, RefreshCw, X } from "lucide-react";
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
  readonly onRefresh: () => void;
  readonly onSignIn?: () => void;
  readonly prerequisites: readonly PrerequisiteView[];
  readonly onRemedy: (request: OperationRequest) => void;
}) {
  const selected = props.profiles.find((entry) => entry.name === props.profile);
  return (
    <header className="deploy-account" aria-label="AWS account">
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
        <button className="quiet" onClick={props.onRefresh} disabled={!props.profile} title="Read AWS and this machine again">
          <RefreshCw size={14} className={props.loading ? "spin" : undefined} aria-hidden /> Refresh
        </button>
      </div>
      <ul className="prerequisites" aria-label="This machine">
        {props.prerequisites.map((item) => (
          <li key={item.id} className={`prerequisite ${item.status}`} title={item.detail ?? item.summary}>
            {item.status === "ok" ? <Check size={12} aria-hidden /> : item.status === "fail" ? <X size={12} aria-hidden /> : item.status === "warn" ? <AlertTriangle size={12} aria-hidden /> : <CircleDashed size={12} aria-hidden />}
            <span className="prerequisite-label">{item.label}</span>
            {item.status !== "ok" ? <span className="prerequisite-summary">{item.summary}</span> : null}
            {item.remedy ? (
              <button className="linkish small" onClick={() => props.onRemedy(item.remedy!)}>
                {item.remedy.kind === "docker-start" ? "Start" : item.remedy.kind === "deps-install" ? "Install" : "Fix"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </header>
  );
}
