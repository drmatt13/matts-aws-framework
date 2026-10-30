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
  const flanks = islandSlabs(scene).map((slab) => ({
    title: slab.island.title,
    left: Math.min(slab.bounds.minX, ...scene.frames.filter((frame) => frame.members.includes(slab.island.id)).map((frame) => frame.geometry.bounds.minX)),
  }));
  let camera = fitBounds(scene.bounds, viewport, padding);
  for (let pass = 0; pass < 8; pass++) {
    const scale = Math.max(0.8, Math.min(1.15, camera.zoom * 1.6));
    const minX = Math.min(scene.bounds.minX, ...flanks.map(({ title, left }) => left - (title.length * 8 * scale + 24) / camera.zoom));
    const next = fitBounds({ ...scene.bounds, minX }, viewport, padding);
    const settled = Math.abs(next.x - camera.x) * next.zoom < 0.1;
    camera = next;
    if (settled) break;
  }
  return camera;
}
