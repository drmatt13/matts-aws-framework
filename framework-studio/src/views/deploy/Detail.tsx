import { AlertOctagon, AlertTriangle, ExternalLink, Info, MoreHorizontal, ScrollText } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AccountContext, AwsProblem, DeploymentRecordView, DriftView, LocalRunView, StackEventView, StatusView } from "../../../shared/deploy";
import type { Action, Finding } from "../../../shared/deploy-findings";
import { DeploymentBadge } from "../DeploymentBadge";
import { callerName, eventTone, relativeTime, shortStack, stackTone } from "./format";
import type { RailRow } from "./Rail";

export type MoreAction = "plan" | "change-sets" | "export" | "drift" | "delete";

function Panel(props: { readonly title: string; readonly tone?: string; readonly children: ReactNode }) {
  return (
    <section className={`state-panel ${props.tone ?? ""}`} aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

const SEVERITY_ICON = {
  blocking: <AlertOctagon size={16} aria-hidden />,
  attention: <AlertTriangle size={16} aria-hidden />,
  info: <Info size={16} aria-hidden />,
};

function ActionButton(props: { readonly action: Action; readonly onAction: (action: Action) => void; readonly primary?: boolean }) {
  const { action } = props;
  return (
    <button
      className={props.primary ? "primary" : action.tone === "danger" ? "quiet danger" : "quiet"}
      onClick={() => props.onAction(action)}
      disabled={Boolean(action.disabled)}
      title={action.disabled}
    >
      {action.label}
    </button>
  );
}

/**
 * One deployment, as the three states it lives in: what this repository
 * intends, what AWS holds, and what this machine runs — with what to do next.
 */
export function Detail(props: {
  readonly row: RailRow;
  readonly context?: AccountContext;
  readonly problem?: AwsProblem;
  readonly status?: StatusView;
  readonly statusLoading: boolean;
  readonly record?: DeploymentRecordView;
  readonly findings: readonly Finding[];
  /** Whether AWS has answered for this profile yet. */
  readonly awsKnown: boolean;
  readonly next?: Action;
  readonly local?: LocalRunView;
  readonly events: readonly StackEventView[];
  readonly drift?: DriftView | null;
  readonly busy: boolean;
  readonly onAction: (action: Action) => void;
  readonly onMore: (action: MoreAction) => void;
  readonly onServiceLogs: (service: string) => void;
}) {
  const { row, context, status, record, local } = props;
  const actions = useRef<HTMLDetailsElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const closeActions = (restoreFocus = false) => {
    if (!actions.current) return;
    actions.current.open = false;
    if (restoreFocus) actions.current.querySelector("summary")?.focus();
  };
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!actions.current?.contains(event.target as Node)) closeActions();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [actionsOpen]);
  // Once status has answered (from the deployment's own region), it is the authority, even when it found nothing.
  const deployment = status ? status.detail : row.deployment;
  const exists = Boolean(deployment && deployment.state.kind !== "absent");
  const origin = row.target?.origin === "declared" ? "Declared in cdk-app/cdk.json" : row.target?.origin === "personal" ? "Your development deployment" : row.target ? "Named target" : "Discovered in this account";
  const contracts = deployment?.contracts.length ? deployment.contracts.map((value) => `contract ${value}`).join(" + ") : undefined;

  return (
    <section className={`deploy-detail ${row.mode}`} aria-labelledby="deployment-heading">
      <header className="detail-header">
        <div className="detail-title">
          <p className="eyebrow">{origin}</p>
          <h1 id="deployment-heading">{row.name} <DeploymentBadge kind={row.mode} /></h1>
          <p className="identity-line">
            {context ? <span>{deployment?.account ?? context.account} · {deployment?.region ?? context.region}</span> : null}
            {contracts ? <span>{contracts}</span> : null}
            {record?.deployedAt ? (
              <span title={record.deployedBy}>
                Deployed {relativeTime(record.deployedAt)}{record.deployedBy ? ` by ${callerName(record.deployedBy)}` : ""}{record.via ? ` via ${record.via === "studio" ? "Studio" : "the CLI"}` : ""}
                {record.revision?.commit ? <> from <code>{record.revision.commit.slice(0, 7)}{record.revision.dirty ? "+" : ""}</code></> : null}
              </span>
            ) : deployment?.lastUpdated ? <span>Updated {relativeTime(deployment.lastUpdated)}</span> : null}
          </p>
        </div>
        <div className="detail-actions">
          {props.next ? <ActionButton action={props.next} onAction={props.onAction} primary /> : null}
          <details ref={actions} className="more-menu"
            onToggle={(event) => setActionsOpen(event.currentTarget.open)}
            onClick={(event) => { if ((event.target as HTMLElement).closest("[role=menuitem]")) closeActions(true); }}
            onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) closeActions(); }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && event.currentTarget.open) {
                event.preventDefault(); event.stopPropagation(); closeActions(true);
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              event.currentTarget.open = true;
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length);
              items[index]?.focus();
            }}>
            <summary className="icon-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={actionsOpen}><MoreHorizontal size={16} aria-hidden /></summary>
            <div className="menu" role="menu">
              {row.target ? <button role="menuitem" onClick={() => props.onMore("plan")} disabled={props.busy || !context}>Compare AWS templates (read-only)…</button> : null}
              {row.target ? <button role="menuitem" onClick={() => props.onMore("change-sets")} disabled={props.busy || !context} title="Creates CloudFormation change sets and possibly empty review stacks in AWS; does not execute infrastructure changes.">Prepare CloudFormation change sets…</button> : null}
              {row.target && row.mode === "dev" && exists ? <button role="menuitem" onClick={() => props.onMore("export")} disabled={!context}>Export settings to this machine</button> : null}
              {exists ? <button role="menuitem" onClick={() => props.onMore("drift")} disabled={props.busy || !context} title="Starts CloudFormation drift detection. It changes no resource.">Check for drift</button> : null}
              {exists ? <button role="menuitem" className="danger" onClick={() => props.onMore("delete")} disabled={props.busy || !context}>Delete deployment…</button> : null}
            </div>
          </details>
        </div>
      </header>
      {row.target ? <p className="small muted">Template comparison reads AWS without creating review objects. Preparing CloudFormation change sets creates review objects and possibly empty stacks; new secrets require separate approval. Neither action applies infrastructure.</p> : null}

      <section className="findings" aria-label="What needs attention">
        {!props.awsKnown ? <p className="finding-loading muted">Reading what {context?.account ?? "the account"} holds…</p> : null}
        {props.findings.map((finding) => (
          <article key={`${finding.code}-${finding.title}`} className={`finding ${finding.severity} ${finding.scope}`}>
            <span className="finding-icon">{SEVERITY_ICON[finding.severity]}</span>
            <div className="finding-body">
              <strong>{finding.title}</strong>
              {finding.detail ? <p>{finding.detail}</p> : null}
            </div>
            <div className="finding-actions">
              {finding.actions.filter((action) => !(props.next && action.id === props.next.id && action.plan === props.next.plan)).map((action) => (
                <ActionButton key={`${action.id}-${action.plan ?? ""}`} action={action} onAction={props.onAction} />
              ))}
            </div>
          </article>
        ))}
      </section>

      <div className="state-panels">
        <Panel title="Repository">
          <dl className="facts">
            <dt>Intent</dt><dd>{row.target ? (row.target.origin === "personal" ? "CDK_APP_NAME in your development inputs" : "framework:targets in cdk.json") : "Not declared here (read-only)"}</dd>
            <dt>Mode</dt><dd>{row.mode === "prod" ? "Production" : "Development"}<span className="muted"> · fixed when created</span></dd>
            {row.target ? <><dt>Inputs</dt><dd><code>{row.target.inputs ?? (`cdk-app/.env.${row.mode}`)}</code></dd></> : null}
            {row.target ? <><dt>Account</dt><dd>{row.target.account ? <code>{row.target.account}</code> : <span className="muted">the profile's</span>}</dd></> : null}
            {row.target?.region ? <><dt>Region</dt><dd><code>{row.target.region}</code></dd></> : null}
          </dl>
        </Panel>

        <Panel title="AWS" tone={props.problem ? "unreadable" : undefined}>
          {status?.observedAt ? <p className="small muted">Observed {new Date(status.observedAt).toLocaleString()}{props.statusLoading ? " · refreshing" : Date.now() - Date.parse(status.observedAt) > 90_000 ? " · stale; refresh before relying on this observation" : ""}. CloudFormation state; application health is separate.</p> : null}
          {status?.unreadable.map((message) => <p className="diagnostic" key={message}>{message}</p>)}
          {props.problem ? <p className="muted">Not readable with this profile.</p>
            : !deployment && props.statusLoading ? <p className="muted">Reading CloudFormation…</p>
              : !exists ? <p className="muted">No stacks of {row.name}{context ? ` in ${context.account} · ${context.region}` : ""}.</p>
                : (
                  <>
                    <ul className="stack-list">
                      {deployment!.stacks.map((stack) => (
                        <li key={stack.name} className={`stack ${stackTone(stack.health)}`}>
                          <span className={`status-dot ${stackTone(stack.health)}`} aria-hidden />
                          <span className="stack-name" title={stack.name}>{shortStack(stack.name, row.name)}</span>
                          <span className="stack-status">{stack.status.replaceAll("_", " ").toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                    {status?.detail?.changeSets.length ? (
                      <p className="small muted">{status.detail.changeSets.length} pending change set{status.detail.changeSets.length === 1 ? "" : "s"}: {status.detail.changeSets.map((set) => `${shortStack(set.stack, row.name)} (${set.ours ? "a framework plan" : set.name})`).join(", ")}</p>
                    ) : null}
                  </>
                )}
        </Panel>

        <Panel title="This machine" tone="machine">
          {row.mode === "dev" ? <p className="small muted">Starting checks storage. Migrations, orphan cleanup and test identity setup are separate actions. <a href="/database">Review local database</a></p> : null}
          {row.mode === "dev" && local?.readiness ? <p className={local.readiness.state === "blocked" ? "diagnostic" : "small"}>{local.readiness.message} · checked {relativeTime(local.readiness.observedAt)}</p> : null}
          {row.mode === "prod" ? <p className="muted">Local development runs against a development deployment.</p>
            : !local ? <p className="muted">Reading Docker…</p>
              : (
                <>
                  <dl className="facts">
                    <dt>Docker</dt><dd>{local.docker.engine === "running" ? `running${local.docker.context ? ` (${local.docker.context})` : ""}` : local.docker.engine === "missing" ? "not installed" : "not running"}</dd>
                    <dt>Settings</dt><dd>{local.exported.deployment ? <>for <strong>{local.exported.deployment}</strong>{status?.detail?.local && local.exported.deployment === row.name ? (status.detail.local.exported.fresh ? " · current" : " · out of date") : ""}</> : <span className="muted">none exported</span>}</dd>
                    <dt>Watch</dt><dd>{local.watch.running ? "syncing source" : <span className="muted">off</span>}</dd>
                    <dt>Web client</dt><dd>{local.client.running ? (local.appUrl ? <a href={local.appUrl} target="_blank" rel="noreferrer">{local.appUrl} <ExternalLink size={12} aria-hidden /></a> : "running") : <span className="muted">off</span>}</dd>
                  </dl>
                  {local.services.length ? (
                    <ul className="service-list" aria-label="Containers">
                      {local.services.map((service) => {
                        const stopped = local.startedBy === "none";
                        const tone = service.state === "running" ? (service.health === "unhealthy" ? "bad" : service.health === "starting" ? "busy" : "ok")
                          : service.oneShot && service.exitCode === 0 ? "done" : stopped ? "none" : service.state === "exited" && service.exitCode !== 0 ? "bad" : "none";
                        const label = service.oneShot && service.exitCode === 0 ? "completed" : service.state === "running" ? service.health ?? "running" : stopped ? "stopped" : service.exitCode ? `exited ${service.exitCode}` : service.state;
                        return (
                          <li key={service.container}>
                            <button className="service" onClick={() => props.onServiceLogs(service.name)} title={`Logs of ${service.name}`}>
                              <span className={`status-dot ${tone}`} aria-hidden />
                              <span className="service-name">{service.name}</span>
                              <span className="service-state">{label}</span>
                              <ScrollText size={12} aria-hidden />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </>
              )}
        </Panel>
      </div>

      {props.drift ? (
        <section className="drift-report" aria-label="Drift">
          <h3>Drift <span className="small muted">checked {relativeTime(props.drift.checkedAt)}</span></h3>
          <ul>
            {props.drift.stacks.map((stack) => (
              <li key={stack.stack}><strong>{shortStack(stack.stack, row.name)}</strong> {stack.status === "DRIFTED" ? `drifted: ${stack.resources.map((resource) => `${resource.logicalId} (${resource.status.toLowerCase()})`).join(", ")}` : stack.status.toLowerCase().replace("_", " ")}</li>
            ))}
          </ul>
          <p className="small muted">{props.drift.note}</p>
        </section>
      ) : null}

      {props.events.length ? (
        <section className="events" aria-label="CloudFormation events">
          <h3>Events</h3>
          <ol className="event-list">
            {props.events.slice(0, 30).map((event) => (
              <li key={event.id} className={eventTone(event.status)}>
                <time dateTime={event.time}>{new Date(event.time).toLocaleTimeString()}</time>
                <span className="event-stack">{shortStack(event.stack, row.name)}</span>
                <span className="event-resource">{event.logicalId === event.stack ? "stack" : event.logicalId}</span>
                <span className="event-status">{event.status.replaceAll("_", " ").toLowerCase()}</span>
                {event.reason ? <span className="event-reason">{event.reason}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}
