import { useEffect, useState } from "react";
import type { Editability, FieldFact, ModelTarget } from "../../shared/model";
import { describeValue } from "../lookup";
import { useStudio } from "../studio";
import { deploymentSettingLabel } from "../deployment";

export function lockedReason(editability: Editability | undefined, fact: FieldFact): string | undefined {
  if (fact.blocked) return fact.blocked;
  if (!editability) return "The source index has no answer for this field.";
  switch (editability.kind) {
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

const INHERIT = "\u0000inherit";

export function FieldRow(props: { readonly target: { readonly ref: string; readonly role?: ModelTarget["role"] }; readonly fact: FieldFact; readonly editability: Editability | undefined; readonly allowInherit?: boolean }) {
  const { preview, live, model, snapshot } = useStudio();
  const { target, fact, editability } = props;
  const locked = model.stale ? "Editing is paused until the configuration loads again." : lockedReason(editability, fact);
  const current = fact.authored === undefined ? INHERIT : String(fact.authored);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const changed = draft !== current;
  const unit = fact.domain.kind === "number" ? ` ${fact.domain.unit}` : "";
  const webSocketApi = target.role === "webSocket" || target.role === "webSocketAuthorizer" ? snapshot.webSocketApi : undefined;
  const display = (value: unknown) => {
    if (fact.field === "deploy") return deploymentSettingLabel(String(value), webSocketApi);
    if (fact.field.endsWith(".packaging")) return value === "container" ? "Container image (Dockerfile)" : "Source bundle (ZIP)";
    if (fact.field.endsWith(".logRetentionDays")) return `${value} days`;
    if (typeof value === "boolean") return value ? "On" : "Off";
    return String(value);
  };
  const inheritLabel = fact.inherited
    ? fact.field === "deploy" ? `Use default (${display(fact.inherited.value)})` : `Inherit (${display(fact.inherited.value)}${unit} from ${fact.inherited.from})`
    : "Inherit";

  const submit = () => {
    if (draft === INHERIT) void preview({ target: target.ref, field: fact.field, inherit: true });
    else {
      const value = fact.domain.kind === "number" ? Number(draft) : fact.domain.values.find((value) => String(value) === draft) ?? draft;
      void preview({ target: target.ref, field: fact.field, value });
    }
  };

  return (
    <div className="field">
      <span className="name">{fact.label}</span>
      <span className="control">
        {locked ? (
          <code>{display(fact.effective)}{unit}</code>
        ) : fact.domain.kind === "enum" ? (
          <select value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={fact.label}>
            {fact.domain.values.map((value) => (
              <option key={String(value)} value={String(value)}>
                {display(value)}
              </option>
            ))}
            {props.allowInherit !== false ? <option value={INHERIT}>{inheritLabel}</option> : null}
          </select>
        ) : (
          <>
            <input
              type="number"
              min={fact.domain.min}
              max={fact.domain.max}
              required={props.allowInherit === false}
              value={draft === INHERIT ? "" : draft}
              placeholder={fact.inherited ? String(fact.inherited.value) : ""}
              onChange={(event) => setDraft(event.target.value === "" ? INHERIT : event.target.value)}
              aria-label={`${fact.label} in ${fact.domain.unit}`}
            />
            <span className="muted small">{fact.domain.unit}</span>
          </>
        )}
        {changed && !locked ? (
          <button className="primary" onClick={submit} disabled={live.evaluating || (draft === INHERIT && props.allowInherit === false) || (draft !== INHERIT && fact.domain.kind === "number" && (!Number.isSafeInteger(Number(draft)) || Number(draft) < fact.domain.min || Number(draft) > fact.domain.max))}>
            Preview change
          </button>
        ) : null}
      </span>
      {locked ? (
        <span className="locked">{locked}</span>
      ) : (
        <span className="note">
          {fact.field === "deploy" ? fact.authored === undefined ? `Uses default: ${display(fact.effective)}.` : `Set to ${display(fact.authored)}.` : fact.authored === undefined
            ? `Not written here. Resolves to ${display(fact.effective)}${unit} from ${fact.provenance}.`
            : `Written as ${describeValue(fact.authored)}.`}
        </span>
      )}
    </div>
  );
}

