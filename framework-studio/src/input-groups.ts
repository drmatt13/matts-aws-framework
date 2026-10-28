import type { ModelEdge, ModelResource } from "../shared/model";

/**
 * A catalog group is a plain object of inputs and secrets, such as `resources.langgraph`.
 * It owns no AWS resource: each entry keeps its own environment variable, value, absence
 * and consumers. The map draws the outermost group as one building, so these helpers read
 * the group through its entries, nested groups included.
 */

/** The outermost catalog group holding a resource, if it is declared inside one. */
export function inputGroupOf(resource: ModelResource, resources: ReadonlyMap<string, ModelResource>): ModelResource | undefined {
  let group: ModelResource | undefined;
  for (let current = resource.parent ? resources.get(resource.parent) : undefined, depth = 0; current && depth < 8; current = current.parent ? resources.get(current.parent) : undefined, depth += 1) {
    if (current.kind === "group") group = current;
  }
  return group;
}

/** Whether an id is the group itself or anything declared inside it. */
export const withinGroup = (group: string, id: string): boolean => id === group || id.startsWith(`${group}.`);

/** Every input and secret the group holds, nested groups included, in declaration order. */
export function groupEntries(group: ModelResource, resources: Iterable<ModelResource>): readonly ModelResource[] {
  return [...resources].filter((resource) => (resource.kind === "input" || resource.kind === "secret") && withinGroup(group.id, resource.id) && resource.id !== group.id);
}

/** "4 inputs", "1 secret", "3 inputs and 1 secret". */
export function entryCount(entries: readonly ModelResource[]): string {
  const inputs = entries.filter((entry) => entry.kind === "input").length;
  const secrets = entries.length - inputs;
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  return [inputs ? plural(inputs, "input") : "", secrets ? plural(secrets, "secret") : ""].filter(Boolean).join(" and ") || "No entries";
}

/** "a", "a and b", "a, b and c", bounded with a remaining count. */
export function nameList(names: readonly string[], limit = 4): string {
  const shown = names.length > limit ? [...names.slice(0, limit), `${names.length - limit} more`] : names;
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** How the group's entries meet the rest of the application, read from the member edges. */
export interface GroupUse {
  /** Workloads that read an entry, with the entries each one reads. */
  readonly readers: readonly { readonly id: string; readonly entries: readonly string[] }[];
  /** Client variables, conditional workloads and other destinations an entry feeds. */
  readonly feeds: readonly { readonly id: string; readonly relation: ModelEdge["relation"]; readonly entries: readonly string[] }[];
}

export function groupUse(group: ModelResource, edges: readonly ModelEdge[]): GroupUse {
  const readers = new Map<string, Set<string>>();
  const feeds = new Map<string, { relation: ModelEdge["relation"]; entries: Set<string> }>();
  for (const edge of edges) {
    if ((edge.relation === "env" || edge.relation === "secret") && withinGroup(group.id, edge.to) && !withinGroup(group.id, edge.from)) {
      readers.set(edge.from, (readers.get(edge.from) ?? new Set()).add(edge.to));
    } else if ((edge.relation === "maps" || edge.relation === "deployWhen") && withinGroup(group.id, edge.from) && !withinGroup(group.id, edge.to)) {
      const feed = feeds.get(edge.to) ?? { relation: edge.relation, entries: new Set<string>() };
      feeds.set(edge.to, { ...feed, entries: feed.entries.add(edge.from) });
    }
  }
  return {
    readers: [...readers].map(([id, entries]) => ({ id, entries: [...entries] })),
    feeds: [...feeds].map(([id, feed]) => ({ id, relation: feed.relation, entries: [...feed.entries] })),
  };
}
