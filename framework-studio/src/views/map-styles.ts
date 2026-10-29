import type { Mode } from "../../shared/model";
import { DEPLOYMENT_BADGES } from "../deployment";
import { cx } from "../ui/classes";
import type { CSSProperties } from "react";

/** DOM chrome over the always-dark canvas. Geometry is supplied by the caller. */
export function mapTooltipClasses(portal = false) {
  return cx(
    "w-[400px] max-w-[calc(100vw-16px)] overflow-auto overscroll-contain rounded-lg border border-white/16 bg-map-surface p-4 text-label leading-[1.5] text-map-text shadow-popover wrap-anywhere scrollbar-thin [scrollbar-color:#556174_transparent] [&_p]:m-0 [&_dl]:m-0 forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText] forced-colors:[&_strong]:text-[CanvasText] forced-colors:[&_dt]:text-[CanvasText] forced-colors:[&_dd]:text-[CanvasText] forced-colors:[&_p]:text-[CanvasText] forced-colors:[&_span]:text-[CanvasText] forced-colors:[&_[data-environment]]:border-[CanvasText] forced-colors:[&_[data-enabled=false]]:border-dashed",
    portal ? "pointer-events-auto fixed z-40" : "pointer-events-auto absolute z-4",
  );
}

export const mapCameraButtonClasses = "inline-flex h-[calc(var(--control-height)-2px)] w-(--control-height) cursor-pointer items-center justify-center border-0 border-l border-rule bg-transparent text-graphite first:rounded-l-md first:border-l-0 last:rounded-r-md hover:not-disabled:bg-wash hover:not-disabled:text-ink aria-pressed:bg-wash aria-pressed:text-ink disabled:cursor-default disabled:opacity-35";

/** Use the same semantic palette in canvas badges and DOM environment facts. */
export const environmentStyle = (mode: Mode): CSSProperties => ({ "--badge-fg": DEPLOYMENT_BADGES[mode].color, "--badge-bg": DEPLOYMENT_BADGES[mode].background } as CSSProperties);
export const environmentTextClasses = "text-(--badge-fg)";
