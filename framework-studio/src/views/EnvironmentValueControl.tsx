import { useState } from "react";

/** Values stay in the private inspector draft; secrets start masked in either editor. */
export function EnvironmentValueControl({ name, value, sensitive, disabled, onChange, placeholder, describedBy, rows = 1, onReveal }: {
  readonly name: string; readonly value: string; readonly sensitive: boolean; readonly disabled: boolean;
  readonly onChange: (value: string) => void; readonly placeholder?: string; readonly describedBy?: string; readonly rows?: number;
  /** Fetches a value the server withheld, before it is shown. */
  readonly onReveal?: () => Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const toggle = async () => { if (!revealed && onReveal) await onReveal(); setRevealed(!revealed); };
  const props = { "aria-label": `Value for ${name}`, "aria-describedby": describedBy, autoComplete: "off", spellCheck: false, disabled, value, placeholder };
  return <div className="env-value-control">
    {sensitive && !revealed
      ? <input {...props} type="password" onChange={(event) => onChange(event.target.value)} />
      : <textarea {...props} rows={value.includes("\n") ? Math.max(4, rows) : rows} onChange={(event) => onChange(event.target.value)} />}
    {sensitive ? <button className="linkish small" disabled={disabled && !!onReveal && !revealed} aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`} aria-pressed={revealed} onClick={() => void toggle()}>{revealed ? "Hide" : "Reveal"}</button> : null}
  </div>;
}
