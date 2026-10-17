import type { Region } from "./build";

const COLUMN_GAP = 6;
const ISLAND_GAP = 5;

/** Measured isometric bounds in the screen-aligned grid frame, not fixed positions. */
export interface IslandFootprint {
  readonly id: string;
  readonly title: string;
  readonly region: Region;
  readonly size: number;
}
export interface IslandPosition { readonly id: string; readonly left: number; readonly top: number }

/** Leave room for a neighbouring island's screen-space title at overview zoom. */
export function titleRoom(title: string): number {
  const READ_ZOOM = 0.45;
  return Math.ceil((32 + (14 + title.length * 6.5) / READ_ZOOM) / 32);
}

interface Block {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly members: readonly IslandPosition[];
}
interface Row { readonly blocks: { readonly block: Block; readonly left: number }[]; width: number; height: number }
const blockOf = (island: IslandFootprint): Block => ({ title: island.title, width: island.size, height: island.size, members: [{ id: island.id, left: 0, top: 0 }] });
function packRows(blocks: readonly Block[], width: number): Row[] {
  const rows: Row[] = [];
  for (const block of blocks) {
    const row = rows.at(-1);
    const left = row ? row.width + titleRoom(block.title) : 0;
    if (row && left + block.width <= width) {
      row.blocks.push({ block, left }); row.width = left + block.width; row.height = Math.max(row.height, block.height);
    } else rows.push({ blocks: [{ block, left: 0 }], width: block.width, height: block.height });
  }
  return rows;
}
const rowWidth = (rows: readonly Row[]) => Math.max(0, ...rows.map((row) => row.width));
const rowHeight = (rows: readonly Row[]) => rows.reduce((sum, row) => sum + row.height, 0) + ISLAND_GAP * Math.max(0, rows.length - 1);
const widest = (blocks: readonly Block[]) => Math.max(0, ...blocks.map((block) => block.width));
const joinedWidth = (blocks: readonly Block[]) => blocks.reduce((sum, block, at) => sum + block.width + (at ? titleRoom(block.title) : 0), 0);

/** The existing row packer chooses a compact network grid from actual footprints.
 * Network identities and input order never determine a special fixed VPC slot. */
function networkRows(blocks: readonly Block[]): Row[] {
  if (!blocks.length) return [];
  const widths = new Set([widest(blocks)]);
  for (let at = 1; at <= blocks.length; at++) widths.add(Math.max(widest(blocks), joinedWidth(blocks.slice(0, at))));
  let best: Row[] = [];
  let bestScore = Infinity;
  const area = blocks.reduce((sum, block) => sum + block.width * block.height, 0);
  for (const width of [...widths].sort((a, b) => a - b)) {
    const rows = packRows(blocks, width);
    const w = rowWidth(rows), h = rowHeight(rows);
    // sx projects twice as wide as sy. Prefer a monitor-shaped, dense cluster.
    const score = Math.abs(Math.log((2 * w / h) / (16 / 9))) + 0.1 * (1 - area / (w * h));
    if (score < bestScore) { best = rows; bestScore = score; }
  }
  return best;
}

/** Semantic placement preferences over the same measured footprint/row packing.
 * Recomputed for every scene; no saved coordinates or model/config mutations. */
export function layoutIslands(islands: readonly IslandFootprint[]): readonly IslandPosition[] {
  const lowerOrder = ["island:agentcore", "island:orchestration", "island:local", "island:stacks"];
  const lower = lowerOrder.flatMap((id) => islands.filter((island) => island.id === id)).map(blockOf);
  const environment = islands.find((island) => island.id === "island:environment");
  const inputs = islands.find((island) => island.id === "island:inputs");
  const compute = islands.filter((island) => island.region === "compute").map(blockOf);
  const networks = islands.filter((island) => island.region === "network").sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(blockOf);
  const entry = islands.filter((island) => !lowerOrder.includes(island.id) && island.region !== "compute" && island.region !== "network" && island !== environment).map(blockOf);
  if (environment && inputs) {
    const index = entry.findIndex((block) => block.members[0]?.id === inputs.id);
    const height = Math.max(environment.size, inputs.size);
    // A paired row reserves the inputs title between the file and input boundaries.
    entry[index] = { title: environment.title, width: environment.size + titleRoom(inputs.title) + inputs.size, height,
      members: [{ id: environment.id, left: 0, top: (height - environment.size) / 2 }, { id: inputs.id, left: environment.size + titleRoom(inputs.title), top: (height - inputs.size) / 2 }] };
  } else if (environment) entry.push(blockOf(environment));

  const network = networkRows(networks);
  const rightWidth = Math.max(widest(compute), rowWidth(network));
  const leftWidth = widest(entry);
  const gap = Math.max(COLUMN_GAP, ...[...compute, ...networks].map((block) => titleRoom(block.title)));
  const naturalWidth = leftWidth + (leftWidth && rightWidth ? gap : 0) + rightWidth;
  const mainWidth = Math.max(naturalWidth, Math.min(joinedWidth(lower), Math.ceil(naturalWidth * 1.5)));
  const rightLeft = mainWidth - rightWidth;
  const computeRows = packRows(compute, rightWidth);
  const computeHeight = rowHeight(computeRows);
  const networkTop = computeHeight + (compute.length && networks.length ? ISLAND_GAP : 0);
  const rightHeight = networkTop + rowHeight(network);
  const entryRows = packRows(entry, leftWidth);
  const leftHeight = rowHeight(entryRows);
  const positions: IslandPosition[] = [];
  const placeRows = (rows: readonly Row[], left: number, width: number, top: number) => {
    let y = top;
    for (const row of rows) {
      const rowLeft = left + (width - row.width) / 2;
      for (const { block, left: offset } of row.blocks) for (const member of block.members) positions.push({ id: member.id, left: rowLeft + offset + member.left, top: y + (row.height - block.height) / 2 + member.top });
      y += row.height + ISLAND_GAP;
    }
  };
  // Place compute first so the scene builder can retain connection-based node ordering.
  placeRows(computeRows, rightLeft, rightWidth, 0);
  placeRows(network, rightLeft, rightWidth, networkTop);
  placeRows(entryRows, 0, leftWidth, Math.max(0, (rightHeight - leftHeight) / 2));
  const lowerWidth = Math.max(mainWidth, widest(lower));
  placeRows(packRows(lower, lowerWidth), (mainWidth - lowerWidth) / 2, lowerWidth, Math.max(rightHeight, leftHeight) + ISLAND_GAP * 2);
  return positions;
}
