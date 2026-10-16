import { Crosshair, Maximize2, Minus, Pause, Play, Plus, RefreshCw } from "lucide-react";
import { api } from "../api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABEL, RELATION_LABEL, titleOf, type EdgeCategory } from "../lookup";
import { buildScene, type Scene, type SceneNode, type Tile } from "../scene/build";
import {
  DRAG_THRESHOLD,
  fitBounds,
  interpolate,
  isVisible,
  pan,
  screenToWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
  type Camera,
  type Point,
  type Viewport,
} from "../scene/camera";
import { arcControl, arcPoints, distanceToPolyline, insidePolygon, pickEntity, pickTile, type CardHit } from "../scene/picking";
import { CATEGORY_COLORS, SceneRenderer } from "../scene/render";
import { catalogAvailability, deploymentSummary } from "../deployment";
import { DeploymentLegend } from "./DeploymentBadge";
import { useStudio } from "../studio";

/**
 * The landscape view: the same application, as a lit miniature you can fly over.
 *
 * Everything here is presentation. The scene comes from the model the other
 * views read; selecting a building selects that entity everywhere, and the
 * inspector beside the canvas is the same one, with the same edits. Moving the
 * camera changes nothing on disk.
 */

const CATEGORIES = Object.keys(CATEGORY_LABEL) as EdgeCategory[];

/** Where the camera was, so leaving the view and coming back keeps your place. */
let rememberedCamera: Camera | undefined;

interface Hover {
  readonly kind: "node" | "edge" | "tile" | "prop";
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface Tween {
  readonly from: Camera;
  readonly to: Camera;
  readonly start: number;
  readonly duration: number;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function laneText(node: SceneNode): string | undefined {
  if (!node.lanes) return undefined;
  return deploymentSummary(node.lanes);
}

export function Isometric() {
  const { model, index, snapshot, selected, select, toast, live: studioLive } = useStudio();
  const [scanning, setScanning] = useState(false);
  const refreshCdkLinks = async () => {
    setScanning(true);
    try {
      const result = await api.refreshCdkLinks();
      toast(`Found ${result.edges} CDK resource links in ${result.files} stack files.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "refuse");
    } finally { setScanning(false); }
  };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);
  const [categories, setCategories] = useState<ReadonlySet<EdgeCategory>>(() => new Set(CATEGORIES));
  const [motion, setMotion] = useState(() => !reducedMotion());
  const [hover, setHover] = useState<Hover | undefined>();
  const [stats, setStats] = useState({ ms: 0 });

  const conditions = useMemo(
    () => Object.fromEntries(Object.entries(snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])),
    [snapshot.source.catalog],
  );
  const resourceAvailability = useMemo(() => catalogAvailability(snapshot.models), [snapshot.models]);
  const scene = useMemo(() => buildScene(model, { webSocketApi: snapshot.webSocketApi, conditions, resourceAvailability }), [model, snapshot.webSocketApi, conditions, resourceAvailability]);
  const nodes = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene]);
  const arcs = useMemo(
    () =>
      scene.edges.map((edge) => {
        const a = nodes.get(edge.edge.from)!.geometry.top;
        const b = nodes.get(edge.edge.to)!.geometry.top;
        return { edge, points: arcPoints(a, arcControl(a, b), b, 16) };
      }),
    [scene, nodes],
  );

  // Everything the frame loop reads, without re-subscribing it on every render.
  const live = useRef({
    scene,
    camera: rememberedCamera ?? { x: 0, y: 0, zoom: 1 },
    viewport: { width: 1, height: 1 } as Viewport,
    selected,
    hovered: undefined as string | undefined,
    hoveredEdge: undefined as string | undefined,
    categories,
    motion,
    tween: undefined as Tween | undefined,
    cards: [] as readonly CardHit[],
    frame: undefined as number | undefined,
    fitted: rememberedCamera !== undefined,
    samples: [] as number[],
    published: 0,
    frames: 0,
  });
  live.current.scene = scene;
  live.current.selected = selected;
  live.current.categories = categories;
  live.current.motion = motion;

  const draw = useCallback(() => {
    const state = live.current;
    state.frame = undefined;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const now = performance.now();
    if (state.tween) {
      const t = state.tween.duration <= 0 ? 1 : Math.min(1, (now - state.tween.start) / state.tween.duration);
      state.camera = interpolate(state.tween.from, state.tween.to, t);
      if (t >= 1) state.tween = undefined;
    }
    rememberedCamera = state.camera;
    renderer.setScene(state.scene);
    const result = renderer.render({
      camera: state.camera,
      viewport: state.viewport,
      dpr: window.devicePixelRatio || 1,
      ...(state.selected ? { selected: state.selected } : {}),
      ...(state.hovered ? { hovered: state.hovered } : {}),
      ...(state.hoveredEdge ? { hoveredEdge: state.hoveredEdge } : {}),
      categories: state.categories,
      time: now / 1000,
      motion: state.motion,
    });
    state.cards = result.cards;
    state.frames += 1;
    // The readout: a moving average over recent frames, published twice a
    // second at most while animating, and at once when the picture settles.
    state.samples = [...state.samples.slice(-59), result.ms];
    const settles = !result.animating && !state.tween;
    if (settles || now - state.published > 500) {
      state.published = now;
      setStats({ ms: state.samples.reduce((sum, value) => sum + value, 0) / state.samples.length });
    }
    if (result.animating || state.tween) state.frame = requestAnimationFrame(draw);
  }, []);

  const schedule = useCallback(() => {
    if (live.current.frame === undefined) live.current.frame = requestAnimationFrame(draw);
  }, [draw]);

  const moveCamera = useCallback(
    (to: Camera, animate = true) => {
      const state = live.current;
      if (animate && !reducedMotion()) state.tween = { from: state.camera, to, start: performance.now(), duration: 450 };
      else {
        state.tween = undefined;
        state.camera = to;
      }
      schedule();
    },
    [schedule],
  );

  const fit = useCallback(
    (animate = true) => moveCamera(fitBounds(live.current.scene.bounds, live.current.viewport, 40), animate),
    [moveCamera],
  );

  const focus = useCallback(
    (id: string | undefined, zoom?: number) => {
      const node = id ? live.current.scene.nodes.find((candidate) => candidate.id === id) : undefined;
      if (!node) return;
      const camera = live.current.camera;
      moveCamera({ x: node.geometry.top.x, y: node.geometry.top.y, zoom: zoom ?? Math.max(camera.zoom, 0.9) });
    },
    [moveCamera],
  );

  // Mount: the renderer, the canvas's size, and web fonts arriving late.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const container = containerRef.current!;
    rendererRef.current = new SceneRenderer(canvas, schedule);
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const previous = live.current.viewport;
      const next = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
      live.current.viewport = next;
      if (!live.current.fitted) {
        live.current.fitted = true;
        live.current.camera = fitBounds(live.current.scene.bounds, next, 40);
      } else if (previous.width > 1) {
        // The inspector opening or the window resizing keeps the top-left of
        // the world where it was, so nothing you were looking at jumps.
        const camera = live.current.camera;
        live.current.camera = {
          ...camera,
          x: camera.x + (next.width - previous.width) / (2 * camera.zoom),
          y: camera.y + (next.height - previous.height) / (2 * camera.zoom),
        };
        const node = live.current.selected ? live.current.scene.nodes.find((candidate) => candidate.id === live.current.selected) : undefined;
        if (node && !isVisible(live.current.camera, next, node.geometry.top, 60)) {
          live.current.tween = { from: live.current.camera, to: { ...live.current.camera, x: node.geometry.top.x, y: node.geometry.top.y }, start: performance.now(), duration: reducedMotion() ? 0 : 450 };
        }
      }
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      rendererRef.current?.fontsChanged();
      schedule();
    });
    return () => {
      disposed = true;
      observer.disconnect();
      if (live.current.frame !== undefined) cancelAnimationFrame(live.current.frame);
      live.current.frame = undefined;
      rendererRef.current?.dispose();
      rendererRef.current = undefined;
    };
  }, [schedule]);

  useEffect(schedule, [schedule, scene, selected, categories, motion]);

  // A selection made elsewhere — the inspector, a link — brings its building into view.
  useEffect(() => {
    const node = selected ? nodes.get(selected) : undefined;
    if (node && !isVisible(live.current.camera, live.current.viewport, node.geometry.top, 60)) focus(node.id);
  }, [selected, nodes, focus]);

  /** What is under a canvas point, front to back: cards, buildings, furniture, arcs, terrain. */
  const pick = useCallback(
    (screen: Point): Hover | undefined => {
      const state = live.current;
      const world = screenToWorld(state.camera, state.viewport, screen);
      const entity = pickEntity(screen, world, state.cards, scene.nodes.map((node) => ({ id: node.id, hull: node.geometry.hull })));
      if (entity) return { kind: "node", id: entity, ...screen };
      for (let position = scene.props.length - 1; position >= 0; position -= 1) {
        if (insidePolygon(world.x, world.y, scene.props[position]!.geometry.hull)) return { kind: "prop", id: scene.props[position]!.id, ...screen };
      }
      const tolerance = 6 / state.camera.zoom;
      let best: { id: string; distance: number } | undefined;
      for (const arc of arcs) {
        if (!state.categories.has(arc.edge.category)) continue;
        const distance = distanceToPolyline(world, arc.points);
        if (distance < tolerance && (!best || distance < best.distance)) best = { id: arc.edge.edge.id, distance };
      }
      if (best) return { kind: "edge", id: best.id, ...screen };
      const tile = pickTile(world, scene.tiles);
      if (tile) return { kind: "tile", id: `${tile.gx},${tile.gy}`, ...screen };
      return undefined;
    },
    [scene, arcs],
  );

  const setHovered = useCallback(
    (next: Hover | undefined) => {
      const state = live.current;
      const hovered = next?.kind === "node" ? next.id : undefined;
      const hoveredEdge = next?.kind === "edge" ? next.id : undefined;
      if (hovered !== state.hovered || hoveredEdge !== state.hoveredEdge) {
        state.hovered = hovered;
        state.hoveredEdge = hoveredEdge;
        schedule();
      }
      setHover(next);
    },
    [schedule],
  );

  // Pointer input: a press that travels less than the threshold is a click.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; last: Point; dragging: boolean; pinch?: number } | undefined>(undefined);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    canvasRef.current!.setPointerCapture(event.pointerId);
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    live.current.tween = undefined;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { start: point, last: point, dragging: true, pinch: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
    } else {
      gesture.current = { start: point, last: point, dragging: false };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = local(event);
    const current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) {
      setHovered(pick(point));
      return;
    }
    pointers.current.set(event.pointerId, point);
    const state = live.current;
    if (pointers.current.size >= 2 && current.pinch) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const middle = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      state.camera = zoomAt(state.camera, state.viewport, middle, distance / current.pinch);
      current.pinch = distance;
      schedule();
      return;
    }
    if (!current.dragging && Math.hypot(point.x - current.start.x, point.y - current.start.y) >= DRAG_THRESHOLD) {
      current.dragging = true;
      setHovered(undefined);
    }
    if (current.dragging) {
      state.camera = pan(state.camera, point.x - current.last.x, point.y - current.last.y);
      schedule();
    }
    current.last = point;
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) return;
    gesture.current = undefined;
    if (!current || current.dragging) return;
    const hit = pick(local(event));
    if (hit?.kind === "node") select(selected === hit.id ? undefined : hit.id);
    else if (!hit || hit.kind === "tile") select(undefined);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) gesture.current = undefined;
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const point = local(event);
    const hit = pick(point);
    if (hit?.kind === "node") {
      // Its two clicks toggled the selection on and off again; a double-click means this one.
      select(hit.id);
      focus(hit.id, Math.max(1.3, live.current.camera.zoom));
    }
    else moveCamera(zoomAt(live.current.camera, live.current.viewport, point, 1.8));
  };

  // Wheel: zoom about the pointer. Registered by hand, because React's wheel
  // listener is passive and could not stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = live.current;
      state.tween = undefined;
      const point = local(event);
      if (event.ctrlKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
        state.camera = zoomAt(state.camera, state.viewport, point, wheelFactor(event.deltaY, event.deltaMode, state.viewport.height));
      } else {
        state.camera = pan(state.camera, -event.deltaX, 0);
      }
      schedule();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [schedule]);

  const zoomBy = (factor: number) => {
    const state = live.current;
    moveCamera(zoomAt(state.camera, state.viewport, { x: state.viewport.width / 2, y: state.viewport.height / 2 }, factor));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const state = live.current;
    const step = 80;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (move) {
      moveCamera(pan(state.camera, move[0], move[1]));
    } else if (event.key === "+" || event.key === "=") zoomBy(1.25);
    else if (event.key === "-" || event.key === "_") zoomBy(0.8);
    else if (event.key === "0") fit();
    else if (event.key === "f" || event.key === "F") focus(selected);
    else if (event.key === "Escape") select(undefined);
    else return;
    event.preventDefault();
  };

  // Test and console access to where things are drawn. Read-only.
  useEffect(() => {
    const debug = {
      camera: () => live.current.camera,
      viewport: () => live.current.viewport,
      screenOf: (id: string) => {
        const node = nodes.get(id);
        if (!node) return undefined;
        const card = live.current.cards.find((candidate) => candidate.id === id);
        return {
          building: worldToScreen(live.current.camera, live.current.viewport, node.geometry.top),
          card: card ? { x: card.x + card.width / 2, y: card.y + card.height / 2 } : undefined,
        };
      },
      pickAt: (x: number, y: number) => pick({ x, y }),
      cards: () => live.current.cards,
      hullOf: (id: string) => {
        const node = nodes.get(id);
        if (!node) return undefined;
        const points: Point[] = [];
        for (let index = 0; index < node.geometry.hull.length; index += 2) {
          points.push(worldToScreen(live.current.camera, live.current.viewport, { x: node.geometry.hull[index]!, y: node.geometry.hull[index + 1]! }));
        }
        return points;
      },
      stats: () => ({
        tiles: scene.tiles.length,
        nodes: scene.nodes.length,
        edges: scene.edges.length,
        drawn: rendererRef.current?.drawnItems,
        lastFrameMs: live.current.samples.at(-1),
        frames: live.current.frames,
      }),
    };
    (window as unknown as { __studioLandscape?: typeof debug }).__studioLandscape = debug;
    return () => {
      delete (window as unknown as { __studioLandscape?: typeof debug }).__studioLandscape;
    };
  }, [nodes, pick, scene]);

  if (model.targets.length === 0) {
    return <p className="empty">The {model.mode === "dev" ? "development" : "production"} graph did not load. Open configuration health for the reason.</p>;
  }

  return (
    <div className="landscape" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="landscape-canvas"
        tabIndex={0}
        aria-label="Isometric landscape of the application. Use the list of entities below, or arrow keys to pan, plus and minus to zoom, 0 to fit, F to focus the selection."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => {
          if (!gesture.current) setHovered(undefined);
        }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        style={{ cursor: hover?.kind === "node" ? "pointer" : gesture.current?.dragging ? "grabbing" : "grab" }}
      />
      <div className="landscape-bar landscape-top">
        <div className="landscape-chips" role="group" aria-label="Relations shown">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              className="landscape-chip"
              aria-pressed={categories.has(category)}
              style={{ "--swatch": CATEGORY_COLORS[category] } as React.CSSProperties}
              onClick={() =>
                setCategories((current) => {
                  const next = new Set(current);
                  if (next.has(category)) next.delete(category);
                  else next.add(category);
                  return next;
                })
              }
            >
              {CATEGORY_LABEL[category]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="landscape-tools">
          <button className="refresh-cdk" onClick={() => void refreshCdkLinks()} disabled={scanning || studioLive.evaluating} title="Re-read linked CDK stacks and rebuild the studio link index. CDK source changes also refresh automatically.">
            <RefreshCw size={14} aria-hidden />{scanning ? "Refreshing…" : "Refresh CDK links"}
          </button>
          <button onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)">
            <Minus size={16} aria-hidden />
          </button>
          <button onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)">
            <Plus size={16} aria-hidden />
          </button>
          <button onClick={() => fit()} aria-label="Fit the whole application" title="Fit everything (0)">
            <Maximize2 size={16} aria-hidden />
          </button>
          <button onClick={() => focus(selected)} disabled={!selected} aria-label="Focus the selection" title="Focus the selection (F)">
            <Crosshair size={16} aria-hidden />
          </button>
          <button onClick={() => setMotion((current) => !current)} aria-pressed={!motion} aria-label={motion ? "Pause motion" : "Resume motion"} title={motion ? "Pause motion" : "Resume motion"}>
            {motion ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
          </button>
        </div>
      </div>
      <div className="landscape-bar landscape-bottom">
        <div className="landscape-legend">
          <span>
            <i className="swatch solid" /> Enabled in {model.mode === "dev" ? "Development" : "Production"}
          </span>
          <span>
            <i className="swatch ghost" /> Outside this environment
          </span>
          <DeploymentLegend />
        </div>
        <span className="spacer" />
        <span className="landscape-stats">
          {scene.nodes.length} entities on {scene.tiles.length} tiles, {stats.ms.toFixed(1)} ms a frame
        </span>
      </div>
      {hover ? <HoverCard hover={hover} scene={scene} nodes={nodes} index={index} viewport={live.current.viewport} /> : null}
      <ul className="sr-only" aria-label="Entities in the landscape">
        {scene.nodes.map((node) => (
          <li key={node.id}>
            <button onClick={() => select(node.id)} aria-current={selected === node.id}>
              {node.label}, {node.kindLabel}. {node.presenceText}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the pointer is over, in words: an entity, a relationship, a place, or furniture. */
function HoverCard(props: {
  readonly hover: Hover;
  readonly scene: Scene;
  readonly nodes: ReadonlyMap<string, SceneNode>;
  readonly index: ReturnType<typeof useStudio>["index"];
  readonly viewport: Viewport;
}) {
  const { hover: current, index } = props;
  let title: string;
  let lines: (string | undefined)[] = [];
  if (current.kind === "node") {
    const node = props.nodes.get(current.id)!;
    title = node.label;
    lines = [node.kindLabel, node.presenceText, laneText(node), "Click to inspect, double-click to fly to it."];
  } else if (current.kind === "edge") {
    const edge = props.scene.edges.find((candidate) => candidate.edge.id === current.id)!.edge;
    title = `${RELATION_LABEL[edge.relation]}: ${edge.label}`;
    lines = [`${titleOf(index, edge.from)} to ${titleOf(index, edge.to)}`, edge.detail, edge.provenance === "derived" ? "Derived by the framework." : edge.provenance === "source" ? "Inferred from source; deployment and runtime behavior are not verified." : undefined];
  } else if (current.kind === "prop") {
    const prop = props.scene.props.find((candidate) => candidate.id === current.id)!;
    title = prop.label;
    lines = [...prop.caption];
  } else {
    const [gx, gy] = current.id.split(",").map(Number);
    const tile = props.scene.tiles.find((candidate: Tile) => candidate.gx === gx && candidate.gy === gy);
    const island = props.scene.islands.find((candidate) => candidate.id === tile?.island);
    const band = island?.bands.find((candidate) => candidate.id === tile?.band);
    const terraced = island !== undefined && island.bands.length > 1;
    title = band && terraced ? `${island.title}: ${band.title}` : island?.title ?? "";
    lines = [...(island?.caption ?? []), ...(band && terraced ? band.caption : [])];
  }
  // Stay inside the canvas: flip to the pointer's other side near an edge.
  const left = current.x + 340 > props.viewport.width ? Math.max(8, current.x - 336) : current.x + 16;
  const top = current.y + 180 > props.viewport.height ? Math.max(8, current.y - 150) : current.y + 16;
  return (
    <div className="landscape-hover" style={{ left, top }} role="tooltip">
      <strong>{title}</strong>
      {lines.filter(Boolean).map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}
