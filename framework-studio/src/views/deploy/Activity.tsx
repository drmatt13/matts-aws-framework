import { cx } from "../../ui/classes";
import { buttonClasses } from "../../ui/Button";

import { logClasses } from "./DeployUI";

import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  LoaderCircle,
  Minus,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { JobView } from "../../../shared/deploy";
import { useJobLog } from "../../deploy/live";
import { relativeTime } from "./format";

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

function StepIcon({ status }: { readonly status: string }) {
  if (status === "done") return <Check size={13} aria-label="done" />;
  if (status === "running")
    return (
      <LoaderCircle
        size={13}
        className="animate-spin motion-reduce:animate-none"
        aria-label="running"
      />
    );
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
  const running = props.jobs.filter(
    (entry) =>
      entry.status === "running" && entry.kind !== "local-watch" && entry.kind !== "local-client",
  );
  const headline = running[0] ?? job;

  return (
    <section className="min-h-0 min-w-0 border-t border-rule-strong bg-sheet" aria-label="Activity">
      <button
        className="flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-2 text-left text-inherit hover:bg-wash"
        onClick={props.onToggle}
        aria-expanded={props.open}
      >
        <strong className="flex-none">Activity</strong>
        {headline ? (
          <span
            className={cx(
              "block min-w-0 items-center gap-[6px] overflow-hidden text-step-minus1 text-ellipsis whitespace-nowrap",
              headline.status === "failed" && "text-refuse",
            )}
          >
            {headline.status === "running" ? (
              <LoaderCircle
                size={13}
                className="mr-1.5 animate-spin align-[-2px] motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            {headline.title}
            {headline.steps?.length ? (
              <span className="text-graphite">
                {" "}
                ·{" "}
                {headline.steps
                  .map((step) => step.label)
                  .find((_label, index) => headline.steps![index]!.status === "running") ??
                  STATUS_LABEL[headline.status]}
              </span>
            ) : null}
            {headline.summary && headline.status !== "running" ? (
              <span className="text-graphite"> · {headline.summary}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-graphite">Nothing has run yet.</span>
        )}
        <span className="flex-1" />
        {props.open ? (
          <ChevronDown size={15} className="flex-none" aria-hidden />
        ) : (
          <ChevronUp size={15} className="flex-none" aria-hidden />
        )}
      </button>
      {props.open ? (
        <div className="grid h-[min(340px,42vh)] grid-cols-[260px_minmax(0,1fr)] border-t border-rule vp-900:h-auto vp-900:grid-cols-1">
          <ul
            className="m-0 grid list-none content-start gap-1 overflow-auto border-r border-rule p-2 vp-900:max-h-40 vp-900:border-r-0 vp-900:border-b"
            aria-label="Operations"
          >
            {props.jobs.slice(0, 20).map((entry) => (
              <li key={entry.id}>
                <button
                  data-status={entry.status}
                  className={cx(
                    "group/job grid w-full cursor-pointer gap-1 rounded-sm border-0 px-3 py-2 text-left text-inherit hover:bg-wash",
                    entry.id === job?.id ? "bg-wash" : "bg-transparent",
                  )}
                  aria-current={entry.id === job?.id ? "true" : undefined}
                  onClick={() => props.onSelect(entry.id)}
                >
                  <span className="truncate text-step-minus1 font-medium">{entry.title}</span>
                  <span className="text-meta text-graphite group-data-[status=running]/job:text-local group-data-[status=failed]/job:text-refuse">
                    {STATUS_LABEL[entry.status]} · {relativeTime(entry.endedAt ?? entry.startedAt)}
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
                        ? "text-local"
                        : job.status === "succeeded"
                          ? "text-accept"
                          : job.status === "failed"
                            ? "text-refuse"
                            : "text-graphite",
                    )}
                  >
                    {STATUS_LABEL[job.status]}
                  </span>
                  {job.summary ? (
                    <p className="mt-1 mb-0 text-caption text-graphite">{job.summary}</p>
                  ) : null}
                </div>
                {job.status === "running" ? (
                  <button
                    className={buttonClasses({ variant: "quiet", size: "regular" })}
                    onClick={() => props.onCancel(job.id)}
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
              {job.steps?.length ? (
                <ol className="m-0 flex flex-none list-none flex-wrap gap-x-4 gap-y-1 px-4 pt-0 pb-2 text-step-minus1 text-graphite">
                  {job.steps.map((step, index) => (
                    <li
                      key={index}
                      className={cx(
                        "inline-flex items-center gap-1",
                        step.status === "running"
                          ? "text-local"
                          : step.status === "done"
                            ? "text-accept"
                            : step.status === "failed"
                              ? "text-refuse"
                              : undefined,
                      )}
                    >
                      <StepIcon status={step.status} /> {step.label}
                    </li>
                  ))}
                </ol>
              ) : null}
              <pre
                ref={log}
                className={cx(logClasses, "min-h-0 flex-1")}
                tabIndex={0}
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
            <p className="text-graphite p-4">
              Operations you start here appear with their steps and log.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
