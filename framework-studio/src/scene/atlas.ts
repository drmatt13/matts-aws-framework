import { MATERIALS, type Material } from "./build";

/**
 * The terrain's block sprites, generated rather than drawn.
 *
 * Each sprite is a 32 × 32 pixel-art block: a 2:1 diamond top in rows 8–24
 * and a side skirt below it, drawn at 2× into a 64 × 64 quad so its top covers
 * exactly one 64 × 32 tile and the skirt one elevation step. The whole block is
 * scaled, never squashed. Sprites sit in 34 × 34 atlas cells with their edge
 * pixels extruded one pixel outward, so sampling the inner 32 × 32 never bleeds
 * a neighbour in. Elevation is baked in — higher ground is brighter — which
 * keeps each tile a single image draw.
 */

export const SPRITE = 32;
export const CELL = 34;
export const VARIANTS = 3;
export const LEVELS = 8;

type Rgb = readonly [number, number, number];

interface Palette {
  readonly top: Rgb;
  readonly detail: Rgb;
  readonly pattern: "pavers" | "circuit" | "moss" | "strata" | "soil" | "speckle" | "ripple" | "polished";
}

export const PALETTES: Readonly<Record<Material, Palette>> = {
  limestone: { top: [150, 140, 118], detail: [112, 102, 84], pattern: "pavers" },
  basalt: { top: [98, 108, 122], detail: [70, 78, 90], pattern: "pavers" },
  quartz: { top: [142, 122, 136], detail: [108, 90, 104], pattern: "polished" },
  circuit: { top: [62, 76, 92], detail: [118, 150, 176], pattern: "circuit" },
  moss: { top: [92, 112, 72], detail: [66, 84, 52], pattern: "moss" },
  lichen: { top: [82, 102, 96], detail: [60, 76, 72], pattern: "moss" },
  shale: { top: [80, 76, 96], detail: [58, 55, 72], pattern: "strata" },
  copper: { top: [132, 94, 70], detail: [96, 66, 48], pattern: "soil" },
  plum: { top: [108, 82, 102], detail: [140, 110, 134], pattern: "polished" },
  granite: { top: [100, 106, 116], detail: [140, 146, 156], pattern: "speckle" },
  sand: { top: [136, 122, 94], detail: [110, 98, 74], pattern: "ripple" },
};

function noise(x: number, y: number, seed: number): number {
  let value = Math.imul(x * 374761393 + y * 668265263 + seed * 2147483647, 1274126177);
  value ^= value >>> 13;
  value = Math.imul(value, 1103515245);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale(color: Rgb, factor: number): Rgb {
  return [color[0] * factor, color[1] * factor, color[2] * factor];
}

/** The surface colour at (u, v) on the top face, before lighting. */
function surface(palette: Palette, u: number, v: number, px: number, py: number, variant: number): Rgb {
  const grain = noise(px, py, variant + 7) - 0.5;
  let color = scale(palette.top, 1 + grain * 0.12);
  switch (palette.pattern) {
    case "pavers": {
      const seamU = Math.abs(u - 0.5) < 0.035 || u < 0.03;
      const seamV = Math.abs(v - 0.5) < 0.035 || v < 0.03;
      const slab = noise(Math.floor(u * 2), Math.floor(v * 2), variant + 31);
      color = scale(color, 0.94 + slab * 0.1);
      if (seamU || seamV) color = mix(color, palette.detail, 0.75);
      break;
    }
    case "circuit": {
      const traceU = Math.abs(u - (variant === 1 ? 0.3 : 0.7)) < 0.03 && v > 0.15 && v < 0.85;
      const traceV = Math.abs(v - (variant === 2 ? 0.3 : 0.62)) < 0.03 && u > 0.2;
      const via = Math.hypot(u - 0.5, v - 0.5) < 0.07;
      if (traceU || traceV) color = mix(color, palette.detail, 0.55);
      if (via) color = mix(color, palette.detail, 0.85);
      break;
    }
    case "moss": {
      const clump = noise(Math.floor(px / 3), Math.floor(py / 2), variant + 3);
      if (clump > 0.72) color = mix(color, palette.detail, 0.6);
      else if (clump < 0.12) color = scale(color, 1.12);
      break;
    }
    case "strata": {
      const band = Math.floor((u + v * 0.35) * 7 + variant) % 3;
      if (band === 0) color = mix(color, palette.detail, 0.45);
      break;
    }
    case "soil": {
      if (noise(px, py, variant + 11) > 0.86) color = mix(color, palette.detail, 0.8);
      break;
    }
    case "speckle": {
      const speck = noise(px, py, variant + 19);
      if (speck > 0.9) color = mix(color, palette.detail, 0.7);
      else if (speck < 0.08) color = scale(color, 0.82);
      break;
    }
    case "ripple": {
      if (Math.sin((u * 3 + v) * 9 + variant) > 0.82) color = mix(color, palette.detail, 0.5);
      break;
    }
    case "polished": {
      const sheen = Math.max(0, 1 - Math.abs(u - v - 0.1 * (variant - 1)) * 3);
      color = mix(color, palette.detail, sheen * 0.3);
      break;
    }
  }
  // A bevel: the back edges catch the light, the front edges fall into shadow.
  if (u < 0.06 || v < 0.06) color = scale(color, 1.16);
  else if (u > 0.94 || v > 0.94) color = scale(color, 0.84);
  return color;
}

/** Side faces: the left lit, the right in shadow, banded like cut stone. */
export function sideColor(material: Material, face: "left" | "right"): Rgb {
  const palette = PALETTES[material];
  return scale(mix(palette.top, palette.detail, 0.35), face === "left" ? 0.6 : 0.42);
}

/** The pixels of one sprite: RGBA, 32 × 32, row-major. */
export function spritePixels(material: Material, variant: number, level: number): Uint8ClampedArray {
  const palette = PALETTES[material];
  const pixels = new Uint8ClampedArray(SPRITE * SPRITE * 4);
  const light = 0.86 + Math.min(level, LEVELS - 1) * 0.045;
  for (let py = 0; py < SPRITE; py += 1) {
    for (let px = 0; px < SPRITE; px += 1) {
      const x = px + 0.5;
      const y = py + 0.5;
      // The top: (u, v) on the diamond whose corners are (16, 8), (32, 16), (16, 24), (0, 16).
      const a = (x - 16) / 16;
      const b = (y - 8) / 8;
      const u = (a + b) / 2;
      const v = (b - a) / 2;
      let color: Rgb | undefined;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        color = scale(surface(palette, u, v, px, py, variant), light);
      } else if (x < 16 && y > 16 + x / 2 && y <= 24 + x / 2) {
        const depth = y - (16 + x / 2);
        color = scale(sideColor(material, "left"), depth < 1 ? 1.25 : 1 - (Math.floor(depth) % 4 === 3 ? 0.08 : 0));
      } else if (x >= 16 && y > 24 - (x - 16) / 2 && y <= 32 - (x - 16) / 2) {
        const depth = y - (24 - (x - 16) / 2);
        color = scale(sideColor(material, "right"), depth < 1 ? 1.25 : 1 - (Math.floor(depth) % 4 === 3 ? 0.08 : 0));
      }
      if (!color) continue;
      const offset = (py * SPRITE + px) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export const ATLAS_COLUMNS = VARIANTS * LEVELS;
export const ATLAS_ROWS = MATERIALS.length;

/** Where a sprite's inner 32 × 32 starts in the atlas. */
export function spriteOrigin(material: Material, variant: number, level: number): { readonly x: number; readonly y: number } {
  const row = MATERIALS.indexOf(material);
  const column = (variant % VARIANTS) * LEVELS + Math.max(0, Math.min(LEVELS - 1, level));
  return { x: column * CELL + 1, y: row * CELL + 1 };
}

/** The whole atlas as RGBA pixels, each sprite edge-extruded into its cell. */
export function atlasPixels(): { readonly width: number; readonly height: number; readonly pixels: Uint8ClampedArray } {
  const width = ATLAS_COLUMNS * CELL;
  const height = ATLAS_ROWS * CELL;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const material of MATERIALS) {
    for (let variant = 0; variant < VARIANTS; variant += 1) {
      for (let level = 0; level < LEVELS; level += 1) {
        const sprite = spritePixels(material, variant, level);
        const origin = spriteOrigin(material, variant, level);
        for (let y = -1; y <= SPRITE; y += 1) {
          for (let x = -1; x <= SPRITE; x += 1) {
            const sx = Math.min(SPRITE - 1, Math.max(0, x));
            const sy = Math.min(SPRITE - 1, Math.max(0, y));
            const from = (sy * SPRITE + sx) * 4;
            const to = ((origin.y + y) * width + origin.x + x) * 4;
            pixels[to] = sprite[from]!;
            pixels[to + 1] = sprite[from + 1]!;
            pixels[to + 2] = sprite[from + 2]!;
            pixels[to + 3] = sprite[from + 3]!;
          }
        }
      }
    }
  }
  return { width, height, pixels };
}
