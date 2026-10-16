import { ELEVATION_STEP, project } from "./iso";
import type { Point } from "./camera";

/**
 * What is under the pointer.
 *
 * Everything is tested in the order it is painted, from the front: label
 * cards first (they are drawn over everything), then buildings by their
 * silhouettes, then terrain tiles by their top faces and front walls at their
 * own heights — never by a ground-plane inverse, which would pick the tile
 * behind a raised one.
 */

/** Even-odd point-in-polygon over a flat [x, y, ...] list. */
export function insidePolygon(x: number, y: number, points: readonly number[]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 2; index < points.length; previous = index, index += 2) {
    const xi = points[index]!;
    const yi = points[index + 1]!;
    const xj = points[previous]!;
    const yj = points[previous + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface CardHit {
  readonly id: string;
  /** Screen rectangle, CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Which label cards to draw: the highest priority first, then from the front,
 * each kept only if it lands clear of every card already kept. Returns the
 * kept cards in their original (painter's) order.
 */
export function acceptCards<T extends { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly priority: number; readonly order: number }>(
  candidates: readonly T[],
  margin = 2,
): T[] {
  const accepted: T[] = [];
  for (const card of [...candidates].sort((a, b) => b.priority - a.priority || b.order - a.order)) {
    const clash = accepted.some(
      (other) =>
        card.x < other.x + other.width + margin &&
        other.x < card.x + card.width + margin &&
        card.y < other.y + other.height + margin &&
        other.y < card.y + card.height + margin,
    );
    if (!clash) accepted.push(card);
  }
  return accepted.sort((a, b) => a.order - b.order);
}

export interface Silhouette {
  readonly id: string;
  /** World polygon. */
  readonly hull: readonly number[];
}

/**
 * The entity under a point: `cards` in screen space and `buildings` in world
 * space, each in painter's order (so the last one that contains the point is
 * the one on top).
 */
export function pickEntity(
  screen: Point,
  world: Point,
  cards: readonly CardHit[],
  buildings: readonly Silhouette[],
): string | undefined {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index]!;
    if (screen.x >= card.x && screen.x <= card.x + card.width && screen.y >= card.y && screen.y <= card.y + card.height) return card.id;
  }
  for (let index = buildings.length - 1; index >= 0; index -= 1) {
    if (insidePolygon(world.x, world.y, buildings[index]!.hull)) return buildings[index]!.id;
  }
  return undefined;
}

export interface TileShape {
  readonly gx: number;
  readonly gy: number;
  readonly h: number;
  readonly wallLeft?: number;
  readonly wallRight?: number;
}

/** A tile's top face and the front walls it shows, as world polygons. */
export function tilePolygons(tile: TileShape): number[][] {
  const centre = project({ x: tile.gx, y: tile.gy, h: tile.h });
  const north = [centre.x, centre.y - 16];
  const east = [centre.x + 32, centre.y];
  const south = [centre.x, centre.y + 16];
  const west = [centre.x - 32, centre.y];
  const polygons = [[...north, ...east, ...south, ...west]];
  if (tile.wallLeft !== undefined) {
    const drop = (tile.h - tile.wallLeft) * ELEVATION_STEP;
    polygons.push([...west, ...south, south[0]!, south[1]! + drop, west[0]!, west[1]! + drop]);
  }
  if (tile.wallRight !== undefined) {
    const drop = (tile.h - tile.wallRight) * ELEVATION_STEP;
    polygons.push([...south, ...east, east[0]!, east[1]! + drop, south[0]!, south[1]! + drop]);
  }
  return polygons;
}

/** The frontmost tile whose top or visible walls contain a world point. Tiles in painter's order. */
export function pickTile<T extends TileShape>(world: Point, tiles: readonly T[]): T | undefined {
  for (let index = tiles.length - 1; index >= 0; index -= 1) {
    const tile = tiles[index]!;
    const centre = project({ x: tile.gx, y: tile.gy, h: tile.h });
    // Cheap rejection: nothing of a tile lies outside its column.
    if (Math.abs(world.x - centre.x) > 32 || world.y < centre.y - 16) continue;
    if (tilePolygons(tile).some((polygon) => insidePolygon(world.x, world.y, polygon))) return tile;
  }
  return undefined;
}

/** A quadratic Bézier from `a` to `b` arching up through `control`, sampled. */
export function arcPoints(a: Point, control: Point, b: Point, samples = 24): Point[] {
  const points: Point[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const u = 1 - t;
    points.push({ x: u * u * a.x + 2 * u * t * control.x + t * t * b.x, y: u * u * a.y + 2 * u * t * control.y + t * t * b.y });
  }
  return points;
}

/** The control point that lifts an edge into an arc above the landscape. */
export function arcControl(a: Point, b: Point): Point {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 24 - length * 0.16 };
}

/** Distance from a point to a polyline. */
export function distanceToPolyline(point: Point, polyline: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1]!;
    const b = polyline[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}
