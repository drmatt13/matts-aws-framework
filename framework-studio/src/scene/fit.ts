import type { Scene } from "./build";
import { fitBounds, type Camera, type Viewport } from "./camera";
import { islandSlabs } from "./slabs";

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
