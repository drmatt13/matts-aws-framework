/**
 * Isometric projection for the landscape view.
 *
 * The math of the audited Bevy renderer, ported rather than embedded: a
 * 64 × 32 diamond per tile, 16 units per elevation step, and draw order by
 * diagonal row. Screen y grows downward everywhere in this module, the
 * canvas's own convention, so terrain, buildings, edges, the camera and picking
 * all share one frame and none of them flips a sign.
 */

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;
export const ELEVATION_STEP = 16;

const HALF_WIDTH = TILE_WIDTH / 2;
const HALF_HEIGHT = TILE_HEIGHT / 2;

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

/** Grid to world. Elevation lifts a point up the page. */
export function project(point: GridPoint): ScreenPoint {
  return {
    x: (point.x - point.y) * HALF_WIDTH,
    y: (point.x + point.y) * HALF_HEIGHT - (point.h ?? 0) * ELEVATION_STEP,
  };
}

/** World to grid on the plane at elevation `h`: the exact inverse of {@link project} there. */
export function unprojectAt(point: ScreenPoint, h: number): GridPoint {
  const difference = point.x / HALF_WIDTH; // x - y
  const sum = (point.y + h * ELEVATION_STEP) / HALF_HEIGHT; // x + y
  return { x: (sum + difference) / 2, y: (sum - difference) / 2, h };
}

/** World to grid on the ground plane. */
export function unproject(point: ScreenPoint): GridPoint {
  const { x, y } = unprojectAt(point, 0);
  return { x, y };
}

/** Painter's order: rows further back draw first; within a row, lower before higher. */
export function depth(point: GridPoint): number {
  return (point.x + point.y) * 1000 + (point.h ?? 0);
}

/** A tile's top face as a flat [x, y, ...] list, clockwise from the north corner. */
export function tileTopPoints(point: GridPoint): number[] {
  const centre = project(point);
  return [
    centre.x, centre.y - HALF_HEIGHT,
    centre.x + HALF_WIDTH, centre.y,
    centre.x, centre.y + HALF_HEIGHT,
    centre.x - HALF_WIDTH, centre.y,
  ];
}

/** The same face as an SVG points string. */
export function tileTop(point: GridPoint): string {
  const points = tileTopPoints(point);
  const pairs: string[] = [];
  for (let index = 0; index < points.length; index += 2) pairs.push(`${points[index]},${points[index + 1]}`);
  return pairs.join(" ");
}
