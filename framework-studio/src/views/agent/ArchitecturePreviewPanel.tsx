import type { ArchitecturePreview } from "../../../shared/architecture-preview";
import { Notice } from "../../ui/Surface";

export function ArchitecturePreviewPanel({ preview, digest }: { readonly preview: ArchitecturePreview; readonly digest: string }) {
  if (preview.proposalDigest !== digest) return <Notice tone="warning">Architecture preview belongs to an older proposal. Refresh this review.</Notice>;
  return <details className="rounded-md border border-rule p-3">
    <summary className="cursor-pointer font-semibold">Proposed architecture{preview.status === "unavailable" ? " · unavailable" : preview.status === "partial" ? " · partial" : ""}</summary>
    <div className="mt-3 grid gap-3">
      {preview.reason ? <Notice tone="warning">{preview.reason}</Notice> : null}
      {preview.modes.map(mode => <section key={mode.mode} aria-label={`${mode.mode === "dev" ? "Development" : "Production"} architecture changes`} className="grid gap-2">
        <h4 className="m-0 font-semibold">{mode.mode === "dev" ? "Development" : "Production"} · {mode.status === "unavailable" ? "unavailable" : `${mode.changes.length} changes`}</h4>
        {mode.changes.length ? <ul className="m-0 grid gap-2 pl-5 text-caption">{mode.changes.map(change => <li key={`${change.entity}:${change.id}`}><span className="font-semibold">{change.kind === "add" ? "Added" : change.kind === "remove" ? "Removed" : "Changed"} {change.entity}</span>: <code className="wrap-anywhere">{change.id}</code>{change.kind === "modify" ? <p className="m-0 text-graphite">{change.fields.join(", ")}</p> : null}{change.implications.map((text, at) => <p className="m-0 text-graphite" key={at}>{text}</p>)}</li>)}</ul> : mode.status !== "unavailable" ? <p className="m-0 text-caption text-graphite">No projected declaration changes.</p> : null}
        {mode.diagnostics.map((text, at) => <p key={at} className="m-0 text-caption text-graphite">{text}</p>)}
      </section>)}
      <ul className="m-0 grid gap-1 pl-5 text-caption text-graphite">{preview.limitations.map((text, at) => <li key={at}>{text}</li>)}</ul>
    </div>
  </details>;
}
