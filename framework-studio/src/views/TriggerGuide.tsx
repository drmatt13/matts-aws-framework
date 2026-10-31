import { InspectorSummary } from "./InspectorUI";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { ArrowLeft, Check, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { triggerGuide, triggerGuideSummary } from "../../shared/trigger-guide";
import { ICONS, iconUrl, type IconKey } from "../icons";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";
import { Written } from "./Written";

const SERVICE_ICONS: Readonly<Record<string, IconKey>> = {
  cognito: "userpool",
  eventbridge: "bus",
  sqs: "queue",
  sns: "topic",
  dynamodb: "table",
  s3: "bucket",
};
export const iconOf = (kind: string): IconKey => SERVICE_ICONS[kind] ?? "event";

function CopyCode({ code, label }: { readonly code: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="relative" data-slot="guide-code">
      <pre className="m-0 rounded-md bg-wash px-2.5 pt-8 pb-2 font-mono text-meta whitespace-pre-wrap wrap-anywhere">
        <code>{code}</code>
      </pre>
      <button
        className={cx(
          buttonClasses({ variant: "neutral", size: "custom" }),
          "absolute top-1 right-1 min-h-8 px-2 py-0.5 text-caption",
        )}
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => setCopied(true),
            () => undefined,
          );
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Step one of adding a trigger from an event Lambda: every service that can
 * invoke it, then that service's stack resources. Only resources that work for
 * this Lambda can be chosen; the rest say why, beside their source.
 */
export function TriggerSourcePicker(props: {
  readonly event: string;
  readonly kind?: string;
  readonly onKind: (kind: string | undefined) => void;
  readonly onChoose: (resource: string, adapter: string) => void;
}) {
  const { snapshot, index } = useStudio();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [props.kind]);
  const summary = triggerGuideSummary(snapshot, props.event);
  const guide = props.kind ? triggerGuide(snapshot, props.kind, props.event) : undefined;
  if (!guide)
    return (
      <div
        ref={root}
        className="m-0 grid gap-2 rounded-md border border-rule bg-paper p-3"
        role="region"
        aria-labelledby={`${id}-title`}
        data-slot="trigger-guide"
      >
        <h4 className="m-0 flex-1 text-step0 text-balance" id={`${id}-title`}>
          What should invoke {props.event}?
        </h4>
        <div className="grid grid-cols-3 gap-2" data-slot="trigger-guide-grid">
          {summary.map((item) => (
            <button
              key={item.kind}
              className={cx(
                "hover:border-ink focus-visible:border-ink grid justify-items-center [gap:3px] border border-rule rounded-md cursor-pointer text-step-minus1 [min-height:82px] p-[10px_6px] bg-sheet",
                item.reason ? "opacity-55" : "",
              )}
              aria-label={`${item.label}: ${item.reason ? "unavailable" : item.resourceless ? "no resource needed" : `${item.usable} compatible`}`}
              title={item.reason}
              onClick={() =>
                item.resourceless && !item.reason
                  ? props.onChoose("", item.kind)
                  : props.onKind(item.kind)
              }
              data-slot="trigger-guide-service"
            >
              <img className="size-6" src={iconUrl(iconOf(item.kind))} alt="" aria-hidden />
              <span>{item.label}</span>
              <span
                className={cx("font-mono text-meta", item.usable ? "text-accept" : "text-faint")}
                data-slot="trigger-guide-count"
              >
                {item.reason ? "n/a" : item.resourceless ? "ready" : item.usable || "none"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  const reason = summary.find((item) => item.kind === guide.adapter.kind)?.reason;
  const usable = guide.candidates.filter((item) => !item.reason);
  return (
    <div
      ref={root}
      className="m-0 grid gap-2 rounded-md border border-rule bg-paper p-3"
      role="region"
      aria-labelledby={`${id}-title`}
      data-slot="trigger-guide"
    >
      <div className="flex items-center gap-1.5" data-slot="trigger-guide-heading">
        <button
          className={iconButtonClasses()}
          aria-label="All services"
          title="All services"
          onClick={() => props.onKind(undefined)}
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <h4 className="m-0 flex-1 text-step0 text-balance" id={`${id}-title`}>
          Triggered by {guide.adapter.label}
        </h4>
      </div>
      <p className="mt-0 mb-2 text-caption text-graphite">{guide.adapter.delivery}.</p>
      {reason ? (
        <p className="mt-0 mb-2 text-refuse wrap-anywhere text-caption" role="note">
          {reason}
        </p>
      ) : null}
      {guide.candidates.length ? (
        <>
          <h5 className="mt-1 mb-0 text-step-minus1 uppercase tracking-[.04em] text-graphite text-balance">
            {usable.length ? "Choose a resource" : "Your stack resources"}
          </h5>
          <ul className="m-0 grid list-none gap-2 p-0" data-slot="trigger-guide-candidates">
            {guide.candidates.map((item) => (
              <li key={item.resource} className="border-b border-rule py-2.5">
                <div className="flex items-center gap-1.5" data-slot="trigger-guide-candidate">
                  <img
                    className="size-4.5"
                    src={iconUrl(iconOf(guide.adapter.kind))}
                    alt=""
                    aria-hidden
                    title={ICONS[iconOf(guide.adapter.kind)][1]}
                  />
                  <span className="flex-1 text-caption wrap-anywhere">
                    <strong className={item.reason ? "text-graphite" : undefined}>
                      {item.name}
                    </strong>{" "}
                    <span className="text-caption text-graphite">{titleOf(index, item.stack)}</span>
                  </span>
                  {!item.reason ? (
                    <button
                      className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
                      aria-label={`Use ${item.name}`}
                      onClick={() => props.onChoose(item.resource, guide.adapter.kind)}
                    >
                      Use
                    </button>
                  ) : null}
                </div>
                {item.reason ? (
                  <p className="mt-[2px] mb-0 ml-6 text-caption text-refuse wrap-anywhere">
                    {item.reason}
                  </p>
                ) : item.warning ? (
                  <p
                    className="text-caption text-local flex items-center gap-1 m-[2px_0_0_24px]"
                    data-slot="trigger-warning"
                  >
                    <TriangleAlert size={12} aria-hidden /> {item.warning}
                  </p>
                ) : null}
                <Written className="ml-6" location={item.location} label="Declared in" />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-0 mb-2 text-caption text-graphite">
          No {guide.adapter.label} resource in your stacks yet. Add a public field like this to a
          stack:
        </p>
      )}
      <details className="text-caption" open={!guide.candidates.length}>
        <InspectorSummary className="cursor-pointer font-semibold">
          {guide.candidates.length
            ? `Add another ${guide.adapter.label} resource`
            : "Field snippet"}
        </InspectorSummary>
        <ul
          className="m-0 [padding-left:18px] grid [gap:3px] text-caption"
          data-slot="trigger-guide-rules"
        >
          {guide.requirements.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <CopyCode code={guide.snippet} label={`${guide.adapter.label} field snippet`} />
        <details className="text-caption">
          <InspectorSummary className="cursor-pointer font-semibold">
            Stack not in the resource catalog yet?
          </InspectorSummary>
          <CopyCode code={guide.catalogSnippet} label="catalog snippet" />
        </details>
      </details>
      <a className="text-caption" href={guide.adapter.guide.docs} target="_blank" rel="noreferrer">
        AWS documentation <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}
