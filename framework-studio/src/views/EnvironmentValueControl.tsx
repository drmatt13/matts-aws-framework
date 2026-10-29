import { TextInput, Textarea } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
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
  return <div className={"flex min-w-0 items-center gap-2 [&>input]:min-h-(--panel-control-height) [&>textarea]:min-h-(--panel-control-height) [&>input]:flex-[1_1_0] [&>textarea]:flex-[1_1_0] [&>input]:font-mono [&>textarea]:font-mono [&>input]:leading-[1.5] [&>textarea]:leading-[1.5] [&>input]:text-caption [&>textarea]:text-caption [&>button]:min-h-(--panel-control-height) [&>button]:min-w-12 [&>button]:flex-none [&>button]:px-1 [&>button]:py-0 [&>button]:text-center"} data-slot="env-value-control">
    {sensitive && !revealed
      ? <TextInput {...props} type="password" onChange={(event) => onChange(event.target.value)} />
      : <Textarea {...props} rows={value.includes("\n") ? Math.max(4, rows) : rows} onChange={(event) => onChange(event.target.value)} />}
    {sensitive ? <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} disabled={disabled && !!onReveal && !revealed} aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`} aria-pressed={revealed} onClick={() => void toggle()}>{revealed ? "Hide" : "Reveal"}</button> : null}
  </div>;
}
