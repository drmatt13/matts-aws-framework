import type { ComponentPropsWithRef } from "react";
import { cx } from "./classes";

export function cardClasses({ variant = "regular", className }: { variant?: "regular" | "state" | "document"; className?: string } = {}): string {
  return cx("min-w-0 border border-rule bg-sheet p-4 text-ink wrap-anywhere", variant === "state" ? "rounded-lg" : "rounded-md", variant === "document" && "vp-720:p-3", className);
}
export function Card({ variant, className, ...props }: ComponentPropsWithRef<"section"> & { variant?: "regular" | "state" | "document" }) {
  return <section {...props} className={cardClasses({ variant, className })} />;
}
export function noticeClasses({ tone = "error", className }: { tone?: "error" | "warning" | "success" | "neutral"; className?: string } = {}): string {
  return cx("m-0 min-w-0 rounded-md border border-s-[3px] p-3 text-label leading-[1.5] wrap-anywhere", {
    error: "border-[color-mix(in_srgb,var(--refuse)_40%,var(--rule))] border-s-refuse bg-refuse-wash",
    warning: "border-rule border-s-local bg-wash",
    success: "border-rule border-s-accept bg-accept-wash",
    neutral: "border-rule bg-sheet",
  }[tone], className);
}
export function Notice({ tone, className, ...props }: ComponentPropsWithRef<"div"> & { tone?: "error" | "warning" | "success" | "neutral" }) {
  return <div {...props} className={noticeClasses({ tone, className })} />;
}
export const workspaceToolbarClasses = "min-h-[57px] border-b border-rule bg-sheet px-4 py-3 text-label text-ink";
export function WorkspaceToolbar({ className, ...props }: ComponentPropsWithRef<"header">) {
  return <header {...props} className={cx(workspaceToolbarClasses, className)} />;
}
