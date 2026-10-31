import type { ComponentPropsWithRef } from "react";
import { cx } from "./classes";

export interface ButtonAppearance {
  variant?: "primary" | "neutral" | "quiet" | "link";
  size?: "compact" | "regular" | "prominent" | "dense" | "custom";
  tone?: "default" | "danger";
  className?: string;
}

const sizes = {
  // Callers with bespoke geometry supply their complete min-height and padding.
  custom: "",
  compact: "min-h-7 px-2 py-0.5",
  // Trigger actions keep regular target height with tighter padding and icon spacing.
  dense: "min-h-8 px-2 py-0.75",
  regular: "min-h-8 px-3 py-1",
  prominent: "min-h-9 px-3 py-1",
} as const;
const variants = {
  primary:
    "border-ink bg-ink text-sheet font-semibold not-disabled:hover:bg-[color-mix(in_srgb,var(--ink)_85%,var(--sheet))]",
  neutral:
    "border-rule-strong bg-sheet font-medium not-disabled:hover:bg-wash not-disabled:hover:border-graphite",
  quiet:
    "border-rule-strong bg-transparent font-medium not-disabled:hover:bg-wash not-disabled:hover:border-graphite",
} as const;

/** Also used by native anchors and router links; className is for placement, not overrides. */
export function buttonClasses({
  variant = "neutral",
  size = "regular",
  tone = "default",
  className,
}: ButtonAppearance = {}): string {
  if (variant === "link")
    return cx(
      "cursor-pointer border-0 bg-transparent p-0 text-left underline decoration-rule-strong underline-offset-[3px] hover:decoration-ink disabled:cursor-not-allowed",
      tone === "danger" && "text-refuse",
      className,
    );
  return cx(
    "inline-flex items-center justify-center rounded-md border font-sans text-label leading-[1.5] no-underline cursor-pointer transition-[background-color,border-color,color] duration-120 disabled:opacity-45 disabled:cursor-not-allowed [&>svg]:shrink-0",
    sizes[size],
    size === "dense" ? "gap-1" : "gap-2",
    tone === "danger" && variant === "primary"
      ? "border-refuse bg-refuse text-paper font-semibold not-disabled:hover:bg-[color-mix(in_srgb,var(--refuse)_85%,var(--paper))]"
      : variants[variant],
    tone === "danger" && variant !== "primary" && "text-refuse",
    className,
  );
}

export type ButtonProps = ComponentPropsWithRef<"button"> & ButtonAppearance;
/** The native default type is deliberate: callers retain form submission semantics. */
export function Button({ variant, size, tone, className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      data-variant={variant ?? "neutral"}
      className={buttonClasses({ variant, size, tone, className })}
    />
  );
}
