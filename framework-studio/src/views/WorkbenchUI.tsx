import { sourceDiff } from "../../shared/source-diff";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export function WorkbenchDialog({ title, children, footer, onClose, busy = false, className = "", id }: { readonly title: string; readonly children: ReactNode; readonly footer: ReactNode; readonly onClose: () => void; readonly busy?: boolean; readonly className?: string; readonly id?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const element = dialog.current!; element.showModal(); return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} id={id} className={`preview workbench-dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}><X size={16} /></button></header><div className="body">{children}</div><footer>{footer}</footer></dialog>;
}

export function SourceComparison({ before, after, beforeLabel = "Saved source", afterLabel = "Proposed source" }: { readonly before: string; readonly after: string; readonly beforeLabel?: string; readonly afterLabel?: string }) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  const changes = sourceDiff("source", before, after, 0).lines;
  const removed = new Set(changes.filter(line => line.kind === "remove").map(line => line.oldLine));
  const added = new Set(changes.filter(line => line.kind === "add").map(line => line.newLine));
  return <div className="workbench-source-comparison">{[{ lines: oldLines, label: beforeLabel, kind: "remove" }, { lines: newLines, label: afterLabel, kind: "add" }].map(({ lines, label, kind }) => <section key={label}><h3>{label}</h3><pre aria-label={label}>{lines.map((line, index) => <span key={index} className={(kind === "remove" ? removed : added).has(index + 1) ? kind : "context"}><span className="line-number" aria-hidden>{index + 1}</span>{line}{"\n"}</span>)}</pre></section>)}</div>;
}

