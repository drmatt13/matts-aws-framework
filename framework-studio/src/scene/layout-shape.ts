import type { Bounds } from "./camera";
import { ELEVATION_STEP, TILE_HEIGHT, TILE_WIDTH } from "./iso";

/**
 * Projected island geometry for placement, exact in the renderer's own directions.
 *
 * Every edge an island paints runs along one of four screen directions: the two ground
 * diagonals (2:1 across the page), the vertical walls, and the horizontal edges of a
 * screen-aligned title. A convex shape whose edges all lie in those directions is an
 * eight-sided "discrete oriented polytope": its extent along x, y, a = x + 2y and
 * b = x − 2y describes it completely, so two shapes overlap exactly when all four
 * extents overlap. Diamonds can therefore nest diagonally where bounding boxes could not,
 * and a clearance test is eight subtractions rather than a polygon intersection.
 *
 * Coordinates are world pixels relative to an island's layout origin, `(left · 32, top · 16)`.
 */
export interface Dop {
  readonly x0: number; readonly x1: number;
  readonly y0: number; readonly y1: number;
  readonly a0: number; readonly a1: number;
  readonly b0: number; readonly b1: number;
}
/** Layout positions count half tiles: one unit across is 32 world px, one unit down is 16. */
export const UNIT_X = TILE_WIDTH / 2;
export const UNIT_Y = TILE_HEIGHT / 2;
/** Painted clearance between two islands' terrain, walls and headroom, in world px. */
export const ISLAND_CLEARANCE = 56;
/** Captions and plaques above the back row of buildings. */
const HEADROOM = 40;
const ROOT5 = Math.sqrt(5);

/** An island's measured terrain: lattice cells including the rim, elevations in steps. */
export interface IslandGround {
  readonly width: number;
  readonly length: number;
  /** Padding around the grid footprint for a foundation that overhangs it. */
  readonly inset: number;
  readonly top: number;
  readonly base: number;
  /** Cells of foundation margin around the terrain (VPC frames). */
  readonly frame?: number;
}
export interface IslandShape {
  readonly body: Dop;
  /** The left flank a title hangs from: its x and the vertical span it may centre on. */
  readonly flank: { readonly x: number; readonly y: number };
  readonly centre: { readonly x: number; readonly y: number };
}

export function dopOf(points: readonly { readonly x: number; readonly y: number }[]): Dop {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const { x, y } of points) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    a0 = Math.min(a0, x + 2 * y); a1 = Math.max(a1, x + 2 * y); b0 = Math.min(b0, x - 2 * y); b1 = Math.max(b1, x - 2 * y);
  }
  return { x0, x1, y0, y1, a0, a1, b0, b1 };
}
export const shiftDop = (d: Dop, x: number, y: number): Dop => ({ x0: d.x0 + x, x1: d.x1 + x, y0: d.y0 + y, y1: d.y1 + y, a0: d.a0 + x + 2 * y, a1: d.a1 + x + 2 * y, b0: d.b0 + x - 2 * y, b1: d.b1 + x - 2 * y });
export const dopBounds = (d: Dop): Bounds => ({ minX: d.x0, maxX: d.x1, minY: d.y0, maxY: d.y1 });

/** Ground terrain for footprints measured without it (synthetic fixtures): a square deck. */
function groundOf(footprint: { readonly size: number; readonly ground?: IslandGround }): IslandGround {
  return footprint.ground ?? { width: footprint.size / 2, length: footprint.size / 2, inset: 0, top: 2, base: -1 };
}

/** The island's painted envelope, matching `build.ts`'s placement of grid cells from a position. */
export function islandShape(footprint: { readonly size: number; readonly ground?: IslandGround }): IslandShape {
  const { width: w, length: l, inset, top, base, frame } = groundOf(footprint);
  // A tile edge (u, v) cells from the island's north corner, at elevation h.
  const corner = (u: number, v: number, h: number) => ({ x: (inset + l + u - v) * UNIT_X, y: (inset - 1 + u + v) * UNIT_Y - h * ELEVATION_STEP });
  const points = [
    corner(0, 0, top), corner(w, 0, top), corner(w, l, top), corner(0, l, top),
    { ...corner(0, 0, top), y: corner(0, 0, top).y - HEADROOM }, { ...corner(w, 0, top), y: corner(w, 0, top).y - HEADROOM }, { ...corner(0, l, top), y: corner(0, l, top).y - HEADROOM },
    corner(w, 0, base), corner(w, l, base), corner(0, l, base),
  ];
  let flank = { x: corner(0, l, top).x, y: (corner(0, l, top).y + corner(0, l, base).y) / 2 };
  if (frame) {
    const depth = ELEVATION_STEP / 2, h = base - 0.25;
    const outline = [corner(-frame, -frame, h), corner(w + frame, -frame, h), corner(w + frame, l + frame, h), corner(-frame, l + frame, h)];
    points.push(...outline, ...outline.slice(1).map((p) => ({ ...p, y: p.y + depth })));
    flank = { x: outline[3]!.x, y: outline[3]!.y + depth / 2 };
  }
  const body = dopOf(points);
  return { body, flank, centre: { x: (body.x0 + body.x1) / 2, y: (body.y0 + body.y1) / 2 } };
}

/** Island titles are screen-sized; their world size depends on the overview zoom. */
export function titleScale(zoom: number): number { return Math.max(0.8, Math.min(1.15, zoom * 1.6)); }
/** The title's world rectangle at the overview zoom, hanging left of the flank (`placeIslandTitle`). */
export function titleDop(title: string, shape: IslandShape, zoom: number): Dop {
  const scale = titleScale(zoom);
  // Conservative ink for 600-weight Barlow Semi Condensed, the renderer's 10 px gap and 2 px margins.
  const width = (title.length * 7 * scale + 14) / zoom, height = (16 * scale + 6) / zoom;
  const right = shape.flank.x;
  return dopOf([{ x: right - width, y: shape.flank.y - height / 2 }, { x: right, y: shape.flank.y + height / 2 }, { x: right - width, y: shape.flank.y + height / 2 }, { x: right, y: shape.flank.y - height / 2 }]);
}

/**
 * How far `b` must move to clear `a` by `gap` world px, and in which direction: the
 * smallest of the four axis penetrations (a minimum translation vector). Zero when clear.
 */
export function penetration(a: Dop, b: Dop, gap: number): { readonly depth: number; readonly x: number; readonly y: number } {
  const g5 = gap * ROOT5;
  // Overlap along each axis, in that axis's own units, and the per-unit world distance.
  const candidates: [number, number, number, number][] = [
    [Math.min(a.x1 + gap - b.x0, b.x1 + gap - a.x0), 1, b.x0 + b.x1 >= a.x0 + a.x1 ? 1 : -1, 0],
    [Math.min(a.y1 + gap - b.y0, b.y1 + gap - a.y0), 1, 0, b.y0 + b.y1 >= a.y0 + a.y1 ? 1 : -1],
    [Math.min(a.a1 + g5 - b.a0, b.a1 + g5 - a.a0), ROOT5, 0, b.a0 + b.a1 >= a.a0 + a.a1 ? 1 : -1],
    [Math.min(a.b1 + g5 - b.b0, b.b1 + g5 - a.b0), ROOT5, 0, b.b0 + b.b1 >= a.b0 + a.b1 ? 1 : -1],
  ];
  let best = { depth: Infinity, x: 0, y: 0 };
  for (const [at, [overlap, norm, sx, sy]] of candidates.entries()) {
    if (overlap <= 0) return { depth: 0, x: 0, y: 0 };
    const depth = overlap / norm;
    if (depth >= best.depth) continue;
    // Unit directions: x, y, and the two ground-diagonal normals (1, ±2)/√5.
    best = at === 2 ? { depth, x: sy / ROOT5, y: 2 * sy / ROOT5 } : at === 3 ? { depth, x: sy / ROOT5, y: -2 * sy / ROOT5 } : { depth, x: sx, y: sy };
  }
  return best;
}
export const overlaps = (a: Dop, b: Dop, gap = 0) => depth(a, 0, 0, b, 0, 0, gap) > 0;
/**
 * The same penetration depth for shapes offset by (ax, ay) and (bx, by), without allocating:
 * the hot path of every clearance test during placement.
 */
export function depth(a: Dop, ax: number, ay: number, b: Dop, bx: number, by: number, gap: number): number {
  const x = Math.min(a.x1 + ax + gap - b.x0 - bx, b.x1 + bx + gap - a.x0 - ax);
  if (x <= 0) return 0;
  const y = Math.min(a.y1 + ay + gap - b.y0 - by, b.y1 + by + gap - a.y0 - ay);
  if (y <= 0) return 0;
  const g5 = gap * ROOT5, aa = ax + 2 * ay, ba = bx + 2 * by, ab = ax - 2 * ay, bb = bx - 2 * by;
  const along = Math.min(a.a1 + aa + g5 - b.a0 - ba, b.a1 + ba + g5 - a.a0 - aa);
  if (along <= 0) return 0;
  const across = Math.min(a.b1 + ab + g5 - b.b0 - bb, b.b1 + bb + g5 - a.b0 - ab);
  if (across <= 0) return 0;
  return Math.min(x, y, along / ROOT5, across / ROOT5);
}

/** The width of the widest empty band between two shapes, along any of the four axes; 0 when they touch. */
export function separation(a: Dop, b: Dop): number {
  return Math.max(0, b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1, (b.a0 - a.a1) / ROOT5, (a.a0 - b.a1) / ROOT5, (b.b0 - a.b1) / ROOT5, (a.b0 - b.b1) / ROOT5);
}
/** Whether a segment enters the shape's interior: Cyrus–Beck clipping against its eight sides. */
export function segmentHitsDop(d: Dop, ax: number, ay: number, bx: number, by: number): boolean {
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number, lo: number, hi: number) => {
    // p + t·q must lie strictly within (lo, hi).
    if (Math.abs(q) < 1e-12) return p > lo && p < hi;
    let enter = (lo - p) / q, leave = (hi - p) / q;
    if (enter > leave) [enter, leave] = [leave, enter];
    t0 = Math.max(t0, enter); t1 = Math.min(t1, leave);
    return t0 < t1;
  };
  const dx = bx - ax, dy = by - ay;
  return clip(ax, dx, d.x0, d.x1) && clip(ay, dy, d.y0, d.y1) && clip(ax + 2 * ay, dx + 2 * dy, d.a0, d.a1) && clip(ax - 2 * ay, dx - 2 * dy, d.b0, d.b1);
}
export function pathHitsDop(points: readonly { readonly x: number; readonly y: number }[], d: Dop): boolean {
  for (let at = 1; at < points.length; at++) {
    const a = points[at - 1]!, b = points[at]!;
    if (Math.max(a.x, b.x) <= d.x0 || Math.min(a.x, b.x) >= d.x1 || Math.max(a.y, b.y) <= d.y0 || Math.min(a.y, b.y) >= d.y1) continue;
    if (segmentHitsDop(d, a.x, a.y, b.x, b.y)) return true;
  }
  return false;
}

/** The shape's horizontal extent between two heights: exact, since every side is a half-plane. */
function span(d: Dop, y0: number, y1: number): { readonly left: number; readonly right: number } {
  // x ≥ a0 − 2y and x ≥ b0 + 2y bind at the band's end that is tighter for each.
  const left = Math.max(d.x0, Math.min(d.a0 - 2 * y0, d.a0 - 2 * y1), Math.min(d.b0 + 2 * y0, d.b0 + 2 * y1));
  const right = Math.min(d.x1, Math.max(d.a1 - 2 * y0, d.a1 - 2 * y1), Math.max(d.b1 + 2 * y0, d.b1 + 2 * y1));
  return { left, right };
}
/**
 * Axis-aligned boxes that hug the shape, for consumers that test boxes (the connection
 * router). Horizontal slabs each cover the shape's widest extent within their band, so
 * together they contain it while leaving a diamond's empty corners clear.
 */
export function dopBoxes(d: Dop, slabs = 4): readonly Bounds[] {
  const boxes: Bounds[] = [];
  for (let at = 0; at < slabs; at++) {
    const minY = d.y0 + (d.y1 - d.y0) * at / slabs, maxY = d.y0 + (d.y1 - d.y0) * (at + 1) / slabs;
    const { left, right } = span(d, minY, maxY);
    if (right > left) boxes.push({ minX: left, maxX: right, minY, maxY });
  }
  return boxes;
}
/** The shape's outline, clockwise from its top-left, for debugging and tests. */
export function dopPolygon(d: Dop): readonly { readonly x: number; readonly y: number }[] {
  const lines: [number, number, number][] = [
    // n·p ≤ c as [nx, ny, c], clockwise from the top edge.
    [0, -1, -d.y0], [1, -2, d.b1], [1, 0, d.x1], [1, 2, d.a1], [0, 1, d.y1], [-1, 2, -d.b0], [-1, 0, -d.x0], [-1, -2, -d.a0],
  ];
  const points: { x: number; y: number }[] = [];
  for (let at = 0; at < lines.length; at++) {
    const [a1, b1, c1] = lines[at]!, [a2, b2, c2] = lines[(at + 1) % lines.length]!;
    const det = a1 * b2 - a2 * b1;
    const point = { x: (c1 * b2 - c2 * b1) / det, y: (a1 * c2 - a2 * c1) / det };
    const last = points.at(-1);
    if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 1e-6) points.push(point);
  }
  return points;
}
