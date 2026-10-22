/**
 * An orthographic 2D camera over the landscape's world plane.
 *
 * The camera is the world point at the viewport's centre plus a zoom. Screen
 * coordinates here are CSS pixels relative to the canvas element; the device
 * pixel ratio is the renderer's business and never enters this module, so the
 * same transform serves drawing, picking and pointer input.
 */

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Low enough that a fit shows the whole application on a small screen. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 2.5;

/** Pointer travel, in CSS pixels, before a press becomes a pan rather than a click. */
export const DRAG_THRESHOLD = 6;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(camera: Camera, viewport: Viewport, point: Point): Point {
  return {
    x: (point.x - camera.x) * camera.zoom + viewport.width / 2,
    y: (point.y - camera.y) * camera.zoom + viewport.height / 2,
  };
}

export function screenToWorld(camera: Camera, viewport: Viewport, point: Point): Point {
  return {
    x: (point.x - viewport.width / 2) / camera.zoom + camera.x,
    y: (point.y - viewport.height / 2) / camera.zoom + camera.y,
  };
}

/** Moves the world with the pointer: a drag of (dx, dy) screen pixels. */
export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom };
}

/** Resize the viewport while keeping every world point at the same position from its top-left. */
export function resizeCamera(camera: Camera, previous: Viewport, next: Viewport): Camera {
  return {
    ...camera,
    x: camera.x + (next.width - previous.width) / (2 * camera.zoom),
    y: camera.y + (next.height - previous.height) / (2 * camera.zoom),
  };
}

/**
 * Zooms by `factor` about a screen point, keeping the world point under it
 * where it was: find it before, zoom, find it after, and move the camera by
 * the difference.
 */
export function zoomAt(camera: Camera, viewport: Viewport, anchor: Point, factor: number): Camera {
  const before = screenToWorld(camera, viewport, anchor);
  const zoomed = { ...camera, zoom: clampZoom(camera.zoom * factor) };
  const after = screenToWorld(zoomed, viewport, anchor);
  return { ...zoomed, x: zoomed.x + before.x - after.x, y: zoomed.y + before.y - after.y };
}

/**
 * A wheel event as a zoom factor. Lines and pages are normalized to pixels,
 * and the exponential keeps a trackpad's many small deltas and a mouse's few
 * large ones feeling alike. Scrolling down zooms out.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pageHeight: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  const bounded = Math.max(-240, Math.min(240, pixels));
  return Math.exp(-bounded * 0.0015);
}

/** The camera that shows `bounds` whole, with `padding` CSS pixels around it. */
export function fitBounds(bounds: Bounds, viewport: Viewport, padding = 48, maxZoom = 1.2): Camera {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (viewport.width - padding * 2) / width,
      (viewport.height - padding * 2) / height,
    ),
  );
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom };
}

/** Whether a world point is inside the viewport, inset by `margin` CSS pixels. */
export function isVisible(camera: Camera, viewport: Viewport, point: Point, margin = 40): boolean {
  const screen = worldToScreen(camera, viewport, point);
  return screen.x >= margin && screen.y >= margin && screen.x <= viewport.width - margin && screen.y <= viewport.height - margin;
}

/**
 * A point on the way from one camera to another, `t` in [0, 1]. Zoom is
 * interpolated in log space, so a zoom-in and a zoom-out of the same ratio take
 * the same time to feel done.
 */
export function interpolate(from: Camera, to: Camera, t: number): Camera {
  const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * eased),
  };
}
