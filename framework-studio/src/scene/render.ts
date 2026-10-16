import type { EdgeCategory } from "../lookup";
import { atlasPixels, sideColor, spriteOrigin, SPRITE } from "./atlas";
import type { Decoration, Island, Prop, Scene, SceneEdge, SceneNode, Tile } from "./build";
import { worldToScreen, type Camera, type Point, type Viewport } from "./camera";
import { ELEVATION_STEP, project } from "./iso";
import { acceptCards, arcControl, arcPoints, type CardHit } from "./picking";
import type { Face, Glyph, Part, Shade, ShapeKind } from "./shapes";

/**
 * Draws a {@link Scene} onto a 2D canvas.
 *
 * Passes, back to front: the void, light pooling under each island, terrain
 * and buildings interleaved by diagonal row (so raised ground hides what is
 * behind it), the relationship arcs in the air above, their moving packets,
 * the label cards, and the region names. Nothing here decides anything about
 * the application; it paints what the scene says.
 *
 * Per scene, the draw order and every terrain gradient are built once.
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
}

export interface FrameResult {
  /** Label cards as drawn, in painter's order, for picking. */
  readonly cards: readonly CardHit[];
  /** Whether anything on screen moves, so the caller keeps drawing. */
  readonly animating: boolean;
  readonly ms: number;
}

export const LANE_COLORS = { local: "#e0a43a", dev: "#2fb3bc", prod: "#8789ff" } as const;

export const CATEGORY_COLORS: Readonly<Record<EdgeCategory, string>> = {
  routes: "#ddd3bd",
  inputs: "#8fb7d9",
  permissions: "#e59a86",
  invocations: "#c3b2ff",
  integrations: "#94d6b0",
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

interface Prepared {
  readonly scene: Scene;
  readonly items: readonly DrawItem[];
  readonly walls: ReadonlyMap<Tile, { left?: CanvasGradient | string; right?: CanvasGradient | string }>;
  readonly arcs: ReadonlyMap<SceneEdge, { readonly points: readonly Point[]; readonly length: number }>;
  readonly anchors: ReadonlyMap<string, Point>;
  /** Each draw item's world bounding box, for culling. */
  readonly boxes: ReadonlyMap<DrawItem, { minX: number; minY: number; maxX: number; maxY: number }>;
}

const CARD_HEIGHT = 22;
const CARD_MAX_TEXT = 140;
const CARD_LIFT = 64;

export class SceneRenderer {
  private readonly context: CanvasRenderingContext2D;
  private prepared: Prepared | undefined;
  private readonly widths = new Map<string, number>();
  /** One screen pixel, in world units, for this frame. */
  private pixel = 1;
  /** How many tiles and buildings the last frame drew, after culling. */
  drawnItems = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser offers no 2D canvas.");
    this.context = context;
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
      const a = anchors.get(edge.edge.from)!;
      const b = anchors.get(edge.edge.to)!;
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
    this.prepared = { scene, items, walls, arcs, anchors, boxes };
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
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = context.createRadialGradient(viewport.width * 0.5, viewport.height * 0.3, 0, viewport.width * 0.5, viewport.height * 0.3, Math.max(viewport.width, viewport.height) * 0.85);
    sky.addColorStop(0, "#1b2330");
    sky.addColorStop(1, "#0a0d13");
    context.fillStyle = sky;
    context.fillRect(0, 0, viewport.width, viewport.height);
    if (!prepared) return { cards: [], animating: false, ms: performance.now() - started };

    const { scene } = prepared;
    const zoom = camera.zoom;
    this.pixel = 1 / zoom;
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

    const spotlight = new Set<string>();
    if (state.selected) {
      spotlight.add(state.selected);
      for (const edge of scene.edges) {
        if (!state.categories.has(edge.category)) continue;
        if (edge.edge.from === state.selected) spotlight.add(edge.edge.to);
        if (edge.edge.to === state.selected) spotlight.add(edge.edge.from);
      }
    }
    const dimmed = (id: string) => state.selected !== undefined && !spotlight.has(id);

    this.drawUnderglow(scene);
    const sheet = atlas();
    const pulse = state.motion ? 0.5 + 0.5 * Math.sin(state.time * 3) : 0.7;
    // What the viewport can see, in world units, with room for walls and roofs.
    const view = {
      minX: camera.x - viewport.width / 2 / zoom - 40,
      maxX: camera.x + viewport.width / 2 / zoom + 40,
      minY: camera.y - viewport.height / 2 / zoom - 80,
      maxY: camera.y + viewport.height / 2 / zoom + 40,
    };
    let drawn = 0;
    for (const item of prepared.items) {
      const box = prepared.boxes.get(item)!;
      if (box.maxX < view.minX || box.minX > view.maxX || box.maxY < view.minY || box.minY > view.maxY) continue;
      drawn += 1;
      if (item.kind === "tile") this.drawTile(item.tile, item.island, prepared, sheet);
      else if (item.kind === "prop") this.drawFaces(item.prop.geometry.faces, item.prop.shape, undefined, 0.85);
      else this.drawNode(item.node, state, dimmed(item.node.id), pulse);
    }
    this.drawnItems = drawn;

    this.drawEdges(prepared, state);
    const cards = this.drawCards(prepared, state, spotlight);
    this.drawTitles(scene, state);

    const animating = state.motion && state.selected !== undefined;
    return { cards, animating, ms: performance.now() - started };
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
    const alpha = island.ghost === "absent" ? 0.2 : island.ghost === "blueprint" ? 0.5 : 1;
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
        this.drawFaces(node.geometry.faces, node.shape, node.glyph, factor);
        break;
      case "local":
        // A hologram: Compose runs it, the selected deployment does not.
        this.drawFaces(node.geometry.faces, node.shape, node.glyph, 0.42 * factor, `rgba(224, 164, 58, ${0.85 * factor})`);
        break;
      default:
        this.drawFaces(node.geometry.faces, node.shape, node.glyph, 0, `rgba(200, 210, 225, ${0.5 * factor})`, true);
        break;
    }
    if (selected || state.hovered === node.id) {
      trace(context, node.geometry.hull);
      context.strokeStyle = selected ? "rgba(255, 248, 230, 0.95)" : "rgba(255, 255, 255, 0.6)";
      context.lineWidth = (selected ? 1.6 : 1.2) * pixel;
      context.stroke();
    }
  }

  private drawEdges(prepared: Prepared, state: RenderState): void {
    const context = this.context;
    const pixel = this.pixel;
    const lit: SceneEdge[] = [];
    for (const edge of prepared.scene.edges) {
      if (!state.categories.has(edge.category)) continue;
      const active =
        state.hoveredEdge === edge.edge.id ||
        (state.selected !== undefined && (edge.edge.from === state.selected || edge.edge.to === state.selected));
      if (active) {
        lit.push(edge);
        continue;
      }
      const arc = prepared.arcs.get(edge)!;
      const color = hex(CATEGORY_COLORS[edge.category]);
      context.strokeStyle = rgba(color, state.selected ? 0.06 : edge.edge.provenance === "derived" ? 0.14 : 0.24);
      context.lineWidth = 1.2 * pixel;
      context.setLineDash(edge.edge.provenance === "derived" ? [4 * pixel, 4 * pixel] : []);
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
      context.setLineDash(edge.edge.provenance === "derived" ? [5 * pixel, 4 * pixel] : []);
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
      const dots = node.lanes ? 30 * scale : node.auth ? 14 * scale : 0;
      const width = textWidth + 14 * scale + dots;
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
      if (node.lanes) {
        const lanes = [
          [node.lanes.local, LANE_COLORS.local],
          [node.lanes.dev, LANE_COLORS.dev],
          [node.lanes.prod, LANE_COLORS.prod],
        ] as const;
        lanes.forEach(([on, color], index) => {
          const cx = x + padding + textWidth + 8 * scale + index * 8.5 * scale;
          context.beginPath();
          context.arc(cx, y + height / 2, 3 * scale, 0, Math.PI * 2);
          context.lineWidth = 1.5;
          context.strokeStyle = color;
          context.fillStyle = color;
          if (on) context.fill();
          else context.stroke();
        });
      } else if (node.auth) {
        // A padlock: the gateway admits signed-in users only.
        const lx = x + padding + textWidth + 5 * scale;
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

  private drawTitles(scene: Scene, state: RenderState): void {
    const context = this.context;
    const { camera, viewport } = state;
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    context.textAlign = "right";
    for (const island of scene.islands) {
      // On the island's left flank, level with its surface, like a map label.
      const flank = project({ x: island.gx0, y: island.gy1 + 0.5, h: island.top });
      const point = worldToScreen(camera, viewport, { x: flank.x - 32, y: flank.y });
      const x = point.x - 14;
      const note =
        island.ghost === "absent"
          ? "absent in this graph"
          : island.ghost === "blueprint"
            ? scene.mode === "dev"
              ? "not built by a development deployment"
              : "not built: nothing is placed in it"
            : undefined;
      context.textBaseline = "middle";
      context.font = `600 ${15 * scale}px "Barlow Semi Condensed", Barlow, system-ui, sans-serif`;
      context.fillStyle = island.ghost ? "rgba(214, 222, 234, 0.6)" : "rgba(236, 239, 244, 0.94)";
      context.fillText(island.title, x, note ? point.y - 8 * scale : point.y);
      if (note) {
        context.font = `400 ${12 * scale}px Barlow, system-ui, sans-serif`;
        context.fillStyle = "rgba(190, 200, 214, 0.75)";
        context.fillText(note, x, point.y + 10 * scale);
      }
    }
    context.textAlign = "center";
    if (camera.zoom >= 0.45) {
      context.font = `500 ${11 * scale}px Barlow, system-ui, sans-serif`;
      context.textBaseline = "middle";
      for (const island of scene.islands) {
        if (island.bands.length < 2) continue;
        for (const band of island.bands) {
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
