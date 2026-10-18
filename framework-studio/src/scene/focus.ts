import type { ModeModel } from "../../shared/model";
import type { Scene } from "./build";

export interface SearchMatches {
  readonly nodes: ReadonlySet<string>;
  readonly props: ReadonlySet<string>;
  readonly islands: ReadonlySet<string>;
}

/** Searches authored identities and displayed metadata, never resolved input/secret values. */
export function searchScene(scene: Scene, model: ModeModel, query: string): SearchMatches | undefined {
  const terms = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return undefined;
  const matches = (...parts: unknown[]) => {
    const text = parts.flat(Infinity).filter((part) => typeof part === "string").join(" ").normalize("NFKC").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  };
  const nodes = new Set<string>();
  const props = new Set<string>();
  const islands = new Set<string>();
  const bands = new Set<string>();
  const wholeIslands = new Set<string>();
  for (const island of scene.islands) {
    if (matches(island.id, island.title, island.region)) wholeIslands.add(island.id);
    for (const band of island.bands) if (matches(band.id, band.title)) bands.add(band.id);
  }
  const targets = new Map(model.targets.map((target) => [target.ref, target]));
  const routes = new Map(model.routes.map((route) => [route.id, route]));
  const resources = new Map(model.resources.map((resource) => [resource.id, resource]));
  const resourceText = (id: string) => {
    const resource = resources.get(id);
    return resource ? [resource.id, resource.path, resource.kind, resource.fromEnv, resource.typeText, resource.stackClass, resource.stackOutputs?.map((output) => [output.name, output.envName]), resource.deploymentFile?.path, resource.deploymentFile?.entries.map((entry) => entry.name)] : [];
  };
  for (const node of scene.nodes) {
    const target = targets.get(node.id);
    const route = routes.get(node.id);
    if (wholeIslands.has(node.island) || bands.has(node.band) || matches(
      node.id, node.label, node.kindLabel, node.icon, node.roleIcon,
      target && [target.title, target.id, target.role, target.directory, target.constructId, target.environment.map((entry) => entry.name)],
      route && [route.path, route.browserPath, route.target], resourceText(node.id),
    )) nodes.add(node.id);
  }
  // Stack fields are represented by their owning stack on the map.
  for (const [id, representative] of Object.entries(scene.representatives)) if (matches(resourceText(id))) nodes.add(representative);
  for (const prop of scene.props) {
    const island = scene.islands.find((island) => island.bands.some((band) => prop.serves.includes(band.id)));
    if (island && (wholeIslands.has(island.id) || prop.serves.some((band) => bands.has(band)) || matches(prop.id, prop.label, prop.caption, prop.icon, prop.roleIcon))) {
      props.add(prop.id); islands.add(island.id);
    }
  }
  for (const node of scene.nodes) if (nodes.has(node.id)) islands.add(node.island);
  for (const id of wholeIslands) islands.add(id);
  return { nodes, props, islands };
}

export interface LandscapeFocus extends SearchMatches { readonly kind: "all" | "selection" | "search" }

/** Selection temporarily takes precedence; clearing it uses the unchanged search matches again. */
export function landscapeFocus(scene: Scene, selected?: string, matches?: SearchMatches): LandscapeFocus {
  if (!selected) return matches ? { kind: "search", ...matches } : {
    kind: "all", nodes: new Set(scene.nodes.map((node) => node.id)), props: new Set(scene.props.map((prop) => prop.id)), islands: new Set(scene.islands.map((island) => island.id)),
  };
  const nodes = new Set([selected]);
  const selectedEdge = scene.edges.find((edge) => edge.edge.id === selected);
  if (selectedEdge) { nodes.add(selectedEdge.from); nodes.add(selectedEdge.to); }
  for (const node of scene.nodes) if (node.island === selected) nodes.add(node.id);
  for (const edge of scene.edges) {
    if (edge.from === selected) nodes.add(edge.to);
    if (edge.to === selected) nodes.add(edge.from);
  }
  const islands = new Set(scene.nodes.filter((node) => nodes.has(node.id)).map((node) => node.island));
  if (selected.startsWith("island:")) islands.add(selected);
  const band = scene.nodes.find((node) => node.id === selected)?.band;
  const island = scene.islands.find((island) => island.id === selected);
  const props = new Set(scene.props.filter((prop) => (band && prop.serves.includes(band)) || island?.bands.some((band) => prop.serves.includes(band.id))).map((prop) => prop.id));
  const fixture = scene.props.find((prop) => prop.id === selected);
  if (fixture) {
    props.add(fixture.id);
    for (const island of scene.islands) if (island.bands.some((band) => fixture.serves.includes(band.id))) islands.add(island.id);
  }
  return { kind: "selection", nodes, props, islands };
}

export const SEARCH_FADE = 0.08;
export function searchOpacity(focus: LandscapeFocus, kind: keyof SearchMatches, id: string): number {
  return focus.kind === "search" && !focus[kind].has(id) ? SEARCH_FADE : 1;
}
