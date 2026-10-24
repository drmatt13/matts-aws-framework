import type { Bounds, Point } from "./camera";

export interface Obstacle { readonly id: string; readonly bounds: Bounds }
export const intersects = (a: Bounds, b: Bounds, gap = 0) => a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;
export const translated = (box: Bounds, x: number, y: number): Bounds => ({ minX: box.minX + x, maxX: box.maxX + x, minY: box.minY + y, maxY: box.maxY + y });
export function boundsOf(boxes: readonly Bounds[]): Bounds {
  return boxes.length ? { minX: Math.min(...boxes.map((b) => b.minX)), maxX: Math.max(...boxes.map((b) => b.maxX)), minY: Math.min(...boxes.map((b) => b.minY)), maxY: Math.max(...boxes.map((b) => b.maxY)) } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}
/** A conservative envelope for every segment of a sampled path. */
export function pathBounds(points: readonly Point[]): Bounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY };
}
const orient = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
/** Strict crossings exclude shared endpoints and collinear/overdrawn segments. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  return orient(a, b, c) * orient(a, b, d) < -0.0001 && orient(c, d, a) * orient(c, d, b) < -0.0001;
}
export function pathsCross(a: readonly Point[], b: readonly Point[]): boolean {
  for (let i = 1; i < a.length; i++) {
    const start = a[i - 1]!, end = a[i]!;
    const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
    for (let j = 1; j < b.length; j++) {
      const c = b[j - 1]!, d = b[j]!;
      if (c.x <= minX && d.x <= minX || c.x >= maxX && d.x >= maxX
        || c.y <= minY && d.y <= minY || c.y >= maxY && d.y >= maxY) continue;
      if (segmentsCross(start, end, c, d)) return true;
    }
  }
  return false;
}
export function pathHits(points: readonly Point[], box: Bounds): boolean {
  const topLeft = { x: box.minX, y: box.minY }, topRight = { x: box.maxX, y: box.minY };
  const bottomRight = { x: box.maxX, y: box.maxY }, bottomLeft = { x: box.minX, y: box.maxY };
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY) return true;
    if (!i) continue;
    const a = points[i - 1]!;
    if (a.x <= box.minX && p.x <= box.minX || a.x >= box.maxX && p.x >= box.maxX
      || a.y <= box.minY && p.y <= box.minY || a.y >= box.maxY && p.y >= box.maxY) continue;
    if (segmentsCross(a, p, topLeft, topRight) || segmentsCross(a, p, topRight, bottomRight)
      || segmentsCross(a, p, bottomRight, bottomLeft) || segmentsCross(a, p, bottomLeft, topLeft)) return true;
  }
  return false;
}
export const pathLength = (points: readonly Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0);
