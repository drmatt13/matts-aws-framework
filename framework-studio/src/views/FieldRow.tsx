import { useId } from "react";
import type { Editability, FieldFact, ModelTarget } from "../../shared/model";
import { describeValue } from "../lookup";
import { useStudio } from "../studio";
import { deploymentSettingLabel } from "../deployment";
import { InspectorSwitch } from "./InspectorUI";

export function lockedReason(editability: Editability | undefined, fact: FieldFact): string | undefined {
  if (fact.blocked) return fact.blocked;
  if (!editability) return "The source index has no answer for this field.";
  switch (editability.kind) {
    case "literal": case "absent": return undefined;
    case "computed": return `Computed by ${editability.text}. Change it in your editor.`;
    case "spread": return `It may come from ${editability.text}. Change it in your editor.`;
    case "unsupported": return editability.reason;
  }
}
interface Props { readonly target: { readonly ref: string; readonly role?: ModelTarget["role"] }; readonly fact: FieldFact; readonly editability: Editability | undefined; readonly allowInherit?: boolean; readonly description?: string }
const INHERIT = "\u0000inherit";

export function FieldRow({ target, fact, editability, allowInherit }: Props) {
  const id = useId();
  const { draft, draftState, live, model, snapshot } = useStudio();
  const locked = model.stale ? "Editing is paused until the configuration loads again." : lockedReason(editability, fact);
  const value = draft.value(target.ref, fact);
  const entry = draft.field(target.ref, fact);
  const unit = fact.domain.kind === "number" ? ` ${fact.domain.unit}` : "";
  const webSocketApi = target.role === "webSocket" || target.role === "webSocketAuthorizer" ? {
    dev: snapshot.models.dev.webSocketApi ?? snapshot.webSocketApi,
    prod: snapshot.models.prod.webSocketApi ?? snapshot.webSocketApi,
  } : undefined;
  const display = (value: unknown) => {
    if (fact.field === "deploy") return deploymentSettingLabel(String(value), webSocketApi);
    if (fact.field.endsWith(".packaging")) return value === "container" ? "Container image (Dockerfile)" : "Source bundle (ZIP)";
    if (fact.field.endsWith(".logRetentionDays")) return `${value} days`;
    if (typeof value === "boolean") return value ? "On" : "Off";
    return String(value);
  };
  const inherited = draft.inherited(fact);
  const inheritLabel = fact.inherited ? `Inherit · ${display(inherited)}${unit}` : "Inherit";
  const numericDefault = fact.domain.kind === "number" && inherited !== undefined;
  const describedBy = [numericDefault ? `${id}-default` : undefined, entry?.error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;
  return <div className={`field ${entry ? "field-dirty" : ""}`}>
    {locked ? <span className="name">{fact.label}</span> : <label className="name" htmlFor={id}>{fact.label}</label>}
    <span className="control">
      {locked ? <code>{display(fact.effective)}{unit}</code> : fact.domain.kind === "enum" ? <select id={id} value={value === undefined ? INHERIT : String(value)} onChange={(event) => draft.setField(target.ref, fact, event.target.value === INHERIT ? undefined : event.target.value)} aria-label={fact.label} aria-invalid={!!entry?.error} aria-describedby={describedBy} disabled={!!draftState.busy || live.evaluating}>
        {fact.domain.values.map((value) => <option key={String(value)} value={String(value)}>{display(value)}</option>)}
        {allowInherit !== false ? <option value={INHERIT}>{inheritLabel}</option> : null}
      </select> : <><input id={id} type="number" min={fact.domain.min} max={fact.domain.max} required={allowInherit === false} value={value === undefined ? "" : String(value)} placeholder={inherited === undefined ? "" : String(inherited)} onChange={(event) => draft.setField(target.ref, fact, event.target.validity.badInput ? "Invalid number" : event.target.value === "" ? undefined : event.target.value)} aria-label={`${fact.label} in ${fact.domain.unit}`} aria-invalid={!!entry?.error} aria-describedby={describedBy} disabled={!!draftState.busy || live.evaluating} /><span className="muted small">{fact.domain.unit}</span></>}
    </span>
    {entry?.error ? <span className="locked" role="alert" id={`${id}-error`}>{entry.error}</span> : null}
    {numericDefault ? <div className="note numeric-default">
      <span id={`${id}-default`} title={fact.inherited?.from}>Default: {display(inherited)}{unit}</span>
      {value !== undefined && allowInherit !== false && !locked ? <button className="linkish" aria-label={`Use default ${fact.label.toLowerCase()}`} disabled={!!draftState.busy || live.evaluating} onClick={() => draft.setField(target.ref, fact, undefined)}>Use default</button> : null}
    </div> : null}
    {locked ? <span className="locked">{locked}</span> : <details className="note field-origin"><summary>{entry ? "Unsaved change" : fact.authored === undefined ? "Inherited value" : "Configured here"}</summary><span>{entry ? `Unsaved: ${value === undefined ? inheritLabel : display(value) + unit}.` : fact.authored === undefined ? `Inherited: ${display(draft.effective(target.ref, fact))}${unit} from ${fact.provenance}.` : `Written as ${describeValue(fact.authored)}.`}</span></details>}
  </div>;
}

/** Auth switches and shared-default switches stage through exactly the same control. */
export function BooleanField({ target, fact, editability, description }: Props) {
  const id = useId();
  const { draft, draftState, model, live } = useStudio();
  const locked = model.stale ? "Editing is paused until the configuration loads again." : lockedReason(editability, fact);
  const enabled = draft.effective(target.ref, fact) === true;
  const entry = draft.field(target.ref, fact);
  const describedBy = [description ? `${id}-help` : undefined, locked || entry?.error ? `${id}-status` : undefined].filter(Boolean).join(" ") || undefined;
  return <div className={`field ${entry ? "field-dirty" : ""}`}>
    <label className="name" htmlFor={id}>{fact.label}</label><span className="control"><InspectorSwitch id={id} label={fact.label} checked={enabled} describedBy={describedBy} invalid={!!entry?.error} disabled={!!locked || !!draftState.busy || live.evaluating} onChange={() => draft.toggleField(target.ref, fact)} /></span>
    {description ? <span className="note field-help" id={`${id}-help`}>{description}</span> : null}
    <details className="note field-origin"><summary>{entry ? "Unsaved change" : fact.authored === undefined ? "Inherited value" : "Configured here"}</summary><span>{fact.authored === undefined ? `Inherited from ${fact.provenance}.` : "Written in this configuration."}</span>
    {draft.value(target.ref, fact) !== undefined && fact.inherited && !locked ? <span className="note"><button className="linkish small" disabled={!!draftState.busy || live.evaluating} onClick={() => draft.setField(target.ref, fact, undefined)}>Use inherited value ({draft.inherited(fact) ? "On" : "Off"})</button></span> : null}</details>
    {locked || entry?.error ? <span className="locked" id={`${id}-status`} role={entry?.error ? "alert" : undefined}>{locked ?? entry?.error}</span> : null}
  </div>;
}
