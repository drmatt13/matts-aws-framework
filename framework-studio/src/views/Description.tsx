import { useId } from "react";
import { DESCRIPTION_FILE, DESCRIPTION_LIMIT } from "../../shared/descriptions";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

export function Description({ entity, connection = false }: { readonly entity: string; readonly connection?: boolean }) {
  const id = useId();
  const { draft, draftState, snapshot, live, model } = useStudio();
  const entry = draftState.entries.find((entry) => entry.kind === "description" && entry.entity === entity);
  const separate = draftState.entries.some((entry) => entry.kind === "environment" || entry.kind === "resource");
  const problem = snapshot.descriptions.problem;
  const editor = <div className="description-editor-content">
    <label className="sr-only" htmlFor={id}>Description</label>
    <textarea id={id} aria-label="Description" rows={connection ? 3 : 5} maxLength={DESCRIPTION_LIMIT}
      value={draft.description(entity)} placeholder={connection ? "Describe why these items are connected…" : "Describe what this item does…"}
      onChange={(event) => draft.setDescription(entity, event.target.value)}
      disabled={!!draftState.busy || live.evaluating || !!model.stale || !!problem || separate}
      aria-invalid={!!entry?.error} aria-describedby={entry?.error ? `${id}-error` : undefined} />
    {entry?.error ? <p id={`${id}-error`} className="reason" role="alert">{entry.error}</p> : null}
    {problem ? <p className="reason" role="alert">{problem}</p> : null}
    <p className="small muted"><span className="inspector-status-copy">
      <span aria-hidden={separate}>{entry ? "Unsaved · Review Changes to save." : "Shared across environments."}</span>
      <span aria-hidden={!separate}>Apply or discard input changes to edit this description.</span>
    </span><a href={editorLink(snapshot.repositoryRoot, { file: DESCRIPTION_FILE, line: 1, column: 1, start: 0, end: 0 })}>Open descriptions.ts</a></p>
  </div>;
  return <section className="node-description" aria-label={connection ? "Connection description" : "Node description"}>
    {connection ? editor : <>
      <details className="description-editor">
        <summary>Description<span className="description-edit-label">Edit</span></summary>
        {editor}
      </details>
      <p className="description-preview">{draft.description(entity).trim() || "Add a description of this item."}</p>
    </>}
  </section>;
}
