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
  return <section className="node-description" aria-label={connection ? "Connection description" : "Node description"}>
    <h3><label htmlFor={id}>Description</label></h3>
    <textarea id={id} aria-label="Description" rows={connection ? 3 : 5} maxLength={DESCRIPTION_LIMIT}
      value={draft.description(entity)} placeholder={connection ? "Describe why these items are connected…" : "Describe what this item does…"}
      onChange={(event) => draft.setDescription(entity, event.target.value)}
      disabled={!!draftState.busy || live.evaluating || !!model.stale || !!problem || separate}
      aria-invalid={!!entry?.error} aria-describedby={entry?.error ? `${id}-error` : undefined} />
    {entry?.error ? <p id={`${id}-error`} className="reason" role="alert">{entry.error}</p> : null}
    {problem ? <p className="reason" role="alert">{problem}</p> : null}
    {separate ? <p className="small muted">Apply or discard the input changes before editing this description.</p> : null}
    <p className="small muted">{entry ? "Unsaved description. Review Changes to save." : "Shared by Development and Production."} <a href={editorLink(snapshot.repositoryRoot, { file: DESCRIPTION_FILE, line: 1, column: 1, start: 0, end: 0 })}>Open descriptions.ts</a></p>
  </section>;
}
