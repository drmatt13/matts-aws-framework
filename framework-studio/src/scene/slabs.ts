import { chamferSize, type Island, type Scene } from "./build";
import type { Bounds } from "./camera";
import { ELEVATION_STEP, project } from "./iso";
import { GRAPHITE } from "./look";

/**
 * The graphite look's terrain: each island as one continuous slab rather than
 * a field of tiles.
 *
 * An island is its grid rectangle with its four corners chamfered. Each band
 * (a VPC terrace, or the whole island) is that outline's strip of columns at
 * the band's height. Only edges that face the viewer get a wall: the two front
 * edges and the front facet fall to the island's floor, and a terrace that
 * stands higher than the next one steps down to it. Everything here is plain
 * numbers, so it runs and is tested under Node; the renderer turns it into
 * paths and gradients once per scene.
 */

type Uv = readonly [number, number];

export type WallSide = "left" | "right" | "front";

export interface WallRun {
  readonly side: WallSide;
  /** Its top edge, left end first, then the two lower corners. */
  readonly quad: readonly number[];
  /** Falls to the island's floor, rather than stepping down to the next terrace. */
  readonly rim: boolean;
  readonly depth: number;
  /** Its top edge, left end first. */
  readonly lip: readonly [number, number, number, number];
  /** Linear-gradient endpoints: constant along the top edge, 0 there and 1 at the wall's foot. */
  readonly gradient: readonly [number, number, number, number];
}

export interface BandSlab {
  readonly id: string;
  readonly index: number;
  readonly h: number;
  /** The band's top in grid cells, [gx, gy, ...]: its strip of the chamfered outline. */
  readonly region: readonly number[];
  /** The same top in world units. */
  readonly top: readonly number[];
  /** The top's edges that face the viewer, as one polyline in world units: where the trim runs. */
  readonly front: readonly number[];
  readonly walls: readonly WallRun[];
  /** A darkening strip on this terrace at the foot of the step down from the one behind it. */
  readonly stepShade?: { readonly polygon: readonly number[]; readonly gradient: readonly [number, number, number, number] };
  /** Hairlines along tile edges, as segments [x0, y0, x1, y1, ...]. They overrun the chamfers; clip to `top`. */
  readonly grid: readonly number[];
  /** An inset diamond under each building and fixture standing on this band, by its id. */
  readonly pads: readonly { readonly id: string; readonly points: readonly number[] }[];
  readonly bounds: Bounds;
}

export interface IslandSlab {
  readonly island: Island;
  /** The chamfered outline in grid cells, [gx, gy, ...], clockwise on screen from the back. */
  readonly outline: readonly number[];
  /** The same outline at the top of the island, in world units: the rim of a deck seen as one piece. */
  readonly rim: readonly number[];
  /** Its bands are zones on one continuous deck (an unbuilt network), not terraces standing apart. */
  readonly deck: boolean;
  readonly bands: readonly BandSlab[];
  /** The outline cast onto a floor far below, from its sharp core outward. */
  readonly shadow: readonly (readonly number[])[];
  /** The slab itself: tops and walls, with headroom for what stands on it. */
  readonly bounds: Bounds;
  readonly shadowBounds: Bounds;
}

const EPSILON = 1e-9;
/** Room above a slab for the plaques standing on it. */
const HEADROOM = 60;
const PAD = 0.82;
const SHADE_WIDTH = 0.7;

/** A chamfered rectangle in grid space, clockwise on screen starting from the back corner's cut. */
function octagon(x0: number, y0: number, x1: number, y1: number, cut: number): Uv[] {
  return dedupe([
    [x0 + cut, y0], [x1 - cut, y0],
    [x1, y0 + cut], [x1, y1 - cut],
    [x1 - cut, y1], [x0 + cut, y1],
    [x0, y1 - cut], [x0, y0 + cut],
  ]);
}

function dedupe(points: readonly Uv[]): Uv[] {
  const out: Uv[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - point[0]) > EPSILON || Math.abs(last[1] - point[1]) > EPSILON) out.push(point);
  }
  while (out.length > 1 && Math.abs(out[0]![0] - out[out.length - 1]![0]) <= EPSILON && Math.abs(out[0]![1] - out[out.length - 1]![1]) <= EPSILON) out.pop();
  return out;
}

/** One Sutherland–Hodgman pass against the column line u = `at`, keeping the side `keep` accepts. */
function clipColumn(points: readonly Uv[], at: number, keep: (u: number) => boolean): Uv[] {
  const out: Uv[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const inA = keep(a[0]);
    const inB = keep(b[0]);
    if (inA) out.push(a);
    if (inA !== inB) {
      const t = (at - a[0]) / (b[0] - a[0]);
      out.push([at, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return dedupe(out);
}

function flat(points: readonly Uv[]): number[] {
  return points.flatMap(([u, v]) => [u, v]);
}

function world(points: readonly Uv[], h: number): number[] {
  return points.flatMap(([u, v]) => {
    const point = project({ x: u, y: v, h });
    return [point.x, point.y];
  });
}

/** Signed shoelace area of a flat [x, y, ...] polygon. */
export function polygonArea(points: readonly number[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 2) {
    const next = (index + 2) % points.length;
    area += points[index]! * points[next + 1]! - points[next]! * points[index + 1]!;
  }
  return area / 2;
}

/**
 * Gradient endpoints for a band of colour that is constant along a line
 * through `from` in direction `along`, and reaches 1 at `to`.
 */
function across(from: { x: number; y: number }, along: { x: number; y: number }, to: { x: number; y: number }): [number, number, number, number] {
  const length = Math.hypot(along.x, along.y);
  let nx = -along.y / length;
  let ny = along.x / length;
  const reach = nx * (to.x - from.x) + ny * (to.y - from.y);
  if (reach < 0) {
    nx = -nx;
    ny = -ny;
  }
  const distance = Math.abs(reach);
  return [from.x, from.y, from.x + nx * distance, from.y + ny * distance];
}

function boundsOf(lists: readonly (readonly number[])[], headroom = 0): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const points of lists) {
    for (let index = 0; index < points.length; index += 2) {
      minX = Math.min(minX, points[index]!);
      maxX = Math.max(maxX, points[index]!);
      minY = Math.min(minY, points[index + 1]!);
      maxY = Math.max(maxY, points[index + 1]!);
    }
  }
  return { minX, minY: minY - headroom, maxX, maxY };
}

function islandSlab(island: Island, standing: readonly { readonly id: string; readonly gx: number; readonly gy: number }[]): IslandSlab {
  const x0 = island.gx0 - 0.5;
  const y0 = island.gy0 - 0.5;
  const x1 = island.gx1 + 0.5;
  const y1 = island.gy1 + 0.5;
  const cut = chamferSize(island.gx1 - island.gx0 + 1, island.gy1 - island.gy0 + 1);
  const outline = octagon(x0, y0, x1, y1, cut);
  const floor = island.base;

  // A terraced island's slabs stand apart by a narrow seam, each a deck of its own. An unbuilt network is the
  // exception: its subnets are zones on one continuous deck, level and flush, with no wall between them. A
  // built network keeps its separate terraces.
  const deck = island.ghost === "blueprint" && island.bands.length > 1 && island.bands.every((band) => band.h === island.bands[0]!.h);
  const seam = island.bands.length > 1 && !deck ? GRAPHITE.terraceGap / 2 : 0;
  const bands = island.bands.map((band, index): BandSlab => {
    const u0 = band.gx0 - 0.5 + (index > 0 ? seam : 0);
    const u1 = band.gx1 + 0.5 - (index < island.bands.length - 1 ? seam : 0);
    const region = clipColumn(clipColumn(outline, u0, (u) => u >= u0 - EPSILON), u1, (u) => u <= u1 + EPSILON);
    const next = island.bands[index + 1];
    const previous = island.bands[index - 1];
    const steps = next !== undefined && next.h < band.h;
    const walls: WallRun[] = [];
    const facing: boolean[] = [];
    for (let at = 0; at < region.length; at += 1) {
      const a = region[at]!;
      const b = region[(at + 1) % region.length]!;
      const du = b[0] - a[0];
      const dv = b[1] - a[1];
      // Clockwise on screen, so the outward normal is (dv, -du); it faces the viewer when it points down the screen.
      const nu = dv;
      const nv = -du;
      const toward = nu + nv;
      const column = Math.abs(du) <= EPSILON;
      // Beside a seam, a band's right edge is open to the viewer and falls to the floor like a
      // rim; without one, it is a step down to the next terrace, or no edge at all.
      const innerRight = column && Math.abs(a[0] - u1) <= EPSILON && u1 < x1 - EPSILON && seam === 0;
      const innerLeft = column && Math.abs(a[0] - u0) <= EPSILON && u0 > x0 + EPSILON;
      const hidden = innerLeft || (innerRight && !steps);
      facing.push(!hidden && toward > -EPSILON);
      if (hidden || toward <= EPSILON) continue;
      const depth = (innerRight ? band.h - next!.h : band.h - floor) * ELEVATION_STEP;
      const p = project({ x: a[0], y: a[1], h: band.h });
      const q = project({ x: b[0], y: b[1], h: band.h });
      const [left, right] = p.x <= q.x ? [p, q] : [q, p];
      walls.push({
        side: Math.abs(nv) <= EPSILON ? "right" : Math.abs(nu) <= EPSILON ? "left" : "front",
        quad: [left.x, left.y, right.x, right.y, right.x, right.y + depth, left.x, left.y + depth],
        rim: !innerRight,
        depth,
        lip: [left.x, left.y, right.x, right.y],
        gradient: across(left, { x: right.x - left.x, y: right.y - left.y }, { x: left.x, y: left.y + depth }),
      });
    }

    // The front edges form one unbroken run around a convex outline: start where it begins
    // (edge `at` runs from point `at` to the next), and follow it while edges face the viewer.
    const front: number[] = [];
    const start = facing.every(Boolean) ? 0 : facing.findIndex((value, at) => value && !facing[(at - 1 + facing.length) % facing.length]);
    if (start >= 0) {
      front.push(...world([region[start]!], band.h));
      for (let step = 0; step < region.length && facing[(start + step) % region.length]; step += 1) {
        front.push(...world([region[(start + step + 1) % region.length]!], band.h));
      }
    }

    let stepShade: BandSlab["stepShade"];
    if (previous !== undefined && previous.h > band.h) {
      const strip = clipColumn(region, u0 + SHADE_WIDTH, (u) => u <= u0 + SHADE_WIDTH + EPSILON);
      const middle = (y0 + y1) / 2;
      const from = project({ x: u0, y: middle, h: band.h });
      const along = project({ x: u0, y: middle + 1, h: band.h });
      const to = project({ x: u0 + SHADE_WIDTH, y: middle, h: band.h });
      stepShade = { polygon: world(strip, band.h), gradient: across(from, { x: along.x - from.x, y: along.y - from.y }, to) };
    }

    const grid: number[] = [];
    const segment = (a: Uv, b: Uv) => {
      const p = project({ x: a[0], y: a[1], h: band.h });
      const q = project({ x: b[0], y: b[1], h: band.h });
      grid.push(p.x, p.y, q.x, q.y);
    };
    for (let gx = band.gx0 + 1; gx <= band.gx1; gx += 1) segment([gx - 0.5, y0], [gx - 0.5, y1]);
    for (let gy = island.gy0 + 1; gy <= island.gy1; gy += 1) segment([u0, gy - 0.5], [u1, gy - 0.5]);

    const pads = standing
      .filter((item) => item.gx >= band.gx0 && item.gx <= band.gx1)
      .map((item) => {
        const centre = project({ x: item.gx, y: item.gy, h: band.h });
        return { id: item.id, points: [centre.x, centre.y - 16 * PAD, centre.x + 32 * PAD, centre.y, centre.x, centre.y + 16 * PAD, centre.x - 32 * PAD, centre.y] };
      });

    const top = world(region, band.h);
    return {
      id: band.id,
      index,
      h: band.h,
      region: flat(region),
      top,
      front,
      walls,
      ...(stepShade ? { stepShade } : {}),
      grid,
      pads,
      bounds: boundsOf([top, ...walls.map((wall) => wall.quad)]),
    };
  });

  const { drop, shift, layers } = GRAPHITE.shadow;
  const shadow = layers.map(({ grow }) =>
    world(octagon(x0 - grow, y0 - grow, x1 + grow, y1 + grow, cut + grow * 0.6), floor - drop).map((value, at) => (at % 2 === 0 ? value + shift : value)),
  );
  return {
    island,
    outline: flat(outline),
    rim: world(outline, Math.max(...island.bands.map((band) => band.h))),
    deck,
    bands,
    shadow,
    bounds: boundsOf(bands.flatMap((band) => [band.top, ...band.walls.map((wall) => wall.quad)]), HEADROOM),
    shadowBounds: boundsOf(shadow),
  };
}

/** Every island's slab, in the scene's island order. */
export function islandSlabs(scene: Pick<Scene, "islands" | "nodes" | "props">): IslandSlab[] {
  const standing = [...scene.nodes, ...scene.props];
  return scene.islands.map((island) =>
    islandSlab(island, standing.filter((item) => item.gx >= island.gx0 && item.gx <= island.gx1 && item.gy >= island.gy0 && item.gy <= island.gy1)),
  );
}

function overlap(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Whether `a` stands wholly behind `b` on the grid. */
export function behind(a: Island, b: Island): boolean {
  return a.gx1 < b.gx0 || a.gy1 < b.gy0;
}

/**
 * Painter's order for whole islands. Islands are disjoint grid rectangles, so
 * of two that overlap on screen one always stands wholly behind the other;
 * that one draws first. Otherwise, back corner first.
 */
export function islandDrawOrder(slabs: readonly IslandSlab[]): IslandSlab[] {
  const pending = [...slabs].sort((a, b) => a.island.gx0 + a.island.gy0 - (b.island.gx0 + b.island.gy0) || a.island.gx0 - b.island.gx0);
  const ordered: IslandSlab[] = [];
  while (pending.length > 0) {
    const free = pending.findIndex((candidate) =>
      !pending.some((other) => other !== candidate && overlap(other.bounds, candidate.bounds) && behind(other.island, candidate.island)),
    );
    ordered.push(...pending.splice(Math.max(0, free), 1));
  }
  return ordered;
}
