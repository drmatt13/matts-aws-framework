import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cx } from "../ui/classes";

export const navigationItemClasses = "inline-flex min-h-8 flex-none cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent bg-transparent px-3 py-1 font-sans text-label font-medium leading-[1.5] text-graphite no-underline hover:bg-wash hover:text-ink focus-visible:outline-offset-[-2px] aria-[current=page]:border-rule aria-[current=page]:bg-wash aria-[current=page]:text-ink aria-pressed:border-rule aria-pressed:bg-wash aria-pressed:text-ink data-[status=active]:border-rule data-[status=active]:bg-wash data-[status=active]:text-ink";

/** Native links/buttons retain keyboard behavior; only this strip scrolls. */
export function NavigationStrip({ label, activeKey, className = "", children }: { readonly label: string; readonly activeKey: string; readonly className?: string; readonly children: ReactNode }) {
  const strip = useRef<HTMLElement>(null);
  const reveal = (item: Element | null) => {
    const container = strip.current;
    if (!container || !item) return;
    const viewport = container.getBoundingClientRect(), bounds = item.getBoundingClientRect();
    const inset = 4;
    if (bounds.left < viewport.left + inset) container.scrollLeft += bounds.left - viewport.left - inset;
    else if (bounds.right > viewport.right - inset) container.scrollLeft += bounds.right - viewport.right + inset;
  };
  useLayoutEffect(() => {
    const container = strip.current!;
    const revealActive = () => reveal(container.querySelector('[aria-current="page"], [aria-pressed="true"], [data-status="active"]'));
    revealActive();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealActive);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeKey]);
  return <nav ref={strip} className={cx("flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-thin", className)} aria-label={label} onFocusCapture={event => reveal(event.target.closest("a, button"))}>{children}</nav>;
}
