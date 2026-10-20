import { useState } from "react";

/** Values stay in the private inspector draft; secrets start masked in either editor. */
export function EnvironmentValueControl({ name, value, sensitive, disabled, onChange, placeholder, describedBy, rows = 1 }: {
  readonly name: string; readonly value: string; readonly sensitive: boolean; readonly disabled: boolean;
  readonly onChange: (value: string) => void; readonly placeholder?: string; readonly describedBy?: string; readonly rows?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const props = { "aria-label": `Value for ${name}`, "aria-describedby": describedBy, autoComplete: "off", spellCheck: false, disabled, value, placeholder };
  return <div className="env-value-control">
    {sensitive && !revealed
      ? <input {...props} type="password" onChange={(event) => onChange(event.target.value)} />
      : <textarea {...props} rows={value.includes("\n") ? Math.max(4, rows) : rows} onChange={(event) => onChange(event.target.value)} />}
    {sensitive ? <button className="linkish small" aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`} aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Reveal"}</button> : null}
  </div>;
}
