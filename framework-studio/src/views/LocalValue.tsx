import { Select } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { useId } from "react";
import type { ModelResource } from "../../shared/model";
import type { ResourceDetails } from "../../shared/resources";
import type { EnvironmentEdit } from "../draft";
import { useStudio } from "../studio";
import { EnvironmentValueControl } from "./EnvironmentValueControl";
import { RequirementNotice } from "./InputRequirement";
import { InspectorSection } from "./InspectorUI";

export function LocalValue({
  resource,
  details,
  error,
  busy,
  onRetry,
}: {
  readonly resource: ModelResource;
  readonly details?: ResourceDetails;
  readonly error?: string;
  readonly busy: boolean;
  readonly onRetry: () => void;
}) {
  const { mode, model, draft, draftState, live, select } = useStudio();
  const help = useId();
  const name = resource.fromEnv!;
  const file = details?.file ?? `cdk-app/.env.${mode}`;
  const pending = draft.environment(mode);
  const edit = pending?.edits.find((item) => item.name === name);
  const value = edit?.value ?? details?.value ?? "";
  const secret = resource.kind === "secret";
  const hasDefault = !secret && resource.default !== undefined;
  const usingDefault = !value.trim() && hasDefault && !!resource.default?.trim();
  const otherChanges = draftState.entries.some(
    (entry) => entry.kind !== "environment" || entry.mode !== mode,
  );
  const disabled =
    busy ||
    !!draftState.busy ||
    draft.conflict ||
    otherChanges ||
    live.evaluating ||
    live.running !== null ||
    model.stale ||
    !details?.inputFile?.exists;
  const update = (nextValue: string) => {
    if (!details?.inputFile) return;
    const others = pending?.edits.filter((item) => item.name !== name) ?? [];
    const next: EnvironmentEdit = edit
      ? { ...edit, value: nextValue }
      : {
          key: name,
          name,
          value: nextValue,
          ...(details.configured ? { original: details.value ?? "" } : { create: true }),
        };
    draft.setEnvironment(
      mode,
      pending?.hash ?? details.inputFile.hash,
      !details.configured && nextValue === "" ? others : [...others, next],
      details.configured ? [name] : [],
    );
  };
  const revert = () => {
    if (pending)
      draft.setEnvironment(
        mode,
        pending.hash,
        pending.edits.filter((item) => item.name !== name),
        details?.configured ? [name] : [],
      );
  };
  const status = edit
    ? "Unsaved change"
    : usingDefault
      ? "Using default"
      : value.trim()
        ? "Set locally"
        : details?.configured
          ? "Empty"
          : "Not set";
  const requiredMissing = resource.inputRequirement?.required && !value.trim() && !usingDefault;
  return (
    <InspectorSection
      title="Local value"
      data-slot="local-input"
      actions={
        <span
          className="text-caption font-medium text-graphite"
          data-slot="local-input-mode"
          data-mode={mode}
        >
          {mode === "dev" ? "Development" : "Production"} file
        </span>
      }
    >
      <code
        className="mb-1 block text-caption wrap-anywhere"
        data-slot="local-input-name"
      >
        {name}
      </code>
      <p className="mt-0 mb-3 text-caption text-graphite" data-slot="local-input-source">
        Saves to{" "}
        <button
          className={buttonClasses({ variant: "link" })}
          title="Open all variables in this local file"
          onClick={() => select(`envfile:${mode}`)}
        >
          {file}
        </button>
      </p>
      {resource.absent || model.stale ? (
        <p className="mt-0 mb-2 text-caption text-graphite">
          {resource.absent
            ? "Not declared in this graph."
            : "Unavailable until the configuration loads."}
        </p>
      ) : error ? (
        <div className="grid justify-items-start gap-2" data-slot="local-input-error">
          <p className="mt-0 mb-2 text-refuse wrap-anywhere" role="alert">
            {error}
          </p>
          <button
            className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
            onClick={onRetry}
          >
            Retry value read
          </button>
        </div>
      ) : !details ? (
        <p role="status" className="mt-0 mb-2 text-caption text-graphite">
          Reading local value…
        </p>
      ) : (
        <>
          <div
            className={cx(
              "mb-2 flex items-center gap-1.5 text-caption",
              edit ? "text-dev" : requiredMissing ? "text-refuse" : "text-graphite",
            )}
            role="status"
            data-slot="local-input-status"
          >
            <span className="size-1.5 flex-none rounded-full bg-current" aria-hidden />
            <span className="grid min-w-0" data-slot="inspector-status-copy">
              <span className="[grid-area:1/1] aria-hidden:invisible" aria-hidden={otherChanges}>
                {status}
              </span>
              <span className="[grid-area:1/1] aria-hidden:invisible" aria-hidden={!otherChanges}>
                Apply or discard settings to edit this value.
              </span>
            </span>
          </div>
          {details.inputFile?.exists === false ? (
            <div className="grid justify-items-start gap-2" data-slot="local-input-empty">
              <p className="mt-0 mb-2 text-caption text-graphite">
                Create this environment file before setting a local value.
              </p>
              <button
                className={cx(buttonClasses({ variant: "quiet" }), "text-caption")}
                onClick={() => select(`envfile:${mode}`)}
              >
                Set up .env.{mode}
              </button>
            </div>
          ) : (
            <>
              {resource.values && !secret ? (
                <Select
                  controlSize="panel"
                  className="w-full"
                  aria-label={`Value for ${name}`}
                  aria-describedby={help}
                  value={value}
                  disabled={disabled}
                  onChange={(event) => update(event.target.value)}
                  data-slot="local-input-choice"
                >
                  <option value="">
                    {hasDefault ? `Use default · ${resource.default}` : "No local value"}
                  </option>
                  {value && !resource.values.includes(value) ? (
                    <option value={value}>{value} (current)</option>
                  ) : null}
                  {resource.values.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </Select>
              ) : (
                <EnvironmentValueControl
                  align="start"
                  textareaClassName="max-h-40"
                  key={`${resource.id}:${mode}`}
                  name={name}
                  value={value}
                  sensitive={secret}
                  disabled={disabled}
                  describedBy={help}
                  placeholder={
                    hasDefault
                      ? "Blank uses the default"
                      : secret
                        ? "Enter a secret value…"
                        : "Enter a local value…"
                  }
                  onChange={update}
                />
              )}
              <div
                className="mt-2 flex flex-wrap items-center justify-between gap-2 empty:hidden"
                data-slot="local-input-actions"
              >
                {value !== "" ? (
                  <button
                    className={cx(
                      buttonClasses({ variant: "link" }),
                      "min-h-(--panel-icon-target) text-caption",
                    )}
                    disabled={disabled}
                    onClick={() => update("")}
                  >
                    {hasDefault ? "Use default" : "Clear local value"}
                  </button>
                ) : null}
                {edit ? (
                  <button
                    className={cx(
                      buttonClasses({ variant: "link" }),
                      "min-h-(--panel-icon-target) text-caption",
                    )}
                    disabled={!!draftState.busy}
                    onClick={revert}
                  >
                    Revert value
                  </button>
                ) : null}
              </div>
            </>
          )}
          <div
            id={help}
            className="mt-2 grid gap-2 text-caption text-graphite wrap-anywhere empty:hidden"
            data-slot="local-input-help"
          >
            {/* The status line already says Empty or Not set, and an empty value select already reads "Use default · value". */}
            {hasDefault && !(resource.values && !secret && value === "") ? (
              <p className="m-0">
                Default: <code className="text-[inherit]">{resource.default}</code>
              </p>
            ) : requiredMissing ? (
              <p className="m-0">A non-blank value is required.</p>
            ) : null}
            {edit ? (
              <p className="m-0">Review Changes to save this value. Nothing is deployed.</p>
            ) : null}
            {secret ? (
              <p className="m-0">Masked by default. Saved only in this local file.</p>
            ) : null}
            {!details.inputFile ? (
              <p className="m-0">Restart Studio to enable inline value editing.</p>
            ) : null}
          </div>
          {!edit ? <RequirementNotice requirement={resource.inputRequirement} /> : null}
          {pending?.error ? (
            <p className="mt-0 mb-2 text-refuse wrap-anywhere text-caption" role="alert">
              {pending.error}
            </p>
          ) : null}
        </>
      )}
    </InspectorSection>
  );
}
