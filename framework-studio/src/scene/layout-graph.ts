import type { ModeModel, ModelEdge, Relation } from "../../shared/model";
import type { Point } from "./camera";

export interface LayoutAnchor extends Point {
  readonly id: string;
  readonly island: string;
  /** Attachment elevation in grid steps, including the plaque's height. */
  readonly h?: number;
}
export interface LayoutLink { readonly id: string; readonly from: LayoutAnchor; readonly to: LayoutAnchor; readonly weight: number; readonly category: string }
export interface IslandLink { readonly from: string; readonly to: string; readonly weight: number }
export interface LayoutGraph { readonly links: readonly LayoutLink[]; readonly islands: readonly IslandLink[]; readonly signature: string }
const weights: Record<Relation, number> = { deployWhen: 2, contains: 1, routes: 3, authorizes: 2, env: 2, supplies: 2, maps: 2, secret: 2, grant: 1.5, database: 3, localReplay: 2, trigger: 3, runsTask: 3, startsWorkflow: 3, invokesAgent: 3, usesTool: 3, step: 3, integration: 2, completesCallback: 2, cdk: 1 };
const reverse = new Set<Relation>(["deployWhen", "env", "secret", "grant", "database", "localReplay", "integration"]);

/** Union both deployment topologies. Mode visibility and presentation are not topology. */
export function topologyEdges(models: readonly ModeModel[]): readonly ModelEdge[] {
  return [...new Map(models.flatMap((model) => model.edges).map((edge) => [edge.id, edge])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function extractLayoutGraph(anchors: readonly LayoutAnchor[], edges: readonly ModelEdge[], representatives: Readonly<Record<string, string>> = {}): LayoutGraph {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const links = new Map<string, LayoutLink>();
  const pairs = new Map<string, IslandLink>();
  for (const edge of [...edges].sort((a, b) => a.id < b.id ? -1 : 1)) {
    const from = byId.get(representatives[edge.from] ?? edge.from), to = byId.get(representatives[edge.to] ?? edge.to);
    if (!from || !to || from.island === to.island) continue;
    const key = `${from.id}>${to.id}:${edge.relation}`;
    const weight = weights[edge.relation];
    links.set(key, { id: key, from, to, category: edge.relation, weight: (links.get(key)?.weight ?? 0) + weight });
    const source = reverse.has(edge.relation) ? to.island : from.island;
    const target = reverse.has(edge.relation) ? from.island : to.island;
    const pair = `${source}>${target}`;
    pairs.set(pair, { from: source, to: target, weight: (pairs.get(pair)?.weight ?? 0) + weight });
  }
  const values = [...links.values()];
  return { links: values, islands: [...pairs.values()], signature: JSON.stringify(values.map((link) => [link.id, link.weight, link.from.x, link.from.y, link.to.x, link.to.y])) };
}
