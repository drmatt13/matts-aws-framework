import { screenToWorld, type Camera, type Point, type Viewport } from "./camera";
import { project, unproject } from "./iso";

export interface GridLine { readonly a: Point; readonly b: Point; readonly major: boolean }

/** Ground-plane lattice, anchored to the world. Coarsen at distant zooms to avoid moiré. */
export function backgroundGrid(camera: Camera, viewport: Viewport): GridLine[] {
  const corners = [{ x: 0, y: 0 }, { x: viewport.width, y: 0 }, { x: 0, y: viewport.height }, { x: viewport.width, y: viewport.height }]
    .map((point) => unproject(screenToWorld(camera, viewport, point)));
  const step = 2 ** Math.max(0, Math.ceil(Math.log2(14 / (32 * camera.zoom))));
  const minX = Math.floor(Math.min(...corners.map((p) => p.x)) / step) * step;
  const maxX = Math.ceil(Math.max(...corners.map((p) => p.x)) / step) * step;
  const minY = Math.floor(Math.min(...corners.map((p) => p.y)) / step) * step;
  const maxY = Math.ceil(Math.max(...corners.map((p) => p.y)) / step) * step;
  const lines: GridLine[] = [];
  for (let x = minX; x <= maxX; x += step) lines.push({ a: project({ x, y: minY }), b: project({ x, y: maxY }), major: x % (step * 5) === 0 });
  for (let y = minY; y <= maxY; y += step) lines.push({ a: project({ x: minX, y }), b: project({ x: maxX, y }), major: y % (step * 5) === 0 });
  return lines;
}
