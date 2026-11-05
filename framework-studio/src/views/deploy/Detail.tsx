import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";
import { Notice } from "../../ui/Surface";

import {
  AlertOctagon,
  AlertTriangle,
  ChevronRight,
  Info,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { DeploymentScope } from "../../deploy/context";
import type {
  AccountContext,
  DeploymentRecordView,
  DiscoveredDeploymentView,
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
import { callerName, relativeTime, shortStack } from "./format";
import type { RailRow } from "./Rail";
import { StackInspector } from "./StackInspector";

const SEVERITY_ICON = {
  blocking: <AlertOctagon size={16} aria-hidden />,
  attention: <AlertTriangle size={16} aria-hidden />,
  info: <Info size={16} aria-hidden />,
};

function ActionButton(props: {
  readonly action: Action;
  readonly onAction: (action: Action, trigger?: HTMLButtonElement) => void;
  readonly compact?: boolean;
}) {
  const { action } = props;
  return (
    <button
      className={buttonClasses({
        variant: "quiet",
        tone: action.tone === "danger" ? "danger" : "default",
        size: props.compact ? "custom" : "regular",
        className: cx(
          props.compact && "min-h-7 px-3 py-1",
        ),
      })}
      onClick={event => props.onAction(action, event.currentTarget)}
      disabled={Boolean(action.disabled)}
      title={action.disabled}
    >
      {action.label}
    </button>
  );
}

function DeployedCard({ finding, deployment, context, busy, stale, onAction, inspectionScope }: {
  readonly finding: Finding;
  readonly deployment: DiscoveredDeploymentView;
  readonly context?: AccountContext;
  readonly busy?: string;
  readonly stale?: boolean;
  readonly onAction: (action: Action, trigger?: HTMLButtonElement) => void;
  readonly inspectionScope?: DeploymentScope;
}) {
  const [selectedStack, setSelectedStack] = useState<string>();
  const stackTrigger = useRef<HTMLButtonElement>(null);
  const profile = context?.profile;
  return (
    <>
    <details aria-label="Deployed deployment" className="group/deployed min-w-0 overflow-hidden rounded-md border border-l-[3px] border-rule bg-sheet">
      <summary className="grid min-h-12 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <Info size={16} className="text-graphite" aria-hidden />
        <span className="grid min-w-0 gap-1 wrap-anywhere">
          <strong className="text-body font-semibold">{finding.title}</strong>
          {stale ? <span className="text-caption text-local">Last observed · status unavailable</span> : null}
        </span>
        <ChevronRight size={16} className="text-graphite transition-transform duration-120 group-open/deployed:rotate-90 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="grid min-w-0 gap-4 border-t border-rule px-4 py-3">
        <p className={documentSupportClasses}>
          {deployment.name} · {deployment.mode === "dev" ? "Development" : "Production"}
          {context?.profile ? ` · profile ${context.profile}` : ""} · {deployment.account} · {deployment.region}
        </p>
        <section className="grid min-w-0 gap-2" aria-label="Deployed stacks">
          <h2 className={documentTitleClasses}>Stacks</h2>
          <ul className="m-0 grid list-none gap-2 p-0">
            {deployment.stacks.map(stack => (
              <li className="min-w-0" key={stack.name}>
                <button type="button" aria-label={`Inspect ${stack.name}`} disabled={!profile}
                  className="grid min-w-0 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-rule bg-transparent px-3 py-2 text-left text-ink hover:bg-wash disabled:cursor-not-allowed disabled:opacity-45"
                  onClick={event => { stackTrigger.current = event.currentTarget; setSelectedStack(stack.name); }}>
                  <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <code className="text-caption wrap-anywhere">{stack.name}</code>
                    <span className="text-caption text-graphite">{stack.status}</span>
                  </span>
                  <ChevronRight size={16} className="text-graphite" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
        <div className="flex justify-end">
          <ActionButton action={{ id: "delete", label: "Destroy…", tone: "danger", ...(stale ? { disabled: "Refresh deployment status before destroying." } : busy ? { disabled: `${busy} is running.` } : {}) }} onAction={onAction} compact />
        </div>
      </div>
    </details>
    {selectedStack && profile ? <StackInspector scope={{
      repository: inspectionScope?.repository ?? "", sourceRevision: inspectionScope?.sourceRevision ?? "",
      generation: inspectionScope?.generation ?? "", profile, deployment: deployment.name,
      mode: deployment.mode, account: deployment.account, region: deployment.region, stack: selectedStack,
    }} onClose={() => setSelectedStack(undefined)} returnFocusRef={stackTrigger} /> : null}
    </>
  );
}

function FindingCards({ findings, onAction, deployment, context, busy, stale, inspectionScope }: {
  readonly findings: readonly Finding[];
  readonly onAction: (action: Action, trigger?: HTMLButtonElement) => void;
  readonly deployment?: DiscoveredDeploymentView;
  readonly context?: AccountContext;
  readonly busy?: string;
  readonly stale?: boolean;
  readonly inspectionScope?: DeploymentScope;
}) {
  const inspectionIdentity = JSON.stringify({
    repository: inspectionScope?.repository, generation: inspectionScope?.generation,
    profile: inspectionScope?.profile, selectedProfile: context?.profile, caller: context?.arn,
    mode: deployment?.mode, deployment: deployment?.name, account: deployment?.account, region: deployment?.region,
    expectedAccount: inspectionScope?.account, expectedRegion: inspectionScope?.region,
  });
  return (
    <>
      {findings.map((finding) => finding.code === "DEPLOYED" && deployment ? (
        <DeployedCard key={`${finding.code}-${inspectionIdentity}`} finding={finding} deployment={deployment} context={context} busy={busy} stale={stale} onAction={onAction} inspectionScope={inspectionScope} />
      ) : (
        <article
          key={`${finding.code}-${finding.actions.find(action => action.plan)?.plan ?? finding.title}`}
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
            {finding.actions.map((action) => (
              <ActionButton
                key={`${action.id}-${action.plan ?? ""}`}
                action={action}
                onAction={onAction}
                compact
              />
            ))}
          </div>
        </article>
      ))}
    </>
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
  readonly earlierFindings?: readonly Finding[];
  readonly events: readonly StackEventView[];
  readonly drift?: DriftView | null;
  readonly onAction: (action: Action, trigger?: HTMLButtonElement) => void;
  readonly machine?: ReactNode;
  readonly notice?: ReactNode;
  readonly actions?: ReactNode;
  readonly busy?: string;
  readonly deploymentStale?: boolean;
  readonly inspectionScope?: DeploymentScope;
}) {
  const { row, context, status, record } = props;
  const authenticationFinding = props.findings.find((finding) => finding.code === "SIGNED_OUT");
  const deployment = status ? status.detail : row.deployment;
  const findings = props.findings.filter((finding) => finding !== authenticationFinding);
  // Read errors explain why current status is unavailable, but do not erase the
  // last exact-destination deployment evidence retained by the shared observer.
  if (props.deploymentStale && deployment?.state.kind === "ready" && !findings.some(finding => finding.code === "DEPLOYED")) {
    findings.push({ code: "DEPLOYED", severity: "info", scope: "aws", title: `Deployed · ${deployment.stacks.length} stack${deployment.stacks.length === 1 ? "" : "s"}`, actions: [] });
  }
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
          {props.actions}
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
            <FindingCards findings={findings} onAction={props.onAction} deployment={deployment} context={context} busy={props.busy} stale={props.deploymentStale} inspectionScope={props.inspectionScope} />
          </section>
        ) : null}

        {props.earlierFindings?.length ? (
          <details className="grid min-w-0 gap-2" aria-label="Earlier plans">
            <summary className="min-h-8 cursor-pointer py-1 text-caption text-graphite">Earlier plans ({props.earlierFindings.length})</summary>
            <p className={documentSupportClasses}>Saved for history and recovery. Reviewing an earlier plan uses its saved templates and assets.</p>
            <div className="mt-2 grid gap-2"><FindingCards findings={props.earlierFindings} onAction={props.onAction} /></div>
          </details>
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
      </section>
    </div>
  );
}
