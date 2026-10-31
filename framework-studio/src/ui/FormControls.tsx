import type { ComponentPropsWithRef } from "react";
import { cx } from "./classes";

export interface ControlAppearance {
  controlSize?: "compact" | "regular" | "prominent" | "panel";
  className?: string;
}
const sizes = {
  compact: "min-h-7",
  regular: "min-h-8",
  prominent: "min-h-9",
  panel: "min-h-(--panel-control-height)",
} as const;
// Native controls inherit context typography and color, matching the existing document/inspector rhythm.
const control =
  "min-w-0 max-w-full rounded-md border border-rule-strong bg-paper px-3 py-1 transition-[border-color,background-color] duration-120 placeholder:text-faint placeholder:opacity-100 enabled:hover:not-focus:border-graphite disabled:opacity-55 disabled:cursor-not-allowed aria-invalid:border-refuse";
export function inputClasses({
  controlSize = "regular",
  className,
}: ControlAppearance = {}): string {
  return cx(control, sizes[controlSize], className);
}
export function textareaClasses(options: ControlAppearance = {}): string {
  return cx(inputClasses(options), "resize-y");
}
export function selectClasses({
  multiple,
  size,
  ...options
}: ControlAppearance & { multiple?: boolean; size?: number } = {}): string {
  return cx(
    inputClasses(options),
    !multiple &&
      size === undefined &&
      "appearance-none pr-9 bg-(image:--select-chevron) bg-no-repeat bg-position-[right_12px_center] bg-size-[14px] text-ellipsis forced-colors:appearance-auto forced-colors:bg-none",
  );
}
const checkbox =
  "m-0 size-4 shrink-0 disabled:opacity-55 disabled:cursor-not-allowed aria-invalid:border-refuse";
export const checkboxClasses = cx(checkbox, "accent-dev");
/** A checkbox inside a Development or Production card takes that environment's color. */
export const environmentCheckboxClasses = {
  dev: checkboxClasses,
  prod: cx(checkbox, "accent-prod"),
} as const;
export function TextInput({
  controlSize,
  className,
  type,
  ...props
}: ComponentPropsWithRef<"input"> & ControlAppearance) {
  return (
    <input
      {...props}
      type={type}
      className={
        type === "checkbox" || type === "radio"
          ? cx(checkboxClasses, className)
          : inputClasses({ controlSize, className })
      }
    />
  );
}
/**
 * A text input whose unit sits inside its border at the trailing edge, as a select's chevron
 * does. The unit is presentation: the caller names it in the input's accessible label.
 */
export function UnitInput({
  unit,
  controlSize,
  className,
  style,
  ...props
}: ComponentPropsWithRef<"input"> & ControlAppearance & { readonly unit: string }) {
  return (
    <span className={cx("grid min-w-0 flex-1", className)} data-slot="unit-input">
      <input
        {...props}
        style={{ ...style, paddingRight: `calc(var(--control-padding) * 2 + ${unit.length}ch)` }}
        className={inputClasses({ controlSize, className: "w-full [grid-area:1/1]" })}
      />
      <span
        aria-hidden
        className="pointer-events-none mr-3 self-center justify-self-end text-caption text-graphite [grid-area:1/1]"
        data-slot="field-unit"
      >
        {unit}
      </span>
    </span>
  );
}
export function Select({
  controlSize,
  className,
  multiple,
  size,
  ...props
}: ComponentPropsWithRef<"select"> & ControlAppearance) {
  return (
    <select
      {...props}
      multiple={multiple}
      size={size}
      className={selectClasses({ controlSize, className, multiple, size })}
    />
  );
}
export function Textarea({
  controlSize,
  className,
  ...props
}: ComponentPropsWithRef<"textarea"> & ControlAppearance) {
  return <textarea {...props} className={textareaClasses({ controlSize, className })} />;
}
