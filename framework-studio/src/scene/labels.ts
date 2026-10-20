import type { Viewport } from "./camera";
import { acceptCards, type CardHit } from "./picking";

/** A fixed caption above each plaque, in projected world units. */
export const NODE_CAPTION = { width: 160, offset: -64, height: 40, minZoom: 0.55 } as const;
/** The deployment tag sits on the plinth's front edge, separate from its name. */
export const NODE_DEPLOYMENT_TAG = { offset: 10, height: 15 } as const;
export type LabelRect = Omit<CardHit, "id">;

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
  candidates: readonly T[], obstacles: readonly LabelRect[], viewport: Viewport,
): T[] {
  return acceptCards(candidates.filter((card) => card.x >= 6 && card.y >= 6 &&
    card.x + card.width <= viewport.width - 6 && card.y + card.height <= viewport.height - 6 &&
    obstacles.every((obstacle) => !rectanglesOverlap(card, obstacle))), 3);
}
