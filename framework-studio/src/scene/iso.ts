/**
 * Isometric projection for the network landscape (a later phase).
 *
 * The math of the audited Bevy renderer, ported rather than embedded: a
 * 64 × 32 diamond per tile, 16 units per elevation step, and draw order by
 * diagonal row. Kept here, tested, and free of any renderer, so whatever draws
 * the landscape — SVG now, a canvas if a measured need appears — projects the
 * same way.
 */

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;
export const ELEVATION_STEP = 16;

export interface GridPoint {
  readonly x: number;
  readonly y: number;
  /** Elevation in steps above the ground plane. */
  readonly h?: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Grid to screen. Screen y grows downward, so elevation lifts a point up the page. */
export function project(point: GridPoint): ScreenPoint {
  return {
    x: (point.x - point.y) * (TILE_WIDTH / 2),
    y: (point.x + point.y) * (TILE_HEIGHT / 2) - (point.h ?? 0) * ELEVATION_STEP,
  };
}

/** Screen to grid on the ground plane: the inverse of {@link project} at h = 0, for picking. */
export function unproject(point: ScreenPoint): GridPoint {
  const a = point.x / (TILE_WIDTH / 2);
  const b = point.y / (TILE_HEIGHT / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Painter's order: rows further back draw first; within a row, lower before higher. */
export function depth(point: GridPoint): number {
  return (point.x + point.y) * 1000 + (point.h ?? 0);
}

/** The four corners of a tile's top face, clockwise from the top, as an SVG points string. */
export function tileTop(point: GridPoint): string {
  const centre = project(point);
  const halfWidth = TILE_WIDTH / 2;
  const halfHeight = TILE_HEIGHT / 2;
  return [
    [centre.x, centre.y - halfHeight],
    [centre.x + halfWidth, centre.y],
    [centre.x, centre.y + halfHeight],
    [centre.x - halfWidth, centre.y],
  ]
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}
