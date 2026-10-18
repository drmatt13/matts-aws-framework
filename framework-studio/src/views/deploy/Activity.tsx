import { Check, ChevronDown, ChevronUp, CircleDot, LoaderCircle, Minus, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { JobView } from "../../../shared/deploy";
import { useJobLog } from "../../deploy/api";
import { relativeTime } from "./format";

/** stderr lines that read as a failure, rather than one of the notices tools write there. */
const FAILURE = /\b(error|failed|failure|refus\w*|denied|cannot|could not|unable|not allowed|exception)\b|✖|❌/i;

const STATUS_LABEL: Readonly<Record<JobView["status"], string>> = {
  running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted",
};

function StepIcon({ status }: { readonly status: string }) {
  if (status === "done") return <Check size={13} aria-label="done" />;
  if (status === "running") return <LoaderCircle size={13} className="spin" aria-label="running" />;
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
}) {
  const job = props.jobs.find((entry) => entry.id === props.selected) ?? props.jobs[0];
  const lines = useJobLog(props.open ? job?.id : undefined);
  const log = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = log.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines.length, job?.id]);
  const running = props.jobs.filter((entry) => entry.status === "running" && entry.kind !== "local-watch" && entry.kind !== "local-client");
  const headline = running[0] ?? job;

  return (
    <section className={`deploy-activity ${props.open ? "open" : ""}`} aria-label="Activity">
      <button className="activity-bar" onClick={props.onToggle} aria-expanded={props.open}>
        <strong>Activity</strong>
        {headline ? (
          <span className={`activity-headline ${headline.status}`}>
            {headline.status === "running" ? <LoaderCircle size={13} className="spin" aria-hidden /> : null}
            {headline.title}
            {headline.steps?.length ? <span className="muted"> · {headline.steps.map((step) => step.label).find((_label, index) => headline.steps![index]!.status === "running") ?? STATUS_LABEL[headline.status]}</span> : null}
            {headline.summary && headline.status !== "running" ? <span className="muted"> · {headline.summary}</span> : null}
          </span>
        ) : <span className="muted">Nothing has run yet.</span>}
        <span className="spacer" />
        {props.open ? <ChevronDown size={15} aria-hidden /> : <ChevronUp size={15} aria-hidden />}
      </button>
      {props.open ? (
        <div className="activity-body">
          <ul className="job-list" aria-label="Operations">
            {props.jobs.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <button className={`job ${entry.status} ${entry.id === job?.id ? "selected" : ""}`} onClick={() => props.onSelect(entry.id)}>
                  <span className="job-title">{entry.title}</span>
                  <span className="job-meta">{STATUS_LABEL[entry.status]} · {relativeTime(entry.endedAt ?? entry.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {job ? (
            <div className="job-detail">
              <header>
                <div>
                  <strong>{job.title}</strong>
                  <span className={`job-status ${job.status}`}>{STATUS_LABEL[job.status]}</span>
                  {job.summary ? <p className="small">{job.summary}</p> : null}
                </div>
                {job.status === "running" ? (
                  <button className="quiet" onClick={() => props.onCancel(job.id)} title={job.kind.startsWith("deploy") || job.kind === "destroy" ? "Stops the command. A CloudFormation operation already started continues in AWS." : undefined}>
                    <Square size={12} aria-hidden /> {job.kind === "local-watch" || job.kind === "local-client" ? "Stop" : "Cancel"}
                  </button>
                ) : null}
              </header>
              {job.steps?.length ? (
                <ol className="job-steps">
                  {job.steps.map((step, index) => <li key={index} className={step.status}><StepIcon status={step.status} /> {step.label}</li>)}
                </ol>
              ) : null}
              <pre
                ref={log}
                className="job-log"
                aria-label="Log"
                onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}
              >
                {lines.map((line) => <span key={line.seq} className={`line ${line.stream === "err" && !FAILURE.test(line.text) ? "note" : line.stream}`}>{line.text}{"\n"}</span>)}
              </pre>
            </div>
          ) : <p className="muted job-empty">Operations you start here appear with their steps and log.</p>}
        </div>
      ) : null}
    </section>
  );
}
