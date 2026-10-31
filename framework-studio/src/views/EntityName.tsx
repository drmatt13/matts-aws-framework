import { Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { NameEntry } from "../draft";
import { editorLink } from "../lookup";
import { displayName } from "../naming";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { TextInput } from "../ui/FormControls";
import { useStudio } from "../studio";

/** A name is staged in the same Inspector transaction as its settings. */
export function EntityName({
  entity,
  fallback,
  icon,
}: {
  readonly entity: string;
  readonly fallback: string;
  readonly icon?: ReactNode;
}) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const capability = snapshot.namingCapabilities?.[entity];
  const id = useId();
  const action = useRef<HTMLButtonElement>(null);
  const checkpoint = useRef<readonly NameEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [displayOpen, setDisplayOpen] = useState(false);
  const resetVersion = draft.resetVersion;
  useEffect(() => {
    setOpen(false);
  }, [resetVersion]);
  const pending = draft.nameEntries(entity);
  const errors = pending.filter((entry) => entry.error);
  const privateEdits = draftState.entries.some((entry) => entry.kind === "environment");
  const disabled =
    !!draftState.busy ||
    draft.conflict ||
    live.evaluating ||
    live.running !== null ||
    !!model.stale ||
    privateEdits;
  const begin = () => {
    checkpoint.current = [...draft.nameEntries(entity)];
    setCode(draft.codeName(entity));
    setLabel(draft.displayName(entity));
    setDisplayOpen(!!draft.displayName(entity));
    setOpen(true);
  };
  const close = (cancel: boolean) => {
    if (disabled) return;
    if (cancel) draft.restoreNameEntries(entity, checkpoint.current);
    else if (errors.length) return;
    setOpen(false);
    requestAnimationFrame(() => action.current?.focus());
  };
  const nextCode = pending.find((entry) => entry.kind === "rename");
  const source = snapshot.source.entities[entity]?.key;
  const reference = entity.startsWith("resource:")
    ? `resources.${entity.slice("resource:".length).split(".").slice(0, -1).concat(code.trim()).join(".")}`
    : undefined;
  const automatic =
    capability?.code && nextCode?.kind === "rename" ? nextCode.name.trim() : fallback;
  return (
    <div data-slot="entity-name" className="mt-1 mb-1.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h2 className="m-0 min-w-0 flex-1 font-sans text-[20px] leading-[1.3] font-semibold tracking-[-.025em] wrap-anywhere text-balance">
          {icon ? <span className="float-left mt-px mr-2 inline-flex size-6">{icon}</span> : null}
          {displayName(model, entity, fallback)}
        </h2>
        {capability?.display ? (
          <button
            ref={action}
            type="button"
            className={iconButtonClasses({ variant: "quiet", className: "-my-[3px] shrink-0" })}
            aria-label={`Rename ${fallback}`}
            title="Rename"
            aria-expanded={open}
            aria-controls={`${id}-editor`}
            disabled={disabled}
            onClick={() => (open ? close(false) : begin())}
          >
            <Pencil size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      {open ? (
        <form
          id={`${id}-editor`}
          className="mt-3 grid min-w-0 gap-3 rounded-md border border-rule bg-paper p-3 text-caption"
          aria-label={`Rename ${fallback}`}
          onSubmit={(event) => {
            event.preventDefault();
            close(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
          }}
        >
          {capability?.code ? (
            <>
              <label className="grid gap-1.5 font-medium">
                Code name
                <TextInput
                  autoFocus
                  value={code}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${id}-code-help${errors.length ? ` ${id}-error` : ""}`}
                  aria-invalid={pending.some((entry) => entry.kind === "rename" && entry.error)}
                  disabled={disabled}
                  onChange={(event) => {
                    setCode(event.target.value);
                    draft.setCodeName(entity, event.target.value);
                  }}
                />
              </label>
              <p id={`${id}-code-help`} className="m-0 text-graphite">
                Updates the declaration and its references in both environments when you apply.
              </p>
              {reference ? (
                <code className="block text-meta text-graphite wrap-anywhere">{reference}</code>
              ) : null}
              <details
                open={displayOpen}
                onToggle={(event) => setDisplayOpen(event.currentTarget.open)}
              >
                <summary className="cursor-pointer font-medium">Display name</summary>
                <label className="mt-2 grid gap-1.5">
                  Display name
                  <TextInput
                    value={label}
                    placeholder={automatic}
                    autoComplete="off"
                    aria-describedby={`${id}-display-help${errors.length ? ` ${id}-error` : ""}`}
                    aria-invalid={pending.some(
                      (entry) => entry.kind === "displayName" && entry.error,
                    )}
                    disabled={disabled}
                    onChange={(event) => {
                      setLabel(event.target.value);
                      draft.setDisplayName(entity, event.target.value);
                    }}
                  />
                </label>
                <p id={`${id}-display-help`} className="mb-0 mt-2 text-graphite">
                  Optional. Leave blank to follow the code name.
                </p>
              </details>
            </>
          ) : (
            <>
              <label className="grid gap-1.5 font-medium">
                Display name
                <TextInput
                  autoFocus
                  value={label}
                  placeholder={fallback}
                  autoComplete="off"
                  aria-describedby={`${id}-display-help${errors.length ? ` ${id}-error` : ""}`}
                  aria-invalid={pending.some(
                    (entry) => entry.kind === "displayName" && entry.error,
                  )}
                  disabled={disabled}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    draft.setDisplayName(entity, event.target.value);
                  }}
                />
              </label>
              <p id={`${id}-display-help`} className="m-0 text-graphite">
                Leave blank to use the original name. {capability?.reason}
              </p>
            </>
          )}
          {!capability?.code && source ? (
            <a
              className="text-caption underline underline-offset-2"
              href={editorLink(snapshot.repositoryRoot, source)}
            >
              Open code declaration in VS Code
            </a>
          ) : null}
          {errors.length ? (
            <p id={`${id}-error`} className="m-0 text-refuse wrap-anywhere" role="alert">
              {errors.map((entry) => entry.error).join(" ")}
            </p>
          ) : null}
          {snapshot.displayNames?.problem ? (
            <p className="m-0 text-refuse wrap-anywhere" role="alert">
              {snapshot.displayNames.problem}
            </p>
          ) : null}
          <p className="m-0 text-graphite">Pending changes are saved through Review Changes.</p>
          <div className="flex justify-end gap-2">
            <button
              className={buttonClasses({ variant: "quiet", size: "compact" })}
              type="button"
              disabled={disabled}
              onClick={() => close(true)}
            >
              Cancel rename
            </button>
            <button
              className={buttonClasses({ variant: "quiet", size: "compact" })}
              type="submit"
              disabled={disabled || !!errors.length}
            >
              Done
            </button>
          </div>
        </form>
      ) : pending.length ? (
        <p className="mb-0 mt-2 text-caption text-dev" role="status">
          Pending name: {draft.displayName(entity) || automatic}
        </p>
      ) : null}
    </div>
  );
}
