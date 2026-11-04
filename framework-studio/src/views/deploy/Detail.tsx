import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";
import { Notice } from "../../ui/Surface";

import { StatusDot, statePanelClasses, factsClasses } from "./DeployUI";

import {
  AlertOctagon,
  AlertTriangle,
  ExternalLink,
  Info,
  ScrollText,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AccountContext,
  DeploymentRecordView,
  DriftView,
  LocalRunView,
  StackEventView,
  StatusView,
} from "../../../shared/deploy";
import type { Action, Finding } from "../../../shared/deploy-findings";
import { DeploymentBadge } from "../DeploymentBadge";
import {
  PageToolbar, pageBodyClasses, pageTitleClasses, documentTitleClasses,
  documentProseClasses, documentSupportClasses,
} from "../DocumentUI";
import { callerName, eventTone, relativeTime, shortStack } from "./format";
import type { RailRow } from "./Rail";

function Panel(props: {
  readonly title: string;
  readonly tone?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cx(statePanelClasses(props.tone), "grid gap-3")} aria-label={props.title}>
      <h2 className={documentTitleClasses}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

const SEVERITY_ICON = {
  blocking: <AlertOctagon size={16} aria-hidden />,
  attention: <AlertTriangle size={16} aria-hidden />,
  info: <Info size={16} aria-hidden />,
};

function ActionButton(props: {
  readonly action: Action;
  readonly onAction: (action: Action) => void;
  readonly primary?: boolean;
  readonly compact?: boolean;
}) {
  const { action } = props;
  return (
    <button
      className={buttonClasses({
        variant: props.primary ? "primary" : "quiet",
        tone: !props.primary && action.tone === "danger" ? "danger" : "default",
        size: props.compact ? "custom" : "regular",
        className: cx(
          props.primary &&
            "vp-480:flex-1 group-data-[mode=prod]/detail:border-prod group-data-[mode=prod]/detail:bg-prod",
          props.compact && "min-h-7 px-3 py-1",
        ),
      })}
      onClick={() => props.onAction(action)}
      disabled={Boolean(action.disabled)}
      title={action.disabled}
    >
      {action.label}
    </button>
  );
}

/**
 * The active mode's deployment, its findings, and local development status.
 */
export function Detail(props: {
  readonly row: RailRow;
  readonly context?: AccountContext;
  readonly status?: StatusView;
  readonly record?: DeploymentRecordView;
  readonly findings: readonly Finding[];
  /** Whether AWS has answered for this profile yet. */
  readonly awsKnown: boolean;
  readonly connectionMissing?: boolean;
  readonly onChooseConnection?: () => void;
  readonly next?: Action;
  readonly local?: LocalRunView;
  readonly events: readonly StackEventView[];
  readonly drift?: DriftView | null;
  readonly onAction: (action: Action) => void;
  readonly onServiceLogs: (service: string) => void;
  readonly machine?: ReactNode;
  readonly notice?: ReactNode;
  readonly frontend?: ReactNode;
}) {
  const { row, context, status, record, local } = props;
  const deployment = status ? status.detail : row.deployment;
  const contracts = deployment?.contracts.length
    ? deployment.contracts.map((value) => `contract ${value}`).join(" + ")
    : undefined;

  return (
    <div
      data-mode={row.mode}
      className="group/detail min-w-0"
    >
      <PageToolbar appearance="plain" className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1
            id="deployment-heading"
            className={cx(pageTitleClasses, "flex min-h-8 flex-wrap items-center gap-2 wrap-anywhere")}
          >
            {row.name} <DeploymentBadge kind={row.mode} />
          </h1>
          {context || contracts || record?.deployedAt || deployment?.lastUpdated ? (
            <p className={cx(documentSupportClasses, "flex flex-wrap gap-x-4 gap-y-1 wrap-anywhere")}>
              {context ? (
                <span>
                  {deployment?.account ?? context.account} · {deployment?.region ?? context.region}
                </span>
              ) : null}
              {contracts ? <span>{contracts}</span> : null}
              {record?.deployedAt ? (
                <span title={record.deployedBy}>
                  Deployed {relativeTime(record.deployedAt)}
                  {record.deployedBy ? ` by ${callerName(record.deployedBy)}` : ""}
                  {record.via ? ` via ${record.via === "studio" ? "Studio" : "the CLI"}` : ""}
                  {record.revision?.commit ? (
                    <>
                      {" "}
                      from{" "}
                      <code>
                        {record.revision.commit.slice(0, 7)}
                        {record.revision.dirty ? "+" : ""}
                      </code>
                    </>
                  ) : null}
                </span>
              ) : deployment?.lastUpdated ? (
                <span>Updated {relativeTime(deployment.lastUpdated)}</span>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-8 min-w-0 max-w-full flex-wrap items-center justify-end gap-3">
          {props.machine}
          {props.next ? (
            <ActionButton action={props.next} onAction={props.onAction} primary />
          ) : null}
        </div>
      </PageToolbar>
      <section className={cx(pageBodyClasses, "grid auto-rows-max gap-3 @container")} aria-labelledby="deployment-heading">
        {props.notice}
        {props.connectionMissing || !props.awsKnown || props.findings.length ? (
          <section className="grid gap-2" aria-label="What needs attention">
            {props.connectionMissing ? (
              <Notice tone="neutral" className="grid justify-items-start gap-2">
                <p className={documentProseClasses}>Choose an AWS profile for {row.mode === "dev" ? "Development" : "Production"} to inspect this deployment.</p>
                <button className={buttonClasses({ variant: "quiet", size: "compact" })} onClick={props.onChooseConnection}>Choose connection</button>
              </Notice>
            ) : !props.awsKnown ? (
              <Notice tone="neutral" role="status">
                Reading what {context?.account ?? "the account"} holds…
              </Notice>
            ) : null}
            {props.findings.map((finding) => (
              <article
                key={`${finding.code}-${finding.title}`}
                data-severity={finding.severity}
                className={cx(
                  "group/finding grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border border-l-[3px] border-rule px-4 py-3 vp-900:grid-cols-[auto_minmax(0,1fr)] detail-640:grid-cols-[auto_minmax(0,1fr)]",
                  finding.severity === "blocking"
                    ? "border-l-refuse bg-[color-mix(in_srgb,var(--refuse-wash)_70%,var(--sheet))]"
                    : finding.severity === "attention"
                      ? "border-l-local bg-sheet"
                      : "bg-sheet",
                )}
              >
                <span className="pt-0.5 group-data-[severity=blocking]/finding:text-refuse group-data-[severity=attention]/finding:text-local group-data-[severity=info]/finding:text-graphite">
                  {SEVERITY_ICON[finding.severity]}
                </span>
                <div className="grid min-w-0 gap-1 wrap-anywhere">
                  <strong className="text-body font-semibold">{finding.title}</strong>
                  {finding.detail ? (
                    <p className={documentSupportClasses}>{finding.detail}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap justify-end gap-2 vp-900:col-start-2 vp-900:justify-start detail-640:col-start-2 detail-640:justify-start">
                  {finding.actions
                    .filter(
                      (action) =>
                        !(props.next && action.id === props.next.id && action.plan === props.next.plan),
                    )
                    .map((action) => (
                      <ActionButton
                        key={`${action.id}-${action.plan ?? ""}`}
                        action={action}
                        onAction={props.onAction}
                        compact
                      />
                    ))}
                </div>
              </article>
            ))}
          </section>
        ) : null}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
          <Panel title="This machine" tone="machine">
            {row.mode === "dev" ? (
              <p className={documentSupportClasses}>
                Starting checks storage. Migrations, orphan cleanup and test identity setup are
                separate actions. <a href="/database">Review local database</a>
              </p>
            ) : null}
            {row.mode === "dev" && local?.readiness ? (
              <p
                className={cx(
                  documentSupportClasses,
                  local.readiness.state === "blocked"
                    ? "border-l-[3px] border-refuse py-0.5 pl-[10px]"
                    : undefined,
                )}
              >
                {local.readiness.message} · checked {relativeTime(local.readiness.observedAt)}
              </p>
            ) : null}
            {row.mode === "prod" ? (
              <p className={documentProseClasses}>
                Local development runs against a development deployment.
              </p>
            ) : !local ? (
              <p className={documentSupportClasses} role="status">Reading Docker…</p>
            ) : (
              <>
                <dl className={factsClasses}>
                  <dt className="text-graphite">Local AWS profile</dt>
                  <dd className="m-0 wrap-anywhere">{local.profile ? <>{local.startedBy !== "none" || local.watch.running || local.client.running ? "Running with" : "Last launched with"} <strong>{local.profile}</strong></> : "Not started by Studio"}</dd>
                  <dt className="text-graphite">Docker</dt>
                  <dd className="m-0 wrap-anywhere">
                    {local.docker.engine === "running"
                      ? `running${local.docker.context ? ` (${local.docker.context})` : ""}`
                      : local.docker.engine === "missing"
                        ? "not installed"
                        : "not running"}
                  </dd>
                  <dt className="text-graphite">Settings</dt>
                  <dd className="m-0 wrap-anywhere">
                    {local.exported.deployment ? (
                      <>
                        for <strong>{local.exported.deployment}</strong>
                        {status?.detail?.local && local.exported.deployment === row.name
                          ? status.detail.local.exported.fresh
                            ? " · current"
                            : " · out of date"
                          : ""}
                      </>
                    ) : (
                      <span className="text-graphite">none exported</span>
                    )}
                  </dd>
                  <dt className="text-graphite">Watch</dt>
                  <dd className="m-0 wrap-anywhere">
                    {local.watch.running ? (
                      "syncing source"
                    ) : (
                      <span className="text-graphite">off</span>
                    )}
                  </dd>
                  <dt className="text-graphite">Web client</dt>
                  <dd className="m-0 wrap-anywhere">
                    {local.client.running ? (
                      local.appUrl ? (
                        <a
                          href={local.appUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-full items-center gap-1"
                        >
                          {local.appUrl} <ExternalLink size={12} aria-hidden className="flex-none" />
                        </a>
                      ) : (
                        "running"
                      )
                    ) : (
                      <span className="text-graphite">off</span>
                    )}
                  </dd>
                </dl>
                <p className={documentSupportClasses}>Local containers use native SDK credentials and a read-only AWS configuration mount. Browser sign-in does not establish container refresh or external-provider compatibility.</p>
                {local.services.length ? (
                  <ul
                    className="m-0 grid list-none gap-1 border-t border-rule p-0 pt-3 text-label"
                    aria-label="Containers"
                  >
                    {local.services.map((service) => {
                      const stopped = local.startedBy === "none";
                      const tone =
                        service.state === "running"
                          ? service.health === "unhealthy"
                            ? "bad"
                            : service.health === "starting"
                              ? "busy"
                              : "ok"
                          : service.oneShot && service.exitCode === 0
                            ? "done"
                            : stopped
                              ? "none"
                              : service.state === "exited" && service.exitCode !== 0
                                ? "bad"
                                : "none";
                      const label = service.disabledByDeploy
                        ? "Disabled by Deploy"
                        : service.oneShot && service.exitCode === 0
                          ? "completed"
                          : service.state === "running"
                            ? (service.health ?? "running")
                            : stopped
                              ? "stopped"
                              : service.exitCode
                                ? `exited ${service.exitCode}`
                                : service.state;
                      return (
                        <li key={service.container}>
                          <button
                            className="grid min-h-8 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-sm border-0 bg-transparent p-1 text-left text-inherit hover:bg-wash"
                            onClick={() => props.onServiceLogs(service.name)}
                            title={`Logs of ${service.name}`}
                          >
                            <StatusDot tone={tone} />
                            <span className="truncate">{service.name}</span>
                            <span className="text-graphite">{label}</span>
                            <ScrollText size={12} className="text-faint" aria-hidden />
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
          <section className="grid gap-3" aria-label="Drift">
            <h2 className={documentTitleClasses}>
              Drift{" "}
              <span className="text-caption text-graphite">
                checked {relativeTime(props.drift.checkedAt)}
              </span>
            </h2>
            <ul className="m-0 pl-5">
              {props.drift.stacks.map((stack) => (
                <li key={stack.stack}>
                  <strong>{shortStack(stack.stack, row.name)}</strong>{" "}
                  {stack.status === "DRIFTED"
                    ? `drifted: ${stack.resources.map((resource) => `${resource.logicalId} (${resource.status.toLowerCase()})`).join(", ")}`
                    : stack.status.toLowerCase().replace("_", " ")}
                </li>
              ))}
            </ul>
            <p className={documentSupportClasses}>{props.drift.note}</p>
          </section>
        ) : null}

        {props.events.length ? (
          <section className="grid gap-3" aria-label="CloudFormation events">
            <h2 className={documentTitleClasses}>Events</h2>
            <ol className="m-0 grid list-none overflow-hidden rounded-md border border-rule bg-sheet p-0 text-label">
              {props.events.slice(0, 30).map((event) => (
                <li
                  key={event.id}
                  data-tone={eventTone(event.status)}
                  className="group/event grid grid-cols-[80px_repeat(3,minmax(0,1fr))] gap-x-3 gap-y-1 border-t border-rule px-3 py-2 wrap-anywhere first:border-t-0 vp-900:grid-cols-[70px_minmax(0,1fr)] detail-640:grid-cols-[80px_minmax(0,1fr)]"
                >
                  <time className="font-mono text-caption text-faint" dateTime={event.time}>
                    {new Date(event.time).toLocaleTimeString()}
                  </time>
                  <span>{shortStack(event.stack, row.name)}</span>
                  <span className="wrap-anywhere detail-640:col-start-2">
                    {event.logicalId === event.stack ? "stack" : event.logicalId}
                  </span>
                  <span className="detail-640:col-start-2 group-data-[tone=busy]/event:text-local group-data-[tone=bad]/event:text-refuse">
                    {event.status.replaceAll("_", " ").toLowerCase()}
                  </span>
                  {event.reason ? (
                    <span className="col-[2/-1] text-graphite wrap-anywhere group-data-[tone=bad]/event:text-refuse">
                      {event.reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {props.frontend}
      </section>
    </div>
  );
}
