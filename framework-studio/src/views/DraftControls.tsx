import { useEffect, useRef } from "react";
import { useStudio } from "../studio";

export function DraftFooter() {
  const { draft, draftState } = useStudio();
  if (!draft.dirty && !draftState.error) return null;
  return <footer className="draft-footer" aria-label="Pending inspector changes">
    <strong role="status">{draft.count} unsaved {draft.count === 1 ? "change" : "changes"}</strong>
    {draft.conflict ? <p className="reason" role="alert">Source changed while you were editing. Your draft is preserved. Discard it to load the latest configuration.</p> : null}
    {draftState.error ? <p className="reason" role="alert">{draftState.error}</p> : null}
    <div className="draft-actions"><button className="quiet" disabled={!!draftState.busy} onClick={() => draft.discard()}>Discard</button><button className="primary" disabled={!draft.dirty || draft.invalid || draft.conflict || !!draftState.busy} onClick={() => void draft.review()}>{draftState.busy === "review" ? "Checking all changes…" : draftState.busy === "apply" ? "Applying…" : "Review Changes"}</button></div>
  </footer>;
}

export function UnsavedChangesDialog() {
  const { draft, draftState } = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!draftState.pendingNavigation) return;
    const element = dialog.current!; element.showModal();
    return () => element.close();
  }, [draftState.pendingNavigation]);
  return <dialog ref={dialog} className="preview unsaved-dialog" aria-labelledby="unsaved-title" onCancel={(event) => { event.preventDefault(); draft.keepEditing(); }}>
    <header><h2 id="unsaved-title">Unsaved changes</h2></header>
    <div className="body"><p>You have {draft.count} unsaved {draft.count === 1 ? "change" : "changes"}. Leaving this inspector will discard them.</p></div>
    <footer><button className="quiet" autoFocus onClick={() => draft.keepEditing()}>Keep Editing</button><button className="quiet" onClick={() => draft.discardAndContinue()}>Discard and Continue</button><button className="primary" disabled={draft.invalid || draft.conflict} onClick={() => void draft.review()}>Review Changes</button></footer>
  </dialog>;
}
