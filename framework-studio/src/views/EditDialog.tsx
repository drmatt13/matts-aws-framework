import { checkClasses, checkGridClasses, checkMessageClasses } from "../inspector-ui";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { dialogClasses, dialogHeaderClasses, dialogTitleClasses, dialogBodyClasses, dialogFooterClasses } from "../inspector-ui";
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
  return <dialog ref={dialog} className={dialogClasses()} aria-labelledby="preview-title" onCancel={(event) => { event.preventDefault(); if (!writing) draft.backToEditing(); }} data-slot="preview">
    <header className={dialogHeaderClasses}><p className={"text-graphite text-caption"}>Inspector draft</p><h2 id="preview-title" className={dialogTitleClasses}>Review {draft.count} {draft.count === 1 ? "change" : "changes"}</h2></header>
    <div className={dialogBodyClasses}>
      {checking ? <p role="status">Checking all changes… The review will appear here when validation finishes.</p> : null}
      {draftState.error ? <p className={"text-refuse wrap-anywhere"} role="alert">{draftState.error}</p> : null}
      {!checking && !review && draftState.error ? <button className={buttonClasses({ variant: "quiet" })} disabled={draft.invalid || draft.conflict} onClick={() => void draft.review()}>Retry Review</button> : null}
      {draft.conflict ? <p className={"text-refuse wrap-anywhere"} role="alert">Source changed since this review. Your draft is preserved. {draftState.entries.some(entry => entry.kind === "environment" || entry.kind === "resource") ? "Choose Back to Editing to preserve your values, then reload that inspector before reviewing." : "Choose Back to Editing, then Review against latest source to keep your changes."} Discard All loads the latest configuration without your draft.</p> : null}
      {review ? <>
      <div className={checkGridClasses} data-slot="checks">{review.kind === "environment" ? <div className={checkClasses("ok")} data-slot="check"><strong><Check size={16} aria-hidden />Dotenv syntax and file revision checked</strong><p className={checkMessageClasses} data-slot="message">Values are hidden in this review. Check values in the inspector before applying. Synthesis validates infrastructure separately.</p></div> : review.kind === "batch" ? (["dev", "prod"] as const).map((mode) => <div key={mode} className={checkClasses(review.plan.preflight[mode].ok ? "ok" : "refused")} data-slot="check"><strong>{review.plan.preflight[mode].ok ? <Check size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}{mode === "dev" ? "Development" : "Production"} graph: {review.plan.preflight[mode].ok ? "accepted" : "refused"}</strong>{review.plan.preflight[mode].diagnostics.map((item, at) => <p className={checkMessageClasses} key={at} data-slot="message">{item.message}</p>)}</div>) : <div className={checkClasses(review.plan.ok ? "ok" : "refused")} data-slot="check"><strong>{review.plan.ok ? <Check size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}{review.plan.ok ? "Both graphs and TypeScript accepted" : "Configuration refused"}</strong>{diagnostics.map((item, at) => <p className={checkMessageClasses} key={at} data-slot="message">{item.message}</p>)}</div>}</div>
      {review.kind !== "resource" ? <><h3>Pending changes</h3><ul className={"m-0 [padding-left:18px]"} data-slot="impact">{review.plan.summaries.map((summary, at) => <li key={at}>{summary}</li>)}</ul>{review.kind === "batch" ? <ul className={"m-0 [padding-left:18px]"} data-slot="impact">{review.plan.impact.map((note) => <li key={note}>{note}</li>)}</ul> : null}</> : null}
      {review.plan.changes.map((change) => <div className={"border border-rule rounded-md overflow-auto font-mono text-[0.8rem] [&_table]:border-collapse [&_table]:w-full [&_td]:p-[0_10px] [&_td]:whitespace-pre [&_td]:align-top [&_td]:text-meta [&_td]:[line-height:1.7]"} key={change.file} aria-label={`Changes to ${change.file}`} data-slot="diff"><div className={"border-b border-rule bg-wash px-[10px] py-[6px] text-meta wrap-anywhere"}>{change.file}{"operation" in change && change.operation === "create" ? " · New file" : ""}</div><table><tbody>{change.diff.lines.map((line, at) => <Fragment key={at}>{line.hunk ? <tr className={"bg-paper text-graphite"} data-slot="hunk"><td colSpan={3}>{line.hunk}</td></tr> : null}<tr className={line.kind === "add" ? "bg-added" : line.kind === "remove" ? "bg-removed" : undefined}><td className={"w-[1%] text-right text-faint select-none"}>{line.oldLine ?? ""}</td><td className={"w-[1%] text-right text-faint select-none"}>{line.newLine ?? ""}</td><td>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}{line.text}</td></tr></Fragment>)}</tbody></table></div>)}
      <p className={"text-caption text-graphite"}>{review.kind === "environment" ? "Only these variables in the selected local file will be saved. Other environment files stay unchanged. Nothing is deployed." : "Only the reviewed source changes will be written. Validation covers the complete proposed configuration; deployment is a separate action."}</p>
      </> : null}
    </div>
    <footer className={dialogFooterClasses}>{review && !review.plan.ok ? <span className="mr-auto text-caption text-refuse wrap-anywhere vp-540:w-full">Resolve the rejected settings before applying.</span> : null}<button className={buttonClasses({ variant: "quiet" })} disabled={writing} autoFocus onClick={() => draft.backToEditing()}>Back to Editing</button><button className={buttonClasses({ variant: "quiet" })} disabled={writing} onClick={() => draft.discard()}>Discard All</button><button className={buttonClasses({ variant: "primary" })} disabled={!review?.plan.ok || checking || writing || draft.invalid || draft.conflict} onClick={() => void applyDraft()} data-variant="primary">{writing ? "Applying…" : "Apply All"}</button></footer>
  </dialog>;
}
