import { Crosshair, LayoutGrid, Maximize2, Minus, Pause, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import { api } from "../api";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RELATION_LABEL, indexModel, titleOf } from "../lookup";
import { buildScene, type Scene, type SceneNode } from "../scene/build";
import { islandDrawOrder, islandSlabs } from "../scene/slabs";
import {
  DRAG_THRESHOLD,
  fitBounds,
  interpolate,
  isVisible,
  pan,
  resizeCamera,
  screenToWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
  type Camera,
  type Point,
  type Viewport,
} from "../scene/camera";
import { distanceToPolyline, insidePolygon, pickEntity, pickIsland, type CardHit } from "../scene/picking";
import { layoutAspect, type LayoutResult } from "../scene/layout-optimize";
import { fitScene } from "../scene/fit";
import { connectionMidpoint } from "../scene/routing";
import { landscapeFocus, searchOpacity, searchScene } from "../scene/focus";
import { SceneRenderer } from "../scene/render";
import { nodeHoverFacts, propHoverFacts, type HoverFacts } from "../scene/hover";
import { catalogAvailability } from "../deployment";
import { AddMenu } from "./AddMenu";
import { useStudio } from "../studio";

/**
 * The landscape view: the same application, as a lit miniature you can fly over.
 *
 * Everything here is presentation. The scene comes from the model the other
 * views read; selecting a building selects that entity everywhere, and the
 * inspector beside the canvas is the same one, with the same edits. Moving the
 * camera changes nothing on disk.
 */

/** Where the camera was, so leaving the view and coming back keeps your place. */
let rememberedCamera: Camera | undefined;

interface Hover {
  readonly kind: "node" | "edge" | "island" | "prop";
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly band?: string;
}

interface Tween {
  readonly from: Camera;
  readonly to: Camera;
  readonly start: number;
  readonly duration: number;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const ENVIRONMENTS = [["dev", "Dev"], ["prod", "Prod"]] as const;
const NO_DESCRIPTION = "No description yet. Select it to write one.";

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
  const [motion, setMotion] = useState(() => !reducedMotion());
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<Hover | undefined>();
  const [stats, setStats] = useState({ ms: 0 });
  const [aspect, setAspect] = useState(16 / 9);
  const previousLayout = useRef<LayoutResult | undefined>(undefined);
  const [arrangement, setArrangement] = useState(0);
  const pendingArrangeFit = useRef(false);
  const aspectTimer = useRef<number | undefined>(undefined);
  const appliedAspect = useRef(16 / 9);

  const conditions = useMemo(
    () => Object.fromEntries(Object.entries(snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])),
    [snapshot.source.catalog],
  );
  const resourceAvailability = useMemo(() => catalogAvailability(snapshot.models), [snapshot.models]);
  const scene = useMemo(() => buildScene(model, { webSocketApi: snapshot.webSocketApi, conditions, resourceAvailability,
    layoutModels: [snapshot.models.dev, snapshot.models.prod], layoutSettings: { aspect, previous: previousLayout.current?.positions, previousKey: previousLayout.current?.topologyKey } }), [model, snapshot.models, snapshot.webSocketApi, conditions, resourceAvailability, aspect, arrangement]);
  useLayoutEffect(() => { previousLayout.current = scene.layout; }, [scene]);
  const visibleSelected = selected ? scene.representatives[selected] ?? selected : undefined;
  const matches = useMemo(() => searchScene(scene, model, query), [scene, model, query]);
  const focusState = useMemo(() => landscapeFocus(scene, visibleSelected, matches), [scene, visibleSelected, matches]);
  const nodes = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene]);
  const slabs = useMemo(() => islandDrawOrder(islandSlabs(scene)), [scene]);
  const arcs = useMemo(
    () =>
      scene.edges.map((edge) => {
        return { edge, points: scene.routes[edge.edge.id]!.points };
      }),
    [scene],
  );

  // Everything the frame loop reads, without re-subscribing it on every render.
  const live = useRef({
    scene,
    camera: rememberedCamera ?? { x: 0, y: 0, zoom: 1 },
    viewport: { width: 1, height: 1 } as Viewport,
    selected: visibleSelected,
    hovered: undefined as string | undefined,
    hoveredEdge: undefined as string | undefined,
    hoveredIsland: undefined as string | undefined,
    motion,
    focus: focusState,
    tween: undefined as Tween | undefined,
    cards: [] as readonly CardHit[],
    frame: undefined as number | undefined,
    fitted: rememberedCamera !== undefined,
    samples: [] as number[],
    published: 0,
    frames: 0,
  });
  live.current.scene = scene;
  live.current.selected = visibleSelected;
  live.current.motion = motion;
  live.current.focus = focusState;

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
      ...(state.hoveredIsland ? { hoveredIsland: state.hoveredIsland } : {}),
      time: now / 1000,
      motion: state.motion,
      focus: state.focus,
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
    (animate = true) => moveCamera(fitScene(live.current.scene, live.current.viewport), animate),
    [moveCamera],
  );

  const focus = useCallback(
    (id: string | undefined, zoom?: number) => {
      const node = id ? live.current.scene.nodes.find((candidate) => candidate.id === id) : undefined;
      if (!node) {
        const island = islandSlabs(live.current.scene).find((slab) => slab.island.id === id);
        if (island) moveCamera(fitBounds(island.bounds, live.current.viewport, 60));
        return;
      }
      const camera = live.current.camera;
      moveCamera({ x: node.geometry.top.x, y: node.geometry.top.y, zoom: zoom ?? Math.max(camera.zoom, 0.9) });
    },
    [moveCamera],
  );

  const resize = useCallback(() => {
    const container = containerRef.current;
    if (!container || !rendererRef.current) return;
    const state = live.current;
    const rect = container.getBoundingClientRect();
    const previous = state.viewport;
    const next = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    // Selection and the inspector are presentation; use the containing workspace
    // width so opening a node does not relayout the architecture.
    const workspaceWidth = container.closest(".workspace")?.getBoundingClientRect().width ?? next.width;
    const nextAspect = layoutAspect(workspaceWidth, next.height);
    window.clearTimeout(aspectTimer.current);
    aspectTimer.current = window.setTimeout(() => {
      if (appliedAspect.current === nextAspect) return;
      appliedAspect.current = nextAspect; previousLayout.current = undefined; pendingArrangeFit.current = true; setAspect(nextAspect);
    }, 180);
    if (state.fitted && next.width === previous.width && next.height === previous.height) return;
    state.viewport = next;
    if (!state.fitted) {
      state.fitted = true;
      state.camera = fitScene(state.scene, next);
    } else if (previous.width > 1) {
      state.camera = resizeCamera(state.camera, previous, next);
      // An in-flight focus starts from the resized camera, without jumping back to its old origin.
      if (state.tween) state.tween = { ...state.tween, from: state.camera, start: performance.now() };
      const node = state.selected ? state.scene.nodes.find((candidate) => candidate.id === state.selected) : undefined;
      if (node && !isVisible(state.camera, next, node.geometry.top, 60)) {
        state.tween = { from: state.camera, to: { ...state.camera, zoom: state.tween?.to.zoom ?? state.camera.zoom, x: node.geometry.top.x, y: node.geometry.top.y }, start: performance.now(), duration: reducedMotion() ? 0 : 450 };
      }
    }
    // A ResizeObserver runs before paint but after animation callbacks. Waiting for another
    // animation frame would let CSS stretch the old bitmap for one frame when the panel opens.
    if (state.frame !== undefined) cancelAnimationFrame(state.frame);
    state.frame = undefined;
    draw();
  }, [draw]);

  // Mount before paint: the renderer, the canvas's size, and web fonts arriving late.
  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const container = containerRef.current!;
    rendererRef.current = new SceneRenderer(canvas, schedule);
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
      window.clearTimeout(aspectTimer.current);
      observer.disconnect();
      if (live.current.frame !== undefined) cancelAnimationFrame(live.current.frame);
      live.current.frame = undefined;
      rendererRef.current?.dispose();
      rendererRef.current = undefined;
    };
  }, [schedule, resize]);

  useEffect(schedule, [schedule, scene, selected, motion, focusState]);
  useEffect(() => { if (pendingArrangeFit.current) { pendingArrangeFit.current = false; fit(); } }, [scene, fit]);

  // Opening/closing the inspector changes CSS layout during this commit. Resize and paint
  // now, rather than leaving a stretched frame until the observer's next animation callback.
  useLayoutEffect(() => {
    resize();
    const node = visibleSelected ? nodes.get(visibleSelected) : undefined;
    const state = live.current;
    const alreadyFocusing = node && state.tween?.to.x === node.geometry.top.x && state.tween.to.y === node.geometry.top.y;
    if (node && !alreadyFocusing && !isVisible(state.camera, state.viewport, node.geometry.top, 60)) focus(node.id);
  }, [visibleSelected, nodes, focus, resize]);

  /** Icons keep their inspector; empty terrain opens island defaults, even beneath an arc. */
  const pick = useCallback(
    (screen: Point): Hover | undefined => {
      const state = live.current;
      const world = screenToWorld(state.camera, state.viewport, screen);
      const entity = pickEntity(screen, world, state.cards, scene.nodes.map((node) => ({ id: node.id, hull: node.geometry.hull })));
      if (entity) return { kind: "node", id: entity, ...screen };
      for (const arc of arcs) if (arc.edge.edge.inputRequirement?.status === "missing") {
        const marker = worldToScreen(state.camera, state.viewport, connectionMidpoint(arc.points));
        if (Math.hypot(marker.x - screen.x, marker.y - screen.y) <= 12) return { kind: "edge", id: arc.edge.edge.id, ...screen };
      }
      for (let position = scene.props.length - 1; position >= 0; position -= 1) {
        if (insidePolygon(world.x, world.y, scene.props[position]!.geometry.hull)) return { kind: "prop", id: scene.props[position]!.id, ...screen };
      }
      const island = pickIsland(world, slabs);
      if (island) return { kind: "island", ...island, ...screen };
      for (const frame of scene.frames) {
        if ([frame.geometry.top, frame.geometry.left, frame.geometry.right].some((polygon) => insidePolygon(world.x, world.y, polygon))) return { kind: "island", id: frame.members[0]!, ...screen };
      }
      const tolerance = 6 / state.camera.zoom;
      let best: { id: string; distance: number } | undefined;
      for (const arc of arcs) {
        const distance = distanceToPolyline(world, arc.points);
        if (distance < tolerance && (!best || distance < best.distance)) best = { id: arc.edge.edge.id, distance };
      }
      if (best) return { kind: "edge", id: best.id, ...screen };
      return undefined;
    },
    [scene, slabs, arcs],
  );

  const setHovered = useCallback(
    (next: Hover | undefined) => {
      const state = live.current;
      const hovered = next?.kind === "node" ? next.id : undefined;
      const hoveredEdge = next?.kind === "edge" ? next.id : undefined;
      const hoveredIsland = next?.kind === "island" ? next.id : undefined;
      if (hovered !== state.hovered || hoveredEdge !== state.hoveredEdge || hoveredIsland !== state.hoveredIsland) {
        state.hovered = hovered;
        state.hoveredEdge = hoveredEdge;
        state.hoveredIsland = hoveredIsland;
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
    if (hit?.kind === "node" || hit?.kind === "island" || hit?.kind === "edge" || hit?.kind === "prop") select(selected === hit.id ? undefined : hit.id);
    else if (!hit) select(undefined);
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
    else if (event.key === "f" || event.key === "F") focus(visibleSelected);
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
        focus: live.current.focus.kind,
      }),
      search: () => ({
        active: live.current.focus.kind === "search",
        nodes: [...live.current.focus.nodes],
        props: [...live.current.focus.props],
        opacityOf: (id: string) => searchOpacity(live.current.focus, "nodes", id),
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
        style={{ cursor: gesture.current?.dragging ? "grabbing" : hover?.kind === "node" || hover?.kind === "island" ? "pointer" : "grab" }}
      />
      <div className="landscape-bar landscape-top">
        <div className="landscape-search-panel">
          <div className="landscape-search">
            <Search size={16} aria-hidden />
            <input type="search" aria-label="Search isometric map" placeholder="Search the map…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (selected) select(undefined); else setQuery("");
              event.preventDefault();
            }} />
            {query ? <button className="icon-button" aria-label="Clear map search" onClick={() => setQuery("")}><X size={14} aria-hidden /></button> : null}
          </div>
          {matches ? <span className="landscape-search-status" role="status">{matches.nodes.size + matches.props.size} {matches.nodes.size + matches.props.size === 1 ? "match" : "matches"}{selected ? " · Search resumes when selection clears" : ""}</span> : null}
        </div>
        <span className="spacer" />
        <div className="landscape-tools">
          <button aria-label="Auto-arrange islands" title="Rebuild the layout from current connections, then fit the map" disabled={studioLive.evaluating} onClick={() => { previousLayout.current = undefined; pendingArrangeFit.current = true; setArrangement((value) => value + 1); }}><LayoutGrid size={16} aria-hidden /></button>
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
          <button onClick={() => focus(visibleSelected)} disabled={!selected} aria-label="Focus the selection" title="Focus the selection (F)">
            <Crosshair size={16} aria-hidden />
          </button>
          <button onClick={() => setMotion((current) => !current)} aria-pressed={!motion} aria-label={motion ? "Pause motion" : "Resume motion"} title={motion ? "Pause motion" : "Resume motion"}>
            {motion ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
          </button>
        </div>
      </div>
      <div className="landscape-bar landscape-bottom">
        <span className="landscape-stats">
          {scene.nodes.length} entities on {scene.tiles.length} tiles, {stats.ms.toFixed(1)} ms a frame
        </span>
        <span className="spacer" />
        <AddMenu />
      </div>
      {hover ? <HoverCard hover={hover} scene={scene} nodes={nodes} index={index} viewport={live.current.viewport} /> : null}
      <ul className="sr-only" aria-label="Entities in the landscape">
        {scene.edges.filter((edge) => edge.edge.inputRequirement).map(({ edge }) => <li key={edge.id}><button onClick={() => select(edge.id)} aria-current={visibleSelected === edge.id}>{edge.inputRequirement!.status === "missing" ? "Missing required value" : "Input connection"}: {edge.label} in .env.{edge.inputRequirement!.mode}</button></li>)}
        {scene.islands.map((island) => <li key={island.id}><button onClick={() => select(island.id)} aria-current={visibleSelected === island.id}>{island.title} island settings</button></li>)}
        {scene.props.map((prop) => <li key={prop.id}><button onClick={() => select(prop.id)} aria-current={visibleSelected === prop.id}>{prop.label}</button></li>)}
        {scene.nodes.map((node) => (
          <li key={node.id}>
            <button onClick={() => select(node.id)} aria-current={visibleSelected === node.id}>
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
  const { draft, snapshot } = useStudio();
  // Both environments, so the label reads the same whichever the map is showing.
  const indexes = useMemo(() => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }), [snapshot.models]);
  let title: string;
  let subtitle: string | undefined;
  let lines: (string | undefined)[] = [];
  let facts: HoverFacts | undefined;
  let description = "";
  if (current.kind === "node") {
    const node = props.nodes.get(current.id);
    if (!node) return null;
    title = node.label;
    facts = nodeHoverFacts(node, indexes);
    // The draft's value, so an unsaved edit previews here as it does in the inspector.
    description = draft.description(node.id).trim();
    subtitle = node.kindLabel;
    lines = description ? [] : [NO_DESCRIPTION];
  } else if (current.kind === "edge") {
    const sceneEdge = props.scene.edges.find((candidate) => candidate.edge.id === current.id);
    const edge = sceneEdge?.edge;
    if (!edge) return null;
    title = `${RELATION_LABEL[edge.relation]}: ${edge.label}`;
    const onlyIn = sceneEdge.otherLens ? `Only in ${sceneEdge.otherLens === "dev" ? "Development" : "Production"}. Switch the view to see it with the rest of that environment.` : undefined;
    lines = [onlyIn, `${titleOf(index, edge.from)} to ${titleOf(index, edge.to)}`, edge.inputRequirement?.status === "missing" ? `Required in ${edge.inputRequirement.mode === "dev" ? "Development" : "Production"}: no non-blank value or default. Click to resolve.` : undefined, edge.detail, edge.relation === "supplies" ? "Input-file presence and requirement guidance. Values stay outside the map." : edge.provenance === "derived" ? "Derived by the framework." : edge.provenance === "source" ? "Inferred from source; deployment and runtime behavior are not verified." : undefined];
  } else if (current.kind === "prop") {
    const prop = props.scene.props.find((candidate) => candidate.id === current.id);
    if (!prop) return null;
    title = prop.label;
    facts = propHoverFacts(snapshot.models);
    description = draft.description(prop.id).trim();
    lines = description ? [] : [...prop.caption];
  } else {
    const island = props.scene.islands.find((candidate) => candidate.id === current.id);
    if (!island) return null;
    const band = island?.bands.length && island.bands.length > 1 ? island.bands.find((band) => band.id === current.band) : undefined;
    title = island ? `${island.title}${band ? `: ${band.title}` : ""}` : "";
    lines = [...(island?.caption ?? []), ...(band?.caption ?? []), "Click empty terrain for island settings and service defaults."];
  }
  // Stay inside the canvas: near an edge, anchor the card to the pointer's other side.
  const { width, height } = props.viewport;
  const placement = {
    ...(current.x + 340 > width ? { right: Math.max(8, width - current.x + 16) } : { left: current.x + 16 }),
    ...(current.y + 260 > height ? { bottom: Math.max(8, height - current.y + 16) } : { top: current.y + 16 }),
  };
  return (
    <div className="landscape-hover" style={placement} role="tooltip">
      <strong>{title}</strong>
      {subtitle ? <span>{subtitle}</span> : null}
      {facts ? (
        <>
          <span className="landscape-hover-tags">
            {ENVIRONMENTS.map(([env, label]) => {
              const place = facts.places.find((candidate) => candidate.env === env);
              // Both pills always stand; the one an environment does not deploy goes dark. The dot's fill and the
              // hidden text carry the state too, so it never rests on colour alone.
              return <span key={env} className={`hover-tag ${place ? env : "off"}`}>{label}<span className="sr-only">: {place?.where ?? "not deployed"}</span></span>;
            })}
            {facts.frameworkManaged ? <span className="hover-tag managed">Framework-managed</span> : null}
          </span>
          {facts.notDeployed ? <span className="landscape-hover-note">{facts.notDeployed}</span> : null}
        </>
      ) : null}
      {description ? <span className="landscape-hover-description">{description}</span> : null}
      {lines.filter(Boolean).map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}
