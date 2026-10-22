import type { Viewport } from "./camera";
import { acceptCards, type CardHit } from "./picking";

/** A fixed caption above each plaque, in projected world units. */
export const NODE_CAPTION = { width: 160, offset: -64, height: 40, minOpacity: 0.25, hoverDuration: 0.12 } as const;
/** The deployment tag sits on the plinth's front edge, separate from its name. */
export const NODE_DEPLOYMENT_TAG = { offset: 10, height: 15 } as const;
export type LabelRect = Omit<CardHit, "id">;

/** Screen-space section labels retain legible type instead of following a terrain face. */
export const SUBNET_LABEL = { fontSize: 13, fullSizeZoom: 0.65, fullOpacityZoom: 0.5, fadeStartZoom: 0.08, minOpacity: 0.5, height: 28, padding: 10, cue: 12, radius: 6, gap: 6, minSpacing: 4, endCapBalance: 0.5 } as const;

/** Align the card's bottom-left corner with the middle of its zone's top-right rim. */
export function subnetLabelRect(anchor: { x: number; y: number }, width: number, height: number, scale: number, rimEndX = Infinity, previous?: LabelRect): LabelRect {
  const gap = SUBNET_LABEL.gap * scale;
  const desiredX = anchor.x + gap;
  const correction = Math.min(0, rimEndX + gap - width - desiredX);
  const x = desiredX + correction * SUBNET_LABEL.endCapBalance;
  // Balance the trailing name between its midpoint and the VPC end cap, moving
  // along the rim's 1:2 slope. This bound is terrain, never viewport.
  const rect = { x, y: anchor.y - gap / 2 - height + (x - anchor.x - gap) / 2, width, height };
  const spacing = Math.max(SUBNET_LABEL.minSpacing, gap);
  if (previous && rectanglesOverlap(rect, previous, spacing)) {
    // The smallest down/right slide that clears the previous name along this
    // same rail. Min/max keep the solution continuous through zoom changes.
    const slide = Math.max(0, Math.min(previous.x + previous.width + spacing - rect.x, 2 * (previous.y + previous.height + spacing - rect.y)));
    rect.x += slide;
    rect.y += slide / 2;
  }
  return rect;
}

/** Let names shrink more gently than the scene, without oversized screen-fixed labels. */
export function nodeCaptionPresentation(zoom: number): { scale: number; detail: number; gap: number } {
  const progress = Math.max(0, Math.min(1, (zoom - 0.18) / (0.85 - 0.18)));
  const scale = zoom < 0.9 ? 0.9 * Math.pow(zoom / 0.9, 0.65) : Math.min(1.2, zoom);
  return { scale, detail: progress * progress * (3 - 2 * progress), gap: 3 * Math.min(1, zoom / 0.9) };
}

/** Full readable type in detail views, with node-caption scaling and a later overview fade. */
export function subnetLabelPresentation(zoom: number): { scale: number; alpha: number; plateAlpha: number } {
  const { scale } = nodeCaptionPresentation(zoom);
  const progress = Math.max(0, Math.min(1, (zoom - SUBNET_LABEL.fadeStartZoom) / (SUBNET_LABEL.fullOpacityZoom - SUBNET_LABEL.fadeStartZoom)));
  const detail = progress * progress * (3 - 2 * progress);
  const alpha = SUBNET_LABEL.minOpacity + (1 - SUBNET_LABEL.minOpacity) * detail;
  return { scale: Math.min(1, scale / nodeCaptionPresentation(SUBNET_LABEL.fullSizeZoom).scale), alpha, plateAlpha: alpha * alpha };
}

export function rectanglesOverlap(a: LabelRect, b: LabelRect, gap = 3): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * Captions stay attached to their plinths. Never move one in response to hover,
 * wires or zoom: suppress a caption if its fixed slot is obstructed instead.
 * Hover/inspector details retain the full name at every zoom.
 */
export function visibleNodeCaptions<T extends CardHit & { priority: number; order: number }>(
  candidates: readonly T[], obstacles: readonly LabelRect[], viewport: Viewport, gap = 3,
): T[] {
  return acceptCards(candidates.filter((card) => card.x >= 6 && card.y >= 6 &&
    card.x + card.width <= viewport.width - 6 && card.y + card.height <= viewport.height - 6 &&
    obstacles.every((obstacle) => !rectanglesOverlap(card, obstacle, gap))), gap);
}
