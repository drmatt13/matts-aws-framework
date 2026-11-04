import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { StatusDot, statePanelClasses, factsClasses, sectionTitleClasses } from "./DeployUI";

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
import { callerName, eventTone, relativeTime, shortStack } from "./format";
import type { RailRow } from "./Rail";

function Panel(props: {
  readonly title: string;
  readonly tone?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={statePanelClasses(props.tone)} aria-label={props.title}>
      <h3
        className={cx(
          "mt-0 mb-3 font-sans text-label font-semibold leading-[1.5]",
          props.tone === "machine" ? "text-[color-mix(in_srgb,var(--local)_75%,var(--ink))]" : "text-graphite",
        )}
      >
        {props.title}
      </h3>
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
  readonly frontend?: ReactNode;
}) {
  const { row, context, status, record, local } = props;
  const deployment = status ? status.detail : row.deployment;
  const contracts = deployment?.contracts.length
    ? deployment.contracts.map((value) => `contract ${value}`).join(" + ")
    : undefined;

  return (
    <section
      data-mode={row.mode}
      className="group/detail grid min-w-0 auto-rows-max gap-5 overflow-auto px-4 pt-2 pb-8 @container"
      aria-labelledby="deployment-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            id="deployment-heading"
            className="mt-0 mb-2 flex flex-wrap items-center gap-2 font-condensed text-[28px] font-semibold leading-[1.2] wrap-anywhere"
          >
            {row.name} <DeploymentBadge kind={row.mode} />
          </h1>
          <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-step-minus1 text-graphite wrap-anywhere">
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
        </div>
        {props.next ? (
          <ActionButton action={props.next} onAction={props.onAction} primary />
        ) : null}
      </header>
      <section className="grid gap-2" aria-label="What needs attention">
        {props.connectionMissing ? (
          <div className="grid justify-items-start gap-2">
            <p className="m-0 text-graphite">Choose an AWS profile for {row.mode === "dev" ? "Development" : "Production"} to inspect this deployment.</p>
            <button className={buttonClasses({ variant: "quiet", size: "compact" })} onClick={props.onChooseConnection}>Choose connection</button>
          </div>
        ) : !props.awsKnown ? (
          <p className="m-0 text-graphite">
            Reading what {context?.account ?? "the account"} holds…
          </p>
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
            <div className="min-w-0 wrap-anywhere">
              <strong>{finding.title}</strong>
              {finding.detail ? (
                <p className="mt-1 mb-0 text-step-minus1 text-graphite">{finding.detail}</p>
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

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
        <Panel title="This machine" tone="machine">
          {row.mode === "dev" ? (
            <p className="m-0 [&+p]:mt-2 text-caption text-graphite">
              Starting checks storage. Migrations, orphan cleanup and test identity setup are
              separate actions. <a href="/database">Review local database</a>
            </p>
          ) : null}
          {row.mode === "dev" && local?.readiness ? (
            <p
              className={cx(
                "m-0 [&+p]:mt-2",
                local.readiness.state === "blocked"
                  ? "border-l-[3px] border-refuse py-0.5 pl-[10px]"
                  : "text-caption",
              )}
            >
              {local.readiness.message} · checked {relativeTime(local.readiness.observedAt)}
            </p>
          ) : null}
          {row.mode === "prod" ? (
            <p className="m-0 [&+p]:mt-2 text-graphite">
              Local development runs against a development deployment.
            </p>
          ) : !local ? (
            <p className="m-0 [&+p]:mt-2 text-graphite">Reading Docker…</p>
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
              <p className="m-0 mt-3 text-caption text-graphite">Local containers use native SDK credentials and a read-only AWS configuration mount. Browser sign-in does not establish container refresh or external-provider compatibility.</p>
              {local.services.length ? (
                <ul
                  className="m-0 mt-3 grid list-none gap-1 border-t border-rule p-0 pt-3 text-step-minus1"
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
        <section aria-label="Drift">
          <h3 className={sectionTitleClasses}>
            Drift{" "}
            <span className="text-caption text-graphite">
              checked {relativeTime(props.drift.checkedAt)}
            </span>
          </h3>
          <ul className="mt-0 mb-1.5 pl-4.5">
            {props.drift.stacks.map((stack) => (
              <li key={stack.stack}>
                <strong>{shortStack(stack.stack, row.name)}</strong>{" "}
                {stack.status === "DRIFTED"
                  ? `drifted: ${stack.resources.map((resource) => `${resource.logicalId} (${resource.status.toLowerCase()})`).join(", ")}`
                  : stack.status.toLowerCase().replace("_", " ")}
              </li>
            ))}
          </ul>
          <p className="text-caption text-graphite">{props.drift.note}</p>
        </section>
      ) : null}

      {props.events.length ? (
        <section aria-label="CloudFormation events">
          <h3 className={sectionTitleClasses}>Events</h3>
          <ol className="m-0 grid list-none overflow-hidden rounded-lg border border-rule bg-sheet p-0 text-step-minus1">
            {props.events.slice(0, 30).map((event) => (
              <li
                key={event.id}
                data-tone={eventTone(event.status)}
                className="group/event grid grid-cols-[80px_repeat(3,minmax(0,1fr))] gap-x-3 gap-y-1 border-t border-rule px-3 py-2 wrap-anywhere first:border-t-0 vp-900:grid-cols-[70px_minmax(0,1fr)] detail-640:grid-cols-[80px_minmax(0,1fr)]"
              >
                <time className="font-mono text-[0.75rem] text-faint" dateTime={event.time}>
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
  );
}
