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
  return <div className="guide-code">
    <pre><code>{code}</code></pre>
    <button className="quiet small" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined); }}>
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
  if (!guide) return <div ref={root} className="trigger-guide" role="region" aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`}>What should invoke {props.event}?</h4>
    <div className="trigger-guide-grid">
      {summary.map((item) => <button key={item.kind} className={`trigger-guide-service${item.reason ? " unavailable" : ""}`} aria-label={`${item.label}: ${item.reason ? "unavailable" : item.resourceless ? "no resource needed" : `${item.usable} usable`}`} title={item.reason}
        onClick={() => item.resourceless && !item.reason ? props.onChoose("", item.kind) : props.onKind(item.kind)}>
        <img src={iconUrl(iconOf(item.kind))} alt="" aria-hidden />
        <span>{item.label}</span>
        <span className={`trigger-guide-count ${item.usable ? "" : "muted"}`}>{item.reason ? "n/a" : item.resourceless ? "ready" : item.usable || "none"}</span>
      </button>)}
    </div>
  </div>;
  const reason = summary.find((item) => item.kind === guide.adapter.kind)?.reason;
  const usable = guide.candidates.filter((item) => !item.reason);
  return <div ref={root} className="trigger-guide" role="region" aria-labelledby={`${id}-title`}>
    <div className="trigger-guide-heading">
      <button className="icon-button" aria-label="All services" title="All services" onClick={() => props.onKind(undefined)}><ArrowLeft size={16} aria-hidden /></button>
      <h4 id={`${id}-title`}>Triggered by {guide.adapter.label}</h4>
    </div>
    <p className="small muted">{guide.adapter.delivery}.</p>
    {reason ? <p className="reason small" role="note">{reason}</p> : null}
    {guide.candidates.length ? <>
      <h5>{usable.length ? "Choose a resource" : "Your stack resources"}</h5>
      <ul className="trigger-guide-candidates">
        {guide.candidates.map((item) => <li key={item.resource} className={item.reason ? "unavailable" : ""}>
          <div className="trigger-guide-candidate">
            <img src={iconUrl(iconOf(guide.adapter.kind))} alt="" aria-hidden title={ICONS[iconOf(guide.adapter.kind)][1]} />
            <span><strong>{item.name}</strong> <span className="small muted">{titleOf(index, item.stack)}</span></span>
            {!item.reason ? <button className="quiet small" aria-label={`Use ${item.name}`} onClick={() => props.onChoose(item.resource, guide.adapter.kind)}>Use</button> : null}
          </div>
          {item.reason ? <p className="small reason">{item.reason}</p> : item.warning ? <p className="small trigger-warning"><TriangleAlert size={12} aria-hidden /> {item.warning}</p> : null}
          <Written location={item.location} label="Declared in" />
        </li>)}
      </ul>
    </> : <p className="small muted">No {guide.adapter.label} resource in your stacks yet. Add a public field like this to a stack:</p>}
    <details className="small" open={!guide.candidates.length}>
      <summary>{guide.candidates.length ? `Add another ${guide.adapter.label} resource` : "Field snippet"}</summary>
      <ul className="trigger-guide-rules small">{guide.requirements.map((line) => <li key={line}>{line}</li>)}</ul>
      <CopyCode code={guide.snippet} label={`${guide.adapter.label} field snippet`} />
      <details className="small"><summary>Stack not in the resource catalog yet?</summary><CopyCode code={guide.catalogSnippet} label="catalog snippet" /></details>
    </details>
    <a className="small" href={guide.adapter.guide.docs} target="_blank" rel="noreferrer">AWS documentation <ExternalLink size={12} aria-hidden /></a>
  </div>;
}
