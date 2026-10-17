import type { IslandSlab } from "./slabs";
import type { Point } from "./camera";

/** Boundary segments of joined surface faces; shared tile edges are internal. */
export function surfaceOutline(polygons: readonly (readonly number[])[]): readonly number[] {
  const edges = new Map<string, { points: readonly number[]; count: number }>();
  for (const polygon of polygons) {
    for (let at = 0; at < polygon.length; at += 2) {
      const next = (at + 2) % polygon.length;
      const points = [polygon[at]!, polygon[at + 1]!, polygon[next]!, polygon[next + 1]!];
      const a = `${points[0]!.toFixed(6)},${points[1]!.toFixed(6)}`;
      const b = `${points[2]!.toFixed(6)},${points[3]!.toFixed(6)}`;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key);
      if (edge) edge.count += 1;
      else edges.set(key, { points, count: 1 });
    }
  }
  return [...edges.values()].flatMap((edge) => edge.count === 1 ? [...edge.points] : []);
}

/**
 * What is under the pointer.
 *
 * Everything is tested in the order it is painted, from the front: label
 * cards first (they are drawn over everything), then buildings by their
 * silhouettes, then painted slabs by their top faces and front walls — never
 * by a ground-plane inverse, which would pick the ground behind raised terrain.
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

/** Horizontal extent of a projected polygon within a screen-space horizontal band. */
function polygonStrip(polygon: readonly number[], top: number, bottom: number): { left: number; right: number } {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  const include = (x: number) => { left = Math.min(left, x); right = Math.max(right, x); };
  for (let at = 0, previous = polygon.length - 2; at < polygon.length; previous = at, at += 2) {
    const x = polygon[at]!;
    const y = polygon[at + 1]!;
    const px = polygon[previous]!;
    const py = polygon[previous + 1]!;
    if (y >= top && y <= bottom) include(x);
    if (y === py) continue;
    for (const edge of [top, bottom]) {
      const t = (edge - py) / (y - py);
      if (t >= 0 && t <= 1) include(px + (x - px) * t);
    }
  }
  return { left, right };
}

/**
 * A right-aligned island title, just outside its actual projected left flank.
 * All inputs and the gap are CSS pixels. Use the whole ink height against the
 * outline, including walls, so a sloping edge cannot cut through the text.
 * A collision slides the title along that same flank, never farther into the void.
 */
export function placeIslandTitle(
  polygons: readonly (readonly number[])[],
  size: { readonly width: number; readonly height: number },
  obstacles: readonly (readonly number[])[],
  gap = 10,
): Omit<CardHit, "id"> | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let flankTop = Number.POSITIVE_INFINITY;
  let flankBottom = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (let at = 0; at < polygon.length; at += 2) {
      const x = polygon[at]!;
      const y = polygon[at + 1]!;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      // Projected vertices on the same flank can differ by floating-point noise.
      // Treat them as one edge so a pan cannot switch the anchor between its ends.
      if (x < left - 1e-7) { left = x; flankTop = y; flankBottom = y; }
      else if (x <= left + 1e-7) {
        left = Math.min(left, x);
        flankTop = Math.min(flankTop, y);
        flankBottom = Math.max(flankBottom, y);
      }
    }
  }
  if (!Number.isFinite(left)) return undefined;
  const preferred = (flankTop + flankBottom) / 2;
  const reach = Math.max(preferred - top, bottom - preferred);
  for (let distance = 0; distance <= reach + 4; distance += 4) {
    for (const centre of distance === 0 ? [preferred] : [preferred - distance, preferred + distance]) {
      if (centre < top || centre > bottom) continue;
      const y = centre - size.height / 2;
      const edge = Math.min(...polygons.map((polygon) => polygonStrip(polygon, y, y + size.height).left));
      if (!Number.isFinite(edge)) continue;
      const x = edge - gap - size.width;
      const margin = 2;
      const clash = obstacles.some((polygon) => {
        const span = polygonStrip(polygon, y - margin, y + size.height + margin);
        return span.left < x + size.width + margin && span.right > x - margin;
      });
      if (!clash) return { x, y, ...size };
    }
  }
  // As with entity cards, leave out a title only when no clear flank position exists.
  return undefined;
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

/** The frontmost painted slab face under a world point, using the actual island geometry. */
export function pickIsland(world: Point, slabs: readonly IslandSlab[]): { id: string; band: string } | undefined {
  for (let index = slabs.length - 1; index >= 0; index -= 1) {
    const slab = slabs[index]!;
    for (let at = slab.bands.length - 1; at >= 0; at -= 1) {
      const band = slab.bands[at]!;
      if ([band.top, ...band.walls.map((wall) => wall.quad)].some((polygon) => insidePolygon(world.x, world.y, polygon))) return { id: slab.island.id, band: band.id };
    }
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
