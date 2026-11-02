import { useId, useRef } from "react";
import type { ModelResource } from "../../shared/model";
import { inputChoicesError } from "../../shared/resources";
import { sourceEditBlocked } from "../editing-state";
import { inspectorSectionClasses } from "../inspector-ui";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { TextInput } from "../ui/FormControls";
import { InspectorSwitch } from "./InspectorUI";

/** Enum metadata is a reviewed source edit; this editor never reads or copies input values. */
export function InputAllowedValues({ resource }: { readonly resource: ModelResource }) {
  const { draft, draftState, model, live, snapshot } = useStudio();
  const prefix = useId();
  const fields = useRef<(HTMLInputElement | null)[]>([]);
  const add = useRef<HTMLButtonElement>(null);
  const form = draft.resourceForm(resource);
  if (form.secret) return null;
  const choices = form.choices ?? resource.values ?? [];
  const editable = !resource.frameworkInput || !!resource.inputChoices;
  const disabled = sourceEditBlocked({ draftState, draft, model, live }) || live.running !== null || draftState.entries.some(entry => entry.kind === "environment" || entry.kind === "create");
  const entry = draftState.entries.find(entry => entry.kind === "resource" && entry.intent.resource === resource.id);
  const error = inputChoicesError(choices) ?? entry?.error;
  const update = (choices: readonly string[]) => draft.setResource(resource, { ...form, choices });
  return (
    <section className={inspectorSectionClasses} aria-label="Allowed values" data-slot="input-allowed-values">
      <h3 className="mt-0 mb-3 text-label font-semibold">Allowed values</h3>
      {editable ? (
        <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
          <div className="flex items-center justify-between gap-3 text-label font-medium">
            <label htmlFor={`${prefix}-restricted`}>Restrict allowed values</label>
            <InspectorSwitch id={`${prefix}-restricted`} label="Restrict allowed values" describedBy={`${prefix}-help`} checked={choices.length > 0} onChange={checked => update(checked ? [""] : [])} />
          </div>
          <p id={`${prefix}-help`} className="mt-2 mb-0 text-caption text-graphite">{choices.length ? "Only these values are accepted, ignoring case. Defaults must also be included." : "Unrestricted text. Add a list to limit accepted values."} Changes update the declaration through Review Changes.</p>
          {choices.length ? <div className="mt-3 grid gap-2">
            {choices.map((choice, index) => <div key={index} className="flex min-w-0 items-center gap-2">
              <label className="sr-only" htmlFor={`${prefix}-${index}`}>Allowed value {index + 1}</label>
              <TextInput id={`${prefix}-${index}`} ref={element => { fields.current[index] = element; }} controlSize="panel" className="min-w-0 flex-1" value={choice} autoComplete="off" spellCheck={false}
                aria-invalid={!!error} aria-describedby={error ? `${prefix}-error` : undefined}
                onChange={event => update(choices.map((value, at) => at === index ? event.target.value : value))} />
              <button className={buttonClasses({ variant: "link" })} aria-label={`Remove allowed value ${index + 1}`} onClick={() => {
                update(choices.filter((_, at) => at !== index));
                requestAnimationFrame(() => {
                  if (choices.length === 1) document.getElementById(`${prefix}-restricted`)?.focus();
                  else (fields.current[Math.min(index, choices.length - 2)] ?? add.current)?.focus();
                });
              }}>Remove</button>
            </div>)}
            <button ref={add} className={buttonClasses({ variant: "link" })} onClick={() => {
              update([...choices, ""]);
              requestAnimationFrame(() => fields.current[choices.length]?.focus());
            }}>Add allowed value</button>
          </div> : null}
          {error ? <p id={`${prefix}-error`} role="status" className="mt-2 mb-0 text-caption text-refuse wrap-anywhere">{error}</p> : null}
          {resource.inputChoices?.defaults.length ? <p className="mt-2 mb-0 text-caption text-graphite">Declared defaults: {resource.inputChoices.defaults.join(", ")}.</p> : null}
          {resource.inputChoices ? <p className="mt-2 mb-0 text-caption text-graphite"><a href={editorLink(snapshot.repositoryRoot, resource.inputChoices.source)}>Open {resource.inputChoices.source.file}</a>. Changing choices does not change how the framework reader interprets them.</p> : null}
        </fieldset>
      ) : <p className="m-0 text-caption text-graphite">{choices.length ? choices.join(", ") : "Unrestricted text"}. {resource.frameworkInput === "database" ? "These choices follow the database setting's type, rather than an enum declaration." : "This input has no editable literal enum declaration. Edit its source to change the allowed values."}</p>}
    </section>
  );
}
