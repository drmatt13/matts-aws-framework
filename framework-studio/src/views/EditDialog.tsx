import { AlertTriangle, Check } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import type { Review } from "../draft";
import { useStudio } from "../studio";

export function EditDialog({ review }: { readonly review: Review | undefined }) {
  const { draft, draftState, applyDraft } = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const diagnostics = review?.kind === "resource" ? review.plan.diagnostics : [];
  const checking = draftState.busy === "review";
  const writing = draftState.busy === "apply";
  return <dialog ref={dialog} className="preview" aria-labelledby="preview-title" onCancel={(event) => { event.preventDefault(); if (!writing) draft.backToEditing(); }}>
    <header><p className="muted small">Inspector draft</p><h2 id="preview-title">Review {draft.count} {draft.count === 1 ? "change" : "changes"}</h2></header>
    <div className="body">
      {checking ? <p role="status">Checking all changes… The review will appear here when validation finishes.</p> : null}
      {draftState.error ? <p className="reason" role="alert">{draftState.error}</p> : null}
      {!checking && !review && draftState.error ? <button className="quiet" disabled={draft.invalid || draft.conflict} onClick={() => void draft.review()}>Retry Review</button> : null}
      {draft.conflict ? <p className="reason" role="alert">Source changed since this review. Your draft is preserved. {draftState.entries.some(entry => entry.kind === "environment" || entry.kind === "resource") ? "Choose Back to Editing to preserve your values, then reload that inspector before reviewing." : "Choose Back to Editing, then Review against latest source to keep your changes."} Discard All loads the latest configuration without your draft.</p> : null}
      {review ? <>
      <div className="checks">{review.kind === "environment" ? <div className="check ok"><strong><Check size={16} aria-hidden />Dotenv syntax and file revision checked</strong><p className="message">Values are hidden in this review. Check values in the inspector before applying. Synthesis validates infrastructure separately.</p></div> : review.kind === "batch" ? (["dev", "prod"] as const).map((mode) => <div key={mode} className={`check ${review.plan.preflight[mode].ok ? "ok" : "refused"}`}><strong>{review.plan.preflight[mode].ok ? <Check size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}{mode === "dev" ? "Development" : "Production"} graph: {review.plan.preflight[mode].ok ? "accepted" : "refused"}</strong>{review.plan.preflight[mode].diagnostics.map((item, at) => <p className="message" key={at}>{item.message}</p>)}</div>) : <div className={`check ${review.plan.ok ? "ok" : "refused"}`}><strong>{review.plan.ok ? <Check size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}{review.plan.ok ? "Both graphs and TypeScript accepted" : "Configuration refused"}</strong>{diagnostics.map((item, at) => <p className="message" key={at}>{item.message}</p>)}</div>}</div>
      {review.kind !== "resource" ? <><h3>Pending changes</h3><ul className="impact">{review.plan.summaries.map((summary, at) => <li key={at}>{summary}</li>)}</ul>{review.kind === "batch" ? <ul className="impact">{review.plan.impact.map((note) => <li key={note}>{note}</li>)}</ul> : null}</> : null}
      {review.plan.changes.map((change) => <div className="diff" key={change.file} aria-label={`Changes to ${change.file}`}><div className="file">{change.file}{"operation" in change && change.operation === "create" ? " · New file" : ""}</div><table><tbody>{change.diff.lines.map((line, at) => <Fragment key={at}>{line.hunk ? <tr className="hunk"><td colSpan={3}>{line.hunk}</td></tr> : null}<tr className={line.kind}><td className="number">{line.oldLine ?? ""}</td><td className="number">{line.newLine ?? ""}</td><td>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}{line.text}</td></tr></Fragment>)}</tbody></table></div>)}
      <p className="small muted">{review.kind === "environment" ? "Only these variables in the selected local file will be saved. Other environment files stay unchanged. Nothing is deployed." : "Only the reviewed source changes will be written. Validation covers the complete proposed configuration; deployment is a separate action."}</p>
      </> : null}
    </div>
    <footer>{review && !review.plan.ok ? <span className="reason">Resolve the rejected settings before applying.</span> : null}<button className="quiet" disabled={writing} autoFocus onClick={() => draft.backToEditing()}>Back to Editing</button><button className="quiet" disabled={writing} onClick={() => draft.discard()}>Discard All</button><button className="primary" disabled={!review?.plan.ok || checking || writing || draft.invalid || draft.conflict} onClick={() => void applyDraft()}>{writing ? "Applying…" : "Apply All"}</button></footer>
  </dialog>;
}
