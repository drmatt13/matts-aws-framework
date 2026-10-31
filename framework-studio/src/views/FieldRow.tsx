import { InspectorSummary, InspectorSwitch } from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorFieldClasses,
  inspectorFieldRowClasses,
  inspectorFieldLabelClasses,
  disclosureSummaryClasses,
  inspectorControlClasses,
  inspectorLockedClasses,
  inspectorFullWidthLockedClasses,
  inspectorHelpClasses,
  inspectorFullWidthHelpClasses,
} from "../inspector-ui";
import { useId } from "react";
import type { Editability, FieldFact, ModelTarget } from "../../shared/model";
import { describeValue } from "../lookup";
import { useStudio } from "../studio";
import { deploymentSettingLabel } from "../deployment";

export function lockedReason(
  editability: Editability | undefined,
  fact: FieldFact,
): string | undefined {
  if (fact.blocked) return fact.blocked;
  if (!editability) return "The source index has no answer for this field.";
  switch (editability.kind) {
    case "condition":
    case "literal":
    case "absent":
      return undefined;
    case "computed":
      return `Computed by ${editability.text}. Change it in your editor.`;
    case "spread":
      return `It may come from ${editability.text}. Change it in your editor.`;
    case "unsupported":
      return editability.reason;
  }
}
interface Props {
  readonly target: { readonly ref: string; readonly role?: ModelTarget["role"] };
  readonly fact: FieldFact;
  readonly editability: Editability | undefined;
  readonly allowInherit?: boolean;
  readonly description?: string;
  readonly flush?: boolean;
}
const INHERIT = "\u0000inherit";

export function FieldRow(props: Props) {
  return props.fact.domain.kind === "enum" &&
    props.fact.domain.values.includes(true) &&
    props.fact.domain.values.includes(false) ? (
    <BooleanField {...props} />
  ) : (
    <ValueField {...props} />
  );
}

function ValueField({ target, fact, editability, allowInherit }: Props) {
  const id = useId();
  const { draft, draftState, live, model, snapshot } = useStudio();
  const locked = model.stale
    ? "Editing is paused until the configuration loads again."
    : lockedReason(editability, fact);
  const value = draft.value(target.ref, fact);
  const entry = draft.field(target.ref, fact);
  const unit = fact.domain.kind === "number" ? ` ${fact.domain.unit}` : "";
  const display = (value: unknown) => {
    if (fact.field === "deploy")
      return deploymentSettingLabel(
        String(value),
        target.role
          ? snapshot.models[draftState.mode].deployChoices?.[target.role]?.[String(value)]
          : undefined,
      );
    if (fact.field.endsWith(".packaging"))
      return value === "container" ? "Container image (Dockerfile)" : "Source bundle (ZIP)";
    if (fact.field.endsWith(".logRetentionDays")) return `${value} ${value === 1 ? "day" : "days"}`;
    if (typeof value === "boolean") return value ? "On" : "Off";
    return String(value);
  };
  const inherited = draft.inherited(fact);
  const inheritLabel = fact.inherited ? `Inherit · ${display(inherited)}${unit}` : "Inherit";
  const numericDefault = fact.domain.kind === "number" && inherited !== undefined;
  const describedBy =
    [numericDefault ? `${id}-default` : undefined, entry?.error ? `${id}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className={inspectorFieldClasses} data-slot="field">
      {locked ? (
        <span className={inspectorFieldLabelClasses({ modified: !!entry })} data-slot="field-label">
          {fact.label}
        </span>
      ) : (
        <label
          className={inspectorFieldLabelClasses({ modified: !!entry })}
          htmlFor={id}
          data-slot="field-label"
        >
          {fact.label}
        </label>
      )}
      <span className={inspectorControlClasses} data-slot="control">
        {locked ? (
          <code className="min-w-0 text-caption wrap-anywhere">
            {display(fact.effective)}
            {unit}
          </code>
        ) : fact.domain.kind === "enum" ? (
          <Select
            className="w-full"
            id={id}
            value={value === undefined ? INHERIT : String(value)}
            onChange={(event) =>
              draft.setField(
                target.ref,
                fact,
                event.target.value === INHERIT ? undefined : event.target.value,
              )
            }
            aria-label={fact.label}
            aria-invalid={!!entry?.error}
            aria-describedby={describedBy}
            disabled={!!draftState.busy || live.evaluating}
          >
            {fact.domain.values.map((value) => (
              <option key={String(value)} value={String(value)}>
                {display(value)}
              </option>
            ))}
            {allowInherit !== false ? <option value={INHERIT}>{inheritLabel}</option> : null}
          </Select>
        ) : (
          <>
            <TextInput
              className="w-full flex-1"
              id={id}
              type="number"
              min={fact.domain.min}
              max={fact.domain.max}
              required={allowInherit === false}
              value={value === undefined ? "" : String(value)}
              placeholder={inherited === undefined ? "" : String(inherited)}
              onChange={(event) =>
                draft.setField(
                  target.ref,
                  fact,
                  event.target.validity.badInput
                    ? "Invalid number"
                    : event.target.value === ""
                      ? undefined
                      : event.target.value,
                )
              }
              aria-label={`${fact.label} in ${fact.domain.unit}`}
              aria-invalid={!!entry?.error}
              aria-describedby={describedBy}
              disabled={!!draftState.busy || live.evaluating}
            />
            <span
              className="min-w-[3ch] shrink-0 whitespace-nowrap text-caption text-graphite"
              data-slot="field-unit"
            >
              {fact.domain.unit}
            </span>
          </>
        )}
      </span>
      {entry?.error ? (
        <span className={inspectorLockedClasses} role="alert" id={`${id}-error`} data-slot="locked">
          {entry.error}
        </span>
      ) : null}
      <div
        className={cx(inspectorHelpClasses, "flex flex-wrap items-baseline gap-x-3 empty:hidden")}
        data-slot="field-support"
      >
        {numericDefault ? (
          <div
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
            data-slot="numeric-default"
          >
            <span id={`${id}-default`} title={fact.inherited?.from}>
              Default: {display(inherited)}
              {unit}
            </span>
            {value !== undefined && allowInherit !== false && !locked ? (
              <button
                className={buttonClasses({ variant: "link" })}
                aria-label={`Use default ${fact.label.toLowerCase()}`}
                disabled={!!draftState.busy || live.evaluating}
                onClick={() => draft.setField(target.ref, fact, undefined)}
              >
                Use default
              </button>
            ) : null}
          </div>
        ) : null}
        {locked ? null : (
          <details className="min-w-0 open:basis-full" data-slot="field-origin">
            <InspectorSummary className={disclosureSummaryClasses}>
              {entry
                ? "Unsaved change"
                : fact.authored === undefined
                  ? "Inherited value"
                  : "Configured here"}
            </InspectorSummary>
            <span className="block pt-1 wrap-anywhere">
              {entry
                ? `Unsaved: ${value === undefined ? inheritLabel : display(value) + unit}.`
                : fact.authored === undefined
                  ? `Inherited: ${display(draft.effective(target.ref, fact))}${unit} from ${fact.provenance}.`
                  : `Written as ${describeValue(fact.authored)}.`}
            </span>
          </details>
        )}
      </div>
      {locked ? (
        <span className={inspectorLockedClasses} data-slot="locked">
          {locked}
        </span>
      ) : null}
    </div>
  );
}

/** Auth switches and shared-default switches stage through exactly the same control. */
export function BooleanField({ target, fact, editability, description, flush }: Props) {
  const id = useId();
  const { draft, draftState, model, live } = useStudio();
  const locked = model.stale
    ? "Editing is paused until the configuration loads again."
    : lockedReason(editability, fact);
  const enabled = draft.effective(target.ref, fact) === true;
  const entry = draft.field(target.ref, fact);
  const describedBy =
    [description ? `${id}-help` : undefined, locked || entry?.error ? `${id}-status` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className={inspectorFieldRowClasses({ switch: true, flush })} data-slot="field">
      <label
        className={inspectorFieldLabelClasses({ modified: !!entry })}
        htmlFor={id}
        data-slot="field-label"
      >
        {fact.label}
      </label>
      <span className={inspectorControlClasses} data-slot="control">
        <InspectorSwitch
          id={id}
          label={fact.label}
          checked={enabled}
          describedBy={describedBy}
          invalid={!!entry?.error}
          disabled={!!locked || !!draftState.busy || live.evaluating}
          onChange={() => draft.toggleField(target.ref, fact)}
        />
      </span>
      {description ? (
        <span className={inspectorFullWidthHelpClasses} id={`${id}-help`} data-slot="field-help">
          {description}
        </span>
      ) : null}
      <details className={cx(inspectorFullWidthHelpClasses, "min-w-0")} data-slot="field-origin">
        <InspectorSummary className={disclosureSummaryClasses}>
          {entry
            ? "Unsaved change"
            : fact.authored === undefined
              ? "Inherited value"
              : "Configured here"}
        </InspectorSummary>
        <span className="block pt-1 wrap-anywhere">
          {fact.authored === undefined
            ? `Inherited from ${fact.provenance}.`
            : "Written in this configuration."}
        </span>
        {draft.value(target.ref, fact) !== undefined && fact.inherited && !locked ? (
          <span className={cx(inspectorFullWidthHelpClasses, "block pt-1")} data-slot="note">
            <button
              className={cx(buttonClasses({ variant: "link" }), "text-caption")}
              disabled={!!draftState.busy || live.evaluating}
              onClick={() => draft.setField(target.ref, fact, undefined)}
            >
              Use inherited value ({draft.inherited(fact) ? "On" : "Off"})
            </button>
          </span>
        ) : null}
      </details>
      {locked || entry?.error ? (
        <span
          className={inspectorFullWidthLockedClasses}
          id={`${id}-status`}
          role={entry?.error ? "alert" : undefined}
          data-slot="locked"
        >
          {locked ?? entry?.error}
        </span>
      ) : null}
    </div>
  );
}
