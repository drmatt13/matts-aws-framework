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
/** The full-bleed toolbar surface. `PageToolbar` puts its contents in the page column. */
export const pageToolbarClasses = "min-h-(--toolbar-height) border-b border-rule bg-sheet py-(--toolbar-padding) text-label text-ink";
export const workspaceToolbarClasses = cx(pageToolbarClasses, "px-(--workspace-gutter)");
export function WorkspaceToolbar({ className, ...props }: ComponentPropsWithRef<"header">) {
  return <header {...props} className={cx(workspaceToolbarClasses, className)} />;
}
