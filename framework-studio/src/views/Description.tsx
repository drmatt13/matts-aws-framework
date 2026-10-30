import { Textarea } from "../ui/FormControls";
import { cx } from "../ui/classes";
import { useId } from "react";
import { DESCRIPTION_FILE, DESCRIPTION_LIMIT } from "../../shared/descriptions";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

/** Every inspector places this first after its identity header. A bundled connection row passes `inline`: its own disclosure holds the editor. */
export function Description({ entity, connection = false, inline = false }: { readonly entity: string; readonly connection?: boolean; readonly inline?: boolean }) {
  const id = useId();
  const { draft, draftState, snapshot, live, model } = useStudio();
  const entry = draftState.entries.find((entry) => entry.kind === "description" && entry.entity === entity);
  const separate = draftState.entries.some((entry) => entry.kind === "environment");
  const problem = snapshot.descriptions.problem;
  const editor = <div data-slot="description-editor-content">
    <label className={"sr-only"} htmlFor={id}>Description</label>
    <Textarea id={id} aria-label="Description" rows={inline ? 3 : 5} maxLength={DESCRIPTION_LIMIT}
      value={draft.description(entity)} placeholder={connection ? "Describe why these items are connected…" : "Describe what this item does…"}
      onChange={(event) => draft.setDescription(entity, event.target.value)}
      disabled={!!draftState.busy || live.evaluating || !!model.stale || !!problem || separate}
      aria-invalid={!!entry?.error} aria-describedby={entry?.error ? `${id}-error` : undefined} />
    {entry?.error ? <p id={`${id}-error`} className={"text-refuse wrap-anywhere"} role="alert">{entry.error}</p> : null}
    {problem ? <p className={"text-refuse wrap-anywhere"} role="alert">{problem}</p> : null}
    <p className={"text-caption text-graphite"}><span className={"grid min-w-0 [&>span]:[grid-area:1/1] [&>[aria-hidden=true]]:invisible"} data-slot="inspector-status-copy">
      <span aria-hidden={separate}>{entry ? "Unsaved · Review Changes to save." : "Shared across environments."}</span>
      <span aria-hidden={!separate}>Apply or discard local value changes to edit this description.</span>
    </span><a href={editorLink(snapshot.repositoryRoot, { file: DESCRIPTION_FILE, line: 1, column: 1, start: 0, end: 0 })}>Open descriptions.ts</a></p>
  </div>;
  return <section className={cx("[&_textarea]:w-full", inline && "[&_textarea]:min-h-25")} aria-label={connection ? "Connection description" : "Node description"} data-slot="node-description">
    {inline ? editor : <>
      <details className="peer/description [&[open]>summary]:mb-2.5 [&_textarea]:min-h-22 [&_textarea]:text-label [&_textarea+p]:mt-2" data-disclosure="description" data-slot="description-editor">
        <summary className="flex min-h-(--panel-icon-target) cursor-pointer list-none items-center justify-between gap-3 text-label font-semibold [&::-webkit-details-marker]:hidden">Description<span className={"text-graphite text-caption font-normal"} data-slot="description-edit-label">Edit</span></summary>
        {editor}
      </details>
      <p className="mt-1.5! mb-0 line-clamp-2 text-caption leading-[1.55] text-graphite peer-open/description:hidden" data-slot="description-preview">{draft.description(entity).trim() || (connection ? "Add a description of this connection." : "Add a description of this item.")}</p>
    </>}
  </section>;
}
