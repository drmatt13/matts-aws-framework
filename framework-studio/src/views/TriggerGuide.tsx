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

const SERVICE_ICONS: Readonly<Record<string, IconKey>> = { cognito: "userpool", eventbridge: "bus", sqs: "queue", sns: "topic", dynamodb: "table", s3: "bucket" };
export const iconOf = (kind: string): IconKey => SERVICE_ICONS[kind] ?? "event";

function CopyCode({ code, label }: { readonly code: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <div className={"relative [&_pre]:m-0 [&_pre]:p-[32px_10px_var(--space-2)] [&_pre]:bg-wash [&_pre]:rounded-md [&_pre]:font-mono [&_pre]:text-meta [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_button]:absolute [&_button]:top-1 [&_button]:right-1 [&_button]:p-[2px_var(--space-2)] [&_button]:bg-sheet"} data-slot="guide-code">
    <pre><code>{code}</code></pre>
    <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}>
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? "Copied" : "Copy"}
    </button>
  </div>;
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
  useEffect(() => { root.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus(); }, [props.kind]);
  const summary = triggerGuideSummary(snapshot, props.event);
  const guide = props.kind ? triggerGuide(snapshot, props.kind, props.event) : undefined;
  if (!guide) return <div ref={root} className={"[&_h5]:m-[var(--space-1)_0_0] [&_h5]:text-step-minus1 [&_h5]:text-graphite [&_h5]:uppercase [&_h5]:[letter-spacing:.04em] [&_h4]:m-0 [&_h4]:text-step0 border border-rule rounded-md grid gap-2 p-3 m-0 bg-paper"} role="region" aria-labelledby={`${id}-title`} data-slot="trigger-guide">
    <h4 id={`${id}-title`}>What should invoke {props.event}?</h4>
    <div className={"grid grid-cols-3 gap-2"} data-slot="trigger-guide-grid">
      {summary.map((item) => <button key={item.kind} className={cx("hover:border-ink focus-visible:border-ink grid justify-items-center [gap:3px] border border-rule rounded-md cursor-pointer text-step-minus1 [min-height:82px] p-[10px_6px] bg-sheet [&_img]:w-6 [&_img]:h-6", item.reason ? "opacity-55" : "")} aria-label={`${item.label}: ${item.reason ? "unavailable" : item.resourceless ? "no resource needed" : `${item.usable} compatible`}`} title={item.reason}
        onClick={() => item.resourceless && !item.reason ? props.onChoose("", item.kind) : props.onKind(item.kind)} data-slot="trigger-guide-service">
        <img src={iconUrl(iconOf(item.kind))} alt="" aria-hidden />
        <span>{item.label}</span>
        <span className={cx("font-mono text-meta", item.usable ? "text-accept" : "text-faint")} data-slot="trigger-guide-count">{item.reason ? "n/a" : item.resourceless ? "ready" : item.usable || "none"}</span>
      </button>)}
    </div>
  </div>;
  const reason = summary.find((item) => item.kind === guide.adapter.kind)?.reason;
  const usable = guide.candidates.filter((item) => !item.reason);
  return <div ref={root} className={"[&_h5]:m-[var(--space-1)_0_0] [&_h5]:text-step-minus1 [&_h5]:text-graphite [&_h5]:uppercase [&_h5]:[letter-spacing:.04em] [&_h4]:m-0 [&_h4]:text-step0 border border-rule rounded-md grid gap-2 p-3 m-0 bg-paper"} role="region" aria-labelledby={`${id}-title`} data-slot="trigger-guide">
    <div className={"flex items-center [gap:6px] [&_h4]:m-0 [&_h4]:text-step0 [&_h4]:flex-1"} data-slot="trigger-guide-heading">
      <button className={iconButtonClasses()} aria-label="All services" title="All services" onClick={() => props.onKind(undefined)}><ArrowLeft size={16} aria-hidden /></button>
      <h4 id={`${id}-title`}>Triggered by {guide.adapter.label}</h4>
    </div>
    <p className={"text-caption text-graphite"}>{guide.adapter.delivery}.</p>
    {reason ? <p className={"text-refuse wrap-anywhere text-caption"} role="note">{reason}</p> : null}
    {guide.candidates.length ? <>
      <h5>{usable.length ? "Choose a resource" : "Your stack resources"}</h5>
      <ul className={"list-none m-0 p-0 grid gap-2 [&_[data-ui=written]]:ml-6 [&>li]:p-[10px_0] [&>li]:border-b [&>li]:border-rule"} data-slot="trigger-guide-candidates">
        {guide.candidates.map((item) => <li key={item.resource} className={item.reason ? "[&_strong]:text-graphite" : ""}>
          <div className={"flex items-center [gap:6px] [&_img]:w-4.5 [&_img]:h-4.5 [&>span]:flex-1 [&>span]:wrap-anywhere [&>span]:text-caption"} data-slot="trigger-guide-candidate">
            <img src={iconUrl(iconOf(guide.adapter.kind))} alt="" aria-hidden title={ICONS[iconOf(guide.adapter.kind)][1]} />
            <span><strong>{item.name}</strong> <span className={"text-caption text-graphite"}>{titleOf(index, item.stack)}</span></span>
            {!item.reason ? <button className={cx(buttonClasses({ variant: "quiet" }), "text-caption")} aria-label={`Use ${item.name}`} onClick={() => props.onChoose(item.resource, guide.adapter.kind)}>Use</button> : null}
          </div>
          {item.reason ? <p className="mt-[2px] mb-0 ml-6 text-caption text-refuse wrap-anywhere">{item.reason}</p> : item.warning ? <p className={"text-caption text-local flex items-center gap-1 m-[2px_0_0_24px]"} data-slot="trigger-warning"><TriangleAlert size={12} aria-hidden /> {item.warning}</p> : null}
          <Written location={item.location} label="Declared in" />
        </li>)}
      </ul>
    </> : <p className={"text-caption text-graphite"}>No {guide.adapter.label} resource in your stacks yet. Add a public field like this to a stack:</p>}
    <details className={"text-caption"} open={!guide.candidates.length}>
      <InspectorSummary>{guide.candidates.length ? `Add another ${guide.adapter.label} resource` : "Field snippet"}</InspectorSummary>
      <ul className={"m-0 [padding-left:18px] grid [gap:3px] text-caption"} data-slot="trigger-guide-rules">{guide.requirements.map((line) => <li key={line}>{line}</li>)}</ul>
      <CopyCode code={guide.snippet} label={`${guide.adapter.label} field snippet`} />
      <details className={"text-caption"}><InspectorSummary>Stack not in the resource catalog yet?</InspectorSummary><CopyCode code={guide.catalogSnippet} label="catalog snippet" /></details>
    </details>
    <a className={"text-caption"} href={guide.adapter.guide.docs} target="_blank" rel="noreferrer">AWS documentation <ExternalLink size={12} aria-hidden /></a>
  </div>;
}
