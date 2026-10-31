import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  dialogClasses,
  dialogHeaderClasses,
  dialogTitleClasses,
  dialogBodyClasses,
  dialogFooterClasses,
  dialogPrimaryActionClasses,
} from "../inspector-ui";
import { useEffect, useRef } from "react";
import { useStudio } from "../studio";

export function DraftFooter({ className }: { readonly className?: string } = {}) {
  const { draft, draftState } = useStudio();
  if (!draft.dirty && !draftState.error) return null;
  return (
    <footer
      className={cx(
        "flex-none border-t border-rule-strong bg-sheet px-(--panel-padding) py-3 shadow-[0_-4px_16px_#00000008]",
        className,
      )}
      aria-label="Pending inspector changes"
      data-slot="draft-footer"
    >
      <strong className="block text-caption font-medium" role="status">
        {draft.count} unsaved {draft.count === 1 ? "change" : "changes"}
      </strong>
      {draft.conflict ? (
        <div className="text-refuse wrap-anywhere" role="alert">
          <p className="my-2 text-label">
            Source changed while you were editing. Your draft is preserved. Review its changes
            against the latest source before applying.
          </p>
          <button
            className={buttonClasses({ variant: "quiet" })}
            disabled={!!draftState.busy}
            onClick={() => draft.reviewAgainstLatest()}
          >
            Review against latest source
          </button>
        </div>
      ) : null}
      {draftState.error && !draftState.reviewOpen ? (
        <p className="my-2 text-label text-refuse wrap-anywhere" role="alert">
          {draftState.error}
        </p>
      ) : null}
      <div className="mt-2 flex justify-end gap-2" data-slot="draft-actions">
        <button
          className={buttonClasses({ variant: "quiet" })}
          disabled={!!draftState.busy}
          onClick={() => draft.discard()}
        >
          Discard
        </button>
        <button
          className={buttonClasses({ variant: "primary", className: "flex-1" })}
          disabled={!draft.dirty || draft.invalid || draft.conflict || !!draftState.busy}
          onClick={() => void draft.review()}
          data-variant="primary"
        >
          {draftState.busy === "review"
            ? "Checking all changes…"
            : draftState.busy === "apply"
              ? "Applying…"
              : "Review Changes"}
        </button>
      </div>
    </footer>
  );
}

export function UnsavedChangesDialog() {
  const { draft, draftState } = useStudio();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!draftState.pendingNavigation) return;
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, [draftState.pendingNavigation]);
  return (
    <dialog
      ref={dialog}
      className={cx(dialogClasses({ size: "unsaved" }), "[max-width:580px]")}
      aria-labelledby="unsaved-title"
      onCancel={(event) => {
        event.preventDefault();
        draft.keepEditing();
      }}
      data-slot="unsaved-dialog"
    >
      <header className={dialogHeaderClasses}>
        <h2 id="unsaved-title" className={dialogTitleClasses}>
          Unsaved changes
        </h2>
      </header>
      <div className={dialogBodyClasses}>
        <p className="mt-0 mb-2">
          You have {draft.count} unsaved {draft.count === 1 ? "change" : "changes"}. Leaving this
          inspector will discard them.
        </p>
      </div>
      <footer className={dialogFooterClasses}>
        <button
          className={buttonClasses({ variant: "quiet" })}
          autoFocus
          onClick={() => draft.keepEditing()}
        >
          Keep Editing
        </button>
        <button
          className={buttonClasses({ variant: "quiet" })}
          onClick={() => draft.discardAndContinue()}
        >
          Discard and Continue
        </button>
        <button
          className={buttonClasses({ variant: "primary", className: dialogPrimaryActionClasses })}
          disabled={draft.invalid || draft.conflict}
          onClick={() => void draft.review()}
          data-variant="primary"
        >
          Review Changes
        </button>
      </footer>
    </dialog>
  );
}
