import type { IconKey } from "../icons";
import type { Island, Region } from "./build";

type Rgb = readonly [number, number, number];

/**
 * Service colours matching the local SVGs, including Studio's blue database
 * backgrounds, so a trim and its icons read as one system.
 */
const AWS = {
  compute: "#ED7100",
  networking: "#8C4FFF",
  integration: "#E7157B",
  ai: "#01A88D",
  database: "#3B82F6",
  storage: "#7AA116",
  security: "#DD344C",
} as const;

const NEUTRAL = "#9fb3c8";

/** The colour each icon spills onto the ground beneath it. */
export const ICON_TINT: Readonly<Record<IconKey, string>> = {
  lambda: AWS.compute,
  gateway: AWS.networking,
  webSocket: "#6cc9d6",
  event: "#ead46c",
  internetGateway: AWS.networking,
  natGateway: AWS.networking,
  endpoint: AWS.networking,
  service: AWS.compute,
  task: AWS.compute,
  workflow: AWS.integration,
  agent: AWS.ai,
  stack: AWS.integration,
  unattached: "#f0b96b",
  managed: "#a9c5e8",
  table: AWS.database,
  bucket: AWS.storage,
  queue: AWS.integration,
  topic: AWS.integration,
  bus: AWS.integration,
  userpool: AWS.security,
  database: AWS.database,
  postgres: "#2fb3bc",
  secret: AWS.security,
  group: NEUTRAL,
  input: NEUTRAL,
  envFile: NEUTRAL,
  value: NEUTRAL,
  construct: NEUTRAL,
  route: NEUTRAL,
};

/** Trim by island: the category of what stands on it. */
export const ISLAND_TRIM: Readonly<Record<string, string>> = {
  "island:apis": AWS.networking,
  "island:lambda": AWS.compute,
  "island:local": "#2fb3bc",
  "island:vpc": "#9d6bff",
  "island:agentcore": AWS.ai,
  "island:orchestration": AWS.integration,
  "island:stacks": "#6f93c9",
  "island:inputs": AWS.security,
  "island:environment": "#2fb3bc",
};

const REGION_TRIM: Readonly<Record<Region, string>> = {
  entry: AWS.networking,
  compute: AWS.compute,
  local: "#2fb3bc",
  network: "#9d6bff",
  agents: AWS.ai,
  orchestration: AWS.integration,
  catalog: "#6f93c9",
};

export function trimColor(island: Pick<Island, "id" | "region">): string {
  return ISLAND_TRIM[island.id] ?? REGION_TRIM[island.region];
}

export function hexRgb(value: string): Rgb {
  const number = Number.parseInt(value.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

/** Terraces with a colour of their own: subnets read as public (green), private (blue) or isolated (purple). */
export const BAND_TRIM: Readonly<Record<string, string>> = {
  "band:public": "#5fc75a",
  "band:private": "#3d8bfd",
  "band:isolated": "#b07cff",
};

/** A terrace's trim: its own colour where it has one, otherwise its island's. */
export function bandTrim(island: Pick<Island, "id" | "region" | "bands">, index: number): Rgb {
  return hexRgb(BAND_TRIM[island.bands[index]?.id ?? ""] ?? trimColor(island));
}

/** The graphite look's fixed values. Colours are RGB; widths are screen pixels. */
export const GRAPHITE = {
  void: { top: "#0b1018", bottom: "#05070b", vignette: [4, 6, 10] as Rgb },
  blooms: [
    { x: 0.16, y: 0.1, radius: 0.62, color: [47, 179, 188] as Rgb, alpha: 0.085 },
    { x: 0.88, y: 0.92, radius: 0.6, color: [140, 79, 255] as Rgb, alpha: 0.07 },
  ],
  grid: { minor: "rgba(120, 160, 210, 0.045)", major: "rgba(120, 160, 210, 0.09)" },
  /** How much of the trim tints the graphite top. */
  tint: 0.07,
  top: { light: [58, 66, 80] as Rgb, dark: [38, 44, 55] as Rgb },
  walls: {
    left: { top: [38, 45, 55] as Rgb, bottom: [19, 23, 30] as Rgb },
    front: { top: [31, 37, 46] as Rgb, bottom: [15, 18, 24] as Rgb },
    right: { top: [25, 30, 38] as Rgb, bottom: [11, 14, 19] as Rgb },
  },
  lip: 0.2,
  rim: 0.07,
  etch: 0.035,
  glow: [
    { width: 7, alpha: 0.07 },
    { width: 3.2, alpha: 0.17 },
    { width: 1.3, alpha: 0.92 },
  ],
  /** The cast shadow on the floor far below: steps beneath the island's floor, and its soft layers. */
  shadow: { drop: 5, shift: 22, layers: [{ grow: 0, alpha: 0.3 }, { grow: 0.6, alpha: 0.15 }, { grow: 1.3, alpha: 0.08 }, { grow: 2.2, alpha: 0.045 }] },
  /** The seam between a terraced island's slabs, in cells. */
  terraceGap: 0.3,
} as const;
