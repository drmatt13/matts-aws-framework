import type { ModeModel, ModelEdge, ModelResource } from "../shared/model";
import { RELATION_CATEGORY, ROLE_GROUPS, type EdgeCategory } from "./lookup";

/**
 * The architecture board's geometry, computed rather than measured.
 *
 * Three columns read left to right as a request travels: the public names a
 * caller uses, the compute that answers, and the catalog that compute reads.
 * Every row has a fixed height, so the layout is a pure function of the model
 * and a node keeps its place until the model moves it.
 *
 * Order is chosen to keep lines short: compute keeps its declaration order
 * within each group, routes follow their targets, and catalog entries sit
 * beside the average height of what reads them.
 */

export type NodeShape = "route" | "target" | "stack" | "member" | "resource" | "local";

export interface BoardNode {
  readonly id: string;
  readonly shape: NodeShape;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoardEdge {
  readonly edge: ModelEdge;
  readonly category: EdgeCategory;
  readonly path: string;
  readonly label: { readonly x: number; readonly y: number };
}

export interface BoardLayout {
  readonly nodes: readonly BoardNode[];
  readonly titles: readonly { readonly text: string; readonly x: number; readonly y: number; readonly kind: "column" | "group" }[];
  readonly edges: readonly BoardEdge[];
  readonly width: number;
  readonly height: number;
}

const COLUMNS = [
  { title: "Entry points", x: 0, width: 230 },
  { title: "Compute", x: 360, width: 280 },
  { title: "Catalog", x: 860, width: 330 },
] as const;

const TOP = 44;
const GROUP_TITLE = 22;
const GROUP_GAP = 22;
const GAP = 8;
const HEIGHT: Readonly<Record<NodeShape, number>> = { route: 30, target: 48, stack: 30, member: 30, resource: 30, local: 48 };

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.POSITIVE_INFINITY : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function layoutBoard(model: ModeModel): BoardLayout {
  const nodes: BoardNode[] = [];
  const titles: BoardLayout["titles"][number][] = COLUMNS.map((column) => ({ text: column.title, x: column.x, y: 0, kind: "column" }));
  const position = new Map<string, BoardNode>();
  const place = (id: string, shape: NodeShape, column: number, y: number, indent = 0): number => {
    const node = { id, shape, x: COLUMNS[column]!.x + indent, y, width: COLUMNS[column]!.width - indent, height: HEIGHT[shape] };
    nodes.push(node);
    position.set(id, node);
    return y + node.height + GAP;
  };

  // Compute, in groups, in declaration order.
  let y = TOP;
  for (const group of ROLE_GROUPS) {
    const members = model.targets.filter((target) => group.roles.includes(target.role));
    if (members.length === 0) continue;
    titles.push({ text: group.title, x: COLUMNS[1].x, y, kind: "group" });
    y += GROUP_TITLE;
    for (const target of members) y = place(target.ref, "target", 1, y);
    y += GROUP_GAP;
  }
  const computeHeight = y;
  const centre = (id: string) => {
    const node = position.get(id);
    return node ? node.y + node.height / 2 : Number.POSITIVE_INFINITY;
  };

  // Routes, in groups, each beside its target.
  y = TOP;
  const routeGroups: readonly [string, string][] = [
    ["http", "HTTP routes"],
    ["service", "Service mounts"],
    ["webSocket", "WebSocket route keys"],
    ["agent", "Agent routes"],
  ];
  for (const [kind, title] of routeGroups) {
    const routes = model.routes.filter((route) => route.kind === kind).sort((a, b) => centre(a.target) - centre(b.target));
    if (routes.length === 0) continue;
    titles.push({ text: title, x: COLUMNS[0].x, y, kind: "group" });
    y += GROUP_TITLE;
    for (const route of routes) y = place(route.id, "route", 0, y);
    y += GROUP_GAP;
  }
  const routeHeight = y;

  // The catalog, each top-level entry beside what reads it.
  const readers = new Map<string, number[]>();
  for (const edge of model.edges) {
    if (!edge.to.startsWith("resource:")) continue;
    const at = centre(edge.from);
    if (!Number.isFinite(at)) continue;
    for (const id of [edge.to, `resource:${edge.to.slice("resource:".length).split(".")[0]}`]) {
      readers.set(id, [...(readers.get(id) ?? []), at]);
    }
  }
  const children = new Map<string, ModelResource[]>();
  for (const resource of model.resources) {
    if (resource.parent) children.set(resource.parent, [...(children.get(resource.parent) ?? []), resource]);
  }
  const roots = model.resources
    .filter((resource) => !resource.parent)
    .map((resource, order) => ({ resource, order, at: mean(readers.get(resource.id) ?? []) }))
    .sort((a, b) => (a.at === b.at ? a.order - b.order : a.at - b.at));
  y = TOP;
  for (const { resource } of roots) {
    const members = (children.get(resource.id) ?? [])
      .map((member, order) => ({ member, order, at: mean(readers.get(member.id) ?? []) }))
      .sort((a, b) => (a.at === b.at ? a.order - b.order : a.at - b.at));
    if (members.length > 0) {
      y = place(resource.id, "stack", 2, y);
      for (const { member } of members) y = place(member.id, "member", 2, y, 18);
      y += GROUP_GAP - GAP;
    } else {
      y = place(resource.id, "resource", 2, y);
    }
  }
  if (model.localServices?.length) {
    y += GROUP_GAP;
    titles.push({ text: "Local development", x: COLUMNS[2].x, y, kind: "group" });
    y += GROUP_TITLE;
    for (const service of model.localServices) y = place(service.id, "local", 2, y);
  }
  const catalogHeight = y;

  // Edges, between the nodes that exist.
  const counts = new Map<string, number>();
  const edges: BoardEdge[] = [];
  for (const edge of model.edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (!from || !to) continue;
    const pair = `${edge.from}->${edge.to}`;
    const index = counts.get(pair) ?? 0;
    counts.set(pair, index + 1);
    const offset = index * 4;
    let x1: number, y1: number, x2: number, y2: number, c1x: number, c2x: number;
    if (from.x === to.x) {
      // Compute calling compute: an arc out to the right and back.
      x1 = from.x + from.width;
      x2 = to.x + to.width;
      y1 = from.y + from.height / 2 + offset;
      y2 = to.y + to.height / 2 + offset;
      const bulge = 34 + Math.min(Math.abs(y2 - y1) / 6, 80);
      c1x = x1 + bulge;
      c2x = x2 + bulge;
    } else if (from.x < to.x) {
      x1 = from.x + from.width;
      x2 = to.x;
      y1 = from.y + from.height / 2 + offset;
      y2 = to.y + to.height / 2 + offset;
      c1x = c2x = (x1 + x2) / 2;
    } else {
      x1 = from.x;
      x2 = to.x + to.width;
      y1 = from.y + from.height / 2 + offset;
      y2 = to.y + to.height / 2 + offset;
      c1x = c2x = (x1 + x2) / 2;
    }
    edges.push({
      edge,
      category: RELATION_CATEGORY[edge.relation],
      path: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
      label: { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + y2) / 2 },
    });
  }

  const last = COLUMNS[COLUMNS.length - 1]!;
  return {
    nodes,
    titles,
    edges,
    width: last.x + last.width,
    height: Math.max(computeHeight, routeHeight, catalogHeight),
  };
}
