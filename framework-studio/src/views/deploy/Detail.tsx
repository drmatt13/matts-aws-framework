import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";
import { Notice } from "../../ui/Surface";

import {
  AlertOctagon,
  AlertTriangle,
  Info,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AccountContext,
  DeploymentRecordView,
  DriftView,
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
 * The active mode's deployment, its findings, and operational evidence.
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
  readonly events: readonly StackEventView[];
  readonly drift?: DriftView | null;
  readonly onAction: (action: Action) => void;
  readonly machine?: ReactNode;
  readonly notice?: ReactNode;
}) {
  const { row, context, status, record } = props;
  const authenticationFinding = props.findings.find((finding) => finding.code === "SIGNED_OUT");
  const findings = props.findings.filter((finding) => finding !== authenticationFinding);
  const next = authenticationFinding ? undefined : props.next;
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
          <p
            className={cx(documentSupportClasses, "flex min-h-[1.5em] min-w-0 flex-wrap gap-x-4 gap-y-1 wrap-anywhere")}
            data-slot="deployment-context"
            aria-live="polite"
          >
            {authenticationFinding ? (
              <button
                type="button"
                className="max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-caption leading-[1.5] text-refuse underline-offset-2 hover:underline focus-visible:underline"
                aria-label="AWS sign-in required. Open AWS profile configuration"
                title={`${authenticationFinding.title}. ${authenticationFinding.detail ?? "Open AWS profile configuration to reconnect."}`}
                onClick={props.onChooseConnection}
              >
                AWS sign-in required
              </button>
            ) : context ? (
              <span>
                {deployment?.account ?? context.account} · {deployment?.region ?? context.region}
              </span>
            ) : !props.awsKnown && !props.connectionMissing ? (
              <span
                role="status"
                aria-label="Loading AWS profile"
                className="inline-flex h-[1.5em] w-[24ch] max-w-full items-center"
              >
                <span aria-hidden="true" className="h-[1em] w-full animate-deploy-pulse rounded-sm bg-rule-strong motion-reduce:animate-none" />
              </span>
            ) : null}
            {!authenticationFinding && contracts ? <span>{contracts}</span> : null}
            {!authenticationFinding && record?.deployedAt ? (
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
            ) : !authenticationFinding && deployment?.lastUpdated ? (
              <span>Updated {relativeTime(deployment.lastUpdated)}</span>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex min-h-8 min-w-0 max-w-full flex-wrap items-center justify-end gap-3 vp-720:w-full">
          {props.machine}
          {next ? (
            <ActionButton action={next} onAction={props.onAction} primary />
          ) : null}
        </div>
      </PageToolbar>
      <section className={cx(pageBodyClasses, "grid auto-rows-max gap-3 @container")} aria-labelledby="deployment-heading">
        {props.notice}
        {props.connectionMissing || !props.awsKnown || findings.length ? (
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
            {findings.map((finding) => (
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
                        !(next && action.id === next.id && action.plan === next.plan),
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
      </section>
    </div>
  );
}
