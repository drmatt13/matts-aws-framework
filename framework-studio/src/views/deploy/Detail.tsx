import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";
import { iconButtonClasses } from "../../ui/IconButton";

import { StatusDot, statePanelClasses, factsClasses, sectionTitleClasses } from "./DeployUI";

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
    <section className={statePanelClasses(props.tone)} aria-label={props.title}>
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
      data-primary={props.primary || undefined} className={buttonClasses({ variant: props.primary ? "primary" : "quiet", tone: !props.primary && action.tone === "danger" ? "danger" : "default" })}
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
  readonly frontend?: ReactNode;
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
    <section data-mode={row.mode} className="group/detail grid min-w-0 auto-rows-max gap-5 overflow-auto px-5 pt-5 pb-8 @container vp-900:px-4 vp-900:pt-4" aria-labelledby="deployment-heading">
      <header className={"flex flex-wrap items-start justify-between gap-4"}>
        <div className={"min-w-0 [&>h1]:mt-1 [&>h1]:mb-2 [&>h1]:flex [&>h1]:flex-wrap [&>h1]:items-center [&>h1]:gap-2 [&>h1]:font-condensed [&>h1]:text-[28px] [&>h1]:font-semibold [&>h1]:leading-[1.2] [&>h1]:wrap-anywhere"}>
          <p className={"m-0 text-meta tracking-[0.08em] text-graphite uppercase group-data-[mode=dev]/detail:text-dev group-data-[mode=prod]/detail:text-prod"}>{origin}</p>
          <h1 id="deployment-heading">{row.name} <DeploymentBadge kind={row.mode} /></h1>
          <p className={"m-0 flex flex-wrap gap-x-4 gap-y-1 text-step-minus1 text-graphite wrap-anywhere"}>
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
        <div className={"flex items-center gap-2 vp-480:w-full vp-480:justify-end [&>[data-primary]]:vp-480:flex-1 group-data-[mode=prod]/detail:[&>[data-primary]]:border-prod group-data-[mode=prod]/detail:[&>[data-primary]]:bg-prod"}>
          {props.next ? <ActionButton action={props.next} onAction={props.onAction} primary /> : null}
          <details ref={actions} className={"relative [&>summary]:list-none [&>summary::-webkit-details-marker]:hidden"}
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
            <summary className={iconButtonClasses()} aria-label="More actions" aria-haspopup="menu" aria-expanded={actionsOpen}><MoreHorizontal size={16} aria-hidden /></summary>
            <div className={"absolute top-[calc(100%+4px)] right-0 z-10 grid w-max min-w-[min(250px,calc(100vw-32px))] max-w-[calc(100vw-32px)] rounded-lg border border-rule-strong bg-sheet p-1 shadow-[0_18px_40px_-22px_color-mix(in_srgb,var(--ink)_60%,transparent)]"} role="menu">
              {row.target ? <button className={"min-h-8 cursor-pointer rounded-sm border-0 bg-transparent px-3 py-2 text-left wrap-anywhere enabled:hover:bg-wash disabled:cursor-default disabled:opacity-45"} role="menuitem" onClick={() => props.onMore("plan")} disabled={props.busy || !context}>Compare AWS templates (read-only)…</button> : null}
              {row.target ? <button className={"min-h-8 cursor-pointer rounded-sm border-0 bg-transparent px-3 py-2 text-left wrap-anywhere enabled:hover:bg-wash disabled:cursor-default disabled:opacity-45"} role="menuitem" onClick={() => props.onMore("change-sets")} disabled={props.busy || !context} title="Creates CloudFormation change sets and possibly empty review stacks in AWS; does not execute infrastructure changes.">Prepare CloudFormation change sets…</button> : null}
              {row.target && row.mode === "dev" && exists ? <button className={"min-h-8 cursor-pointer rounded-sm border-0 bg-transparent px-3 py-2 text-left wrap-anywhere enabled:hover:bg-wash disabled:cursor-default disabled:opacity-45"} role="menuitem" onClick={() => props.onMore("export")} disabled={!context}>Export settings to this machine</button> : null}
              {exists ? <button className={"min-h-8 cursor-pointer rounded-sm border-0 bg-transparent px-3 py-2 text-left wrap-anywhere enabled:hover:bg-wash disabled:cursor-default disabled:opacity-45"} role="menuitem" onClick={() => props.onMore("drift")} disabled={props.busy || !context} title="Starts CloudFormation drift detection. It changes no resource.">Check for drift</button> : null}
              {exists ? <button role="menuitem" className={"min-h-8 cursor-pointer rounded-sm border-0 bg-transparent px-3 py-2 text-left wrap-anywhere enabled:hover:bg-wash disabled:cursor-default disabled:opacity-45 mt-1 rounded-t-none border-t border-rule text-refuse"} onClick={() => props.onMore("delete")} disabled={props.busy || !context}>Delete deployment…</button> : null}
            </div>
          </details>
        </div>
      </header>
      {row.target ? <p className={"text-caption text-graphite"}>Template comparison reads AWS without creating review objects. Preparing CloudFormation change sets creates review objects and possibly empty stacks; new secrets require separate approval. Neither action applies infrastructure.</p> : null}

      <section className={"grid gap-2"} aria-label="What needs attention">
        {!props.awsKnown ? <p className={"m-0 text-graphite"}>Reading what {context?.account ?? "the account"} holds…</p> : null}
        {props.findings.map((finding) => (
          <article key={`${finding.code}-${finding.title}`} data-severity={finding.severity} className={cx("group/finding grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border border-l-[3px] border-rule px-4 py-3 vp-900:grid-cols-[auto_minmax(0,1fr)] detail-640:grid-cols-[auto_minmax(0,1fr)]", finding.severity === "blocking" ? "border-l-refuse bg-[color-mix(in_srgb,var(--refuse-wash)_70%,var(--sheet))]" : finding.severity === "attention" ? "border-l-local bg-sheet" : "bg-sheet")}>
            <span className={"pt-0.5 group-data-[severity=blocking]/finding:text-refuse group-data-[severity=attention]/finding:text-local group-data-[severity=info]/finding:text-graphite"}>{SEVERITY_ICON[finding.severity]}</span>
            <div className={"min-w-0 wrap-anywhere [&>p]:mt-1 [&>p]:mb-0 [&>p]:text-step-minus1 [&>p]:text-graphite"}>
              <strong>{finding.title}</strong>
              {finding.detail ? <p>{finding.detail}</p> : null}
            </div>
            <div className={"flex flex-wrap justify-end gap-2 vp-900:col-start-2 vp-900:justify-start detail-640:col-start-2 detail-640:justify-start [&>button]:min-h-7 [&>button]:px-3 [&>button]:py-1"}>
              {finding.actions.filter((action) => !(props.next && action.id === props.next.id && action.plan === props.next.plan)).map((action) => (
                <ActionButton key={`${action.id}-${action.plan ?? ""}`} action={action} onAction={props.onAction} />
              ))}
            </div>
          </article>
        ))}
      </section>

      <div className={"grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3"}>
        <Panel title="Repository">
          <dl className={factsClasses}>
            <dt>Intent</dt><dd>{row.target ? (row.target.origin === "personal" ? "CDK_APP_NAME in your development inputs" : "framework:targets in cdk.json") : "Not declared here (read-only)"}</dd>
            <dt>Mode</dt><dd>{row.mode === "prod" ? "Production" : "Development"}<span className={"text-graphite"}> · fixed when created</span></dd>
            {row.target ? <><dt>Inputs</dt><dd><code>{row.target.inputs ?? (`cdk-app/.env.${row.mode}`)}</code></dd></> : null}
            {row.target ? <><dt>Account</dt><dd>{row.target.account ? <code>{row.target.account}</code> : <span className={"text-graphite"}>the profile's</span>}</dd></> : null}
            {row.target?.region ? <><dt>Region</dt><dd><code>{row.target.region}</code></dd></> : null}
          </dl>
        </Panel>

        <Panel title="AWS" tone={props.problem ? "unreadable" : undefined}>
          {status?.observedAt ? <p className={"text-caption text-graphite"}>Observed {new Date(status.observedAt).toLocaleString()}{props.statusLoading ? " · refreshing" : Date.now() - Date.parse(status.observedAt) > 90_000 ? " · stale; refresh before relying on this observation" : ""}. CloudFormation state; application health is separate.</p> : null}
          {status?.unreadable.map((message) => <p className={"border-l-[3px] border-refuse py-0.5 pl-[10px]"} key={message}>{message}</p>)}
          {props.problem ? <p className={"text-graphite"}>Not readable with this profile.</p>
            : !deployment && props.statusLoading ? <p className={"text-graphite"}>Reading CloudFormation…</p>
              : !exists ? <p className={"text-graphite"}>No stacks of {row.name}{context ? ` in ${context.account} · ${context.region}` : ""}.</p>
                : (
                  <>
                    <ul className={"m-0 grid list-none gap-1 p-0 text-step-minus1"}>
                      {deployment!.stacks.map((stack) => (
                        <li key={stack.name} data-tone={stackTone(stack.health)} className="group/stack grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 py-1">
                          <StatusDot tone={stackTone(stack.health)} />
                          <span className={"wrap-anywhere"} title={stack.name}>{shortStack(stack.name, row.name)}</span>
                          <span className={"col-start-2 text-meta text-graphite group-data-[tone=bad]/stack:text-refuse group-data-[tone=busy]/stack:text-local"}>{stack.status.replaceAll("_", " ").toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                    {status?.detail?.changeSets.length ? (
                      <p className={"text-caption text-graphite"}>{status.detail.changeSets.length} pending change set{status.detail.changeSets.length === 1 ? "" : "s"}: {status.detail.changeSets.map((set) => `${shortStack(set.stack, row.name)} (${set.ours ? "a framework plan" : set.name})`).join(", ")}</p>
                    ) : null}
                  </>
                )}
        </Panel>

        <Panel title="This machine" tone="machine">
          {row.mode === "dev" ? <p className={"text-caption text-graphite"}>Starting checks storage. Migrations, orphan cleanup and test identity setup are separate actions. <a href="/database">Review local database</a></p> : null}
          {row.mode === "dev" && local?.readiness ? <p className={local.readiness.state === "blocked" ? "border-l-[3px] border-refuse py-0.5 pl-[10px]" : "text-caption"}>{local.readiness.message} · checked {relativeTime(local.readiness.observedAt)}</p> : null}
          {row.mode === "prod" ? <p className={"text-graphite"}>Local development runs against a development deployment.</p>
            : !local ? <p className={"text-graphite"}>Reading Docker…</p>
              : (
                <>
                  <dl className={factsClasses}>
                    <dt>Docker</dt><dd>{local.docker.engine === "running" ? `running${local.docker.context ? ` (${local.docker.context})` : ""}` : local.docker.engine === "missing" ? "not installed" : "not running"}</dd>
                    <dt>Settings</dt><dd>{local.exported.deployment ? <>for <strong>{local.exported.deployment}</strong>{status?.detail?.local && local.exported.deployment === row.name ? (status.detail.local.exported.fresh ? " · current" : " · out of date") : ""}</> : <span className={"text-graphite"}>none exported</span>}</dd>
                    <dt>Watch</dt><dd>{local.watch.running ? "syncing source" : <span className={"text-graphite"}>off</span>}</dd>
                    <dt>Web client</dt><dd>{local.client.running ? (local.appUrl ? <a href={local.appUrl} target="_blank" rel="noreferrer">{local.appUrl} <ExternalLink size={12} aria-hidden /></a> : "running") : <span className={"text-graphite"}>off</span>}</dd>
                  </dl>
                  {local.services.length ? (
                    <ul className={"m-0 mt-3 grid list-none gap-1 border-t border-rule p-0 pt-3 text-step-minus1"} aria-label="Containers">
                      {local.services.map((service) => {
                        const stopped = local.startedBy === "none";
                        const tone = service.state === "running" ? (service.health === "unhealthy" ? "bad" : service.health === "starting" ? "busy" : "ok")
                          : service.oneShot && service.exitCode === 0 ? "done" : stopped ? "none" : service.state === "exited" && service.exitCode !== 0 ? "bad" : "none";
                        const label = service.disabledByDeploy ? "Disabled by Deploy" : service.oneShot && service.exitCode === 0 ? "completed" : service.state === "running" ? service.health ?? "running" : stopped ? "stopped" : service.exitCode ? `exited ${service.exitCode}` : service.state;
                        return (
                          <li key={service.container}>
                            <button className={"grid min-h-8 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-sm border-0 bg-transparent p-1 text-left text-inherit hover:bg-wash [&>svg]:text-faint"} onClick={() => props.onServiceLogs(service.name)} title={`Logs of ${service.name}`}>
                              <StatusDot tone={tone} />
                              <span className={"truncate"}>{service.name}</span>
                              <span className={"text-graphite"}>{label}</span>
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
        <section className={"[&_ul]:mt-0 [&_ul]:mb-1.5 [&_ul]:pl-4.5"} aria-label="Drift">
          <h3 className={sectionTitleClasses}>Drift <span className={"text-caption text-graphite"}>checked {relativeTime(props.drift.checkedAt)}</span></h3>
          <ul>
            {props.drift.stacks.map((stack) => (
              <li key={stack.stack}><strong>{shortStack(stack.stack, row.name)}</strong> {stack.status === "DRIFTED" ? `drifted: ${stack.resources.map((resource) => `${resource.logicalId} (${resource.status.toLowerCase()})`).join(", ")}` : stack.status.toLowerCase().replace("_", " ")}</li>
            ))}
          </ul>
          <p className={"text-caption text-graphite"}>{props.drift.note}</p>
        </section>
      ) : null}

      {props.events.length ? (
        <section  aria-label="CloudFormation events">
          <h3 className={sectionTitleClasses}>Events</h3>
          <ol className={"m-0 grid list-none overflow-hidden rounded-lg border border-rule bg-sheet p-0 text-step-minus1 [&>li]:grid [&>li]:grid-cols-[80px_repeat(3,minmax(0,1fr))] [&>li]:gap-x-3 [&>li]:gap-y-1 [&>li]:border-t [&>li]:border-rule [&>li]:px-3 [&>li]:py-2 [&>li]:wrap-anywhere [&>li:first-child]:border-t-0 [&_time]:font-mono [&_time]:text-[0.75rem] [&_time]:text-faint vp-900:[&>li]:grid-cols-[70px_minmax(0,1fr)] detail-640:[&>li]:grid-cols-[80px_minmax(0,1fr)]"}>
            {props.events.slice(0, 30).map((event) => (
              <li key={event.id} data-tone={eventTone(event.status)} className="group/event">
                <time dateTime={event.time}>{new Date(event.time).toLocaleTimeString()}</time>
                <span >{shortStack(event.stack, row.name)}</span>
                <span className={"wrap-anywhere detail-640:col-start-2"}>{event.logicalId === event.stack ? "stack" : event.logicalId}</span>
                <span className={"detail-640:col-start-2 group-data-[tone=busy]/event:text-local group-data-[tone=bad]/event:text-refuse"}>{event.status.replaceAll("_", " ").toLowerCase()}</span>
                {event.reason ? <span className={"col-[2/-1] text-graphite wrap-anywhere group-data-[tone=bad]/event:text-refuse"}>{event.reason}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {props.frontend}
    </section>
  );
}
