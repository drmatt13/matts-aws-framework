import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { logClasses } from "./DeployUI";

import {
  Check,
  ChevronUp,
  CircleDot,
  LoaderCircle,
  ListTodo,
  Minus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DockerPresence } from "../../../shared/machine";
import type { JobView } from "../../../shared/operations";
import { useOperationLog } from "../../operations/live";
import { Link } from "@tanstack/react-router";
import { DockerStatus } from "./DockerStatus";
import { relativeTime } from "./format";
import { useActivityResize } from "./useActivityResize";

/** stderr lines that read as a failure, rather than one of the notices tools write there. */
const FAILURE =
  /\b(error|failed|failure|refus\w*|denied|cannot|could not|unable|not allowed|exception)\b|✖|❌/i;

const STATUS_LABEL: Readonly<Record<JobView["status"], string>> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

function statusLabel(job: JobView): string {
  if (job.outcome === "uncertain") return "Outcome uncertain";
  if (job.outcome === "unverified") return "Unverified";
  if (job.cancelRequested && job.status === "running") return "Stopping";
  if (job.execution === "accepted") return "Accepted";
  if (job.execution === "dispatching") return "Starting";
  return STATUS_LABEL[job.status];
}

/** A persistent process stays running after startup; it is not unfinished work. */
function isRunningProcess(job: JobView): boolean {
  return (job.kind === "local-watch" || job.kind === "local-client") && job.status === "running"
    && !job.cancelRequested && !job.observationProblem
    && (job.execution === undefined || job.execution === "running")
    && job.outcome !== "uncertain" && job.outcome !== "unverified";
}

function runningColor(job: JobView): string {
  if (job.observationProblem || job.outcome === "uncertain" || job.outcome === "unverified")
    return "text-[color-mix(in_srgb,var(--local)_70%,var(--ink))]";
  return isRunningProcess(job) ? "text-accept" : "text-graphite";
}

function RunningIcon({ job, className, decorative = false }: {
  readonly job: JobView;
  readonly className?: string;
  readonly decorative?: boolean;
}) {
  const steady = isRunningProcess(job);
  const busy = job.status === "running" && !steady && !job.observationProblem
    && job.outcome !== "uncertain" && job.outcome !== "unverified";
  const Icon = busy ? LoaderCircle : CircleDot;
  return <Icon size={13} className={cx(className, steady && "text-accept", busy && "animate-spin motion-reduce:animate-none")}
    aria-hidden={decorative || undefined} aria-label={decorative ? undefined : "running"} />;
}

/** A startup records the past; only the live status says whether Docker is running now. */
function summary(job: JobView, docker: DockerPresence): string | undefined {
  if (job.kind !== "docker-start" || job.status !== "succeeded") return job.summary;
  return docker.engine === "stopped" ? "Docker has since stopped." : undefined;
}

/** The Docker status covers startups, except the latest failure explaining why Docker is still off. */
function coveredByDockerStatus(job: JobView, jobs: readonly JobView[], docker: DockerPresence): boolean {
  if (job.kind !== "docker-start") return false;
  const unresolved = (job.status === "failed" || job.status === "interrupted") && docker.engine !== "running";
  return !unresolved || job !== jobs.find((entry) => entry.kind === "docker-start");
}

function StepIcon({ status, job }: { readonly status: string; readonly job: JobView }) {
  if (status === "done") return <Check size={13} aria-label="done" />;
  if (status === "running") return <RunningIcon job={job} />;
  if (status === "failed") return <X size={13} aria-label="failed" />;
  if (status === "skipped") return <Minus size={13} aria-label="skipped" />;
  return <CircleDot size={13} aria-label="pending" />;
}

/**
 * What Studio is doing and has done: each operation's steps and its live log,
 * replayed from where the page last saw it. Long-running local processes (the
 * watch, the web client) are jobs too, until stopped.
 */
export function Activity(props: {
  readonly jobs: readonly JobView[];
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onCancel: (id: string) => void;
  readonly loading?: boolean;
  readonly problem?: string;
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
  readonly actionError?: string;
  readonly docker: DockerPresence;
  readonly onStartDocker: () => void;
  readonly onCheckDocker: () => Promise<unknown>;
  readonly mode?: "activity" | "agent";
  readonly onModeChange?: (mode: "activity" | "agent") => void;
  readonly agent?: ReactNode;
  /** The open Agent panel's own views, shown in the bar in place of its summary. */
  readonly agentViews?: ReactNode;
  readonly agentSummary?: string;
  readonly agentPending?: boolean;
  readonly agentUnread?: boolean;
}) {
  const mode = props.mode ?? "activity";
  const drawer = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const resize = useActivityResize({ drawer, bar, open: props.open, onExpand: props.onToggle, onCollapse: () => {
    props.onToggle();
    toggle.current?.focus();
  } });
  const motionRoot = useRef<HTMLElement | undefined>(undefined);
  const [revealed, setRevealed] = useState(props.open);
  const visible = props.open || revealed;
  // Keep contents mounted for the closing motion, but remove their focus/accessibility
  // surface immediately. Reduced motion settles both layout and visibility together.
  useLayoutEffect(() => {
    if (props.open) { setRevealed(true); return; }
    if (!window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRevealed(false);
      return;
    }
    const timer = window.setTimeout(() => setRevealed(false), 320);
    return () => window.clearTimeout(timer);
  }, [props.open]);
  useLayoutEffect(() => {
    const element = drawer.current;
    if (!element) return;
    const root = element.closest<HTMLElement>('[data-ui="shell"]') ?? element;
    motionRoot.current = root;
    const previous = root.style.getPropertyValue("--activity-drawer-visible");
    return () => {
      if (previous) root.style.setProperty("--activity-drawer-visible", previous);
      else root.style.removeProperty("--activity-drawer-visible");
      motionRoot.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    const root = motionRoot.current;
    if (!root) return;
    const finish = (event: TransitionEvent) => {
      if (event.target === root && event.propertyName === "--activity-drawer-visible" && !props.open) setRevealed(false);
    };
    root.addEventListener("transitionend", finish);
    // One typed CSS length animates on the common ancestor. The drawer and map
    // inherit the same value in the same frame; no resize observer can lag behind.
    root.style.setProperty("--activity-drawer-visible", props.open ? "var(--activity-drawer)" : "0px");
    return () => root.removeEventListener("transitionend", finish);
  }, [props.open]);
  const job = props.jobs.find((entry) => entry.id === props.selected) ?? props.jobs[0];
  const replay = useOperationLog(props.open ? job?.id : undefined, job?.lastSeq);
  const lines = replay.lines;
  const log = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = log.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines.length, job?.id]);
  const running = props.jobs.filter(
    (entry) =>
      entry.status === "running" && entry.kind !== "local-watch" && entry.kind !== "local-client",
  );
  const headlines = (entry: JobView) => !coveredByDockerStatus(entry, props.jobs, props.docker);
  const headline = running.find(headlines) ?? (job && headlines(job) ? job : props.jobs.find(headlines));
  const agentViews = mode === "agent" && props.open ? props.agentViews : undefined;

  return (
    <div data-ui="activity-slot" className="h-[min(calc(var(--activity-drawer-visible)+var(--activity-bar-height,40px)+1px),var(--activity-slot-max,100dvh))] min-h-0 min-w-0">
    <section className="absolute inset-x-0 bottom-0 z-10 min-h-0 min-w-0 border-t border-rule-strong bg-sheet" aria-label="Activity" onKeyDown={event => {
      if (event.key === "Escape" && props.open && props.agent) {
        event.preventDefault(); props.onToggle();
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)?.focus();
      }
    }}>
      {props.open ? <div role="separator" aria-label="Resize bottom panel" aria-orientation="horizontal"
        aria-controls="studio-activity-drawer" aria-valuemin={resize.min} aria-valuemax={resize.max} aria-valuenow={Math.round(resize.height)}
        aria-valuetext={`${Math.round(resize.height)} pixels`} tabIndex={0}
        title="Drag to resize the bottom panel, or drag below its minimum height to close. Use Up and Down arrow keys when focused."
        className="absolute -top-1 left-0 z-10 h-2 w-full cursor-row-resize touch-none select-none hover:bg-dev/30 focus-visible:bg-dev/30 focus-visible:-outline-offset-2"
        {...resize.pointer} onKeyDown={event => { if (resize.resizeByKey(event.key)) event.preventDefault(); }} /> : null}
      {/* Modes reveal their panel; the chevron toggles it. Docker remains independent. */}
      <div ref={bar} data-ui="activity-bar" {...resize.pointer} className={cx("grid min-w-0 items-center gap-x-3", !props.open && "cursor-row-resize touch-none select-none", props.agent ? "grid-cols-[auto_minmax(0,1fr)_auto_32px] pl-3 vp-480:pl-2" : "grid-cols-[minmax(0,1fr)_auto_auto] vp-480:grid-cols-[minmax(0,1fr)_auto]")}>
        {!props.open ? <span aria-hidden className="absolute -top-1 left-0 z-10 h-2 w-full hover:bg-dev/30" /> : null}
        {props.agent ? <div className="col-start-1 row-start-1 flex items-center gap-1 py-1" role="tablist" aria-label="Panel mode"
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "activity" : event.key === "End" ? "agent" : mode === "activity" ? "agent" : "activity";
            props.onModeChange?.(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
          }}>
          {(["activity", "agent"] as const).map(value => <button key={value} type="button" role="tab" data-mode={value}
            id={`studio-${value}-tab`} aria-label={value === "activity" ? "Activity" : "Agent"} aria-controls={`studio-${value}-panel`} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1}
            onClick={() => { props.onModeChange?.(value); if (!props.open) props.onToggle(); }}
            className={cx("inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border px-3 py-1 text-label font-medium transition-colors vp-480:px-2", mode === value ? "border-rule-strong bg-wash text-ink" : "border-transparent bg-transparent text-graphite hover:bg-wash hover:text-ink")}>
            {/* The agent's state takes the icon's place and corner, so the views beside it never shift. */}
            {value === "activity" ? <ListTodo size={14} aria-hidden /> : props.agentPending ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-label="Thinking" />
              : <span className="relative flex"><Sparkles size={14} aria-hidden />{props.agentUnread ? <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accept" aria-label="New reply" /> : null}</span>}
            {value === "activity" ? "Activity" : "Agent"}
            {value === "activity" && running.length ? <span className="rounded-sm bg-paper px-1.5 text-meta" aria-label={`${running.length} running`}>{running.length}</span> : null}
          </button>)}
        </div> : null}
        {agentViews ? <div className="relative z-1 col-start-2 row-start-1 flex items-center gap-3 justify-self-start vp-480:col-start-1 vp-480:row-start-2 vp-480:pb-1">
          <span aria-hidden className="h-4 w-px bg-rule-strong vp-480:hidden" />
          {agentViews}
        </div> : null}
        <button
          ref={toggle}
          className={cx("row-start-1 grid min-h-9 min-w-0 cursor-pointer grid-cols-subgrid items-center border-0 bg-transparent py-2 text-left text-inherit hover:bg-wash", props.agent ? "col-start-2 -col-end-1 pr-3" : "col-span-full px-4")}
          onClick={props.onToggle}
          aria-expanded={props.open}
          aria-controls="studio-activity-drawer"
          aria-label={props.agent ? `${mode === "activity" ? "Activity" : "Agent"}: ${props.open ? "collapse" : "expand"} panel` : undefined}
          title={props.open ? undefined : "Click to expand or drag up to open the bottom panel."}
        >
          <span className={cx("col-start-1 flex min-w-0 items-center gap-3", !!props.agent && "pl-3 vp-480:invisible")}>
            {!props.agent ? <strong className="flex-none">Activity</strong> : null}
            {agentViews ? null : mode === "agent" ? <span className="truncate text-caption text-graphite">{props.agentSummary ?? "Ask a question"}</span> : headline ? (
              <span
                className={cx(
                  "block min-w-0 items-center gap-[6px] overflow-hidden text-step-minus1 text-ellipsis whitespace-nowrap",
                  headline.status === "failed" && "text-refuse",
                )}
              >
                {headline.status === "running" ? (
                  <RunningIcon job={headline} className="mr-1.5 align-[-2px]" decorative />
                ) : null}
                {headline.title}
                {headline.steps?.length ? (
                  <span className="text-graphite">
                    {" "}
                    ·{" "}
                    {headline.steps
                      .map((step) => step.label)
                      .find((_label, index) => headline.steps![index]!.status === "running") ??
                      statusLabel(headline)}
                  </span>
                ) : null}
                {summary(headline, props.docker) && headline.status !== "running" ? (
                  <span className="text-graphite"> · {summary(headline, props.docker)}</span>
                ) : null}
              </span>
            ) : props.jobs.length ? null : (
              <span className="text-graphite">{props.problem ? "Activity unavailable" : props.loading ? "Reading activity…" : "Nothing has run yet."}</span>
            )}
          </span>
          <ChevronUp size={15} className={cx("col-start-3 flex-none transition-transform duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", props.open && "rotate-180", !props.agent && "vp-480:col-start-2")} aria-hidden />
        </button>
        <DockerStatus
          presence={props.docker}
          onStart={props.onStartDocker}
          onCheck={props.onCheckDocker}
          className={cx("row-start-1 vp-480:row-start-2", !props.agent ? "col-start-2 vp-480:col-span-full vp-480:col-start-1 vp-480:px-2 vp-480:pb-2"
            // One row height whether or not the views share it, so changing mode moves nothing.
            : cx("col-start-3 vp-480:min-h-9 vp-480:pb-1", agentViews ? "vp-480:col-span-3 vp-480:col-start-2 vp-480:justify-end vp-480:pr-2" : "vp-480:col-span-full vp-480:col-start-1 vp-480:px-2"))}
        />
      </div>
      <div ref={drawer} id="studio-activity-drawer" data-ui={visible ? "activity-drawer" : undefined}
        aria-hidden={!props.open} inert={!props.open}
        className="h-(--activity-drawer-visible) min-h-0 overflow-hidden">
        {/* Fixed-height contents slide as a unit instead of squeezing during motion. */}
        <div hidden={!visible} className="flex h-(--activity-drawer) min-h-0 flex-col border-t border-rule">
          {props.agent ? <div id="studio-agent-panel" role="tabpanel" aria-labelledby="studio-agent-tab" hidden={mode !== "agent"} className="flex min-h-0 flex-1 flex-col">{props.agent}</div> : null}
          <div id={props.agent ? "studio-activity-panel" : undefined} role={props.agent ? "tabpanel" : undefined} aria-labelledby={props.agent ? "studio-activity-tab" : undefined} hidden={mode !== "activity"} tabIndex={0} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {props.problem ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-2" role="alert">
              <span>{props.problem}</span>
              <button className={buttonClasses({ variant: "quiet", size: "compact" })}
                disabled={props.retrying} onClick={props.onRetry}>Retry activity</button>
            </div>
          ) : null}
          {props.actionError ? (
            <p className="m-0 border-t border-rule px-4 py-2 text-refuse" role="alert">{props.actionError}</p>
          ) : null}
          {props.docker.detail ? (
            <p className="m-0 border-t border-rule px-4 py-2 text-caption text-graphite wrap-anywhere">{props.docker.detail}</p>
          ) : null}
          <div className="grid min-h-30 flex-1 grid-cols-[260px_minmax(0,1fr)] border-t border-rule vp-900:grid-cols-1 vp-900:grid-rows-[minmax(0,1fr)_minmax(0,2fr)]">
            <ul
              className="m-0 grid list-none content-start gap-1 overflow-auto border-r border-rule p-2 vp-900:max-h-40 vp-900:border-r-0 vp-900:border-b"
              aria-label="Operations"
            >
              {props.jobs.slice(0, 20).map((entry) => (
                <li key={entry.id}>
                  <button
                    data-status={entry.status}
                    className={cx(
                      "grid w-full cursor-pointer gap-1 rounded-sm border-0 px-3 py-2 text-left text-inherit hover:bg-wash",
                      entry.id === job?.id ? "bg-wash" : "bg-transparent",
                    )}
                    aria-current={entry.id === job?.id ? "true" : undefined}
                    onClick={() => props.onSelect(entry.id)}
                  >
                    <span className="truncate text-step-minus1 font-medium">{entry.title}</span>
                    <span className={cx("text-meta", entry.status === "running" ? runningColor(entry)
                      : entry.status === "failed" ? "text-refuse" : "text-[color-mix(in_srgb,var(--graphite)_85%,var(--ink))]")}>
                      {statusLabel(entry)} · {relativeTime(entry.endedAt ?? entry.startedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {job ? (
              <div className="flex min-h-0 min-w-0 flex-col">
                <header className="flex flex-none items-start justify-between gap-3 px-4 pt-3 pb-2 wrap-anywhere vp-480:flex-wrap">
                  <div className="min-w-0">
                    <strong>{job.title}</strong>
                    <span
                      className={cx(
                        "ml-2 text-meta tracking-[0.06em] uppercase",
                        job.status === "running"
                          ? runningColor(job)
                          : job.status === "succeeded" && job.outcome !== "unverified" && job.outcome !== "uncertain"
                            ? "text-accept"
                            : job.status === "failed"
                              ? "text-refuse"
                              : "text-graphite",
                      )}
                    >
                      {statusLabel(job)}
                    </span>
                    {job.origin ? <Link to={job.origin} className={buttonClasses({ variant: "link", className: "mt-1 block w-fit text-caption" })}>Open workspace</Link> : null}
                    {summary(job, props.docker) ? (
                      <p className="mt-1 mb-0 text-caption text-graphite">{summary(job, props.docker)}</p>
                    ) : null}
                  </div>
                  {job.status === "running" && job.execution !== "lost" ? (
                    <button
                      className={buttonClasses({ variant: "quiet", size: "regular" })}
                      onClick={() => props.onCancel(job.id)}
                      disabled={job.cancelRequested}
                      title={
                        job.kind.startsWith("deploy") || job.kind === "destroy"
                          ? "Stops the command. A CloudFormation operation already started continues in AWS."
                          : undefined
                      }
                    >
                      <Square size={12} aria-hidden />{" "}
                      {job.kind.startsWith("deploy") || job.kind === "destroy"
                        ? "Stop command; AWS may continue"
                        : job.kind === "local-watch" || job.kind === "local-client"
                          ? "Stop"
                          : "Cancel"}
                    </button>
                  ) : null}
                </header>
                {job.observationProblem ? <p role="status" className="m-0 px-4 pb-2 text-caption text-graphite">{job.observationProblem}</p> : null}
                {job.recovery ? <p role="status" className="m-0 px-4 pb-2 text-caption text-graphite">{job.recovery}</p> : null}
                {replay.problem ? <div role="alert" className="flex items-center justify-between gap-3 px-4 pb-2 text-caption">
                  <span>{replay.problem}</span>
                  <button className={buttonClasses({ variant: "quiet", size: "compact" })} disabled={replay.retrying} onClick={replay.retry}>Retry log</button>
                </div> : null}
                {job.steps?.length ? (
                  <ol className="m-0 flex flex-none list-none flex-wrap gap-x-4 gap-y-1 px-4 pt-0 pb-2 text-step-minus1 text-graphite">
                    {job.steps.map((step, index) => (
                      <li
                        key={index}
                        className={cx(
                          "inline-flex items-center gap-1",
                          step.status === "running"
                            ? runningColor(job)
                            : step.status === "done"
                              ? "text-accept"
                              : step.status === "failed"
                                ? "text-refuse"
                                : undefined,
                        )}
                      >
                        <StepIcon status={step.status} job={job} /> {step.label}
                      </li>
                    ))}
                  </ol>
                ) : null}
                <pre
                  ref={log}
                  className={cx(logClasses, "min-h-0 flex-1")}
                  tabIndex={0}
                  role="log"
                  aria-live="off"
                  aria-label="Log"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    pinned.current =
                      element.scrollHeight - element.scrollTop - element.clientHeight < 24;
                  }}
                >
                  {lines.map((line) => (
                    <span
                      key={line.seq}
                      className={
                        line.stream === "err"
                          ? FAILURE.test(line.text)
                            ? "text-refuse"
                            : "text-[color-mix(in_srgb,var(--local)_70%,var(--graphite))]"
                          : line.stream === "info"
                            ? "text-graphite"
                            : undefined
                      }
                    >
                      {line.text}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              </div>
            ) : (
              <p className="text-graphite p-4" role={props.loading ? "status" : undefined}>
                {props.loading ? "Reading activity…" : props.problem ? "Restore the connection to read recorded operations." : "Operations you start in Studio appear with their steps and log."}
              </p>
            )}
          </div>
          </div>
        </div>
      </div>
    </section>
    </div>
  );
}
