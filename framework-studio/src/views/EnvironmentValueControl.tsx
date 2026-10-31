import { TextInput, Textarea } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { useState } from "react";

/** Values stay in the private inspector draft; secrets start masked in either editor. */
export function EnvironmentValueControl({
  name,
  value,
  sensitive,
  disabled,
  onChange,
  placeholder,
  describedBy,
  rows = 1,
  onReveal,
  align = "center",
  textareaClassName,
  invalid,
}: {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly describedBy?: string;
  readonly rows?: number;
  /** Fetches a value the server withheld, before it is shown. */
  readonly onReveal?: () => Promise<void>;
  readonly invalid?: boolean;
  readonly align?: "center" | "start";
  readonly textareaClassName?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const toggle = async () => {
    if (!revealed && onReveal) await onReveal();
    setRevealed(!revealed);
  };
  const valueClasses = "flex-[1_1_0] font-mono text-caption leading-[1.5]";
  const props = {
    controlSize: "panel" as const,
    "aria-label": `Value for ${name}`,
    "aria-describedby": describedBy,
    "aria-invalid": invalid,
    autoComplete: "off",
    spellCheck: false,
    disabled,
    value,
    placeholder,
  };
  return (
    <div
      className={cx("flex min-w-0 gap-2", align === "start" ? "items-start" : "items-center")}
      data-slot="env-value-control"
    >
      {sensitive && !revealed ? (
        <TextInput
          {...props}
          className={valueClasses}
          type="password"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Textarea
          {...props}
          className={cx(valueClasses, textareaClassName)}
          rows={value.includes("\n") ? Math.max(4, rows) : rows}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {/* Link buttons default left; this action centers in its fixed-width slot. */}
      {sensitive ? (
        <button
          className={cx(
            buttonClasses({ variant: "link" }),
            "min-h-(--panel-control-height) min-w-12 flex-none px-1 py-0 [&]:text-center text-caption",
          )}
          disabled={disabled && !!onReveal && !revealed}
          aria-label={`${revealed ? "Hide" : "Reveal"} ${name}`}
          aria-pressed={revealed}
          onClick={() => void toggle()}
        >
          {revealed ? "Hide" : "Reveal"}
        </button>
      ) : null}
    </div>
  );
}
