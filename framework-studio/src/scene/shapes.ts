/** Service plaques, plinth faces and picking silhouettes in projected world space. */
/** Room for an icon, its corner badges and a caption on the next line. */
export const NODE_SPACING = 4;

export interface Face { readonly points: readonly number[] }

export interface Shape {
  readonly faces: readonly Face[];
  /** Where edges attach and the label card hangs: the top of the building. */
  readonly top: { readonly x: number; readonly y: number };
  /** Convex silhouette, for picking. */
  readonly hull: readonly number[];
  readonly height: number;
}

/** Small role or endpoint-service icon on the lower-right corner of a plaque. */
export const ICON_BADGE = { x: 14, y: -30, size: 24, padding: 3 } as const;

/** A service icon on a low isometric plinth. Hull includes the plaque and optional badge. */
export function buildIconShape(x: number, y: number, withBadge = false): Shape {
  return {
    faces: [
      { points: [x - 25, y - 2, x, y + 10, x, y + 15, x - 25, y + 3] },
      { points: [x, y + 10, x + 25, y - 2, x + 25, y + 3, x, y + 15] },
      { points: [x, y - 14, x + 25, y - 2, x, y + 10, x - 25, y - 2] },
    ],
    top: { x, y: y - 54 },
    hull: [x - 24, y - 54, x + 24, y - 54,
      ...(withBadge ? [x + ICON_BADGE.x + ICON_BADGE.size + 1, y + ICON_BADGE.y - 1,
        x + ICON_BADGE.x + ICON_BADGE.size + 1, y + ICON_BADGE.y + ICON_BADGE.size + 1] : []),
      x + 25, y - 2, x + 25, y + 3, x, y + 15, x - 25, y + 3, x - 25, y - 2],
    height: 54,
  };
}
