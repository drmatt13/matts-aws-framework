import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;
const GAP = 12;

/** Prefer the map side of a panel row; use vertical space on narrow windows. */
export function resourceTooltipPlacement(anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">, card: { width: number; height: number }, viewport: { left: number; top: number; width: number; height: number }) {
  const left = viewport.left + MARGIN, top = viewport.top + MARGIN;
  const right = viewport.left + viewport.width - MARGIN, bottom = viewport.top + viewport.height - MARGIN;
  const maxWidth = Math.max(0, right - left);
  const width = Math.min(card.width, maxWidth);
  const besideLeft = anchor.left - GAP - width >= left;
  const besideRight = anchor.right + GAP + width <= right;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  if (besideLeft || besideRight) {
    const maxHeight = Math.max(0, bottom - top);
    return { left: besideLeft ? anchor.left - GAP - width : anchor.right + GAP, top: clamp(anchor.top, top, bottom - Math.min(card.height, maxHeight)), maxHeight, maxWidth };
  }
  const above = Math.max(0, Math.min(anchor.top - GAP, bottom) - top), below = Math.max(0, bottom - Math.max(anchor.bottom + GAP, top));
  const useAbove = card.height <= above || above > below;
  const maxHeight = useAbove ? above : below;
  const height = Math.min(card.height, maxHeight);
  return { left: clamp(anchor.right - width, left, right - width), top: clamp(useAbove ? anchor.top - GAP - height : anchor.bottom + GAP, top, bottom - height), maxHeight, maxWidth };
}

/** A portal keeps the preview out of the resource list's scrolling/clipping context. */
export function ResourceTooltip(props: {
  readonly id: string;
  readonly anchor: HTMLElement;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof resourceTooltipPlacement>>();
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const measure = () => {
      const viewport = window.visualViewport;
      const next = resourceTooltipPlacement(props.anchor.getBoundingClientRect(), element.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      });
      setPlacement(current => current?.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight && current.maxWidth === next.maxWidth ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(props.anchor);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [props.anchor]);
  return createPortal(<div ref={card} id={props.id} className="landscape-hover resource-tooltip" role="tooltip"
    style={{ ...placement, visibility: placement ? "visible" : "hidden" }}
    onPointerEnter={props.onPointerEnter} onPointerLeave={props.onPointerLeave}>
    {props.children}
  </div>, document.body);
}
