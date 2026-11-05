import type { Scene } from "./types";
import { fitBounds, type Bounds, type Camera, type Viewport } from "./camera";
import { islandSlabs } from "./slabs";

/** Actual painted geometry for an inspected icon or island, without shadow/culling padding. */
export function selectionBounds(scene: Scene, id: string): Bounds | undefined {
  const standing = scene.nodes.find(node => node.id === id) ?? scene.props.find(prop => prop.id === id);
  let polygons: readonly (readonly number[])[];
  if (standing) polygons = [standing.geometry.hull];
  else {
    const slab = islandSlabs(scene).find(slab => slab.island.id === id);
    if (!slab) return undefined;
    const bandIds = new Set(slab.island.bands.map(band => band.id));
    polygons = [
      ...slab.bands.flatMap(band => [band.top, ...band.walls.map(wall => wall.quad)]),
      ...scene.frames.filter(frame => frame.members.includes(id)).flatMap(frame => [frame.geometry.top, frame.geometry.left, frame.geometry.right]),
      ...scene.nodes.filter(node => node.island === id).map(node => node.geometry.hull),
      ...scene.props.filter(prop => prop.serves.some(band => bandIds.has(band))).map(prop => prop.geometry.hull),
    ];
  }
  const xs = polygons.flatMap(polygon => polygon.filter((_, at) => at % 2 === 0));
  const ys = polygons.flatMap(polygon => polygon.filter((_, at) => at % 2 === 1));
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Fit screen-sized titles as well as projected terrain and routed wires.
 * Text does not shrink with the world, so its world-space allowance depends on
 * the fitted zoom. Conservative ink widths avoid needing a canvas in layout. */
export function fitScene(scene: Scene, viewport: Viewport, padding = 40): Camera {
  const slabs = islandSlabs(scene);
  const flanks = slabs.map((slab) => ({
    title: slab.island.title,
    left: Math.min(slab.bounds.minX, ...scene.frames.filter((frame) => frame.members.includes(slab.island.id)).map((frame) => frame.geometry.bounds.minX)),
  }));
  let bounds = scene.bounds;
  let camera = fitBounds(bounds, viewport, padding);
  for (let pass = 0; pass < 8; pass++) {
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    const minX = Math.min(scene.bounds.minX, ...flanks.map(({ title, left }) => left - (title.length * 8 * scale + 24) / camera.zoom));
    bounds = { ...scene.bounds, minX };
    const next = fitBounds(bounds, viewport, padding);
    const settled = Math.abs(next.x - camera.x) * next.zoom < 0.1;
    camera = next;
    if (settled) break;
  }
  // Titles need extra room on the left, but their reserved margin should not push
  // the landscape right when a wide viewport has space to center the artwork.
  // Keep the fitted zoom and constrain the horizontal move to the full label bounds.
  // A small screen-space lift balances the overview vertically, retaining at least
  // half the top padding (24 px with the default 40 px padding).
  camera = { ...camera, y: camera.y + Math.min(16, padding / 2) / camera.zoom };
  let left = Infinity, right = -Infinity;
  const include = (x: number) => { left = Math.min(left, x); right = Math.max(right, x); };
  for (const slab of slabs) { include(slab.bounds.minX); include(slab.bounds.maxX); }
  for (const frame of scene.frames) { include(frame.geometry.bounds.minX); include(frame.geometry.bounds.maxX); }
  for (const item of [...scene.nodes, ...scene.props]) for (let at = 0; at < item.geometry.hull.length; at += 2) include(item.geometry.hull[at]!);
  for (const route of Object.values(scene.routes)) for (const point of route.points) include(point.x);
  const halfWidth = (viewport.width / 2 - padding) / camera.zoom;
  const minCenter = bounds.maxX - halfWidth, maxCenter = bounds.minX + halfWidth;
  if (!Number.isFinite(left) || minCenter > maxCenter) return camera;
  return { ...camera, x: Math.max(minCenter, Math.min(maxCenter, (left + right) / 2)) };
}
