import type { EdgeCategory } from "../lookup";
import { ICONS, iconUrl, type IconKey } from "../icons";
import { backgroundGrid } from "./grid";
import { FRAME_COLORS } from "./frame";
import { DEPLOYMENT_BADGES, type DeploymentBadgeKind } from "../deployment";
import { atlasPixels, sideColor, spriteOrigin, SPRITE } from "./atlas";
import type { Decoration, Island, Prop, Scene, SceneEdge, SceneNode, Tile } from "./build";
import { worldToScreen, type Bounds, type Camera, type Point, type Viewport } from "./camera";
import { ELEVATION_STEP, project } from "./iso";
import { bandTrim, GRAPHITE, hexRgb, ICON_TINT, trimColor, type Look } from "./look";
import { acceptCards, arcControl, arcPoints, type CardHit } from "./picking";
import { ICON_BADGE, type Face, type Glyph, type Part, type Shade, type ShapeKind } from "./shapes";
import { islandDrawOrder, islandSlabs, type BandSlab, type IslandSlab, type WallRun } from "./slabs";

/**
 * Draws a {@link Scene} onto a 2D canvas.
 *
 * Passes, back to front: the void, then the terrain and buildings in the
 * selected look, the relationship arcs in the air above, their moving packets,
 * the label cards, and the region names. The classic look pools light under
 * each island and interleaves atlas tiles and buildings by diagonal row (so
 * raised ground hides what is behind it); the graphite look casts shadows,
 * then draws whole lit slabs back to front, each terrace before what stands
 * on it. Nothing here decides anything about the application; it paints what
 * the scene says.
 *
 * Per scene, both looks' draw orders, paths and gradients are built once.
 * Per frame, only the camera, the selection, hover and time change.
 */

export interface RenderState {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly dpr: number;
  readonly selected?: string;
  readonly hovered?: string;
  readonly hoveredEdge?: string;
  readonly categories: ReadonlySet<EdgeCategory>;
  readonly time: number;
  readonly motion: boolean;
  readonly look: Look;
}

export interface FrameResult {
  /** Label cards as drawn, in painter's order, for picking. */
  readonly cards: readonly CardHit[];
  /** Whether anything on screen moves, so the caller keeps drawing. */
  readonly animating: boolean;
  readonly ms: number;
}

const BADGE_WIDTH: Readonly<Record<DeploymentBadgeKind, number>> = { dev: 43, prod: 48, off: 43 };

export const CATEGORY_COLORS: Readonly<Record<EdgeCategory, string>> = {
  routes: "#ddd3bd",
  inputs: "#8fb7d9",
  permissions: "#e59a86",
  invocations: "#c3b2ff",
  integrations: "#94d6b0",
  cdk: "#67d7df",
};

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function rgba(color: Rgb, alpha = 1, factor = 1): string {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
  return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${alpha})`;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const WHITE: Rgb = [255, 255, 255];

function toPath(points: readonly number[], close = true, into = new Path2D()): Path2D {
  if (points.length < 4) return into;
  into.moveTo(points[0]!, points[1]!);
  for (let index = 2; index < points.length; index += 2) into.lineTo(points[index]!, points[index + 1]!);
  if (close) into.closePath();
  return into;
}

function segmentsPath(segments: readonly number[]): Path2D {
  const path = new Path2D();
  for (let index = 0; index < segments.length; index += 4) {
    path.moveTo(segments[index]!, segments[index + 1]!);
    path.lineTo(segments[index + 2]!, segments[index + 3]!);
  }
  return path;
}

function polylineLength(points: readonly number[]): number {
  let length = 0;
  for (let index = 2; index < points.length; index += 2) length += Math.hypot(points[index]! - points[index - 2]!, points[index + 1]! - points[index - 1]!);
  return length;
}

interface PartColors {
  readonly body: string;
  readonly accent: string;
  readonly dark?: string;
  readonly glow?: string;
}

const BUILDINGS: Readonly<Record<ShapeKind, PartColors>> = {
  gate: { body: "#c8b48c", accent: "#ead7a6" },
  mount: { body: "#b6a47f", accent: "#e8d4a2", glow: "#ffd27a" },
  pylon: { body: "#a2b2c4", accent: "#d9e4ef", glow: "#86dbe8" },
  portal: { body: "#a593aa", accent: "#cdb9d2", glow: "#eabcff" },
  lambda: { body: "#d8d3c6", accent: "#f0b35a", dark: "#262b33" },
  service: { body: "#8fa2b6", accent: "#c9d5e1", glow: "#ffe2a0" },
  task: { body: "#a8895f", accent: "#6e583c" },
  workflow: { body: "#c58a5c", accent: "#e3ab7a", glow: "#ffdcae" },
  agent: { body: "#6f6278", accent: "#a993b9", glow: "#e6c6ff" },
  stack: { body: "#bcc1ca", accent: "#7d8590", glow: "#a8d6ff" },
  group: { body: "#c6b99c", accent: "#8e836b" },
  table: { body: "#7ea2c9", accent: "#aac8e8" },
  bucket: { body: "#c97e69", accent: "#e2a08e", dark: "#3a2925" },
  queue: { body: "#d6b25d", accent: "#f2d68e" },
  topic: { body: "#b393d8", accent: "#d9c2f2", glow: "#f0deff" },
  bus: { body: "#6db398", dark: "#20342c", accent: "#9fe0c4", glow: "#b2f5d6" },
  userpool: { body: "#d29f6f", accent: "#f2c393", dark: "#3a2c20" },
  database: { body: "#7090b6", accent: "#a2c0e2" },
  value: { body: "#9ba4ae", accent: "#c7ced6", dark: "#2b3038" },
  secret: { body: "#3a3e48", dark: "#2b2f37", accent: "#d9b25a" },
  input: { body: "#a69c86", accent: "#dacfb3" },
  construct: { body: "#9ca5af", accent: "#c6cdd5" },
  shrub: { body: "#4f6a42", accent: "#6f8f58" },
  lamp: { body: "#59606b", accent: "#8a929c", glow: "#ffe6a8" },
  rock: { body: "#6b6f77", accent: "#868b93" },
  shard: { body: "#8ab8d8", accent: "#b6dcf2", glow: "#bfe6ff" },
};

const ROOF_BY_GLYPH: Partial<Record<Glyph, string>> = {
  lambda: "#f0b35a",
  socket: "#6cc9d6",
  check: "#9fd28a",
  bolt: "#ead46c",
  tool: "#c9a6f0",
};

const SHADE: Readonly<Record<Shade, number>> = { top: 1.08, left: 0.8, right: 0.6, flat: 1 };

function faceColor(kind: ShapeKind, part: Part, shade: Shade, glyph?: Glyph): string {
  const colors = BUILDINGS[kind];
  const base =
    part === "accent" && kind === "lambda" && glyph
      ? ROOF_BY_GLYPH[glyph] ?? colors.accent
      : part === "glow"
        ? colors.glow ?? colors.accent
        : part === "dark"
          ? colors.dark ?? "#262b33"
          : part === "accent"
            ? colors.accent
            : colors.body;
  return rgba(hex(base), 1, part === "glow" ? 1 : SHADE[shade]);
}

let atlasCanvas: HTMLCanvasElement | undefined;

function atlas(): HTMLCanvasElement {
  if (atlasCanvas) return atlasCanvas;
  const { width, height, pixels } = atlasPixels();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  atlasCanvas = canvas;
  return canvas;
}

function trace(context: CanvasRenderingContext2D, points: readonly number[], close = true): void {
  context.beginPath();
  context.moveTo(points[0]!, points[1]!);
  for (let index = 2; index < points.length; index += 2) context.lineTo(points[index]!, points[index + 1]!);
  if (close) context.closePath();
}

type DrawItem =
  | { readonly kind: "tile"; readonly tile: Tile; readonly island: Island }
  | { readonly kind: "node"; readonly node: SceneNode }
  | { readonly kind: "prop"; readonly prop: Prop | Decoration };

type Standing = Exclude<DrawItem, { kind: "tile" }>;

interface Prepared {
  readonly scene: Scene;
  readonly items: readonly DrawItem[];
  readonly walls: ReadonlyMap<Tile, { left?: CanvasGradient | string; right?: CanvasGradient | string }>;
  readonly arcs: ReadonlyMap<SceneEdge, { readonly points: readonly Point[]; readonly length: number }>;
  readonly anchors: ReadonlyMap<string, Point>;
  /** Each draw item's world bounding box, for culling. */
  readonly boxes: ReadonlyMap<DrawItem, { minX: number; minY: number; maxX: number; maxY: number }>;
  /** The graphite look: whole islands, back to front. */
  readonly graphite: readonly GraphiteIsland[];
}

/** One terrace of a graphite slab, as paths and gradients built once per scene. */
interface GraphiteBand {
  readonly slab: BandSlab;
  readonly trim: Rgb;
  readonly top: Path2D;
  readonly topFill: CanvasGradient;
  readonly grid: Path2D;
  readonly pads: Path2D;
  readonly walls: readonly { readonly run: WallRun; readonly path: Path2D; readonly fill: CanvasGradient }[];
  readonly lips: Path2D;
  /** The foot of each wall that falls to the floor. */
  readonly feet: Path2D;
  readonly front?: Path2D;
  readonly frontLength: number;
  readonly shade?: { readonly path: Path2D; readonly fill: CanvasGradient };
  /** The wall a name can be written on: the left rim run's top-left corner, its length and its depth. */
  readonly face?: { readonly x: number; readonly y: number; readonly length: number; readonly depth: number };
  /** Buildings and fixtures standing on this terrace, in painter's order. */
  readonly items: readonly Standing[];
}

interface GraphiteIsland {
  readonly slab: IslandSlab;
  readonly bands: readonly GraphiteBand[];
  readonly shadow: readonly Path2D[];
}

const OUTSIDE = (box: Bounds | undefined, view: Bounds) =>
  box !== undefined && (box.maxX < view.minX || box.minX > view.maxX || box.maxY < view.minY || box.minY > view.maxY);

const CARD_HEIGHT = 22;
const CARD_MAX_TEXT = 140;
const CARD_LIFT = 64;

export class SceneRenderer {
  private readonly context: CanvasRenderingContext2D;
  private prepared: Prepared | undefined;
  private readonly widths = new Map<string, number>();
  private readonly icons = new Map<IconKey, HTMLImageElement>();
  private readonly badgePaths = new Map<DeploymentBadgeKind, readonly Path2D[]>();
  private disposed = false;
  /** One screen pixel, in world units, for this frame. */
  private pixel = 1;
  private zoom = 1;
  private dpr = 1;
  /** Graphite's shared unit gradients, drawn under a transform so one serves every building. */
  private readonly tints = new Map<string, CanvasGradient>();
  private contact: CanvasGradient | undefined;
  private plaque: { readonly face: CanvasGradient; readonly glass: CanvasGradient } | undefined;
  private atmosphere: { readonly width: number; readonly height: number; readonly base: CanvasGradient; readonly vignette: CanvasGradient; readonly blooms: readonly CanvasGradient[] } | undefined;
  /** Islands and terraces whose names this frame wrote on a wall, so no flat title repeats them. */
  private readonly walled = new Set<string>();
  /** How many tiles and buildings the last frame drew, after culling. */
  drawnItems = 0;

  constructor(private readonly canvas: HTMLCanvasElement, invalidate: () => void = () => {}) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser offers no 2D canvas.");
    this.context = context;
    for (const kind of Object.keys(DEPLOYMENT_BADGES) as DeploymentBadgeKind[]) {
      this.badgePaths.set(kind, DEPLOYMENT_BADGES[kind].paths.map((d) => new Path2D(d)));
    }
    for (const key of Object.keys(ICONS) as IconKey[]) {
      const icon = new Image();
      icon.onload = () => { if (!this.disposed) invalidate(); };
      icon.src = iconUrl(key);
      this.icons.set(key, icon);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const icon of this.icons.values()) icon.onload = null;
  }

  /** Forget measured text, after web fonts arrive. */
  fontsChanged(): void {
    this.widths.clear();
  }

  setScene(scene: Scene): void {
    if (this.prepared?.scene === scene) return;
    const context = this.context;
    const islands = new Map(scene.islands.map((island) => [island.id, island]));
    const items: DrawItem[] = [];
    let tile = 0;
    let node = 0;
    let prop = 0;
    const props: (Prop | Decoration)[] = [...scene.props, ...scene.decorations].sort((a, b) => a.gx + a.gy - (b.gx + b.gy));
    const diagonal = (item: { gx: number; gy: number }) => item.gx + item.gy;
    while (tile < scene.tiles.length || node < scene.nodes.length || prop < props.length) {
      const nextTile = scene.tiles[tile];
      const nextNode = scene.nodes[node];
      const nextProp = props[prop];
      const candidates = [
        nextTile ? diagonal(nextTile) - 0.5 : Number.POSITIVE_INFINITY,
        nextNode ? diagonal(nextNode) : Number.POSITIVE_INFINITY,
        nextProp ? diagonal(nextProp) : Number.POSITIVE_INFINITY,
      ];
      const smallest = Math.min(...candidates);
      if (smallest === candidates[0]) {
        items.push({ kind: "tile", tile: nextTile!, island: islands.get(nextTile!.island)! });
        tile += 1;
      } else if (smallest === candidates[1]) {
        items.push({ kind: "node", node: nextNode! });
        node += 1;
      } else {
        items.push({ kind: "prop", prop: nextProp! });
        prop += 1;
      }
    }

    // A wall that falls into the void fades into it; a terrace step is solid.
    const walls = new Map<Tile, { left?: CanvasGradient | string; right?: CanvasGradient | string }>();
    for (const tile of scene.tiles) {
      const island = islands.get(tile.island)!;
      const centre = project({ x: tile.gx, y: tile.gy, h: tile.h });
      const entry: { left?: CanvasGradient | string; right?: CanvasGradient | string } = {};
      for (const side of ["left", "right"] as const) {
        const bottom = side === "left" ? tile.wallLeft : tile.wallRight;
        if (bottom === undefined) continue;
        const color = sideColor(tile.material, side);
        const rim = side === "left" ? tile.rimLeft : tile.rimRight;
        if (!rim) {
          entry[side] = rgba(color, 1, 0.92);
          continue;
        }
        const top = centre.y;
        const depth = (tile.h - island.base) * ELEVATION_STEP + 16;
        const gradient = context.createLinearGradient(0, top, 0, top + depth);
        gradient.addColorStop(0, rgba(color));
        gradient.addColorStop(0.55, rgba(color, 1, 0.55));
        gradient.addColorStop(1, rgba([12, 16, 22], 0));
        entry[side] = gradient;
      }
      walls.set(tile, entry);
    }

    const anchors = new Map(scene.nodes.map((node) => [node.id, node.geometry.top]));
    const arcs = new Map<SceneEdge, { points: Point[]; length: number }>();
    for (const edge of scene.edges) {
      const a = anchors.get(edge.from)!;
      const b = anchors.get(edge.to)!;
      const points = arcPoints(a, arcControl(a, b), b);
      let length = 0;
      for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y);
      arcs.set(edge, { points, length });
    }
    const boxes = new Map<DrawItem, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const item of items) {
      if (item.kind === "tile") {
        const centre = project({ x: item.tile.gx, y: item.tile.gy, h: item.tile.h });
        const floor = Math.min(item.tile.wallLeft ?? item.tile.h, item.tile.wallRight ?? item.tile.h);
        boxes.set(item, { minX: centre.x - 33, maxX: centre.x + 33, minY: centre.y - 17, maxY: centre.y + 33 + (item.tile.h - floor) * ELEVATION_STEP });
      } else {
        const hull = item.kind === "node" ? item.node.geometry.hull : item.prop.geometry.hull;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < hull.length; index += 2) {
          minX = Math.min(minX, hull[index]!);
          maxX = Math.max(maxX, hull[index]!);
          minY = Math.min(minY, hull[index + 1]!);
          maxY = Math.max(maxY, hull[index + 1]!);
        }
        // Room for the selection ring around the base.
        boxes.set(item, { minX: minX - 30, maxX: maxX + 30, minY: minY - 4, maxY: maxY + 18 });
      }
    }
    this.prepared = { scene, items, walls, arcs, anchors, boxes, graphite: this.prepareGraphite(scene, items) };
  }

  /** The graphite look's islands: paths, gradients and who stands on each terrace. */
  private prepareGraphite(scene: Scene, items: readonly DrawItem[]): GraphiteIsland[] {
    const context = this.context;
    const standing = items.filter((item): item is Standing => item.kind !== "tile");
    const ghosts = new Set([
      ...scene.nodes.filter((node) => node.presence === "other" || node.presence === "nowhere" || node.presence === "absent").map((node) => node.id),
      ...scene.props.filter((prop) => prop.presence === "other").map((prop) => prop.id),
    ]);
    return islandDrawOrder(islandSlabs(scene)).map((slab) => {
      const { island } = slab;
      const north = project({ x: island.gx0 - 0.5, y: island.gy0 - 0.5, h: island.top });
      const south = project({ x: island.gx1 + 0.5, y: island.gy1 + 0.5, h: island.top });
      const bands = slab.bands.map((band): GraphiteBand => {
        const meta = island.bands[band.index]!;
        const trim = bandTrim(island, band.index);
        const topFill = context.createLinearGradient(north.x, north.y, south.x, south.y);
        topFill.addColorStop(0, rgba(mixRgb(GRAPHITE.top.light, trim, GRAPHITE.tint)));
        topFill.addColorStop(1, rgba(mixRgb(GRAPHITE.top.dark, trim, GRAPHITE.tint)));
        const walls = band.walls.map((run) => {
          const colors = GRAPHITE.walls[run.side];
          const fill = context.createLinearGradient(...run.gradient);
          fill.addColorStop(0, rgba(mixRgb(colors.top, trim, GRAPHITE.tint * 0.6)));
          fill.addColorStop(1, rgba(colors.bottom));
          return { run, path: toPath(run.quad), fill };
        });
        const lips = new Path2D();
        const feet = new Path2D();
        for (const { run } of walls) {
          toPath(run.lip, false, lips);
          if (run.rim) toPath([run.quad[6]!, run.quad[7]!, run.quad[4]!, run.quad[5]!], false, feet);
        }
        // Etched pads under solid buildings only: a ghost stands on bare ground.
        const pads = new Path2D();
        for (const pad of band.pads) if (!ghosts.has(pad.id)) toPath(pad.points, true, pads);
        let shade: GraphiteBand["shade"];
        if (band.stepShade) {
          const fill = context.createLinearGradient(...band.stepShade.gradient);
          fill.addColorStop(0, "rgba(0, 0, 0, 0.42)");
          fill.addColorStop(1, "rgba(0, 0, 0, 0)");
          shade = { path: toPath(band.stepShade.polygon), fill };
        }
        const face = band.walls.find((run) => run.side === "left" && run.rim);
        return {
          slab: band,
          trim,
          top: toPath(band.top),
          topFill,
          grid: segmentsPath(band.grid),
          pads,
          walls,
          lips,
          feet,
          ...(band.front.length >= 4 ? { front: toPath(band.front, false) } : {}),
          frontLength: polylineLength(band.front),
          ...(shade ? { shade } : {}),
          ...(face ? { face: { x: face.lip[0], y: face.lip[1], length: face.lip[2] - face.lip[0], depth: face.depth } } : {}),
          items: standing
            .filter((item) => {
              const at = item.kind === "node" ? item.node : item.prop;
              return at.gx >= meta.gx0 && at.gx <= meta.gx1 && at.gy >= island.gy0 && at.gy <= island.gy1;
            })
            .sort((a, b) => {
              const one = a.kind === "node" ? a.node : a.prop;
              const two = b.kind === "node" ? b.node : b.prop;
              return one.gx + one.gy - (two.gx + two.gy);
            }),
        };
      });
      return { slab, bands, shadow: slab.shadow.map((layer) => toPath(layer)) };
    });
  }

  render(state: RenderState): FrameResult {
    const started = performance.now();
    const prepared = this.prepared;
    const context = this.context;
    const { viewport, dpr, camera } = state;
    const width = Math.round(viewport.width * dpr);
    const height = Math.round(viewport.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    // The void.
    const graphite = state.look === "graphite";
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (graphite) {
      const atmosphere = this.atmosphereFor(viewport);
      context.fillStyle = atmosphere.base;
    } else {
      const sky = context.createRadialGradient(viewport.width * 0.5, viewport.height * 0.3, 0, viewport.width * 0.5, viewport.height * 0.3, Math.max(viewport.width, viewport.height) * 0.85);
      sky.addColorStop(0, "#1b2330");
      sky.addColorStop(1, "#0a0d13");
      context.fillStyle = sky;
    }
    context.fillRect(0, 0, viewport.width, viewport.height);
    this.walled.clear();
    if (!prepared) return { cards: [], animating: false, ms: performance.now() - started };

    const { scene } = prepared;
    const zoom = camera.zoom;
    this.pixel = 1 / zoom;
    this.zoom = zoom;
    this.dpr = dpr;
    const world = () =>
      context.setTransform(
        dpr * zoom,
        0,
        0,
        dpr * zoom,
        dpr * (viewport.width / 2 - camera.x * zoom),
        dpr * (viewport.height / 2 - camera.y * zoom),
      );
    world();

    // Hairlines follow the same lattice as the terrain, behind every island.
    const grid = backgroundGrid(camera, viewport);
    context.lineWidth = 0.65 / zoom;
    for (const major of [false, true]) {
      context.beginPath();
      for (const line of grid) {
        if (line.major !== major) continue;
        context.moveTo(line.a.x, line.a.y);
        context.lineTo(line.b.x, line.b.y);
      }
      context.strokeStyle = graphite
        ? major ? GRAPHITE.grid.major : GRAPHITE.grid.minor
        : major ? "rgba(139, 170, 205, 0.14)" : "rgba(139, 170, 205, 0.065)";
      context.stroke();
    }
    if (graphite) {
      // The grid fades toward the edges under a vignette, and two soft blooms colour the air.
      const atmosphere = this.atmosphereFor(viewport);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = atmosphere.vignette;
      context.fillRect(0, 0, viewport.width, viewport.height);
      context.globalCompositeOperation = "lighter";
      for (const bloom of atmosphere.blooms) {
        context.fillStyle = bloom;
        context.fillRect(0, 0, viewport.width, viewport.height);
      }
      context.globalCompositeOperation = "source-over";
      world();
    }

    const spotlight = new Set<string>();
    if (state.selected) {
      spotlight.add(state.selected);
      for (const edge of scene.edges) {
        if (!state.categories.has(edge.category)) continue;
        if (edge.from === state.selected) spotlight.add(edge.to);
        if (edge.to === state.selected) spotlight.add(edge.from);
      }
    }
    const dimmed = (id: string) => state.selected !== undefined && !spotlight.has(id);

    const pulse = state.motion ? 0.5 + 0.5 * Math.sin(state.time * 3) : 0.7;
    // What the viewport can see, in world units, with room for walls and roofs.
    const view = {
      minX: camera.x - viewport.width / 2 / zoom - 40,
      maxX: camera.x + viewport.width / 2 / zoom + 40,
      minY: camera.y - viewport.height / 2 / zoom - 80,
      maxY: camera.y + viewport.height / 2 / zoom + 40,
    };
    this.drawnItems = graphite
      ? this.drawGraphite(prepared, state, spotlight, view)
      : this.drawClassic(prepared, state, dimmed, pulse, view);

    this.drawEdges(prepared, state);
    const cards = this.drawCards(prepared, state, spotlight);
    this.drawTitles(scene, state);

    const animating = state.motion && state.selected !== undefined;
    return { cards, animating, ms: performance.now() - started };
  }

  /** The classic look: atlas tiles and buildings interleaved by diagonal row. Returns how many it drew. */
  private drawClassic(prepared: Prepared, state: RenderState, dimmed: (id: string) => boolean, pulse: number, view: Bounds): number {
    this.drawUnderglow(prepared.scene);
    this.drawFrames(prepared);
    const sheet = atlas();
    let drawn = 0;
    for (const item of prepared.items) {
      if (OUTSIDE(prepared.boxes.get(item)!, view)) continue;
      drawn += 1;
      if (item.kind === "tile") this.drawTile(item.tile, item.island, prepared, sheet);
      else if (item.kind === "prop") {
        if ("icon" in item.prop) {
          const factor = this.fixtureLight(item.prop, prepared.scene, state);
          const ghost = item.prop.presence === "other";
          this.drawFaces(item.prop.geometry.faces, "construct", undefined, ghost ? 0 : 0.85 * factor, ghost ? `rgba(200, 210, 225, ${0.5 * factor})` : undefined, ghost);
          const tile = project({ x: item.prop.gx, y: item.prop.gy, h: item.prop.h });
          this.drawIconPlaque(tile, item.prop.icon, (ghost ? 0.32 : 0.85) * factor, false, ghost);
        } else this.drawFaces(item.prop.geometry.faces, item.prop.shape, undefined, 0.85);
      }
      else this.drawNode(item.node, state, dimmed(item.node.id), pulse);
    }
    return drawn;
  }

  /**
   * A gateway or endpoint dims with a selection, like everything outside the
   * spotlight, unless it carries the traffic of the selected building's subnet.
   */
  private fixtureLight(prop: Prop, scene: Scene, state: RenderState): number {
    if (state.selected === undefined) return 1;
    const band = scene.nodes.find((node) => node.id === state.selected)?.band;
    return band !== undefined && prop.serves.includes(band) ? 1 : 0.32;
  }

  // -------------------------------------------------------------------------
  // Graphite
  // -------------------------------------------------------------------------

  private atmosphereFor(viewport: Viewport): NonNullable<SceneRenderer["atmosphere"]> {
    const cached = this.atmosphere;
    if (cached && cached.width === viewport.width && cached.height === viewport.height) return cached;
    const context = this.context;
    const { width, height } = viewport;
    const reach = Math.max(width, height);
    const base = context.createLinearGradient(0, 0, 0, height);
    base.addColorStop(0, GRAPHITE.void.top);
    base.addColorStop(1, GRAPHITE.void.bottom);
    const vignette = context.createRadialGradient(width / 2, height * 0.45, reach * 0.22, width / 2, height * 0.45, reach * 0.78);
    vignette.addColorStop(0, rgba(GRAPHITE.void.vignette, 0));
    vignette.addColorStop(1, rgba(GRAPHITE.void.vignette, 0.82));
    const blooms = GRAPHITE.blooms.map((bloom) => {
      const gradient = context.createRadialGradient(width * bloom.x, height * bloom.y, 0, width * bloom.x, height * bloom.y, reach * bloom.radius);
      gradient.addColorStop(0, rgba(bloom.color, bloom.alpha));
      gradient.addColorStop(1, rgba(bloom.color, 0));
      return gradient;
    });
    this.atmosphere = { width, height, base, vignette, blooms };
    return this.atmosphere;
  }

  /**
   * The graphite look. Shadows on the floor far below, then the VPC
   * foundation, then whole islands back to front: each terrace's slab, then
   * whatever stands on it. Returns how many slabs and buildings it drew.
   */
  private drawGraphite(prepared: Prepared, state: RenderState, spotlight: ReadonlySet<string>, view: Bounds): number {
    const context = this.context;
    for (const { slab, shadow } of prepared.graphite) {
      if (slab.island.ghost === "blueprint" || OUTSIDE(slab.shadowBounds, view)) continue;
      context.fillStyle = "#000";
      shadow.forEach((layer, index) => {
        context.globalAlpha = GRAPHITE.shadow.layers[index]!.alpha * (slab.island.ghost ? 0.3 : 1);
        context.fill(layer);
      });
    }
    context.globalAlpha = 1;
    this.drawFramesGraphite(prepared);

    const islandOf = new Map(prepared.scene.nodes.map((node) => [node.id, node.island]));
    const lit = new Set([...spotlight].map((id) => islandOf.get(id)));
    const shimmering = state.motion && state.selected !== undefined ? islandOf.get(state.selected) : undefined;
    let drawn = 0;
    for (const island of prepared.graphite) {
      const { id } = island.slab.island;
      const focus = state.selected === undefined || lit.has(id) ? 1 : 0.4;
      for (const band of island.bands) {
        if (!OUTSIDE(band.slab.bounds, view)) {
          this.drawBand(island, band, focus, state.time, shimmering === id);
          drawn += 1;
        }
        for (const item of band.items) {
          if (OUTSIDE(prepared.boxes.get(item), view)) continue;
          drawn += 1;
          if (item.kind === "node") {
            const dimmed = state.selected !== undefined && !spotlight.has(item.node.id);
            this.drawNodeGraphite(item.node, state, dimmed);
          } else if ("icon" in item.prop) {
            const factor = this.fixtureLight(item.prop, prepared.scene, state);
            const ghost = item.prop.presence === "other";
            const tile = project({ x: item.prop.gx, y: item.prop.gy, h: item.prop.h });
            if (!ghost) this.drawStand(tile, item.prop.geometry.faces, item.prop.icon, factor);
            this.drawPlaqueGraphite(tile, item.prop.icon, (ghost ? 0.32 : 0.9) * factor, false, ghost, false);
          } else this.drawFaces(item.prop.geometry.faces, item.prop.shape, undefined, 0.85);
        }
      }
    }
    return drawn;
  }

  /** One terrace: its lit top, etched grid, pads and step shade, its walls and lips, its name, then the glowing trim. */
  private drawBand(island: GraphiteIsland, band: GraphiteBand, focus: number, time: number, shimmer: boolean): void {
    const context = this.context;
    const pixel = this.pixel;
    const ghost = island.slab.island.ghost;
    const trim = band.trim;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.lineWidth = pixel;
    if (ghost === "blueprint") {
      // A drawing of a network this deployment does not build: glass, hairlines and dashes, in the terrace's colour.
      const blueprint = trim;
      context.fillStyle = rgba(blueprint, 0.05);
      context.fill(band.top);
      context.save();
      context.clip(band.top);
      context.strokeStyle = rgba(blueprint, 0.12);
      context.stroke(band.grid);
      context.restore();
      for (const wall of band.walls) {
        context.fillStyle = rgba(blueprint, 0.035);
        context.fill(wall.path);
      }
      context.setLineDash([4 * pixel, 4 * pixel]);
      context.strokeStyle = rgba(blueprint, 0.3);
      for (const wall of band.walls) context.stroke(wall.path);
      context.stroke(band.pads);
      context.strokeStyle = rgba(blueprint, 0.62);
      context.stroke(band.top);
      context.setLineDash([]);
      this.drawWallName(island, band, rgba(mixRgb(blueprint, WHITE, 0.3), 0.7));
      return;
    }
    context.globalAlpha = ghost ? 0.3 : 1;
    context.fillStyle = band.topFill;
    context.fill(band.top);
    context.save();
    context.clip(band.top);
    context.strokeStyle = `rgba(255, 255, 255, ${GRAPHITE.etch})`;
    context.stroke(band.grid);
    if (band.shade) {
      context.fillStyle = band.shade.fill;
      context.fill(band.shade.path);
    }
    context.restore();
    context.fillStyle = "rgba(255, 255, 255, 0.03)";
    context.fill(band.pads);
    context.strokeStyle = rgba(trim, 0.34 * focus);
    context.stroke(band.pads);
    context.strokeStyle = `rgba(255, 255, 255, ${GRAPHITE.rim})`;
    context.stroke(band.top);
    for (const wall of band.walls) {
      context.fillStyle = wall.fill;
      context.fill(wall.path);
    }
    context.strokeStyle = `rgba(255, 255, 255, ${GRAPHITE.lip})`;
    context.stroke(band.lips);
    this.drawWallName(island, band, rgba(mixRgb(trim, WHITE, 0.35), 0.92 * focus), rgba(trim, 0.7 * focus));
    // Light: the trim along the front edges, a faint line at the wall's foot, and the shimmer.
    context.globalCompositeOperation = "lighter";
    context.strokeStyle = rgba(trim, 0.22 * focus);
    context.stroke(band.feet);
    if (band.front) {
      if (ghost) {
        context.setLineDash([4 * pixel, 4 * pixel]);
        context.strokeStyle = rgba(trim, 0.5);
        context.stroke(band.front);
        context.setLineDash([]);
      } else {
        for (const pass of GRAPHITE.glow) {
          context.strokeStyle = rgba(trim, pass.alpha * focus);
          context.lineWidth = pass.width * pixel;
          context.stroke(band.front);
        }
        if (shimmer) {
          const dash = 80;
          const gap = Math.max(band.frontLength, 320);
          context.setLineDash([dash, gap]);
          context.lineDashOffset = -((time * 150) % (dash + gap));
          context.strokeStyle = rgba(mixRgb(trim, WHITE, 0.4), 0.28);
          context.lineWidth = 6 * pixel;
          context.stroke(band.front);
          context.strokeStyle = rgba(mixRgb(trim, WHITE, 0.6), 0.95);
          context.lineWidth = 2 * pixel;
          context.stroke(band.front);
          context.setLineDash([]);
          context.lineDashOffset = 0;
        }
      }
    }
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.lineWidth = pixel;
  }

  /**
   * The island's name on its front-left wall, in the wall's own perspective,
   * or a terrace's name on its stretch of a terraced island's wall. Only when
   * it would be legible and fits; otherwise the flat title stands in for it.
   */
  private drawWallName(island: GraphiteIsland, band: GraphiteBand, color: string, glow?: string): void {
    const face = band.face;
    const terraced = island.slab.island.bands.length > 1;
    const meta = island.slab.island.bands[band.slab.index]!;
    if (!face) return;
    const text = (terraced ? meta.title : island.slab.island.title).toUpperCase();
    const size = Math.min(face.depth * (terraced ? 0.3 : 0.42), terraced ? 13 : 20);
    if (size * this.zoom < 9) return;
    const font = `600 ${size}px "Barlow Semi Condensed", Barlow, system-ui, sans-serif`;
    const spacing = size * 0.14;
    const width = this.measureSpaced(text, font, spacing);
    const inset = size * 0.9;
    if (width + inset * 2 > face.length) return;
    const context = this.context;
    context.save();
    // Wall space: x runs along the wall's top edge, y straight down its face.
    context.transform(1, 0.5, 0, 1, face.x, face.y);
    context.font = font;
    this.setSpacing(spacing);
    context.textBaseline = "middle";
    context.fillStyle = color;
    if (glow) {
      context.shadowColor = glow;
      context.shadowBlur = 8 * this.dpr;
    }
    context.fillText(text, inset, Math.min(face.depth * 0.45, size * 1.1));
    context.restore();
    this.setSpacing(0);
    this.walled.add(terraced ? meta.id : island.slab.island.id);
  }

  private setSpacing(spacing: number): void {
    if ("letterSpacing" in this.context) this.context.letterSpacing = `${spacing}px`;
  }

  private measureSpaced(text: string, font: string, spacing: number): number {
    const key = `${font}\u0000${spacing}\u0000${text}`;
    let width = this.widths.get(key);
    if (width === undefined) {
      this.context.font = font;
      this.setSpacing(spacing);
      width = this.context.measureText(text).width;
      this.setSpacing(0);
      this.widths.set(key, width);
    }
    return width;
  }

  /** The VPC foundation, dark glass edged in its island's trim. */
  private drawFramesGraphite(prepared: Prepared): void {
    const context = this.context;
    const pixel = this.pixel;
    const islands = new Map(prepared.scene.islands.map((island) => [island.id, island]));
    for (const { ghost, geometry, members } of prepared.scene.frames) {
      const owner = islands.get(members[0]!);
      const color = owner ? hexRgb(trimColor(owner)) : hex(FRAME_COLORS.network);
      context.globalAlpha = ghost ? 0.5 : 1;
      context.fillStyle = rgba(mixRgb([10, 10, 15], color, 0.1));
      if (geometry.left.length) { trace(context, geometry.left); context.fill(); }
      context.fillStyle = rgba(mixRgb([6, 6, 10], color, 0.07));
      if (geometry.right.length) { trace(context, geometry.right); context.fill(); }
      context.fillStyle = ghost ? rgba(color, 0.07) : rgba(mixRgb([12, 12, 18], color, 0.12), 0.92);
      trace(context, geometry.top);
      context.fill();
      context.setLineDash(ghost ? [6 * pixel, 4 * pixel] : []);
      context.strokeStyle = rgba(color, ghost ? 0.55 : 0.85);
      context.lineWidth = 1.2 * pixel;
      context.stroke();
      if (!ghost) {
        context.globalCompositeOperation = "lighter";
        context.strokeStyle = rgba(color, 0.12);
        context.lineWidth = 5 * pixel;
        context.stroke();
        context.globalCompositeOperation = "source-over";
      }
      context.setLineDash([]);
      context.strokeStyle = rgba(color, 0.18);
      context.lineWidth = 0.7 * pixel;
      trace(context, geometry.inset);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  /** A filled unit circle under a transform: one cached gradient serves every building. */
  private blob(x: number, y: number, rx: number, ry: number, fill: CanvasGradient): void {
    const context = this.context;
    context.save();
    context.translate(x, y);
    context.scale(rx, ry);
    context.fillStyle = fill;
    context.beginPath();
    context.arc(0, 0, 1, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  private contactShadow(): CanvasGradient {
    if (!this.contact) {
      this.contact = this.context.createRadialGradient(0, 0, 0, 0, 0, 1);
      this.contact.addColorStop(0, "rgba(0, 0, 0, 0.55)");
      this.contact.addColorStop(0.6, "rgba(0, 0, 0, 0.22)");
      this.contact.addColorStop(1, "rgba(0, 0, 0, 0)");
    }
    return this.contact;
  }

  private spill(color: string): CanvasGradient {
    let gradient = this.tints.get(color);
    if (!gradient) {
      const rgb = hex(color);
      gradient = this.context.createRadialGradient(0, 0, 0, 0, 0, 1);
      gradient.addColorStop(0, rgba(rgb, 0.26));
      gradient.addColorStop(0.5, rgba(rgb, 0.08));
      gradient.addColorStop(1, rgba(rgb, 0));
      this.tints.set(color, gradient);
    }
    return gradient;
  }

  private plaqueFills(): NonNullable<SceneRenderer["plaque"]> {
    if (!this.plaque) {
      const face = this.context.createLinearGradient(0, -54, 0, -8);
      face.addColorStop(0, "#1c2738");
      face.addColorStop(1, "#0c121b");
      const glass = this.context.createLinearGradient(0, -54, 0, -30);
      glass.addColorStop(0, "rgba(255, 255, 255, 0.14)");
      glass.addColorStop(1, "rgba(255, 255, 255, 0)");
      this.plaque = { face, glass };
    }
    return this.plaque;
  }

  /**
   * What an enabled building stands on: its contact shadow, the light its icon
   * spills, and a raised graphite plinth. The plinth stays solid when a
   * selection dims the building (only its plaque and light fade); a ghost,
   * outside this environment, stands on nothing.
   */
  private drawStand(tile: Point, faces: readonly Face[], icon: IconKey, light: number): void {
    const context = this.context;
    const pixel = this.pixel;
    context.globalAlpha = 0.9;
    this.blob(tile.x + 3, tile.y + 5, 30, 14, this.contactShadow());
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = light;
    this.blob(tile.x, tile.y + 1, 46, 23, this.spill(ICON_TINT[icon]));
    context.globalCompositeOperation = "source-over";
    const [left, right, top] = faces;
    context.globalAlpha = 1;
    for (const [face, fill] of [[left, "#2c343f"], [right, "#1c222a"], [top, "#3a4452"]] as const) {
      if (!face) continue;
      trace(context, face.points);
      context.fillStyle = fill;
      context.fill();
    }
    if (top) {
      // The plinth's front edges catch the light.
      const [, , ex, ey, sx, sy, wx, wy] = top.points as [number, number, number, number, number, number, number, number];
      context.strokeStyle = "rgba(255, 255, 255, 0.18)";
      context.lineWidth = pixel;
      trace(context, [wx, wy, sx, sy, ex, ey], false);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  /** A service plaque with thickness: a depth edge, a glass face, a hairline in its icon's colour. */
  private drawPlaqueGraphite(tile: Point, key: IconKey, alpha: number, selected: boolean, ghost: boolean, hovered: boolean): void {
    const context = this.context;
    const pixel = this.pixel;
    const fills = this.plaqueFills();
    const tint = hex(ICON_TINT[key]);
    context.save();
    context.translate(tile.x, tile.y);
    context.globalAlpha = alpha;
    if (!ghost) {
      context.fillStyle = "#04070b";
      context.beginPath();
      context.roundRect(-22, -52, 46, 46, 5);
      context.fill();
    }
    context.beginPath();
    context.roundRect(-24, -54, 46, 46, 5);
    context.fillStyle = ghost ? "#111b29" : fills.face;
    context.fill();
    if (!ghost) {
      context.save();
      context.clip();
      context.fillStyle = fills.glass;
      context.fillRect(-24, -54, 46, 24);
      context.restore();
    }
    context.setLineDash(ghost ? [3 * pixel, 3 * pixel] : []);
    context.strokeStyle = selected ? "#f2f6ff" : hovered ? "rgba(255, 255, 255, 0.75)" : ghost ? "#63758d" : rgba(tint, 0.72);
    context.lineWidth = (selected ? 1.5 : 1) * pixel;
    context.stroke();
    context.setLineDash([]);
    if (selected) {
      context.globalCompositeOperation = "lighter";
      context.strokeStyle = rgba(tint, 0.4);
      context.lineWidth = 5 * pixel;
      context.stroke();
      context.globalCompositeOperation = "source-over";
    }
    const icon = this.icons.get(key);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(icon, -21, -51, 40, 40);
    }
    context.restore();
  }

  private drawRoleIconGraphite(tile: Point, key: IconKey, alpha: number, ghost: boolean): void {
    const context = this.context;
    const { x, y, size, padding } = ICON_BADGE;
    context.save();
    context.translate(tile.x, tile.y);
    context.globalAlpha = alpha;
    context.fillStyle = "#04070b";
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, size, size, 4);
    context.fill();
    context.beginPath();
    context.roundRect(x, y, size, size, 4);
    context.fillStyle = "#121b28";
    context.fill();
    context.setLineDash(ghost ? [3 * this.pixel, 3 * this.pixel] : []);
    context.strokeStyle = ghost ? "#63758d" : rgba(hex(ICON_TINT[key]), 0.75);
    context.lineWidth = this.pixel;
    context.stroke();
    context.setLineDash([]);
    const icon = this.icons.get(key);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(icon, x + padding, y + padding, size - padding * 2, size - padding * 2);
    }
    context.restore();
  }

  private drawNodeGraphite(node: SceneNode, state: RenderState, dimmed: boolean): void {
    const context = this.context;
    const tile = project({ x: node.gx, y: node.gy, h: node.h });
    const selected = state.selected === node.id;
    const hovered = state.hovered === node.id;
    const ghost = node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
    const factor = dimmed ? 0.32 : 1;
    if (!ghost) this.drawStand(tile, node.geometry.faces, node.icon, factor);
    this.drawPlaqueGraphite(tile, node.icon, factor * (ghost ? 0.32 : 1), selected, ghost, hovered);
    if (node.roleIcon) this.drawRoleIconGraphite(tile, node.roleIcon, factor * (ghost ? 0.32 : 1), ghost);
    if (selected || hovered) {
      trace(context, node.geometry.hull);
      context.strokeStyle = selected ? "rgba(255, 248, 230, 0.6)" : "rgba(255, 255, 255, 0.35)";
      context.lineWidth = this.pixel;
      context.stroke();
    }
  }

  private drawFrames(prepared: Prepared): void {
    const context = this.context;
    context.save();
    for (const { ghost, geometry } of prepared.scene.frames) {
      const color = FRAME_COLORS.network;
      context.globalAlpha = ghost ? 0.4 : 1;
      context.fillStyle = "#102329";
      if (geometry.left.length) { trace(context, geometry.left); context.fill(); }
      context.fillStyle = "#0b1b22";
      if (geometry.right.length) { trace(context, geometry.right); context.fill(); }
      context.fillStyle = ghost ? "rgba(40, 68, 77, 0.25)" : "rgba(27, 53, 59, 0.94)";
      trace(context, geometry.top);
      context.fill();
      context.setLineDash(ghost ? [6 * this.pixel, 4 * this.pixel] : []);
      context.strokeStyle = ghost ? "#87b7c6" : color;
      context.lineWidth = 1.8 * this.pixel;
      context.stroke();
      context.setLineDash([]);
      context.strokeStyle = `${color}3d`;
      context.lineWidth = 0.7 * this.pixel;
      trace(context, geometry.inset);
      context.stroke();
    }
    context.restore();
  }

  private drawUnderglow(scene: Scene): void {
    const context = this.context;
    for (const island of scene.islands) {
      const centre = project({ x: (island.gx0 + island.gx1) / 2, y: (island.gy0 + island.gy1) / 2, h: island.base });
      const radius = ((island.gx1 - island.gx0 + island.gy1 - island.gy0) / 2) * 30;
      // A circle under a 1 : 0.5 squash, so the fade follows the ellipse to its edge.
      context.save();
      context.translate(centre.x, centre.y + 40);
      context.scale(1, 0.5);
      const glow = context.createRadialGradient(0, 0, 0, 0, 0, radius);
      glow.addColorStop(0, island.ghost ? "rgba(120, 140, 170, 0.05)" : "rgba(120, 150, 190, 0.11)");
      glow.addColorStop(1, "rgba(120, 150, 190, 0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }

  private drawTile(tile: Tile, island: Island, prepared: Prepared, sheet: HTMLCanvasElement): void {
    const context = this.context;
    const centre = project({ x: tile.gx, y: tile.gy, h: tile.h });
    const alpha = island.ghost === "blueprint" ? 0.5 : island.ghost ? 0.2 : 1;
    context.globalAlpha = alpha;
    const walls = prepared.walls.get(tile);
    const west = [centre.x - 32, centre.y];
    const south = [centre.x, centre.y + 16];
    const east = [centre.x + 32, centre.y];
    if (walls?.left !== undefined && tile.wallLeft !== undefined) {
      const drop = (tile.h - tile.wallLeft) * ELEVATION_STEP;
      context.fillStyle = walls.left;
      trace(context, [...west, ...south, south[0]!, south[1]! + drop, west[0]!, west[1]! + drop]);
      context.fill();
    }
    if (walls?.right !== undefined && tile.wallRight !== undefined) {
      const drop = (tile.h - tile.wallRight) * ELEVATION_STEP;
      context.fillStyle = walls.right;
      trace(context, [...south, ...east, east[0]!, east[1]! + drop, south[0]!, south[1]! + drop]);
      context.fill();
    }
    // The block: its whole 32 × 32 sprite at 2×, so the top lands on the tile
    // and the skirt on the first step of wall below it.
    const origin = spriteOrigin(tile.material, tile.variant, tile.h);
    context.imageSmoothingEnabled = false;
    // Half a source pixel of overdraw closes the hairline seams scaling opens.
    context.drawImage(sheet, origin.x, origin.y, SPRITE, SPRITE, centre.x - 32.5, centre.y - 32.5, 65, 65);
    if (island.ghost) {
      context.globalAlpha = 1;
      context.strokeStyle = island.ghost === "blueprint" ? "rgba(150, 190, 235, 0.22)" : "rgba(200, 210, 225, 0.18)";
      context.lineWidth = this.pixel;
      trace(context, [centre.x, centre.y - 16, ...east, ...south, ...west]);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  private drawFaces(faces: readonly Face[], kind: ShapeKind, glyph: Glyph | undefined, alpha: number, outline?: string, dash?: boolean): void {
    const context = this.context;
    const pixel = this.pixel;
    for (const face of faces) {
      const color = face.part === "dark" && face.stroke ? BUILDINGS[kind].dark ?? "#262b33" : faceColor(kind, face.part, face.shade, glyph);
      trace(context, face.points, face.stroke === undefined || face.closed === true);
      if (face.stroke !== undefined) {
        context.globalAlpha = alpha;
        context.strokeStyle = color;
        context.lineWidth = face.stroke;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.stroke();
        continue;
      }
      if (alpha > 0) {
        context.globalAlpha = alpha;
        context.fillStyle = color;
        context.fill();
      }
      if (outline) {
        context.globalAlpha = 1;
        context.setLineDash(dash ? [3 * pixel, 3 * pixel] : []);
        context.strokeStyle = outline;
        context.lineWidth = pixel;
        context.stroke();
        context.setLineDash([]);
      }
    }
    context.globalAlpha = 1;
  }

  private drawNode(node: SceneNode, state: RenderState, dimmed: boolean, pulse: number): void {
    const context = this.context;
    const pixel = this.pixel;
    const tile = project({ x: node.gx, y: node.gy, h: node.h });
    const selected = state.selected === node.id;
    if (selected) {
      // A ring of light on the tile it stands on.
      context.strokeStyle = `rgba(255, 244, 214, ${0.55 + pulse * 0.4})`;
      context.lineWidth = 2 * pixel;
      context.shadowColor = "rgba(255, 226, 160, 0.9)";
      context.shadowBlur = 12;
      context.beginPath();
      context.ellipse(tile.x, tile.y, 26 + pulse * 3, 13 + pulse * 1.5, 0, 0, Math.PI * 2);
      context.stroke();
      context.shadowBlur = 0;
    }
    const factor = dimmed ? 0.32 : 1;
    switch (node.presence) {
      case "built":
      case "present":
        this.drawFaces(node.geometry.faces, "construct", undefined, factor);
        break;
      default:
        this.drawFaces(node.geometry.faces, "construct", undefined, 0, `rgba(200, 210, 225, ${0.5 * factor})`, true);
        break;
    }
    const ghost = node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
    this.drawIconPlaque(tile, node.icon, factor * (ghost ? 0.32 : 1), selected, ghost);
    if (node.roleIcon) this.drawRoleIcon(tile, node.roleIcon, factor * (ghost ? 0.32 : 1), ghost);
    if (selected || state.hovered === node.id) {
      trace(context, node.geometry.hull);
      context.strokeStyle = selected ? "rgba(255, 248, 230, 0.95)" : "rgba(255, 255, 255, 0.6)";
      context.lineWidth = (selected ? 1.6 : 1.2) * pixel;
      context.stroke();
    }
  }

  private drawIconPlaque(tile: Point, key: IconKey, alpha: number, selected = false, ghost = false): void {
    const context = this.context;
    const pixel = this.pixel;
    context.globalAlpha = alpha;
    context.fillStyle = "#111b29";
    context.strokeStyle = selected ? "#e6f1ff" : "#63758d";
    context.lineWidth = (selected ? 1.5 : 0.8) * pixel;
    context.setLineDash(ghost ? [3 * pixel, 3 * pixel] : []);
    context.beginPath();
    context.roundRect(tile.x - 24, tile.y - 54, 48, 48, 5);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    const icon = this.icons.get(key);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(icon, tile.x - 20, tile.y - 50, 40, 40);
    }
    context.globalAlpha = 1;
  }

  private drawRoleIcon(tile: Point, key: IconKey, alpha: number, ghost: boolean): void {
    const context = this.context;
    const { x: dx, y: dy, size, padding } = ICON_BADGE;
    const x = tile.x + dx;
    const y = tile.y + dy;
    context.globalAlpha = alpha;
    context.fillStyle = "#111b29";
    context.strokeStyle = "#63758d";
    context.lineWidth = 0.8 * this.pixel;
    context.setLineDash(ghost ? [3 * this.pixel, 3 * this.pixel] : []);
    context.beginPath();
    context.roundRect(x, y, size, size, 4);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    const icon = this.icons.get(key);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(icon, x + padding, y + padding, size - padding * 2, size - padding * 2);
    }
    context.globalAlpha = 1;
  }

  private drawEdges(prepared: Prepared, state: RenderState): void {
    const context = this.context;
    const pixel = this.pixel;
    const lit: SceneEdge[] = [];
    for (const edge of prepared.scene.edges) {
      if (!state.categories.has(edge.category)) continue;
      const active =
        state.hoveredEdge === edge.edge.id ||
        (state.selected !== undefined && (edge.from === state.selected || edge.to === state.selected));
      if (active) {
        lit.push(edge);
        continue;
      }
      const arc = prepared.arcs.get(edge)!;
      const color = hex(CATEGORY_COLORS[edge.category]);
      context.strokeStyle = rgba(color, state.selected ? 0.06 : edge.edge.provenance === "derived" ? 0.14 : 0.24);
      context.lineWidth = 1.2 * pixel;
      context.setLineDash(edge.edge.provenance !== "declared" ? [4 * pixel, 4 * pixel] : []);
      this.polyline(arc.points);
      context.stroke();
    }
    context.setLineDash([]);
    for (const edge of lit) {
      const arc = prepared.arcs.get(edge)!;
      const color = hex(CATEGORY_COLORS[edge.category]);
      context.shadowColor = rgba(color, 0.8);
      context.shadowBlur = 10;
      context.strokeStyle = rgba(color, 0.95);
      context.lineWidth = 2.2 * pixel;
      context.setLineDash(edge.edge.provenance !== "declared" ? [5 * pixel, 4 * pixel] : []);
      this.polyline(arc.points);
      context.stroke();
      context.setLineDash([]);
      // Which way it points.
      const end = arc.points[arc.points.length - 1]!;
      const before = arc.points[arc.points.length - 3]!;
      const angle = Math.atan2(end.y - before.y, end.x - before.x);
      const size = 7 * pixel;
      context.fillStyle = rgba(color, 0.95);
      context.beginPath();
      context.moveTo(end.x, end.y);
      context.lineTo(end.x - Math.cos(angle - 0.45) * size, end.y - Math.sin(angle - 0.45) * size);
      context.lineTo(end.x - Math.cos(angle + 0.45) * size, end.y - Math.sin(angle + 0.45) * size);
      context.closePath();
      context.fill();
      if (state.motion) {
        // A few packets, travelling at a steady 60 world units a second.
        const count = Math.max(1, Math.min(3, Math.round(arc.length / 220)));
        for (let index = 0; index < count; index += 1) {
          const k = (((state.time * 60) / arc.length + index / count) % 1 + 1) % 1;
          const point = this.along(arc.points, k);
          context.fillStyle = "rgba(255, 252, 240, 0.95)";
          context.beginPath();
          context.arc(point.x, point.y, 2.6 * pixel, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.shadowBlur = 0;
    }
  }

  private polyline(points: readonly Point[]): void {
    const context = this.context;
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (let index = 1; index < points.length; index += 1) context.lineTo(points[index]!.x, points[index]!.y);
  }

  private along(points: readonly Point[], t: number): Point {
    const position = t * (points.length - 1);
    const index = Math.min(points.length - 2, Math.floor(position));
    const fraction = position - index;
    const a = points[index]!;
    const b = points[index + 1]!;
    return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
  }

  private measure(text: string, font: string): number {
    const key = `${font}\u0000${text}`;
    let width = this.widths.get(key);
    if (width === undefined) {
      this.context.font = font;
      width = this.context.measureText(text).width;
      this.widths.set(key, width);
    }
    return width;
  }

  private fit(text: string, font: string, max: number): string {
    if (this.measure(text, font) <= max) return text;
    let low = 1;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.measure(`${text.slice(0, middle)}…`, font) <= max) low = middle;
      else high = middle - 1;
    }
    return `${text.slice(0, low)}…`;
  }

  private drawCards(prepared: Prepared, state: RenderState, spotlight: ReadonlySet<string>): CardHit[] {
    const context = this.context;
    const { camera, viewport, dpr } = state;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Never smaller than legible: where cards would then collide, placement drops the less important.
    const zoomScale = Math.max(0.8, Math.min(1.2, camera.zoom));
    const showAll = camera.zoom >= 0.55;

    // Lay every candidate card out first.
    interface Placed {
      readonly node: SceneNode;
      readonly order: number;
      readonly priority: number;
      readonly scale: number;
      readonly font: string;
      readonly text: string;
      readonly textWidth: number;
      readonly anchor: Point;
      readonly top: Point;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
    const candidates: Placed[] = [];
    prepared.scene.nodes.forEach((node, order) => {
      const emphasised = node.id === state.selected || node.id === state.hovered || (state.selected !== undefined && spotlight.has(node.id));
      if (!showAll && !emphasised) return;
      // What the selection touches stays readable however far out you are.
      const scale = emphasised ? Math.max(0.9, zoomScale) : zoomScale;
      const font = `500 ${12 * scale}px Barlow, system-ui, sans-serif`;
      const tile = project({ x: node.gx, y: node.gy, h: node.h });
      const anchor = worldToScreen(camera, viewport, { x: tile.x, y: tile.y - CARD_LIFT });
      const text = this.fit(node.label, font, CARD_MAX_TEXT * scale);
      const textWidth = this.measure(text, font);
      const badge = node.badge ? (BADGE_WIDTH[node.badge] + 6) * scale : 0;
      const width = textWidth + 14 * scale + badge + (node.auth ? 14 * scale : 0);
      const height = CARD_HEIGHT * scale;
      const x = anchor.x - width / 2;
      const y = anchor.y - height;
      if (x > viewport.width || x + width < 0 || y > viewport.height || y + height < 0) return;
      const priority = node.id === state.selected ? 3 : node.id === state.hovered ? 2 : emphasised ? 1 : 0;
      candidates.push({ node, order, priority, scale, font, text, textWidth, anchor, top: worldToScreen(camera, viewport, node.geometry.top), x, y, width, height });
    });

    // Then let the most important claim their space: the selection, the
    // pointer, what the selection touches, then the rest from the front. A card
    // that would land on one already placed is left out; the inspector still
    // names it.
    const accepted = acceptCards(candidates);

    const cards: CardHit[] = [];
    for (const { node, scale, font, text, textWidth, anchor, top, x, y, width, height } of accepted) {
      const padding = 7 * scale;
      const selected = node.id === state.selected;
      const quiet = state.selected !== undefined && !spotlight.has(node.id);
      const ghost = node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
      context.globalAlpha = quiet ? 0.35 : ghost ? 0.7 : 1;
      // The leader from card to roof.
      if (top.y > anchor.y + 2) {
        context.strokeStyle = selected ? "rgba(255, 244, 214, 0.8)" : "rgba(220, 228, 240, 0.28)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(anchor.x, anchor.y);
        context.lineTo(top.x, top.y - 2);
        context.stroke();
      }
      context.fillStyle = selected ? "#f3efe4" : "rgba(14, 19, 27, 0.86)";
      context.strokeStyle = selected ? "#fff8e6" : node.id === state.hovered ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.14)";
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(x, y, width, height, 5 * scale);
      context.fill();
      context.stroke();
      context.font = font;
      context.textBaseline = "middle";
      context.fillStyle = selected ? "#141922" : ghost ? "#9aa3ae" : "#e7eaef";
      context.fillText(text, x + padding, y + height / 2 + 0.5);
      if (node.badge) this.drawDeploymentBadge(node.badge, x + padding + textWidth + 6 * scale, y + height / 2, scale);
      if (node.auth) {
        // A padlock: the gateway admits signed-in users only.
        const lx = x + padding + textWidth + 5 * scale + (node.badge ? (BADGE_WIDTH[node.badge] + 6) * scale : 0);
        const ly = y + height / 2;
        context.strokeStyle = selected ? "#141922" : "#cfd5dd";
        context.fillStyle = context.strokeStyle;
        context.lineWidth = 1.2;
        context.beginPath();
        context.arc(lx + 3.5 * scale, ly - 1.5 * scale, 2.4 * scale, Math.PI, 0);
        context.stroke();
        context.fillRect(lx, ly - 1.2 * scale, 7 * scale, 5 * scale);
      }
      context.globalAlpha = 1;
      cards.push({ id: node.id, x, y, width, height });
    }
    return cards;
  }

  private drawDeploymentBadge(kind: DeploymentBadgeKind, x: number, y: number, scale: number): void {
    const context = this.context;
    const badge = DEPLOYMENT_BADGES[kind];
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    context.fillStyle = badge.background;
    context.strokeStyle = badge.color;
    context.lineWidth = 0.6;
    context.beginPath();
    context.roundRect(0, -7.5, BADGE_WIDTH[kind], 15, 3);
    context.fill();
    context.stroke();
    context.save();
    context.translate(4, -5.5);
    context.scale(11 / 24, 11 / 24);
    context.lineWidth = 1.8;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const icon of this.badgePaths.get(kind) ?? []) context.stroke(icon);
    context.restore();
    context.font = "600 9px Barlow, system-ui, sans-serif";
    context.fillStyle = badge.color;
    context.textBaseline = "middle";
    context.fillText(badge.label.toUpperCase(), 19, 0.5);
    context.restore();
  }

  private drawTitles(scene: Scene, state: RenderState): void {
    const context = this.context;
    const { camera, viewport } = state;
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    context.textAlign = "right";
    for (const island of scene.islands) {
      if (this.walled.has(island.id)) continue;
      // On the island's left flank, level with its surface, like a map label.
      const flank = project({ x: island.gx0, y: island.gy1 + 0.5, h: island.top });
      const point = worldToScreen(camera, viewport, { x: flank.x - 32, y: flank.y });
      const x = point.x - 14;
      context.textBaseline = "middle";
      context.font = `600 ${15 * scale}px "Barlow Semi Condensed", Barlow, system-ui, sans-serif`;
      const network = state.look === "graphite" ? rgba(mixRgb(hexRgb(trimColor(island)), WHITE, 0.55)) : "#a4ded3";
      context.fillStyle = island.ghost ? "rgba(214, 222, 234, 0.6)" : island.region === "network" ? network : "rgba(236, 239, 244, 0.94)";
      context.fillText(island.title, x, point.y);
    }
    context.textAlign = "center";
    if (camera.zoom >= 0.45) {
      context.font = `500 ${11 * scale}px Barlow, system-ui, sans-serif`;
      context.textBaseline = "middle";
      for (const island of scene.islands) {
        if (island.bands.length < 2) continue;
        for (const band of island.bands) {
          if (this.walled.has(band.id)) continue;
          const ground = project({ x: band.gx, y: band.gy - 0.2, h: band.h });
          const at = worldToScreen(camera, viewport, ground);
          context.fillStyle = "rgba(235, 240, 230, 0.72)";
          context.fillText(band.title, at.x, at.y);
        }
      }
    }
    context.textAlign = "start";
  }
}
