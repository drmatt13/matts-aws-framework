import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export function WorkbenchDialog({ title, children, footer, onClose, busy = false }: { readonly title: string; readonly children: ReactNode; readonly footer: ReactNode; readonly onClose: () => void; readonly busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const element = dialog.current!; element.showModal(); return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="preview workbench-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}><X size={16} /></button></header><div className="body">{children}</div><footer>{footer}</footer></dialog>;
}

export function SourceComparison({ before, after, beforeLabel = "Saved source", afterLabel = "Proposed source" }: { readonly before: string; readonly after: string; readonly beforeLabel?: string; readonly afterLabel?: string }) {
  const oldLines = before.split("\n"), newLines = after.split("\n");
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < Math.min(oldLines.length, newLines.length) - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++;
  return <div className="workbench-source-comparison">{[{ lines: oldLines, label: beforeLabel, kind: "remove" }, { lines: newLines, label: afterLabel, kind: "add" }].map(({ lines, label, kind }) => <section key={label}><h3>{label}</h3><pre aria-label={label}>{lines.map((line, index) => <span key={index} className={index >= prefix && index < lines.length - suffix ? kind : "context"}><span className="line-number" aria-hidden>{index + 1}</span>{line}{"\n"}</span>)}</pre></section>)}</div>;
}

