import { inspectorSectionClasses } from "../inspector-ui";
import { Textarea } from "../ui/FormControls";
import { cx } from "../ui/classes";
import { useId } from "react";
import { DESCRIPTION_FILE, DESCRIPTION_LIMIT } from "../../shared/descriptions";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

/** Every inspector places this first after its identity header. A bundled connection row passes `inline`: its own disclosure holds the editor. */
export function Description({
  entity,
  connection = false,
  inline = false,
}: {
  readonly entity: string;
  readonly connection?: boolean;
  readonly inline?: boolean;
}) {
  const id = useId();
  const { draft, draftState, snapshot, live, model } = useStudio();
  const entry = draftState.entries.find(
    (entry) => entry.kind === "description" && entry.entity === entity,
  );
  const separate = draftState.entries.some((entry) => entry.kind === "environment");
  const problem = snapshot.descriptions.problem;
  const editor = (
    <div data-slot="description-editor-content">
      <label className="sr-only" htmlFor={id}>
        Description
      </label>
      <Textarea
        className={cx("w-full", inline ? "min-h-25" : "min-h-22 text-label")}
        id={id}
        aria-label="Description"
        rows={inline ? 3 : 5}
        maxLength={DESCRIPTION_LIMIT}
        value={draft.description(entity)}
        placeholder={
          connection ? "Describe why these items are connected…" : "Describe what this item does…"
        }
        onChange={(event) => draft.setDescription(entity, event.target.value)}
        disabled={!!draftState.busy || live.evaluating || !!model.stale || !!problem || separate}
        aria-invalid={!!entry?.error}
        aria-describedby={entry?.error ? `${id}-error` : undefined}
      />
      {entry?.error ? (
        <p
          id={`${id}-error`}
          className={cx("mb-2 text-refuse wrap-anywhere", inline ? "mt-0" : "mt-2")}
          role="alert"
        >
          {entry.error}
        </p>
      ) : null}
      {problem ? (
        <p
          className={cx(
            "mb-2 text-refuse wrap-anywhere",
            !inline && !entry?.error ? "mt-2" : "mt-0",
          )}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <p
        className={cx(
          "mb-2 text-caption text-graphite",
          !inline && !entry?.error && !problem ? "mt-2" : "mt-0",
        )}
      >
        <span className="grid min-w-0" data-slot="inspector-status-copy">
          <span className="[grid-area:1/1] aria-hidden:invisible" aria-hidden={separate}>
            {entry ? "Unsaved · Review Changes to save." : "Shared across environments."}
          </span>
          <span className="[grid-area:1/1] aria-hidden:invisible" aria-hidden={!separate}>
            Apply or discard local value changes to edit this description.
          </span>
        </span>
        <a
          href={editorLink(snapshot.repositoryRoot, {
            file: DESCRIPTION_FILE,
            line: 1,
            column: 1,
            start: 0,
            end: 0,
          })}
        >
          Open descriptions.ts
        </a>
      </p>
    </div>
  );
  return (
    <section
      className={inline ? "border-0 px-0 pt-2 pb-0" : inspectorSectionClasses}
      aria-label={connection ? "Connection description" : "Node description"}
      data-slot="node-description"
    >
      {inline ? (
        editor
      ) : (
        <>
          {/* The 32 px row overhangs its title line, which therefore sits where every other section title does. */}
          <details
            className="peer/description group/description-editor"
            data-disclosure="description"
            data-slot="description-editor"
          >
            <summary className="-my-1.5 flex min-h-(--panel-icon-target) cursor-pointer list-none items-center justify-between gap-3 text-label font-semibold group-open/description-editor:mb-1.5 [&::-webkit-details-marker]:hidden">
              Description
              <span
                className="text-graphite text-caption font-normal"
                data-slot="description-edit-label"
              >
                Edit
              </span>
            </summary>
            {editor}
          </details>
          <p
            className="mt-3 mb-0 line-clamp-2 text-caption leading-[1.55] text-graphite peer-open/description:hidden"
            data-slot="description-preview"
          >
            {draft.description(entity).trim() ||
              (connection
                ? "Add a description of this connection."
                : "Add a description of this item.")}
          </p>
        </>
      )}
    </section>
  );
}
