import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;
const GAP = 12;

export interface TooltipViewport { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
export interface TooltipSize { readonly width: number; readonly height: number }
export interface TooltipPlacement { readonly left: number; readonly top: number; readonly maxWidth: number; readonly maxHeight: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** Bounds may be the visual viewport, or its intersection with the map's visible canvas. */
function tooltipBounds(viewport: TooltipViewport) {
  const marginX = Math.min(MARGIN, Math.max(0, viewport.width) / 2);
  const marginY = Math.min(MARGIN, Math.max(0, viewport.height) / 2);
  const left = viewport.left + marginX, top = viewport.top + marginY;
  const width = Math.max(0, viewport.width - marginX * 2), height = Math.max(0, viewport.height - marginY * 2);
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** A constrained tooltip still needs its full content height when deciding where it fits. */
export function tooltipContentSize(element: Pick<HTMLElement, "getBoundingClientRect" | "scrollHeight" | "clientHeight">): TooltipSize {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height + Math.max(0, element.scrollHeight - element.clientHeight) };
}

/** Convert the visible part of a positioned canvas host into its own local coordinates. */
export function canvasTooltipViewport(host: Pick<DOMRect, "left" | "top" | "width" | "height">, visible: TooltipViewport): TooltipViewport {
  const left = clamp(visible.left - host.left, 0, host.width);
  const top = clamp(visible.top - host.top, 0, host.height);
  const right = clamp(visible.left + visible.width - host.left, left, host.width);
  const bottom = clamp(visible.top + visible.height - host.top, top, host.height);
  return { left, top, width: right - left, height: bottom - top };
}

/** The map uses the same measured bounds as list previews, without guessing the card's height. */
export function pointerTooltipPlacement(point: { readonly x: number; readonly y: number }, card: TooltipSize, viewport: TooltipViewport): TooltipPlacement {
  const bounds = tooltipBounds(viewport);
  const width = Math.min(card.width, bounds.width), height = Math.min(card.height, bounds.height);
  const right = point.x + GAP, left = point.x - GAP - width;
  const below = point.y + GAP, above = point.y - GAP - height;
  return {
    left: clamp(right + width <= bounds.right ? right : left, bounds.left, bounds.right - width),
    top: clamp(below + height <= bounds.bottom ? below : above, bounds.top, bounds.bottom - height),
    maxWidth: bounds.width,
    maxHeight: bounds.height,
  };
}

/** Prefer the map side of a panel row; use vertical space on narrow windows. */
export function resourceTooltipPlacement(anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">, card: TooltipSize, viewport: TooltipViewport): TooltipPlacement {
  const { left, top, right, bottom, width: maxWidth } = tooltipBounds(viewport);
  const width = Math.min(card.width, maxWidth);
  const besideLeft = anchor.left - GAP - width >= left;
  const besideRight = anchor.right + GAP + width <= right;
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

const samePlacement = (current: TooltipPlacement | undefined, next: TooltipPlacement) => current?.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight && current.maxWidth === next.maxWidth;

/** A measured, scrollable map preview, bounded by both its canvas host and the visual viewport. */
export function CanvasTooltip(props: {
  readonly id: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [placement, setPlacement] = useState<TooltipPlacement>();
  const measure = useCallback(() => {
    const element = card.current;
    const host = element?.parentElement;
    if (!element || !host) return;
    const rect = host.getBoundingClientRect();
    const visual = window.visualViewport;
    const viewport = canvasTooltipViewport({
      left: rect.left, top: rect.top,
      width: rect.width || latest.current.viewport.width,
      height: rect.height || latest.current.viewport.height,
    }, { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0, width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight });
    const next = pointerTooltipPlacement(latest.current.point, tooltipContentSize(element), viewport);
    setPlacement(current => samePlacement(current, next) ? current : next);
  }, []);
  // React content changes may alter scrollHeight while the constrained border box stays the same.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element?.parentElement) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(element.parentElement);
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
  }, [measure]);
  return <div ref={card} id={props.id} className="landscape-hover canvas-tooltip" role="tooltip"
    style={{ ...placement, visibility: placement ? "visible" : "hidden", overflow: "auto", overscrollBehavior: "contain", pointerEvents: "auto" }}
    onPointerEnter={props.onPointerEnter} onPointerLeave={props.onPointerLeave}>
    {props.children}
  </div>;
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
      const next = resourceTooltipPlacement(props.anchor.getBoundingClientRect(), tooltipContentSize(element), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      });
      setPlacement(current => samePlacement(current, next) ? current : next);
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
