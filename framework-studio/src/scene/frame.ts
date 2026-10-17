import type { Island } from "./build";
import type { Bounds } from "./camera";
import { ELEVATION_STEP, project } from "./iso";

export interface IslandFrame {
  readonly top: readonly number[];
  readonly left: readonly number[];
  readonly right: readonly number[];
  readonly inset: readonly number[];
  readonly bounds: Bounds;
}

/** A shallow isometric foundation beneath the complete island, including all subnet terraces. */
export function islandFrame(island: Island): IslandFrame {
  const elevation = island.base - 0.25;
  const outline = (margin: number) => {
    const x0 = island.gx0 - 0.5 - margin;
    const y0 = island.gy0 - 0.5 - margin;
    const x1 = island.gx1 + 0.5 + margin;
    const y1 = island.gy1 + 0.5 + margin;
    return [
      project({ x: x0, y: y0, h: elevation }),
      project({ x: x1, y: y0, h: elevation }),
      project({ x: x1, y: y1, h: elevation }),
      project({ x: x0, y: y1, h: elevation }),
    ];
  };
  const points = outline(1);
  const [, east, south, west] = points;
  const depth = ELEVATION_STEP * 0.5;
  const flatten = (points: readonly { x: number; y: number }[]) => points.flatMap((point) => [point.x, point.y]);
  const top = flatten(points);
  const face = (a: { x: number; y: number }, b: { x: number; y: number }) => [a.x, a.y, b.x, b.y, b.x, b.y + depth, a.x, a.y + depth];
  return {
    top,
    left: face(west!, south!),
    right: face(south!, east!),
    inset: flatten(outline(0.65)),
    bounds: {
      minX: Math.min(...points.map((point) => point.x)),
      maxX: Math.max(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxY: Math.max(...points.map((point) => point.y)) + depth,
    },
  };
}

export const FRAME_COLORS = { network: "#71c5b6" } as const;

export interface SceneFrame {
  readonly id: string;
  readonly kind: keyof typeof FRAME_COLORS;
  readonly members: readonly string[];
  readonly ghost: boolean;
  readonly geometry: IslandFrame;
}

