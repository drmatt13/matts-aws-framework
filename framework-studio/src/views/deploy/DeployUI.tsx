import type { ComponentPropsWithRef } from "react";
import { cardClasses } from "../../ui/Surface";
import { cx } from "../../ui/classes";

export type StatusTone = "ok" | "done" | "busy" | "warn" | "bad" | "none" | "unknown";
export function StatusDot({ tone, ...props }: Omit<ComponentPropsWithRef<"span">, "children"> & { tone: string }) {
  const colors: Record<string, string> = {
    ok: "bg-accept", done: "bg-faint", busy: "bg-local animate-deploy-pulse motion-reduce:animate-none",
    warn: "bg-local", bad: "bg-refuse", none: "border border-rule-strong bg-transparent",
  };
  return <span {...props} aria-hidden className={cx("size-2 flex-none rounded-full", colors[tone] ?? "bg-rule-strong", props.className)} />;
}
export function flagClasses(tone?: "bad" | "warn") {
  return cx("mr-1 mb-0.5 inline-flex items-center gap-[3px] whitespace-nowrap rounded-full border px-[6px] py-px text-meta", tone === "bad" ? "border-[color-mix(in_srgb,var(--refuse)_45%,transparent)] text-refuse" : tone === "warn" ? "border-[color-mix(in_srgb,var(--local)_45%,transparent)] text-local" : "border-rule-strong text-graphite");
}
export function statePanelClasses(tone?: string) {
  return cx(cardClasses({ variant: "state" }), "[&>h3]:mt-0 [&>h3]:mb-3 [&>h3]:font-sans [&>h3]:text-label [&>h3]:font-semibold [&>h3]:leading-[1.5] [&>p]:m-0 [&>p+p]:mt-2", tone === "machine" ? "[&>h3]:text-local" : "[&>h3]:text-graphite", tone === "unreadable" && "border-dashed");
}
export const factsClasses = "m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-step-minus1 [&>dt]:text-graphite [&>dd]:m-0 [&>dd]:wrap-anywhere [&_a]:inline-flex [&_a]:max-w-full [&_a]:items-center [&_a]:gap-1 [&_a_svg]:flex-none";
export const sectionTitleClasses = "mt-0 mb-2 font-sans text-label font-semibold leading-[1.5] text-graphite";
export const logClasses = "m-0 overflow-auto border-t border-rule bg-paper px-4 py-3 font-mono text-[0.76rem] leading-[1.5] whitespace-pre-wrap wrap-anywhere vp-900:max-h-75";
export function planBannerClasses(tone: "ok" | "warn" | "bad") {
  return cx("m-0 flex items-start gap-2 rounded-md border border-rule p-3 wrap-anywhere [&>svg]:mt-0.5 [&>svg]:flex-none", { ok: "bg-accept-wash", warn: "bg-[color-mix(in_srgb,var(--local)_12%,var(--sheet))]", bad: "bg-refuse-wash text-refuse" }[tone]);
}
