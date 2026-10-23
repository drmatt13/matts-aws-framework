import { useLayoutEffect, useRef, type ReactNode } from "react";

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
  return <nav ref={strip} className={`workspace-tabs ${className}`} aria-label={label} onFocusCapture={event => reveal(event.target.closest("a, button"))}>{children}</nav>;
}
