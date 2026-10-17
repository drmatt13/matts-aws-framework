import { ELEVATION_STEP, TILE_HEIGHT, TILE_WIDTH } from "./iso";

/**
 * The miniature buildings that stand on the landscape, as plain polygons.
 *
 * Each shape is built from a few primitives — cuboids, cylinders, an
 * octahedron — projected the same way the terrain is: one grid step along x is
 * (32, 16) on screen, one along y is (-32, 16), and height lifts straight up.
 * Faces come back in the order they must be painted (back to front within the
 * shape), each tagged with which part of the building it is and which way it
 * faces, so the renderer can light it and the picker can use its silhouette.
 */

export type ShapeKind =
  | "gate"
  | "mount"
  | "pylon"
  | "portal"
  | "lambda"
  | "service"
  | "task"
  | "workflow"
  | "agent"
  | "stack"
  | "group"
  | "table"
  | "bucket"
  | "queue"
  | "topic"
  | "bus"
  | "userpool"
  | "database"
  | "value"
  | "secret"
  | "input"
  | "construct"
  // Decoration: no entity, no meaning, just a lived-in landscape.
  | "shrub"
  | "lamp"
  | "rock"
  | "shard";

/** The icon a Lambda carries on its roof: which invocation surface reaches it. */
export type Glyph = "lambda" | "socket" | "check" | "bolt" | "tool" | "lines" | "key" | "person";

export type Part = "body" | "accent" | "dark" | "glow";
export type Shade = "top" | "left" | "right" | "flat";

export interface Face {
  /** Flat [x, y, ...] world coordinates. */
  readonly points: readonly number[];
  readonly part: Part;
  readonly shade: Shade;
  /** Stroked rather than filled, at this world width. */
  readonly stroke?: number;
  readonly closed?: boolean;
}

export interface Shape {
  readonly faces: readonly Face[];
  /** Where edges attach and the label card hangs: the top of the building. */
  readonly top: { readonly x: number; readonly y: number };
  /** Convex silhouette, for picking. */
  readonly hull: readonly number[];
  readonly height: number;
}

/** Small invocation icon attached to the lower-right corner of a service plaque. */
export const ICON_BADGE = { x: 14, y: -30, size: 24, padding: 3 } as const;

/** A service icon on a low isometric plinth. Hull includes the plaque and optional badge. */
export function buildIconShape(x: number, y: number, withBadge = false): Shape {
  return {
    faces: [
      { points: [x - 25, y - 2, x, y + 10, x, y + 15, x - 25, y + 3], part: "body", shade: "left" },
      { points: [x, y + 10, x + 25, y - 2, x + 25, y + 3, x, y + 15], part: "body", shade: "right" },
      { points: [x, y - 14, x + 25, y - 2, x, y + 10, x - 25, y - 2], part: "body", shade: "top" },
    ],
    top: { x, y: y - 54 },
    hull: [x - 24, y - 54, x + 24, y - 54,
      ...(withBadge ? [x + ICON_BADGE.x + ICON_BADGE.size + 1, y + ICON_BADGE.y - 1,
        x + ICON_BADGE.x + ICON_BADGE.size + 1, y + ICON_BADGE.y + ICON_BADGE.size + 1] : []),
      x + 25, y + 3, x, y + 15, x - 25, y + 3],
    height: 54,
  };
}

/** Buildings stand a little taller and wider than a literal reading of the tile would give, so they read as structures. */
const TALL = 1.35;
const FOOT = 1.12;

const GX = { x: TILE_WIDTH / 2, y: TILE_HEIGHT / 2 };
const GY = { x: -TILE_WIDTH / 2, y: TILE_HEIGHT / 2 };

/** A point offset from (x, y) by u grid steps along x, v along y, lifted by z world units. */
function at(x: number, y: number, u: number, v: number, z: number): [number, number] {
  return [x + u * GX.x + v * GY.x, y + u * GX.y + v * GY.y - z];
}

function flat(points: readonly [number, number][]): number[] {
  return points.flatMap(([px, py]) => [px, py]);
}

class Builder {
  readonly faces: Face[] = [];
  private top = Number.POSITIVE_INFINITY;

  constructor(
    readonly x: number,
    readonly y: number,
  ) {}

  private add(face: Face): void {
    this.faces.push(face);
    for (let index = 1; index < face.points.length; index += 2) this.top = Math.min(this.top, face.points[index]!);
  }

  /**
   * A box `2eu` grid steps along x and `2ev` along y, `height` tall, its base
   * `lift` above the tile, centred `u, v` steps from the anchor. The two faces
   * that look toward the viewer and the top.
   */
  cuboid(eu: number, ev: number, height: number, part: Part, options: { u?: number; v?: number; lift?: number } = {}): this {
    eu *= FOOT;
    ev *= FOOT;
    height *= TALL;
    const u = (options.u ?? 0) * FOOT;
    const v = (options.v ?? 0) * FOOT;
    const lift = (options.lift ?? 0) * TALL;
    const corner = (du: number, dv: number, z: number) => at(this.x, this.y, u + du, v + dv, z);
    const base = lift;
    const roof = lift + height;
    this.add({ part, shade: "left", points: flat([corner(-eu, ev, roof), corner(eu, ev, roof), corner(eu, ev, base), corner(-eu, ev, base)]) });
    this.add({ part, shade: "right", points: flat([corner(eu, -ev, roof), corner(eu, ev, roof), corner(eu, ev, base), corner(eu, -ev, base)]) });
    this.add({ part, shade: "top", points: flat([corner(-eu, -ev, roof), corner(eu, -ev, roof), corner(eu, ev, roof), corner(-eu, ev, roof)]) });
    return this;
  }

  /** An upright cylinder of grid radius `r`: its front half as two lit faces, and its lid. */
  cylinder(r: number, height: number, part: Part, options: { lift?: number; segments?: number } = {}): this {
    r *= FOOT;
    height *= TALL;
    const lift = (options.lift ?? 0) * TALL;
    const segments = options.segments ?? 20;
    const ring = (z: number, from: number, to: number): [number, number][] => {
      const points: [number, number][] = [];
      for (let step = 0; step <= segments; step += 1) {
        const angle = from + ((to - from) * step) / segments;
        // A circle on the ground: radius r along both grid axes, rotated so
        // angle 0 is the east corner of the footprint.
        const cu = (Math.cos(angle) + Math.sin(angle)) * r * Math.SQRT1_2;
        const cv = (Math.sin(angle) - Math.cos(angle)) * r * Math.SQRT1_2;
        points.push(at(this.x, this.y, cu, cv, z));
      }
      return points;
    };
    const roof = lift + height;
    // Screen angle 0 is east, π/2 is south (toward the viewer), π is west.
    const leftHalf = [...ring(roof, Math.PI, Math.PI / 2), ...ring(lift, Math.PI / 2, Math.PI)];
    const rightHalf = [...ring(roof, Math.PI / 2, 0), ...ring(lift, 0, Math.PI / 2)];
    this.add({ part, shade: "left", points: flat(leftHalf) });
    this.add({ part, shade: "right", points: flat(rightHalf) });
    this.add({ part, shade: "top", points: flat(ring(roof, 0, Math.PI * 2)) });
    return this;
  }

  /** A ring drawn as a line around the shape, at a height. */
  ring(r: number, z: number, part: Part, width: number): this {
    r *= FOOT;
    z *= TALL;
    const points: [number, number][] = [];
    for (let step = 0; step <= 24; step += 1) {
      const angle = (Math.PI * 2 * step) / 24;
      const cu = (Math.cos(angle) + Math.sin(angle)) * r * Math.SQRT1_2;
      const cv = (Math.sin(angle) - Math.cos(angle)) * r * Math.SQRT1_2;
      points.push(at(this.x, this.y, cu, cv, z));
    }
    this.add({ part, shade: "flat", points: flat(points), stroke: width, closed: true });
    return this;
  }

  /** A square pyramid cap on a footprint of half-size e. */
  pyramid(e: number, height: number, part: Part, lift: number): this {
    e *= FOOT;
    height *= TALL;
    lift *= TALL;
    const apex = at(this.x, this.y, 0, 0, lift + height);
    const corner = (du: number, dv: number) => at(this.x, this.y, du, dv, lift);
    this.add({ part, shade: "left", points: flat([corner(-e, e), corner(e, e), apex]) });
    this.add({ part, shade: "right", points: flat([corner(e, -e), corner(e, e), apex]) });
    return this;
  }

  /** A floating octahedron: the agent's crystal. */
  crystal(e: number, height: number, part: Part, lift: number): this {
    e *= FOOT;
    height *= TALL;
    lift *= TALL;
    const middle = lift + height / 2;
    const top = at(this.x, this.y, 0, 0, lift + height);
    const bottom = at(this.x, this.y, 0, 0, lift);
    const east = at(this.x, this.y, e, -e, middle);
    const south = at(this.x, this.y, e, e, middle);
    const west = at(this.x, this.y, -e, e, middle);
    this.add({ part, shade: "left", points: flat([west, south, bottom]) });
    this.add({ part, shade: "right", points: flat([south, east, bottom]) });
    this.add({ part, shade: "top", points: flat([west, south, top]) });
    this.add({ part, shade: "left", points: flat([south, east, top]) });
    return this;
  }

  /** A vertical ring standing across the y axis: the agent route's portal. */
  hoop(r: number, lift: number, part: Part, width: number): this {
    r *= FOOT;
    lift *= TALL;
    const points: [number, number][] = [];
    for (let step = 0; step <= 28; step += 1) {
      const angle = (Math.PI * 2 * step) / 28;
      points.push(at(this.x, this.y, 0, Math.cos(angle) * r, lift + r * ELEVATION_STEP * 2 + Math.sin(angle) * r * ELEVATION_STEP * 2));
    }
    this.add({ part, shade: "flat", points: flat(points), stroke: width, closed: true });
    return this;
  }

  /** A mark painted on a horizontal surface `z` high, in glyph units of `scale` grid steps. */
  glyph(glyph: Glyph, z: number, scale: number, part: Part = "dark"): this {
    z *= TALL;
    scale *= FOOT;
    // A glyph lying on the plane: its x runs east on screen, its y south, and
    // the plane halves its height.
    const point = (gx: number, gy: number): [number, number] => [this.x + gx * scale * GX.x, this.y + gy * scale * GX.y - z];
    const line = (points: [number, number][], width = 1.6) =>
      this.add({ part, shade: "flat", points: flat(points.map(([gx, gy]) => point(gx, gy))), stroke: width });
    const fill = (points: [number, number][]) => this.add({ part, shade: "flat", points: flat(points.map(([gx, gy]) => point(gx, gy))) });
    switch (glyph) {
      case "lambda":
        line([[-0.45, -0.75], [-0.1, -0.75], [0.5, 0.75]]);
        line([[0.08, -0.15], [-0.45, 0.75]]);
        break;
      case "socket":
        line([[-0.6, -0.3], [0.5, -0.3]]);
        line([[0.25, -0.6], [0.55, -0.3], [0.25, 0]]);
        line([[0.6, 0.35], [-0.5, 0.35]]);
        line([[-0.25, 0.05], [-0.55, 0.35], [-0.25, 0.65]]);
        break;
      case "check":
        line([[-0.55, 0], [-0.15, 0.45], [0.6, -0.5]], 2);
        break;
      case "bolt":
        fill([[0.15, -0.85], [-0.5, 0.12], [-0.02, 0.12], [-0.2, 0.85], [0.5, -0.15], [0.02, -0.15]]);
        break;
      case "tool":
        line([[-0.55, 0], [0.55, 0]], 2);
        line([[0, -0.6], [0, 0.6]], 2);
        break;
      case "lines":
        line([[-0.55, -0.4], [0.55, -0.4]], 1.2);
        line([[-0.55, 0], [0.55, 0]], 1.2);
        line([[-0.55, 0.4], [0.2, 0.4]], 1.2);
        break;
      case "key":
        line([[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3], [-0.3, -0.3]], 1.4);
        line([[0, 0.3], [0, 0.75]], 1.4);
        break;
      case "person":
        line([[-0.18, -0.55], [0.18, -0.55], [0.18, -0.15], [-0.18, -0.15], [-0.18, -0.55]], 1.4);
        line([[-0.5, 0.65], [-0.35, 0.1], [0.35, 0.1], [0.5, 0.65]], 1.4);
        break;
    }
    return this;
  }

  /** A post: a thin upright line, cheaper than a cuboid at this size. */
  mast(height: number, part: Part, width: number, lift = 0): this {
    height *= TALL;
    lift *= TALL;
    this.add({ part, shade: "flat", points: flat([at(this.x, this.y, 0, 0, lift), at(this.x, this.y, 0, 0, lift + height)]), stroke: width });
    return this;
  }

  build(): Shape {
    const points: [number, number][] = [];
    for (const face of this.faces) {
      for (let index = 0; index < face.points.length; index += 2) points.push([face.points[index]!, face.points[index + 1]!]);
    }
    return {
      faces: this.faces,
      top: { x: this.x, y: Number.isFinite(this.top) ? this.top : this.y },
      hull: convexHull(points),
      height: Number.isFinite(this.top) ? this.y - this.top : 0,
    };
  }
}

/** Andrew's monotone chain, as a flat list. */
export function convexHull(points: readonly (readonly [number, number])[]): number[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted.flat();
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: (readonly [number, number])[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: (readonly [number, number])[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

/** The glyph a Lambda wears, from the surface that invokes it. */
export function lambdaGlyph(role: string): Glyph {
  switch (role) {
    case "webSocket":
      return "socket";
    case "webSocketAuthorizer":
      return "check";
    case "event":
      return "bolt";
    case "tool":
      return "tool";
    default:
      return "lambda";
  }
}

/** A building of `kind` standing on the tile whose top centre is (x, y). */
export function buildShape(kind: ShapeKind, x: number, y: number, glyph?: Glyph): Shape {
  const shape = new Builder(x, y);
  switch (kind) {
    case "gate":
      shape.cuboid(0.09, 0.09, 26, "body", { v: -0.36 });
      shape.cuboid(0.09, 0.09, 26, "body", { v: 0.36 });
      shape.cuboid(0.13, 0.5, 6, "accent", { lift: 24 });
      break;
    case "mount":
      shape.cuboid(0.1, 0.1, 30, "body", { v: -0.42 });
      shape.cuboid(0.1, 0.1, 30, "body", { v: 0.42 });
      shape.cuboid(0.04, 0.34, 18, "glow", { lift: 8 });
      shape.cuboid(0.15, 0.58, 6, "accent", { lift: 28 });
      break;
    case "pylon":
      shape.cuboid(0.16, 0.16, 4, "body");
      shape.mast(32, "body", 2.4, 4);
      shape.ring(0.26, 26, "accent", 1.6);
      shape.ring(0.18, 32, "glow", 1.6);
      break;
    case "portal":
      shape.cuboid(0.14, 0.42, 4, "body");
      shape.hoop(0.42, 4, "glow", 3);
      break;
    case "lambda":
      shape.cuboid(0.3, 0.3, 16, "body");
      shape.cuboid(0.24, 0.24, 3, "accent", { lift: 16 });
      shape.glyph(glyph ?? "lambda", 19, 0.2);
      break;
    case "service":
      shape.cuboid(0.3, 0.3, 38, "body");
      for (const z of [10, 18, 26]) shape.cuboid(0.305, 0.305, 2, "glow", { lift: z });
      shape.cuboid(0.22, 0.22, 3, "accent", { lift: 38 });
      break;
    case "task":
      shape.cuboid(0.32, 0.26, 14, "body");
      shape.cuboid(0.325, 0.04, 14, "accent", { v: 0.0 });
      shape.cuboid(0.34, 0.28, 2.5, "accent", { lift: 14 });
      break;
    case "workflow":
      shape.cuboid(0.4, 0.4, 9, "body");
      shape.cuboid(0.29, 0.29, 9, "body", { lift: 9 });
      shape.cuboid(0.18, 0.18, 9, "accent", { lift: 18 });
      shape.cuboid(0.08, 0.08, 4, "glow", { lift: 27 });
      break;
    case "agent":
      shape.cuboid(0.28, 0.28, 6, "body");
      shape.cuboid(0.2, 0.2, 3, "accent", { lift: 6 });
      shape.crystal(0.2, 24, "glow", 14);
      break;
    case "stack":
      shape.cuboid(0.26, 0.26, 5, "accent");
      shape.cuboid(0.15, 0.15, 40, "body", { lift: 5 });
      shape.cuboid(0.16, 0.16, 3, "glow", { lift: 34 });
      shape.pyramid(0.15, 10, "body", 45);
      break;
    case "group":
      shape.cuboid(0.22, 0.22, 4, "accent");
      shape.cuboid(0.12, 0.12, 24, "body", { lift: 4 });
      shape.pyramid(0.12, 8, "body", 28);
      break;
    case "table":
      shape.cylinder(0.3, 6, "body");
      shape.cylinder(0.3, 6, "body", { lift: 7 });
      shape.cylinder(0.3, 6, "accent", { lift: 14 });
      break;
    case "bucket":
      shape.cuboid(0.3, 0.3, 14, "body");
      shape.cuboid(0.24, 0.24, 0.5, "dark", { lift: 14 });
      break;
    case "queue":
      for (const u of [-0.3, -0.1, 0.1, 0.3]) shape.cuboid(0.08, 0.18, 9, u === 0.3 ? "accent" : "body", { u });
      break;
    case "topic":
      shape.cylinder(0.2, 4, "body");
      shape.mast(30, "body", 2, 4);
      shape.ring(0.28, 22, "accent", 1.6);
      shape.ring(0.18, 30, "glow", 1.6);
      break;
    case "bus":
      shape.cylinder(0.36, 5, "body");
      shape.cylinder(0.22, 1, "dark", { lift: 5 });
      shape.ring(0.29, 8, "glow", 2);
      break;
    case "userpool":
      shape.cylinder(0.27, 18, "body", { segments: 6 });
      shape.cylinder(0.27, 3, "accent", { lift: 18, segments: 6 });
      shape.glyph("person", 21, 0.2);
      break;
    case "database":
      shape.cylinder(0.32, 7, "body");
      shape.cylinder(0.32, 7, "body", { lift: 8 });
      shape.cylinder(0.32, 7, "accent", { lift: 16 });
      break;
    case "value":
      shape.cuboid(0.28, 0.2, 4, "body");
      shape.glyph("lines", 4, 0.18);
      break;
    case "secret":
      shape.cuboid(0.26, 0.26, 16, "dark");
      shape.cuboid(0.265, 0.265, 3, "accent", { lift: 7 });
      shape.glyph("key", 16, 0.18, "accent");
      break;
    case "input":
      shape.mast(24, "body", 2.2);
      shape.cuboid(0.04, 0.28, 10, "accent", { lift: 14 });
      break;
    case "construct":
      shape.cuboid(0.28, 0.28, 20, "body");
      break;
    case "shrub":
      shape.cylinder(0.14, 5, "body", { segments: 8 });
      shape.cylinder(0.1, 4, "accent", { lift: 5, segments: 8 });
      break;
    case "lamp":
      shape.mast(16, "body", 1.4);
      shape.cuboid(0.05, 0.05, 2.5, "glow", { lift: 16 });
      break;
    case "rock":
      shape.cuboid(0.13, 0.1, 4, "body");
      shape.cuboid(0.08, 0.07, 3, "body", { u: 0.06, v: -0.05, lift: 4 });
      break;
    case "shard":
      shape.crystal(0.07, 12, "glow", 1);
      break;
  }
  return shape.build();
}
