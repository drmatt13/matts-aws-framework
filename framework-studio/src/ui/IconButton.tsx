import type { ComponentPropsWithRef } from "react";
import { cx } from "./classes";
import type { ButtonAppearance } from "./Button";

const sizes = { compact: "size-7 min-h-7", regular: "size-8 min-h-8", prominent: "size-9 min-h-9" } as const;
export function iconButtonClasses({ size = "regular", tone = "default", variant = "neutral", className }: ButtonAppearance = {}): string {
  return cx("inline-flex shrink-0 items-center justify-center gap-2 rounded-md border p-0 font-sans text-label font-medium leading-[1.5] cursor-pointer transition-[background-color,border-color,color] duration-120 disabled:opacity-45 disabled:cursor-not-allowed [&>svg]:shrink-0", sizes[size],
    variant === "primary" ? "border-ink bg-ink text-sheet not-disabled:hover:bg-[color-mix(in_srgb,var(--ink)_85%,var(--sheet))]" : variant === "quiet" || variant === "link" ? "border-transparent bg-transparent not-disabled:hover:bg-wash not-disabled:hover:text-ink" : "border-rule-strong bg-sheet not-disabled:hover:bg-wash not-disabled:hover:border-graphite",
    tone === "danger" && "text-refuse", className);
}
export type IconButtonProps = ComponentPropsWithRef<"button"> & ButtonAppearance & { "aria-label": string };
export function IconButton({ variant, size, tone, className, ...props }: IconButtonProps) {
  return <button {...props} className={iconButtonClasses({ variant, size, tone, className })} />;
}
