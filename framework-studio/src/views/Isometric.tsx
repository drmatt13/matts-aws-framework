import { ChevronLeft, Crosshair, Maximize2, Minus, PanelRight, Pause, Play, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RELATION_LABEL, endpointLabel, indexModel } from "../lookup";
import { buildScene, type Scene, type SceneNode } from "../scene/build";
import { islandDrawOrder, islandSlabs } from "../scene/slabs";
import {
  DRAG_THRESHOLD,
  fitBounds,
  interpolate,
  pan,
  revealSelection,
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
import { fitScene, selectionBounds } from "../scene/fit";
import { connectionMidpoint } from "../scene/routing";
import { landscapeFocus, searchOpacity, searchScene } from "../scene/focus";
import { filterSceneByTag } from "../scene/tag-filter";
import { SceneRenderer, type Stage } from "../scene/render";
import { nodeHoverFacts, propHoverFacts, type HoverFacts } from "../scene/hover";
import { catalogAvailability } from "../deployment";
import { connectionLabel, missingConnectionInput } from "../connections";
import { AddMenu } from "./AddMenu";
import { useStudio } from "../studio";
import { SourceEnvironment, SourceHistory } from "./SourceContext";
import { EnvironmentPills } from "./DeploymentBadge";
import { InspectorContent } from "./Inspector";
import { ResourceBrowser, type BrowserMemory } from "./ResourceBrowser";
import { WorkspacePanel } from "./WorkspacePanel";
import { tagGroups, tagKeys, tagValueLabel, UNTAGGED_FILTER } from "../tag-groups";

const TAG_VIEW_STORAGE = "framework-studio:isometric-tag-filter";
interface TagFilterPreference { readonly key: string; readonly value?: string | null }
const rememberedTagFilter = (): TagFilterPreference => {
  try { const value = JSON.parse(window.localStorage.getItem(TAG_VIEW_STORAGE) ?? "null"); if (value && typeof value.key === "string" && (value.value === undefined || value.value === null || typeof value.value === "string")) return value; } catch { /* Invalid preferences fall back to the whole topology. */ }
  return { key: "" };
};

/**
 * The landscape view: the same application, as a lit miniature you can fly over.
 *
 * Everything here is presentation. The scene comes from the model the other
 * views read; selecting a building selects that entity everywhere, and the
 * panel beside the canvas hosts the same inspector, with the same edits. Moving
 * the camera changes nothing on disk.
 */

/**
 * What the map's side panel shows. It is derived, never stored: a selection opens
 * its inspector, and Resources is the layer beneath it.
 */
type PanelView = "closed" | "resources" | "inspector";
const PANEL_ID = "map-workspace-panel";

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
  readonly source?: "reveal";
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const ENVIRONMENTS = [["dev", "Dev"], ["prod", "Prod"]] as const;
const NO_DESCRIPTION = "No description yet. Select it to write one.";

export function Isometric() {
  const { model, index, snapshot, selected, select, created, draft } = useStudio();
  const hasEntities = model.targets.length > 0 || model.resources.length > 0 || !!model.networks?.length;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);
  const [motion, setMotion] = useState(() => !reducedMotion());
  const [query, setQuery] = useState("");
  const [resourceKind, setResourceKind] = useState("");
  // Whether Resources is open beneath any inspector; a selection always shows its inspector.
  const [browsing, setBrowsing] = useState(false);
  const view: PanelView = selected !== undefined ? "inspector" : browsing ? "resources" : "closed";
  const browserMemory = useRef<BrowserMemory>({ scrollTop: 0 });
  const backButton = useRef<HTMLButtonElement>(null);
  const focusBack = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tagKeyRef = useRef<HTMLSelectElement>(null);
  const [tagFilter, setTagFilter] = useState(rememberedTagFilter);
  const [hover, setHover] = useState<Hover | undefined>();
  const [dragging, setDragging] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  const previousLayout = useRef<LayoutResult | undefined>(undefined);
  const pendingLayoutFit = useRef(false);
  const aspectTimer = useRef<number | undefined>(undefined);
  const appliedAspect = useRef(16 / 9);

  const conditions = useMemo(
    () => Object.fromEntries(Object.entries(snapshot.source.catalog).map(([id, facts]) => [id, facts.condition])),
    [snapshot.source.catalog],
  );
  const resourceAvailability = useMemo(() => catalogAvailability(snapshot.models), [snapshot.models]);
  const availableTagKeys = useMemo(() => tagKeys(model, index), [model, index]);
  const activeTagKey = model.tagging ? tagFilter.key : "";
  const untaggedOnly = activeTagKey === UNTAGGED_FILTER;
  const filterValue = untaggedOnly ? null : tagFilter.value;
  const untaggedCount = useMemo(() => tagGroups(model, UNTAGGED_FILTER, index)[0]!.members.length, [model, index]);
  const groups = useMemo(() => activeTagKey ? tagGroups(model, activeTagKey, index) : [], [model, activeTagKey, index]);
  const tagMatchCount = groups.find(group => group.value === filterValue)?.members.length ?? 0;
  const topology = useMemo(() => buildScene(model, { webSocketApi: snapshot.webSocketApi, conditions, resourceAvailability,
    layoutModels: [snapshot.models.dev, snapshot.models.prod], layoutSettings: { aspect, previous: previousLayout.current?.positions, previousKey: previousLayout.current?.topologyKey } }), [model, snapshot.models, snapshot.webSocketApi, conditions, resourceAvailability, aspect]);
  const scene = useMemo(() => activeTagKey && filterValue !== undefined ? filterSceneByTag(topology, model, activeTagKey, filterValue) : topology, [topology, model, activeTagKey, filterValue]);
  useLayoutEffect(() => { previousLayout.current = scene.layout; }, [scene]);
  const visibleSelected = selected ? scene.representatives[selected] ?? scene.edges.find((edge) => edge.members.some((member) => member.edge.id === selected))?.id ?? selected : undefined;
  const matches = useMemo(() => searchScene(scene, model, query), [scene, model, query]);
  const focusState = useMemo(() => landscapeFocus(scene, visibleSelected, matches), [scene, visibleSelected, matches]);
  const nodes = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene]);
  const resourceKinds = useMemo(() => [...new Set(scene.nodes.map(node => node.kindLabel.split(",")[0]!))].sort(), [scene]);
  const navigatorNodes = useMemo(() => scene.nodes.filter(node => (!matches || matches.nodes.has(node.id)) && (!resourceKind || node.kindLabel.split(",")[0] === resourceKind))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), [scene, matches, resourceKind]);
  const navigatorFixtures = useMemo(() => matches ? scene.props.filter(prop => matches.props.has(prop.id)) : [], [scene, matches]);
  const needsAttention = useCallback((id: string) => !!nodes.get(id)?.sourceProblems?.length
    || model.diagnostics.some(diagnostic => diagnostic.entity === id && diagnostic.severity === "error"), [nodes, model.diagnostics]);
  const slabs = useMemo(() => islandDrawOrder(islandSlabs(scene)), [scene]);
  const arcs = useMemo(
    () =>
      scene.edges.map((edge) => {
        const points = scene.routes[edge.id]!.points;
        return { edge, points, missing: missingConnectionInput(edge), midpoint: connectionMidpoint(points),
          minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
          minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)) };
      }),
    [scene],
  );
  const silhouettes = useMemo(() => scene.nodes.map((node) => ({ id: node.id, hull: node.geometry.hull })), [scene]);

  // Everything the frame loop reads, without re-subscribing it on every render.
  const live = useRef({
    scene,
    camera: rememberedCamera ?? { x: 0, y: 0, zoom: 1 },
    viewport: { width: 1, height: 1 } as Viewport,
    /** The viewport's top-left in the window, so a panel opening beside it leaves the map still. */
    origin: { x: 0, y: 0 } as Point,
    /** The map's span with any side panel, so the atmosphere stays still with it. */
    stage: { left: 0, width: 1 } as Stage,
    selected: visibleSelected,
    inspectedSelection: visibleSelected,
    hovered: undefined as string | undefined,
    hoveredEdge: undefined as string | undefined,
    hoveredIsland: undefined as string | undefined,
    motion,
    focus: focusState,
    tween: undefined as Tween | undefined,
    cards: [] as readonly CardHit[],
    badges: [] as readonly CardHit[],
    frame: undefined as number | undefined,
    fitted: rememberedCamera !== undefined,
    samples: [] as number[],
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
      stage: state.stage,
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
    state.badges = result.badges;
    state.frames += 1;
    // Keep frame timings in diagnostics without triggering React renders.
    state.samples = [...state.samples.slice(-59), result.ms];
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

  useEffect(() => { if (created) focus(scene.representatives[created.id] ?? created.id); }, [created, focus]);

  const resize = useCallback(() => {
    const container = containerRef.current;
    if (!container || !rendererRef.current) return;
    const state = live.current;
    const rect = container.getBoundingClientRect();
    const previous = state.viewport;
    const previousOrigin = state.origin;
    const next = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    const origin = { x: rect.left, y: rect.top };
    const selectionChanged = state.selected !== state.inspectedSelection;
    state.inspectedSelection = state.selected;
    if (selectionChanged && state.tween?.source === "reveal") state.tween = undefined;
    // Selection and the panel are presentation; use the containing workspace
    // dimensions so opening a node does not relayout the architecture.
    const workspace = container.closest(".workspace")?.getBoundingClientRect();
    const nextAspect = layoutAspect(workspace?.width ?? next.width, workspace?.height ?? next.height);
    window.clearTimeout(aspectTimer.current);
    aspectTimer.current = window.setTimeout(() => {
      if (appliedAspect.current === nextAspect) return;
      appliedAspect.current = nextAspect; previousLayout.current = undefined; pendingLayoutFit.current = true; setAspect(nextAspect);
    }, 180);
    // Only a side panel holds the map still; vertical changes (a wrapping toolbar, the panel
    // stacked above a narrow map) keep the map anchored to the canvas's top, as before.
    const moved = { x: origin.x - previousOrigin.x, y: 0 };
    if (state.fitted && next.width === previous.width && next.height === previous.height && !moved.x && !selectionChanged) return;
    state.viewport = next;
    state.origin = origin;
    // The map's whole span, panel included, in viewport coordinates.
    const span = container.closest(".landscape-content")?.getBoundingClientRect();
    state.stage = span ? { left: span.left - rect.left, width: span.width } : { left: 0, width: next.width };
    if (!state.fitted) {
      state.fitted = true;
      state.camera = fitScene(state.scene, next);
    } else if (previous.width > 1) {
      state.camera = resizeCamera(state.camera, previous, next, moved);
      // An in-flight focus starts from the resized camera, without jumping back to its old origin,
      // and takes precedence over revealing the selection.
      if (state.tween) state.tween = { ...state.tween, from: state.camera, start: performance.now() };
      // A new selection from the map, the list or a link comes into view, however it was cut off.
      const bounds = selectionChanged && state.selected && !state.tween ? selectionBounds(state.scene, state.selected) : undefined;
      // What the map showed before this change, in the new viewport's coordinates: wider than
      // the viewport when a panel has just opened over part of it.
      const shown = { left: -moved.x, right: previous.width - moved.x };
      const revealed = bounds ? revealSelection(state.camera, next, bounds, shown) : undefined;
      if (revealed) {
        state.tween = { from: state.camera, to: revealed, start: performance.now(), duration: reducedMotion() ? 0 : 450, source: "reveal" };
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
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
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
  }, [schedule, resize, hasEntities]);

  useEffect(schedule, [schedule, scene, selected, motion, focusState]);
  useEffect(() => { if (pendingLayoutFit.current) { pendingLayoutFit.current = false; fit(); } }, [scene, fit]);

  // Opening/closing the panel changes CSS layout during this commit. Resize and paint
  // now, rather than leaving a stretched frame until the observer's next animation callback.
  useLayoutEffect(() => {
    resize();
  }, [visibleSelected, view, resize]);

  /** Opens an inspector in the panel, from the list, the map or the keyboard entity list. */
  const inspect = useCallback((id: string, fromPanel = false) => {
    focusBack.current = fromPanel;
    select(id);
  }, [select]);
  /** Back to Resources: end the selection and return to the list as it was, at the row it opened. Pending edits ask first. */
  const back = () => draft.requestNavigation(() => {
    browserMemory.current.returnTo = selected;
    setBrowsing(true);
    select(undefined);
  });
  /** Close Panel: collapse it, end the selection and hand the keyboard back to the map. */
  const close = (focusMap = true) => {
    const proceed = () => {
      setBrowsing(false);
      if (selected) select(undefined);
      if (focusMap) canvasRef.current?.focus({ preventScroll: true });
    };
    if (selected !== undefined) draft.requestNavigation(proceed); else proceed();
  };
  const toggleResources = () => { if (view === "resources") close(false); else if (view === "inspector") back(); else setBrowsing(true); };
  // Opening a row keeps keyboard users in the panel; a map click leaves focus on the map.
  useEffect(() => {
    if (view !== "inspector" || !focusBack.current) return;
    focusBack.current = false;
    backButton.current?.focus({ preventScroll: true });
  }, [view, selected]);

  /** Node controls keep their inspector; connections take precedence over terrain. */
  const pick = useCallback(
    (screen: Point): Hover | undefined => {
      const state = live.current;
      const world = screenToWorld(state.camera, state.viewport, screen);
      const entity = pickEntity(screen, world, [...state.badges, ...state.cards], silhouettes);
      if (entity) return { kind: "node", id: entity, ...screen };
      for (const arc of arcs) {
        if (!arc.missing) continue;
        const marker = worldToScreen(state.camera, state.viewport, arc.midpoint);
        if (Math.hypot(marker.x - screen.x, marker.y - screen.y) <= 12) return { kind: "edge", id: arc.edge.id, ...screen };
      }
      for (let position = scene.props.length - 1; position >= 0; position -= 1) {
        if (insidePolygon(world.x, world.y, scene.props[position]!.geometry.hull)) return { kind: "prop", id: scene.props[position]!.id, ...screen };
      }
      const tolerance = 6 / state.camera.zoom;
      let best: { id: string; distance: number } | undefined;
      for (const arc of arcs) {
        if (world.x < arc.minX - tolerance || world.x > arc.maxX + tolerance || world.y < arc.minY - tolerance || world.y > arc.maxY + tolerance) continue;
        const distance = distanceToPolyline(world, arc.points);
        if (distance < tolerance && (!best || distance < best.distance)) best = { id: arc.edge.id, distance };
      }
      if (best) return { kind: "edge", id: best.id, ...screen };
      const island = pickIsland(world, slabs);
      if (island) return { kind: "island", ...island, ...screen };
      for (const frame of scene.frames) {
        if ([frame.geometry.top, frame.geometry.left, frame.geometry.right].some((polygon) => insidePolygon(world.x, world.y, polygon))) return { kind: "island", id: frame.members[0]!, ...screen };
      }
      return undefined;
    },
    [scene, slabs, arcs, silhouettes],
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
      setHover((current) => current?.kind === next?.kind && current?.id === next?.id && current?.band === next?.band && current?.x === next?.x && current?.y === next?.y ? current : next);
    },
    [schedule],
  );

  // High-rate pointers only need one hit test and tooltip position per paint.
  const hoverFrame = useRef<number | undefined>(undefined);
  const pendingHover = useRef<Point | undefined>(undefined);
  const cancelHover = useCallback(() => {
    if (hoverFrame.current !== undefined) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = undefined;
    pendingHover.current = undefined;
  }, []);
  useEffect(() => cancelHover, [pick, cancelHover]);
  const queueHover = (point: Point) => {
    pendingHover.current = point;
    if (hoverFrame.current !== undefined) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = undefined;
      const point = pendingHover.current;
      pendingHover.current = undefined;
      if (point) setHovered(pick(point));
    });
  };

  // Pointer input: a press that travels less than the threshold is a click.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; last: Point; dragging: boolean; pinch?: number } | undefined>(undefined);

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    cancelHover();
    canvasRef.current!.setPointerCapture(event.pointerId);
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    live.current.tween = undefined;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { start: point, last: point, dragging: true, pinch: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
      setDragging(true);
    } else {
      gesture.current = { start: point, last: point, dragging: false };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = local(event);
    const current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) {
      queueHover(point);
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
      setDragging(true);
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
    setDragging(false);
    if (!current || current.dragging) return;
    const hit = pick(local(event));
    // Clicking the inspected entity again ends its inspection.
    if (hit) { if (hit.id === selected) select(undefined); else inspect(hit.id); }
    else select(undefined);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    cancelHover();
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = undefined;
      setDragging(false);
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const point = local(event);
    const hit = pick(point);
    if (hit?.kind === "node") {
      // Its two clicks toggled the selection on and off again; a double-click means this one.
      inspect(hit.id);
      focus(hit.id, Math.max(1.3, live.current.camera.zoom));
    }
    else moveCamera(zoomAt(live.current.camera, live.current.viewport, point, 1.8));
  };

  // Wheel: zoom about the pointer. Registered by hand, because React's wheel
  // listener is passive and could not stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
  }, [schedule, hasEntities]);

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

  const changeTagFilter = (value: TagFilterPreference) => {
    setTagFilter(value);
    try { if (value.key) window.localStorage.setItem(TAG_VIEW_STORAGE, JSON.stringify(value)); else window.localStorage.removeItem(TAG_VIEW_STORAGE); } catch { /* View preferences do not block the map. */ }
  };

  // Test and console access to where things are drawn. Read-only.
  useEffect(() => {
    const debug = {
      camera: () => live.current.camera,
      viewport: () => live.current.viewport,
      screenOf: (id: string) => {
        const node = nodes.get(id) ?? scene.props.find(prop => prop.id === id);
        if (!node) return undefined;
        const card = live.current.cards.find((candidate) => candidate.id === id);
        return {
          building: worldToScreen(live.current.camera, live.current.viewport, node.geometry.top),
          card: card ? { x: card.x + card.width / 2, y: card.y + card.height / 2 } : undefined,
        };
      },
      pickAt: (x: number, y: number) => pick({ x, y }),
      cards: () => live.current.cards,
      badges: () => live.current.badges,
      connections: () => scene.edges.map((connection) => ({
        id: connection.id, from: connection.from, to: connection.to, members: connection.members.map((member) => member.edge.id),
        availability: connection.availability, label: connectionLabel(connection),
        points: scene.routes[connection.id]!.points.map((point) => worldToScreen(live.current.camera, live.current.viewport, point)),
        midpoint: worldToScreen(live.current.camera, live.current.viewport, connectionMidpoint(scene.routes[connection.id]!.points)),
      })),
      hullOf: (id: string) => {
        const node = nodes.get(id) ?? scene.props.find(prop => prop.id === id);
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
      tagFilter: () => ({ key: activeTagKey, value: tagFilter.value, muted: scene.nodes.filter(node => node.tagFiltered).map(node => node.id) }),
    };
    (window as unknown as { __studioLandscape?: typeof debug }).__studioLandscape = debug;
    return () => {
      delete (window as unknown as { __studioLandscape?: typeof debug }).__studioLandscape;
    };
  }, [nodes, pick, scene, activeTagKey, tagFilter.value]);

  // Hover coordinates and the timing readout must not rebuild hundreds of
  // hidden controls. Selection, source and scene updates still refresh them.
  const accessibleEntities = useMemo(() => (
    <ul className="sr-only landscape-entity-list" aria-label="Entities in the landscape" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); canvasRef.current?.focus(); return;
      }
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const current = items.indexOf(event.target as HTMLButtonElement);
      if (current < 0) return;
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : undefined;
      if (next === undefined) return;
      event.preventDefault(); items[next]?.focus();
    }}>
      <li className="landscape-entity-help"><strong>Map resources and connections</strong><span>Use arrow keys or Tab to browse, Enter to inspect, Escape to return to the map.</span></li>
      {scene.edges.map((connection) => <li key={connection.id}><button onClick={() => inspect(connection.id)} aria-current={visibleSelected === connection.id}>
        {missingConnectionInput(connection) ? "Missing required value: " : "Connection: "}{endpointLabel(index, connection.from)} to {endpointLabel(index, connection.to)}, {connection.members.length} {connection.members.length === 1 ? "relationship" : "relationships"}{connectionLabel(connection) ? ` (${connectionLabel(connection)})` : ""}
      </button></li>)}
      {scene.islands.map((island) => <li key={island.id}><button onClick={() => inspect(island.id)} aria-current={visibleSelected === island.id}>{island.title} island settings</button></li>)}
      {scene.props.map((prop) => <li key={prop.id}><button data-entity-id={prop.id} aria-description={prop.id} onClick={() => inspect(prop.id)} aria-current={visibleSelected === prop.id}>{prop.label}</button></li>)}
      {scene.nodes.map((node) => <li key={node.id}><button onClick={() => inspect(node.id)} aria-current={visibleSelected === node.id}>
        {node.label}, {node.kindLabel}. {node.presenceText}{node.sourceProblems?.length ? ". Implementation needs attention" : ""}
      </button></li>)}
    </ul>
  ), [scene, visibleSelected, index, inspect]);

  if (!hasEntities) {
    return <div className="landscape-workspace"><div className="workspace-toolbar landscape-top"><div className="source-controls"><SourceEnvironment /><SourceHistory /></div></div><p className="empty">The {model.mode === "dev" ? "development" : "production"} graph did not load. Open configuration health for the reason.</p></div>;
  }

  return (
    <div className="landscape-workspace">
      <div className="workspace-toolbar landscape-top">
        <div className="source-controls"><SourceEnvironment /><SourceHistory /></div>
        <div className="landscape-search-panel">
          <div className="landscape-search" role="search" aria-label="Map search">
            <Search size={16} aria-hidden />
            <input ref={searchRef} type="search" aria-label="Search isometric map" placeholder="Search the map…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (selected) select(undefined); else setQuery("");
              event.preventDefault();
            }} />
            {/* Inside the field, so typing never changes the toolbar's height under the panel. */}
            {matches ? <span className="landscape-search-count" role="status" title={selected ? "Search resumes when selection clears" : undefined}>
              {matches.nodes.size + matches.props.size} {matches.nodes.size + matches.props.size === 1 ? "match" : "matches"}
              {selected ? <><Pause size={11} aria-hidden /><span className="sr-only"> · Search resumes when selection clears</span></> : null}
            </span> : null}
            {query ? <button className="icon-button" aria-label="Clear map search" title="Clear map search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={14} aria-hidden /></button> : null}
          </div>
          <div className="landscape-tag-controls" role="group" aria-label="Map tag filters"><label htmlFor="map-tag-key">Tags</label>
            <select ref={tagKeyRef} id="map-tag-key" aria-label="Filter map by tag key" title={untaggedOnly ? "Entities with no tags" : activeTagKey || "All tags"} value={activeTagKey} onChange={event => changeTagFilter({ key: event.target.value, ...(event.target.value === UNTAGGED_FILTER ? { value: null } : {}) })}>
              <option value="">All tags</option>
              <option value={UNTAGGED_FILTER} disabled={!model.tagging}>Untagged ({untaggedCount})</option>
              {activeTagKey && !untaggedOnly && !availableTagKeys.includes(activeTagKey) ? <option value={activeTagKey}>{activeTagKey} (unavailable in this mode)</option> : null}
              {availableTagKeys.map(key => <option key={key} value={key}>{key === "Untagged" ? "Untagged (key)" : key}</option>)}
            </select>
            {/* Values belong to a chosen key; "All tags" and "Untagged" have none to pick. */}
            {activeTagKey && !untaggedOnly ? <select aria-label="Filter map by tag value" title={filterValue === undefined ? "All values" : tagValueLabel(filterValue)} value={filterValue === undefined ? "all" : JSON.stringify(filterValue)} onChange={event => { const chosen = groups.find(group => JSON.stringify(group.value) === event.target.value); changeTagFilter({ key: activeTagKey, ...(chosen ? { value: chosen.value } : {}) }); }}><option value="all">All values</option>{filterValue !== undefined && !groups.some(group => group.value === filterValue) ? <option value={JSON.stringify(filterValue)}>{tagValueLabel(filterValue)} (no matches)</option> : null}{groups.map(group => <option key={JSON.stringify(group.value)} value={JSON.stringify(group.value)}>{tagValueLabel(group.value)} ({group.members.length})</option>)}</select> : null}
            {activeTagKey ? <button className="icon-button" aria-label="Clear tag filter" title="Clear tag filter" onClick={() => { changeTagFilter({ key: "" }); tagKeyRef.current?.focus(); }}><X size={14} aria-hidden /></button> : null}
          </div>
          {/* The selects show the counts; the map's footer repeats the match, so the toolbar keeps one height. */}
          {activeTagKey && filterValue !== undefined ? <span className="sr-only" role="status">{tagMatchCount} matching {tagMatchCount === 1 ? "entity" : "entities"} in {model.mode === "dev" ? "development" : "production"}</span> : null}
        </div>
        <div className="landscape-tools" role="group" aria-label="Map view controls">
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
        <button className="panel-toggle" onClick={toggleResources} aria-expanded={view === "resources"} aria-controls={PANEL_ID} title={view === "resources" ? "Hide resources" : "Browse resources by name and type"}>
          <PanelRight size={16} aria-hidden /><span>Resources</span>
        </button>
      </div>
      <div className="landscape-content">
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
            cancelHover();
            if (!gesture.current) setHovered(undefined);
          }}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
          style={{ cursor: dragging ? "grabbing" : hover ? "pointer" : "grab" }}
        />
        <div className="landscape-bar landscape-bottom">
          <span className="landscape-stats">
            {scene.nodes.length} resources · {scene.edges.length} connections
            {activeTagKey && filterValue !== undefined ? <> · <strong>{tagMatchCount} {tagMatchCount === 1 ? "matches" : "match"} the tag filter</strong></> : null}
          </span>
          <span className="spacer" />
          <AddMenu />
        </div>
        {hover ? <HoverCard hover={hover} scene={scene} nodes={nodes} index={index} viewport={live.current.viewport} /> : null}
        {accessibleEntities}
      </div>
      {view !== "closed" ? <WorkspacePanel id={PANEL_ID} label={view === "inspector" ? "Inspector" : "Resources"} onClose={() => close()}
        bodyClassName={view === "inspector" ? "inspector" : "resource-browser"}
        heading={view === "inspector"
          ? <button ref={backButton} className="workspace-panel-back" onClick={back} aria-label="Back to Resources" title="Back to Resources"><ChevronLeft size={16} aria-hidden />Resources</button>
          : <><h2 className="workspace-panel-title">Resources</h2><span className="section-count" title={`${scene.nodes.length} resources on the map`}>{scene.nodes.length}</span></>}>
        {view === "inspector" && selected !== undefined ? <InspectorContent selected={selected} /> : <ResourceBrowser
          scene={scene} nodes={navigatorNodes} fixtures={navigatorFixtures} total={scene.nodes.length}
          kinds={resourceKinds} kind={resourceKind} onKind={setResourceKind}
          filtered={!!matches || !!resourceKind} onClearFilters={() => { setQuery(""); setResourceKind(""); }}
          attention={needsAttention} memory={browserMemory}
          onInspect={id => inspect(id, true)} />}
      </WorkspacePanel> : null}
      </div>
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
    lines = [...(node.sourceProblems?.length ? [...node.sourceProblems.slice(0, 3), "Select this resource to review implementation repairs."] : []), ...(description ? [] : [NO_DESCRIPTION])];
  } else if (current.kind === "edge") {
    const sceneEdge = props.scene.edges.find((candidate) => candidate.id === current.id);
    const edge = sceneEdge?.edge;
    if (!edge) return null;
    title = sceneEdge.members.length > 1 ? `${sceneEdge.members.length} relationships` : `${RELATION_LABEL[edge.relation]}: ${edge.label}`;
    facts = {
      places: ENVIRONMENTS.flatMap(([env]) => sceneEdge.availability[env] ? [{ env, where: "Connection enabled" }] : []),
      frameworkManaged: false,
    };
    const onlyIn = sceneEdge.otherLens ? `Only in ${sceneEdge.otherLens === "dev" ? "Development" : "Production"}. Switch the view to see it with the rest of that environment.` : undefined;
    lines = [onlyIn, `From ${endpointLabel(index, sceneEdge.from)}`, `To ${endpointLabel(index, sceneEdge.to)}`,
      ...(sceneEdge.members.length > 1 ? ["Click to inspect the connection map.", ...sceneEdge.members.slice(0, 4).map((member) => `${RELATION_LABEL[member.edge.relation]}: ${member.edge.label}`)] : [edge.detail]),
      missingConnectionInput(sceneEdge) ? "Required value missing. Click to resolve." : undefined,
      edge.provenance === "source" ? "Inferred from source; deployment and runtime behavior are not verified." : undefined];
  } else if (current.kind === "prop") {
    const prop = props.scene.props.find((candidate) => candidate.id === current.id);
    if (!prop) return null;
    title = prop.label;
    facts = propHoverFacts(snapshot.models, prop.id);
    description = draft.description(prop.id).trim();
    lines = description ? [] : [...prop.caption];
  } else {
    const island = props.scene.islands.find((candidate) => candidate.id === current.id);
    if (!island) return null;
    const band = props.scene.mode === "prod" && island?.bands.length && island.bands.length > 1 ? island.bands.find((band) => band.id === current.band) : undefined;
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
            <EnvironmentPills availability={{ dev: facts.places.some((place) => place.env === "dev"), prod: facts.places.some((place) => place.env === "prod") }} descriptions={Object.fromEntries(facts.places.map((place) => [place.env, place.where]))} />
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
