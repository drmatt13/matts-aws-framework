import { carriesOwnTile, ICONS, iconUrl, type IconKey } from "../icons";
import { backgroundGrid } from "./grid";
import { DEPLOYMENT_BADGES, type DeploymentBadgeKind } from "../deployment";
import type { Prop, Scene, SceneEdge, SceneNode } from "./build";
import { worldToScreen, type Bounds, type Camera, type Point, type Viewport } from "./camera";
import { project } from "./iso";
import { searchOpacity, type LandscapeFocus } from "./focus";
import { bandTrim, DECK, GRAPHITE, hexRgb, ICON_TINT, ROLE_BADGE, ROLE_BADGE_PLATE, trimColor } from "./look";
import { connectionHoverEase, EDGE_HOVER_DURATION, offLens, restingAlpha } from "./connections";
import { placeIslandTitle, surfaceOutline, type CardHit } from "./picking";
import { NODE_CAPTION, NODE_DEPLOYMENT_TAG, SUBNET_LABEL, nodeCaptionPresentation, subnetLabelPresentation, subnetLabelRect, rectanglesOverlap, visibleNodeCaptions, type LabelRect } from "./labels";
import { ICON_BADGE, type Face } from "./shapes";
import { connectionMidpoint } from "./routing";
import { missingConnectionInput } from "../connections";
import { islandDrawOrder, islandSlabs, type BandSlab, type IslandSlab, type WallRun } from "./slabs";

/** Production displays the declared network design, including unused gateways/endpoints. */
const propIsGhost = (prop: Prop, mode: Scene["mode"]): boolean => !!prop.tagFiltered || (mode === "dev" && prop.presence === "other");

/**
 * Draws a {@link Scene} onto a 2D canvas.
 *
 * Passes, back to front: atmosphere, slab shadows, VPC foundation, lit slabs
 * with their icon plaques, relationship arcs, label cards and island names.
 * Geometry, paths and gradients are cached per scene. Per frame, only the camera,
 * focus, hover and time change; nothing here changes application configuration.
 */

export interface RenderState {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly dpr: number;
  readonly selected?: string;
  readonly hovered?: string;
  readonly hoveredEdge?: string;
  readonly hoveredIsland?: string;
  readonly time: number;
  readonly motion: boolean;
  readonly focus: LandscapeFocus;
}

export interface FrameResult {
  /** Label cards as drawn, in painter's order, for picking. */
  readonly cards: readonly CardHit[];
  /** Separate deployment tags are also selectable as their owning node. */
  readonly badges: readonly CardHit[];
  /** Whether anything on screen moves, so the caller keeps drawing. */
  readonly animating: boolean;
  readonly ms: number;
}

const BADGE_WIDTH: Readonly<Record<DeploymentBadgeKind, number>> = { dev: 43, prod: 48, off: 43 };
const smoothstep = (progress: number): number => progress * progress * (3 - 2 * progress);

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/** A required connection with no value: red wherever it runs. */
const MISSING_EDGE: Rgb = hex("#ff5f6d");

function rgba(color: Rgb, alpha = 1, factor = 1): string {
  const channel = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
  return `rgba(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])}, ${alpha})`;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const WHITE: Rgb = [255, 255, 255];
const ICON_RGB = Object.fromEntries(Object.entries(ICON_TINT).map(([key, color]) => [key, hex(color)])) as Record<IconKey, Rgb>;
const STAND_FILLS = ["#2c343f", "#1c222a", "#3a4452"];

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

function trace(context: CanvasRenderingContext2D, points: readonly number[], close = true): void {
  context.beginPath();
  context.moveTo(points[0]!, points[1]!);
  for (let index = 2; index < points.length; index += 2) context.lineTo(points[index]!, points[index + 1]!);
  if (close) context.closePath();
}

type Standing =
  | { readonly kind: "node"; readonly node: SceneNode }
  | { readonly kind: "prop"; readonly prop: Prop };

interface PreparedArc {
  readonly points: readonly Point[];
  readonly path: Path2D;
  readonly length: number;
  readonly midpoint: Point;
  readonly missing: boolean;
  readonly bounds: Bounds;
  readonly color: Rgb;
  readonly offLens: boolean;
}

interface Prepared {
  readonly scene: Scene;
  readonly arcs: ReadonlyMap<SceneEdge, PreparedArc>;
  readonly nodes: ReadonlyMap<string, SceneNode>;
  readonly islands: ReadonlyMap<string, Scene["islands"][number]>;
  /** Each draw item's world bounding box, for culling. */
  readonly boxes: ReadonlyMap<Standing, { minX: number; minY: number; maxX: number; maxY: number }>;
  /** Whole islands, back to front. */
  readonly graphite: readonly GraphiteIsland[];
  /** Painted geometry, without culling headroom or shadows. */
  readonly titleSurfaces: ReadonlyMap<string, readonly (readonly number[])[]>;
  readonly outlines: ReadonlyMap<string, Path2D>;
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
  /** On a continuous deck: the edges of this subnet's walls that are the deck's own, never the joins to the next subnet. */
  readonly deckEdges: Path2D;
  readonly front?: Path2D;
  readonly shade?: { readonly path: Path2D; readonly fill: CanvasGradient };
  /** Buildings and fixtures standing on this terrace, in painter's order. */
  readonly items: readonly Standing[];
}

interface GraphiteIsland {
  readonly slab: IslandSlab;
  readonly bands: readonly GraphiteBand[];
  readonly shadow: readonly Path2D[];
  /** The island's whole outline at its top: the rim of a continuous deck. */
  readonly rim: Path2D;
}

const OUTSIDE = (box: Bounds | undefined, view: Bounds) =>
  box !== undefined && (box.maxX < view.minX || box.minX > view.maxX || box.maxY < view.minY || box.minY > view.maxY);

const CARD_HEIGHT = 22;

interface PlacedCard extends CardHit {
  readonly node: SceneNode;
  readonly order: number;
  readonly priority: number;
  readonly scale: number;
  readonly font: string;
  readonly text: string;
  readonly textWidth: number;
}

interface PlacedTag extends CardHit {
  readonly node: SceneNode;
  readonly scale: number;
  readonly kind: DeploymentBadgeKind;
  readonly order: number;
  readonly priority: number;
}

/** Compare the camera projection separately from animation state. Store scalar copies: callers may mutate cameras. */
function sameView(a: RenderState, b: RenderState): boolean {
  return a.camera.x === b.camera.x && a.camera.y === b.camera.y && a.camera.zoom === b.camera.zoom &&
    a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height && a.dpr === b.dpr;
}
const copyView = (state: RenderState): RenderState => ({ ...state, camera: { ...state.camera }, viewport: { ...state.viewport } });

interface TitleLabel {
  readonly island: string;
  readonly text: string;
  readonly font: string;
  readonly color: string;
  readonly align: CanvasTextAlign;
  readonly x: number;
  readonly y: number;
  readonly plate?: LabelRect & { readonly accent: string };
}

export class SceneRenderer {
  private readonly context: CanvasRenderingContext2D;
  private prepared: Prepared | undefined;
  private readonly widths = new Map<string, number>();
  private cardLayout: { state: RenderState; placed: readonly PlacedCard[]; hits: readonly CardHit[]; tags: readonly PlacedTag[]; sections: readonly TitleLabel[] } | undefined;
  private titleLayout: { state: RenderState; cards: readonly CardHit[]; labels: readonly TitleLabel[] } | undefined;
  private subnetLayout: { state: RenderState; labels: readonly TitleLabel[] } | undefined;
  private groundGrid: { state: RenderState; paths: readonly Path2D[] } | undefined;
  private readonly icons = new Map<string, HTMLImageElement>();
  private readonly badgePaths = new Map<DeploymentBadgeKind, readonly Path2D[]>();
  private readonly standPaths = new WeakMap<readonly Face[], { faces: readonly Path2D[]; lip?: Path2D }>();
  private readonly circle = new Path2D();
  private readonly plaqueFace = new Path2D();
  private readonly plaqueDepth = new Path2D();
  private disposed = false;
  private animating = false;
  private readonly captionHovers = new Map<string, { from: number; to: number; started: number }>();
  private readonly edgeHovers = new Map<string, { from: number; to: number; started: number }>();
  private snapEdgeHover = true;
  /** One screen pixel, in world units, for this frame. */
  private pixel = 1;
  private dpr = 1;
  /** Search fades every paint layer, including plinths, shadows and badges. */
  private opacity = 1;
  /** Graphite's shared unit gradients, drawn under a transform so one serves every building. */
  private readonly tints = new Map<string, CanvasGradient>();
  private contact: CanvasGradient | undefined;
  private plaque: { readonly face: CanvasGradient; readonly glass: CanvasGradient } | undefined;
  private atmosphere: { readonly width: number; readonly height: number; readonly base: CanvasGradient; readonly vignette: CanvasGradient; readonly blooms: readonly CanvasGradient[] } | undefined;
  /** How many slabs and standing items the last frame drew, after culling. */
  drawnItems = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly invalidate: () => void = () => {}) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser offers no 2D canvas.");
    this.context = context;
    this.circle.arc(0, 0, 1, 0, Math.PI * 2);
    this.plaqueFace.roundRect(-24, -54, 46, 46, 5);
    this.plaqueDepth.roundRect(-22, -52, 46, 46, 5);
    for (const kind of Object.keys(DEPLOYMENT_BADGES) as DeploymentBadgeKind[]) {
      this.badgePaths.set(kind, DEPLOYMENT_BADGES[kind].paths.map((d) => new Path2D(d)));
    }
    for (const key of Object.keys(ICONS) as IconKey[]) {
      this.loadIcon(key, iconUrl(key));
    }
  }

  private loadIcon(key: string, url: string): void {
    if (this.icons.has(key)) return;
    const icon = new Image();
    icon.onload = () => { if (!this.disposed) this.invalidate(); };
    icon.src = url;
    this.icons.set(key, icon);
  }

  dispose(): void {
    this.disposed = true;
    this.captionHovers.clear();
    this.edgeHovers.clear();
    for (const icon of this.icons.values()) icon.onload = null;
  }

  /** Forget measured text, after web fonts arrive. */
  fontsChanged(): void {
    this.widths.clear();
    this.cardLayout = undefined;
    this.titleLayout = undefined;
    this.subnetLayout = undefined;
  }

  setScene(scene: Scene): void {
    if (this.prepared?.scene === scene) return;
    for (const prop of scene.props) if (prop.serviceIcon) this.loadIcon(prop.serviceIcon, prop.serviceIcon);
    this.captionHovers.clear();
    this.edgeHovers.clear();
    this.snapEdgeHover = true;
    this.cardLayout = undefined;
    this.titleLayout = undefined;
    this.subnetLayout = undefined;
    const items: Standing[] = [
      ...scene.nodes.map((node): Standing => ({ kind: "node", node })),
      ...scene.props.map((prop): Standing => ({ kind: "prop", prop })),
    ];

    const arcs = new Map<SceneEdge, PreparedArc>();
    const nodeOf = new Map(scene.nodes.map((node) => [node.id, node]));
    for (const edge of scene.edges) {
      const { points, length } = scene.routes[edge.id]!;
      const path = new Path2D();
      path.moveTo(points[0]!.x, points[0]!.y);
      for (let at = 1; at < points.length; at++) path.lineTo(points[at]!.x, points[at]!.y);
      const bounds = { minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)) };
      arcs.set(edge, { points, path, length, bounds, midpoint: connectionMidpoint(points), missing: missingConnectionInput(edge), color: hex(edge.style.color), offLens: offLens(edge, nodeOf.get(edge.from), nodeOf.get(edge.to)) });
    }
    const boxes = new Map<Standing, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const item of items) {
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
    const graphite = this.prepareGraphite(scene, items);
    const graphiteSurfaces = new Map(graphite.map(({ slab }) => [slab.island.id, slab.bands.flatMap((band) => [band.top, ...band.walls.map((wall) => wall.quad)])]));
    for (const frame of scene.frames) {
      for (const member of frame.members) {
        const surfaces = [frame.geometry.top, frame.geometry.left, frame.geometry.right];
        graphiteSurfaces.get(member)!.push(...surfaces);
      }
    }
    const outlines = (surfaces: ReadonlyMap<string, readonly (readonly number[])[]>) => new Map([...surfaces].map(([id, polygons]) => {
      const outline = new Path2D();
      const segments = surfaceOutline(polygons);
      for (let at = 0; at < segments.length; at += 4) {
        outline.moveTo(segments[at]!, segments[at + 1]!);
        outline.lineTo(segments[at + 2]!, segments[at + 3]!);
      }
      return [id, outline];
    }));
    this.prepared = { scene, arcs, nodes: nodeOf, islands: new Map(scene.islands.map((island) => [island.id, island])), boxes, graphite, titleSurfaces: graphiteSurfaces, outlines: outlines(graphiteSurfaces) };
  }

  /** Island paths, gradients and who stands on each terrace. */
  private prepareGraphite(scene: Scene, items: readonly Standing[]): GraphiteIsland[] {
    const context = this.context;
    const ghosts = new Set([
      ...scene.nodes.filter((node) => node.tagFiltered || node.roleIcon === "unattached" || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent").map((node) => node.id),
      ...scene.props.filter((prop) => propIsGhost(prop, scene.mode)).map((prop) => prop.id),
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
        // A continuous deck is outlined by its foot and its true corners; where one subnet's wall continues into the next there is no line.
        const deckEdges = new Path2D();
        const last = slab.bands.length - 1;
        for (const { run } of walls) {
          const [lx, ly, rx, ry, fx, fy, gx, gy] = run.quad as [number, number, number, number, number, number, number, number];
          deckEdges.moveTo(gx, gy);
          deckEdges.lineTo(fx, fy);
          const joinsNext = slab.deck && run.side === "left" && band.index < last;
          const joinsPrevious = slab.deck && run.side === "left" && band.index > 0;
          if (!joinsNext) { deckEdges.moveTo(rx, ry); deckEdges.lineTo(fx, fy); }
          if (!joinsPrevious) { deckEdges.moveTo(lx, ly); deckEdges.lineTo(gx, gy); }
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
          deckEdges,
          ...(band.front.length >= 4 ? { front: toPath(band.front, false) } : {}),
          ...(shade ? { shade } : {}),
          items: items
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
      return { slab, bands, shadow: slab.shadow.map((layer) => toPath(layer)), rim: toPath(slab.rim) };
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

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = this.atmosphereFor(viewport).base;
    context.fillRect(0, 0, viewport.width, viewport.height);
    this.animating = false;
    if (!prepared) return { cards: [], badges: [], animating: false, ms: performance.now() - started };

    const zoom = camera.zoom;
    this.pixel = 1 / zoom;
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
    // Keep the original vector paint order and precision. Only grid paths are
    // cached; camera changes rebuild them without resampling a previous bitmap.
    if (!this.groundGrid || !sameView(this.groundGrid.state, state)) {
      const paths = [new Path2D(), new Path2D()];
      for (const line of backgroundGrid(camera, viewport)) {
        const path = paths[Number(line.major)]!;
        path.moveTo(line.a.x, line.a.y);
        path.lineTo(line.b.x, line.b.y);
      }
      this.groundGrid = { state: copyView(state), paths };
    }
    context.lineWidth = 0.65 / zoom;
    for (const [at, path] of this.groundGrid.paths.entries()) {
      context.strokeStyle = at ? GRAPHITE.grid.major : GRAPHITE.grid.minor;
      context.stroke(path);
    }
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

    // What the viewport can see, in world units, with room for walls and roofs.
    const view = {
      minX: camera.x - viewport.width / 2 / zoom - 40,
      maxX: camera.x + viewport.width / 2 / zoom + 40,
      minY: camera.y - viewport.height / 2 / zoom - 80,
      maxY: camera.y + viewport.height / 2 / zoom + 40,
    };
    this.drawnItems = this.drawGraphite(prepared, state, view);

    for (const id of new Set([state.hoveredIsland, state.selected?.startsWith("island:") ? state.selected : undefined])) {
      if (!id) continue;
      context.save();
      context.globalAlpha = this.opacity * (searchOpacity(state.focus, "islands", id));
      context.strokeStyle = id === state.selected ? "rgba(167, 215, 255, 0.85)" : "rgba(207, 229, 248, 0.6)";
      context.lineWidth = (id === state.selected ? 2 : 1.5) / zoom;
      const outline = prepared.outlines.get(id);
      if (outline) context.stroke(outline);
      context.restore();
    }

    this.drawEdges(prepared, state);
    const cards = this.drawCards(prepared, state);
    this.drawTitles(prepared, state, cards);

    return { cards, badges: this.cardLayout!.tags, animating: this.animating, ms: performance.now() - started };
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
   * Shadows on the floor far below, then the VPC
   * foundation, then whole islands back to front: each terrace's slab, then
   * whatever stands on it. Returns how many slabs and buildings it drew.
   */
  private drawGraphite(prepared: Prepared, state: RenderState, view: Bounds): number {
    const context = this.context;
    for (const { slab, shadow } of prepared.graphite) {
      if (OUTSIDE(slab.shadowBounds, view)) continue;
      this.opacity = searchOpacity(state.focus, "islands", slab.island.id);
      context.fillStyle = "#000";
      shadow.forEach((layer, index) => {
        context.globalAlpha = this.opacity * (GRAPHITE.shadow.layers[index]!.alpha * (slab.island.ghost === "blueprint" ? DECK.shadow : slab.island.ghost ? 0.3 : 1));
        context.fill(layer);
      });
    }
    this.opacity = 1;
    context.globalAlpha = this.opacity;
    this.drawFramesGraphite(prepared, state);

    let drawn = 0;
    for (const island of prepared.graphite) {
      const { id } = island.slab.island;
      const focus = state.focus.kind !== "selection" || state.focus.islands.has(id) ? 1 : 0.4;
      for (const band of island.bands) {
        if (!OUTSIDE(band.slab.bounds, view)) {
          this.opacity = searchOpacity(state.focus, "islands", id);
          this.drawBand(island, band, focus);
          drawn += 1;
        }
        for (const item of band.items) {
          if (OUTSIDE(prepared.boxes.get(item), view)) continue;
          drawn += 1;
          if (item.kind === "node") {
            this.opacity = searchOpacity(state.focus, "nodes", item.node.id);
            const dimmed = state.focus.kind === "selection" && !state.focus.nodes.has(item.node.id);
            this.drawNodeGraphite(item.node, state, dimmed);
          } else {
            this.opacity = searchOpacity(state.focus, "props", item.prop.id);
            const factor = state.focus.kind === "selection" && !state.focus.props.has(item.prop.id) ? 0.32 : 1;
            const ghost = propIsGhost(item.prop, prepared.scene.mode);
            const matched = state.focus.kind === "search" && state.focus.props.has(item.prop.id);
            const tile = project({ x: item.prop.gx, y: item.prop.gy, h: item.prop.h });
            if (!ghost) this.drawStand(tile, item.prop.geometry.faces, item.prop.icon, factor);
            this.drawPlaqueGraphite(tile, item.prop.icon, (ghost ? 0.32 : 0.9) * factor, matched, ghost, false);
            if (item.prop.roleIcon) this.drawRoleIconGraphite(tile, item.prop.roleIcon, (ghost ? 0.32 : 0.9) * factor, ghost, item.prop.serviceIcon);
          }
        }
      }
    }
    this.opacity = 1;
    context.globalAlpha = this.opacity;
    return drawn;
  }

  /** One terrace: its lit top, etched grid, pads and step shade, its walls and lips, then the glowing trim. */
  private drawBand(island: GraphiteIsland, band: GraphiteBand, focus: number): void {
    const context = this.context;
    context.globalAlpha = this.opacity;
    const pixel = this.pixel;
    const ghost = island.slab.island.ghost;
    const trim = band.trim;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.lineWidth = pixel;
    if (ghost === "blueprint") {
      this.drawDeckBand(island, band);
      return;
    }
    context.globalAlpha = this.opacity * (ghost ? 0.3 : 1);
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
    // Static light along the front edges and a faint line at the wall's foot.
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
      }
    }
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = this.opacity;
    context.lineWidth = pixel;
  }

  /**
   * One subnet of a development network, as a quiet zone on the single raised deck: the deck's dark glass
   * with a whisper of the subnet's colour and nothing drawn between subnets, one dashed rim around the whole
   * deck (drawn with the last subnet), and pads under the solid buildings.
   */
  private drawDeckBand(island: GraphiteIsland, band: GraphiteBand): void {
    const context = this.context;
    const pixel = this.pixel;
    const meta = island.slab.island;
    const violet = hexRgb(trimColor(meta));
    const glass = (alpha: number) => rgba(mixRgb(DECK.glass.color, violet, DECK.glass.tint), alpha);
    context.fillStyle = glass(DECK.glass.top);
    context.fill(band.top);
    context.fillStyle = rgba(band.trim, DECK.zone);
    context.fill(band.top);
    context.save();
    context.clip(band.top);
    context.strokeStyle = `rgba(255, 255, 255, ${DECK.grid})`;
    context.stroke(band.grid);
    context.restore();
    // What stands on the deck is anchored by a pad of its own.
    context.fillStyle = `rgba(255, 255, 255, ${DECK.pad.fill})`;
    context.fill(band.pads);
    context.strokeStyle = rgba(band.trim, DECK.pad.stroke);
    context.stroke(band.pads);
    for (const wall of band.walls) {
      context.fillStyle = glass(DECK.wall[wall.run.side]);
      context.fill(wall.path);
    }
    context.setLineDash([4 * pixel, 4 * pixel]);
    context.strokeStyle = rgba(violet, DECK.wallEdge);
    context.stroke(band.deckEdges);
    if (band.slab.index === meta.bands.length - 1) {
      context.setLineDash([6 * pixel, 4 * pixel]);
      context.strokeStyle = rgba(violet, DECK.rim);
      context.lineWidth = 1.3 * pixel;
      context.stroke(island.rim);
      context.lineWidth = pixel;
    }
    context.setLineDash([]);
  }

  /** The VPC foundation, dark glass edged in its island's trim. */
  private drawFramesGraphite(prepared: Prepared, state: RenderState): void {
    const context = this.context;
    const pixel = this.pixel;
    for (const { ghost, geometry, members } of prepared.scene.frames) {
      this.opacity = searchOpacity(state.focus, "islands", members[0]!);
      const owner = prepared.islands.get(members[0]!);
      const color = owner ? hexRgb(trimColor(owner)) : hex("#9d6bff");
      context.globalAlpha = this.opacity * (ghost ? 0.5 : 1);
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
    this.opacity = 1;
    context.globalAlpha = this.opacity;
  }

  /** A filled unit circle under a transform: one cached gradient serves every building. */
  private blob(x: number, y: number, rx: number, ry: number, fill: CanvasGradient): void {
    const context = this.context;
    context.save();
    context.translate(x, y);
    context.scale(rx, ry);
    context.fillStyle = fill;
    context.fill(this.circle);
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
    context.globalAlpha = this.opacity * 0.9;
    this.blob(tile.x + 3, tile.y + 5, 30, 14, this.contactShadow());
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = this.opacity * light;
    this.blob(tile.x, tile.y + 1, 46, 23, this.spill(ICON_TINT[icon]));
    context.globalCompositeOperation = "source-over";
    let paths = this.standPaths.get(faces);
    if (!paths) {
      const top = faces[2];
      paths = { faces: faces.map((face) => toPath(face.points)), lip: top ? toPath([
        top.points[6]!, top.points[7]!, top.points[4]!, top.points[5]!, top.points[2]!, top.points[3]!,
      ], false) : undefined };
      this.standPaths.set(faces, paths);
    }
    context.globalAlpha = this.opacity;
    for (const [at, path] of paths.faces.entries()) {
      context.fillStyle = STAND_FILLS[at]!;
      context.fill(path);
    }
    if (paths.lip) {
      // The plinth's front edges catch the light.
      context.strokeStyle = "rgba(255, 255, 255, 0.18)";
      context.lineWidth = pixel;
      context.stroke(paths.lip);
    }
    context.globalAlpha = this.opacity;
  }

  /** A service plaque with thickness: a depth edge, a glass face, a hairline in its icon's colour. */
  private drawPlaqueGraphite(tile: Point, key: IconKey, alpha: number, selected: boolean, ghost: boolean, hovered: boolean): void {
    const context = this.context;
    const pixel = this.pixel;
    const fills = this.plaqueFills();
    const tint = ICON_RGB[key];
    context.save();
    context.translate(tile.x, tile.y);
    context.globalAlpha = this.opacity * alpha;
    if (!ghost) {
      context.fillStyle = "#04070b";
      context.fill(this.plaqueDepth);
    }
    context.fillStyle = ghost ? "#111b29" : fills.face;
    context.fill(this.plaqueFace);
    if (!ghost) {
      context.save();
      context.clip(this.plaqueFace);
      context.fillStyle = fills.glass;
      context.fillRect(-24, -54, 46, 24);
      context.restore();
    }
    context.setLineDash(ghost ? [3 * pixel, 3 * pixel] : []);
    context.strokeStyle = selected ? "#f2f6ff" : hovered ? "rgba(255, 255, 255, 0.75)" : ghost ? "#63758d" : rgba(tint, 0.72);
    context.lineWidth = (selected ? 1.5 : 1) * pixel;
    context.stroke(this.plaqueFace);
    context.setLineDash([]);
    if (selected) {
      context.globalCompositeOperation = "lighter";
      context.strokeStyle = rgba(tint, 0.4);
      context.lineWidth = 5 * pixel;
      context.stroke(this.plaqueFace);
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

  private drawRoleIconGraphite(tile: Point, key: IconKey, alpha: number, ghost: boolean, artworkUrl?: string): void {
    const context = this.context;
    const { x, y, size, padding } = ICON_BADGE;
    const badge = ROLE_BADGE[key];
    const artwork = badge?.artwork ?? key;
    context.save();
    context.translate(tile.x, tile.y);
    context.globalAlpha = this.opacity * alpha;
    context.fillStyle = "#04070b";
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, size, size, 4);
    context.fill();
    context.beginPath();
    context.roundRect(x, y, size, size, 4);
    context.fillStyle = badge?.fill ?? ROLE_BADGE_PLATE;
    context.fill();
    const serviceIcon = artworkUrl ? this.icons.get(artworkUrl) : undefined;
    const icon = serviceIcon?.complete && serviceIcon.naturalWidth > 0 ? serviceIcon : this.icons.get(artwork);
    if (icon?.complete && icon.naturalWidth > 0) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (icon === serviceIcon || carriesOwnTile(artwork)) {
        // The service's own tile fills the badge, clipped to its corners, so no plate shows around it as a border.
        context.save();
        context.clip();
        context.drawImage(icon, x, y, size, size);
        context.restore();
      } else {
        context.drawImage(icon, x + padding, y + padding, size - padding * 2, size - padding * 2);
      }
    }
    context.beginPath();
    context.roundRect(x, y, size, size, 4);
    context.setLineDash(ghost ? [3 * this.pixel, 3 * this.pixel] : []);
    context.strokeStyle = ghost ? "#63758d" : rgba(hex(ICON_TINT[badge?.borderIcon ?? key]), 0.75);
    context.lineWidth = this.pixel;
    context.stroke();
    context.setLineDash([]);
    context.restore();
  }

  private drawNodeGraphite(node: SceneNode, state: RenderState, dimmed: boolean): void {
    const context = this.context;
    context.globalAlpha = this.opacity;
    const tile = project({ x: node.gx, y: node.gy, h: node.h });
    const selected = state.selected === node.id || (state.focus.kind === "search" && state.focus.nodes.has(node.id));
    const hovered = state.hovered === node.id;
    const unattached = node.roleIcon === "unattached";
    const ghost = !!node.tagFiltered || unattached || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
    const factor = dimmed ? 0.32 : 1;
    if (!ghost) this.drawStand(tile, node.geometry.faces, node.icon, factor);
    this.drawPlaqueGraphite(tile, node.icon, factor * (ghost ? 0.32 : 1), selected, ghost, hovered);
    // An unattached stack stays identifiable even though its main plaque is a ghost.
    if (node.roleIcon) this.drawRoleIconGraphite(tile, node.roleIcon, unattached ? 1 : factor * (ghost ? 0.32 : 1), ghost && !unattached);
    if (selected || hovered) {
      trace(context, node.geometry.hull);
      context.strokeStyle = selected ? "rgba(255, 248, 230, 0.6)" : "rgba(255, 255, 255, 0.35)";
      context.lineWidth = this.pixel;
      context.stroke();
    }
  }

  private drawEdges(prepared: Prepared, state: RenderState): void {
    const context = this.context;
    const pixel = this.pixel;
    // Include arrowheads, packets, glow and fixed-size error markers at every zoom.
    const { camera, viewport } = state;
    // Shadow blur ignores the transform; allow for browser zoom producing DPR < 1.
    const padding = 40 / Math.min(1, state.dpr);
    const view = { minX: camera.x - (viewport.width / 2 + padding) * pixel, maxX: camera.x + (viewport.width / 2 + padding) * pixel,
      minY: camera.y - (viewport.height / 2 + padding) * pixel, maxY: camera.y + (viewport.height / 2 + padding) * pixel };
    const lit: { edge: SceneEdge; strength: number; resting: number }[] = [];
    const visible = new Set<string>();
    for (const edge of prepared.scene.edges) {
      const arc = prepared.arcs.get(edge)!;
      if (OUTSIDE(arc.bounds, view)) continue;
      visible.add(edge.id);
      // A connection only the other environment holds lights up when it is hovered or selected itself, never
      // because a node it touches is: the viewed environment's selection tells the viewed environment's story.
      const own = edge.otherLens === undefined;
      const active =
        state.focus.kind === "search" ? own && state.focus.nodes.has(edge.from) && state.focus.nodes.has(edge.to) :
        state.selected === edge.id ||
        (own && state.selected !== undefined && (edge.from === state.selected || edge.to === state.selected));
      const hover = this.hoverAmount(this.edgeHovers, edge.id, state.focus.kind !== "search" && state.hoveredEdge === edge.id ? 1 : 0,
        state, EDGE_HOVER_DURATION, this.snapEdgeHover, connectionHoverEase);
      const resting = state.focus.kind === "search" ? 0.025 : arc.missing ? state.selected ? 0.35 : 0.9 : state.selected ? 0.06 : restingAlpha(edge.edge.provenance, arc.offLens);
      if (active || hover > 0) {
        lit.push({ edge, strength: active ? 1 : hover, resting });
        continue;
      }
      const missing = arc.missing;
      const color = missing ? MISSING_EDGE : arc.color;
      context.strokeStyle = rgba(color, resting);
      context.lineWidth = 1.2 * pixel;
      context.setLineDash(edge.style.dashed ? [4 * pixel, 4 * pixel] : []);
      context.stroke(arc.path);
    }
    this.snapEdgeHover = false;
    for (const id of this.edgeHovers.keys()) if (!visible.has(id)) this.edgeHovers.delete(id);
    context.setLineDash([]);
    for (const { edge, strength, resting } of lit) {
      const arc = prepared.arcs.get(edge)!;
      const missing = arc.missing;
      const color = missing ? MISSING_EDGE : arc.color;
      context.shadowColor = rgba(color, 0.8 * strength);
      context.shadowBlur = 10 * strength;
      context.strokeStyle = rgba(color, resting + (0.95 - resting) * strength);
      context.lineWidth = (1.2 + strength) * pixel;
      context.setLineDash(edge.style.dashed ? [5 * pixel, 4 * pixel] : []);
      context.stroke(arc.path);
      context.setLineDash([]);
      context.globalAlpha = strength;
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
      if (state.motion && state.focus.kind !== "search" && !missing) {
        this.animating = true;
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
      context.globalAlpha = 1;
    }
    // Fixed screen-size markers remain readable and clickable at overview zoom.
    context.setLineDash([]);
    for (const [edge, arc] of prepared.arcs) if (arc.missing && !OUTSIDE(arc.bounds, view)) {
      const at = arc.midpoint;
      const radius = 8 * pixel, inset = 3 * pixel;
      const matches = state.focus.kind !== "search" || state.focus.nodes.has(edge.from) && state.focus.nodes.has(edge.to);
      context.globalAlpha = matches ? 1 : 0.08;
      context.fillStyle = "#191c25";
      context.strokeStyle = "#ff5f6d";
      context.lineWidth = 1.8 * pixel;
      context.beginPath(); context.arc(at.x, at.y, radius, 0, Math.PI * 2); context.fill(); context.stroke();
      context.beginPath(); context.moveTo(at.x - inset, at.y - inset); context.lineTo(at.x + inset, at.y + inset); context.moveTo(at.x - inset, at.y + inset); context.lineTo(at.x + inset, at.y - inset); context.stroke();
    }
    context.globalAlpha = 1;
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

  private placeCards(prepared: Prepared, state: RenderState): NonNullable<SceneRenderer["cardLayout"]> {
    const sections = this.placeSubnetTitles(prepared, state);
    const cached = this.cardLayout;
    if (cached && cached.sections === sections && sameView(cached.state, state) && cached.state.selected === state.selected &&
      cached.state.hovered === state.hovered && cached.state.focus === state.focus) return cached;
    const { camera, viewport } = state;
    const { scale, gap } = nodeCaptionPresentation(camera.zoom);
    const tagScale = scale;
    const font = `500 ${12 * scale}px Barlow, system-ui, sans-serif`;
    const buildings = new Map([...prepared.scene.nodes, ...prepared.scene.props].map((item) => {
      const hull = item.geometry.hull;
      const points = Array.from({ length: hull.length / 2 }, (_, at) => worldToScreen(camera, viewport, { x: hull[at * 2]!, y: hull[at * 2 + 1]! }));
      const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y));
      return [item.id, { x, y, width: Math.max(...points.map((point) => point.x)) - x, height: Math.max(...points.map((point) => point.y)) - y }] as const;
    }));
    const candidates: PlacedCard[] = [];
    const tagCandidates: PlacedTag[] = [];
    prepared.scene.nodes.forEach((node, order) => {
      if (state.focus.kind === "search" && !state.focus.nodes.has(node.id)) return;
      const building = buildings.get(node.id)!;
      if (building.x + building.width < 0 || building.x > viewport.width || building.y + building.height < 0 || building.y > viewport.height) return;
      const height = CARD_HEIGHT * scale;
      const chrome = 14 * scale + (node.auth ? 14 * scale : 0);
      const budget = Math.min(260 * scale, NODE_CAPTION.width * camera.zoom) - chrome;
      if (budget < 24 * scale) return;
      const text = this.fit(node.label, font, budget);
      const textWidth = this.measure(text, font);
      const width = textWidth + chrome;
      const tile = project({ x: node.gx, y: node.gy, h: node.h });
      const anchor = worldToScreen(camera, viewport, { x: tile.x, y: tile.y + NODE_CAPTION.offset });
      candidates.push({ id: node.id, node, order, priority: 0, scale, font, text, textWidth, width, height, x: anchor.x - width / 2, y: anchor.y - height });
      if (node.badge) {
        const at = worldToScreen(camera, viewport, { x: tile.x, y: tile.y + NODE_DEPLOYMENT_TAG.offset });
        const tagWidth = BADGE_WIDTH[node.badge] * tagScale, tagHeight = NODE_DEPLOYMENT_TAG.height * tagScale;
        tagCandidates.push({ id: node.id, node, order, priority: 0, scale: tagScale, kind: node.badge, width: tagWidth, height: tagHeight, x: at.x - tagWidth / 2, y: at.y - tagHeight / 2 });
      }
    });

    const controls = [
      { x: 8, y: 8, width: Math.min(360, viewport.width * 0.5), height: 42 },
      { x: viewport.width - 184, y: 8, width: 176, height: 42 },
      { x: viewport.width - 64, y: viewport.height - 64, width: 64, height: 64 },
    ];
    const sectionLabels = sections.flatMap(label => label.plate ? [label.plate] : []);
    const reserved = [
      ...controls, ...sectionLabels,
      ...[...prepared.arcs.values()].filter((arc) => arc.missing).map((arc) => {
        const at = worldToScreen(camera, viewport, arc.midpoint);
        return { x: at.x - 10, y: at.y - 10, width: 20, height: 20 };
      }),
    ];
    const placed = visibleNodeCaptions(candidates, [...buildings.values(), ...reserved], viewport, gap);
    // Tags intentionally sit on their own plinth; every other node and caption
    // remains an obstacle. This fixed slot never borrows width from the name.
    const tags = visibleNodeCaptions(tagCandidates.filter((tag) => [...buildings].every(([id, rect]) => id === tag.id || !rectanglesOverlap(tag, rect))), [...controls, ...sectionLabels, ...placed], viewport);
    this.cardLayout = { state: copyView(state), sections, placed, tags, hits: placed.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })) };
    return this.cardLayout;
  }

  private hoverAmount(animations: Map<string, { from: number; to: number; started: number }>, id: string,
    target: number, state: RenderState, duration: number, snap = false, ease = smoothstep): number {
    if (!state.motion || snap) {
      if (target) animations.set(id, { from: target, to: target, started: state.time });
      else animations.delete(id);
      return target;
    }
    let animation = animations.get(id);
    const sample = () => {
      if (!animation) return 0;
      const progress = Math.max(0, Math.min(1, (state.time - animation.started) / duration));
      return animation.from + (animation.to - animation.from) * ease(progress);
    };
    const current = sample();
    if ((animation?.to ?? 0) !== target) {
      if (current === target) {
        animations.delete(id);
        return target;
      }
      animation = { from: current, to: target, started: state.time };
      animations.set(id, animation);
    }
    if (animation && animation.from !== animation.to && state.time - animation.started < duration) this.animating = true;
    else if (target === 0) animations.delete(id);
    return sample();
  }

  private captionAlpha(node: SceneNode, state: RenderState, detail: number, hover: number): number {
    if (node.id === state.selected || (state.focus.kind === "search" && state.focus.nodes.has(node.id))) return 1;
    const quiet = state.focus.kind === "selection" && !state.focus.nodes.has(node.id);
    const ghost = !!node.tagFiltered || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent";
    const prominence = node.roleIcon === "unattached" ? 1 : quiet ? 0.35 : ghost ? 0.7 : 1;
    const resting = NODE_CAPTION.minOpacity + (prominence - NODE_CAPTION.minOpacity) * detail;
    return resting + (1 - resting) * hover;
  }

  private drawCards(prepared: Prepared, state: RenderState): readonly CardHit[] {
    const context = this.context;
    const { dpr } = state;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const layout = this.placeCards(prepared, state);
    const visible = new Set([...layout.placed, ...layout.tags].map(({ id }) => id));
    for (const id of this.captionHovers.keys()) if (!visible.has(id)) this.captionHovers.delete(id);
    const hovers = new Map([...visible].map((id) => [id,
      this.hoverAmount(this.captionHovers, id, state.hovered === id ? 1 : 0, state, NODE_CAPTION.hoverDuration)]));
    const { detail } = nodeCaptionPresentation(state.camera.zoom);
    const plate = 0.25 + 0.75 * detail;
    for (const tag of layout.tags) {
      const hover = hovers.get(tag.id)!;
      const selected = tag.id === state.selected || (state.focus.kind === "search" && state.focus.nodes.has(tag.id));
      context.globalAlpha = this.captionAlpha(tag.node, state, detail, hover);
      this.drawDeploymentBadge(tag.kind, tag.x, tag.y + tag.height / 2, tag.scale, selected ? 1 : plate + (1 - plate) * hover);
    }
    context.textAlign = "left";
    for (const { node, scale, font, text, textWidth, x, y, width, height } of layout.placed) {
      const padding = 7 * scale;
      const selected = node.id === state.selected || (state.focus.kind === "search" && state.focus.nodes.has(node.id));
      const unattached = node.roleIcon === "unattached";
      const ghost = !unattached && (node.tagFiltered || node.presence === "other" || node.presence === "nowhere" || node.presence === "absent");
      const hover = hovers.get(node.id)!;
      const alpha = this.captionAlpha(node, state, detail, hover);
      // Let the plate dissolve faster than its name so distant islands keep a quiet texture.
      context.globalAlpha = alpha * (selected ? 1 : plate + (1 - plate) * hover);
      context.fillStyle = selected ? "#f3efe4" : "#0e131b";
      context.strokeStyle = selected ? "#fff8e6" : `rgba(255, 255, 255, ${0.14 + 0.41 * hover})`;
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(x, y, width, height, 5 * scale);
      context.fill();
      context.stroke();
      context.globalAlpha = alpha;
      context.font = font;
      context.textBaseline = "middle";
      context.fillStyle = selected ? "#141922" : ghost ? "#9aa3ae" : "#e7eaef";
      context.fillText(text, x + padding, y + height / 2 + 0.5);
      if (node.auth) {
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
      context.globalAlpha = this.opacity;
    }
    return layout.hits;
  }

  private drawDeploymentBadge(kind: DeploymentBadgeKind, x: number, y: number, scale: number, plateAlpha: number): void {
    const context = this.context;
    const badge = DEPLOYMENT_BADGES[kind];
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    const alpha = context.globalAlpha;
    context.globalAlpha *= plateAlpha;
    context.fillStyle = badge.background;
    context.strokeStyle = badge.color;
    context.lineWidth = 0.6;
    context.beginPath();
    context.roundRect(0, -7.5, BADGE_WIDTH[kind], 15, 3);
    context.fill();
    context.stroke();
    context.globalAlpha = alpha;
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

  /** A stable, horizontal heading rail stays visibly connected to each VPC terrace top. */
  private placeSubnetTitles(prepared: Prepared, state: RenderState): readonly TitleLabel[] {
    const cached = this.subnetLayout;
    if (cached && sameView(cached.state, state)) return cached.labels;
    const labels: TitleLabel[] = [];
    const { scene } = prepared;
    const { camera, viewport } = state;
    if (scene.mode === "prod") {
      const { scale } = subnetLabelPresentation(camera.zoom);
      const baseFont = `600 ${SUBNET_LABEL.fontSize}px Barlow, system-ui, sans-serif`;
      const font = `600 ${SUBNET_LABEL.fontSize * scale}px Barlow, system-ui, sans-serif`;
      const rimEnds = new Map(prepared.graphite.map(({ slab }) => [slab.island.id,
        Math.max(...slab.bands.flatMap(band => band.top.filter((_, at) => at % 2 === 0))),
      ]));
      for (const island of scene.islands) {
        if (island.region !== "network") continue;
        let previous: LabelRect | undefined;
        for (const [index, band] of island.bands.entries()) {
          // One consistent rail outside the top-right edge of the VPC's terrace tops;
          // resource collisions and viewport boundaries never displace an individual name.
          const gx = (band.gx0 + band.gx1) / 2;
          const anchor = worldToScreen(camera, viewport, project({ x: gx, y: island.gy0, h: band.h }));
          const width = (this.measure(band.title, baseFont) + SUBNET_LABEL.padding * 2 + SUBNET_LABEL.cue) * scale;
          const height = SUBNET_LABEL.height * scale;
          const rimEndX = worldToScreen(camera, viewport, { x: rimEnds.get(island.id)!, y: 0 }).x;
          const rect = subnetLabelRect(anchor, width, height, scale, rimEndX, previous);
          previous = rect;
          labels.push({ island: island.id, text: band.title, font, color: "#f1f5f9", align: "left",
            x: rect.x + (SUBNET_LABEL.padding + SUBNET_LABEL.cue) * scale, y: rect.y + rect.height / 2,
            plate: { ...rect, accent: rgba(bandTrim(island, index)) } });
        }
      }
    }
    this.subnetLayout = { state: copyView(state), labels };
    return labels;
  }

  private placeTitles(prepared: Prepared, state: RenderState, cards: readonly CardHit[]): readonly TitleLabel[] {
    const cached = this.titleLayout;
    if (cached && sameView(cached.state, state) && cached.cards === cards) return cached.labels;
    const labels: TitleLabel[] = [];
    const context = this.context;
    const { camera, viewport } = state;
    const { scene } = prepared;
    const screenPolygon = (polygon: readonly number[]) => {
      const points: number[] = [];
      for (let at = 0; at < polygon.length; at += 2) {
        const point = worldToScreen(camera, viewport, { x: polygon[at]!, y: polygon[at + 1]! });
        points.push(point.x, point.y);
      }
      return points;
    };
    const rectangle = ({ x, y, width, height }: Omit<CardHit, "id">) => [x, y, x + width, y, x + width, y + height, x, y + height];
    const surfaces = new Map([...prepared.titleSurfaces].map(([id, polygons]) => [id, polygons.map(screenPolygon)]));
    const obstacles = [
      ...[...surfaces.values()].flat(),
      ...[...scene.nodes, ...scene.props].map((item) => screenPolygon(item.geometry.hull)),
      ...cards.map(rectangle),
      ...this.placeSubnetTitles(prepared, state).flatMap(label => label.plate ? [rectangle(label.plate)] : []),
    ];
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    context.textAlign = "right";
    context.textBaseline = "middle";
    const titleFont = `600 ${15 * scale}px "Barlow Semi Condensed", Barlow, system-ui, sans-serif`;
    context.font = titleFont;
    for (const island of scene.islands) {
      const ink = context.measureText(island.title);
      const placed = placeIslandTitle(surfaces.get(island.id)!, {
        width: ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight,
        height: ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent,
      }, obstacles);
      if (!placed) continue;
      obstacles.push(rectangle(placed));
      const network = rgba(mixRgb(hexRgb(trimColor(island)), WHITE, 0.55));
      const color = island.ghost ? "rgba(214, 222, 234, 0.6)" : island.region === "network" ? network : "rgba(236, 239, 244, 0.94)";
      labels.push({ island: island.id, text: island.title, font: titleFont, color, align: "right", x: placed.x + placed.width - ink.actualBoundingBoxRight, y: placed.y + ink.actualBoundingBoxAscent });
    }
    labels.push(...this.placeSubnetTitles(prepared, state));
    this.titleLayout = { state: copyView(state), cards, labels };
    return labels;
  }

  private drawTitles(prepared: Prepared, state: RenderState, cards: readonly CardHit[]): void {
    const context = this.context;
    const labels = this.placeTitles(prepared, state, cards);
    context.textBaseline = "middle";
    const { alpha, plateAlpha, scale } = subnetLabelPresentation(state.camera.zoom);
    for (const label of labels) {
      const presence = this.opacity * searchOpacity(state.focus, "islands", label.island);
      context.globalAlpha = presence;
      if (label.plate) {
        // Match node captions: the card dissolves faster than its readable name.
        context.globalAlpha = presence * plateAlpha;
        const { x, y, width, height, accent } = label.plate;
        context.fillStyle = "rgba(13, 19, 28, 0.96)";
        context.strokeStyle = "rgba(174, 192, 214, 0.3)";
        context.lineWidth = scale;
        context.beginPath();
        context.roundRect(x, y, width, height, SUBNET_LABEL.radius * scale);
        context.fill(); context.stroke();
        context.fillStyle = accent;
        context.beginPath();
        context.roundRect(x + SUBNET_LABEL.padding * scale, y + 8 * scale, 3 * scale, height - 16 * scale, 1.5 * scale);
        context.fill();
      }
      context.globalAlpha = presence * (label.plate ? alpha : 1);
      context.font = label.font;
      context.textAlign = label.align;
      context.fillStyle = label.color;
      context.fillText(label.text, label.x, label.y);
    }
    context.textAlign = "start";
    context.globalAlpha = this.opacity;
  }
}
