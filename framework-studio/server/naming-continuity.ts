import type { ModelEdge, Snapshot } from "../shared/model";
import { remapEntity } from "../shared/naming";
import { aggregateConnections } from "../src/connections";

/** Exact graph identities for a confirmed write. Source offsets and incidental
 * edge ordinals may change, so they never establish relationship correspondence. */
export function namingEntityRemap(before: Snapshot, after: Snapshot, resourceRemap: Readonly<Record<string, string>>): Record<string, string> {
  const result = { ...resourceRemap };
  const signature = (edge: ModelEdge, remap: Readonly<Record<string, string>>) => JSON.stringify([
    edge.relation, remapEntity(edge.from, remap), remapEntity(edge.to, remap), edge.label,
    edge.attachment ? remapEntity(edge.attachment, remap) : null, edge.provenance, edge.source?.file ?? null, edge.permissionContext ?? null,
  ]);
  const suggestions = new Map<string, Set<string>>();
  const suggest = (from: string, to: string) => {
    const values = suggestions.get(from) ?? new Set<string>();
    values.add(to); suggestions.set(from, values);
  };
  for (const mode of ["dev", "prod"] as const) {
    const candidates = new Map<string, ModelEdge[]>();
    const previousCounts = new Map<string, number>();
    for (const edge of before.models[mode].edges) {
      const key = signature(edge, resourceRemap);
      previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
    }
    for (const edge of after.models[mode].edges) {
      const key = signature(edge, {}), group = candidates.get(key) ?? [];
      group.push(edge); candidates.set(key, group);
    }
    for (const edge of before.models[mode].edges) {
      const key = signature(edge, resourceRemap), matching = candidates.get(key) ?? [];
      // An unchanged exact id is useful evidence even when equivalent parallel
      // relationships exist. Otherwise leave ambiguous wiring source-owned.
      const same = matching.find(candidate => candidate.id === edge.id);
      if (same) suggest(edge.id, same.id);
      else if (matching.length === 1 && previousCounts.get(key) === 1) suggest(edge.id, matching[0]!.id);
    }
  }
  const raw = new Map([...suggestions].flatMap(([from, values]) => values.size === 1 ? [[from, [...values][0]!] as const] : []));
  for (const [from, to] of raw) if (from !== to) result[from] = to;

  const previousGroups = new Map(Object.values(before.models).flatMap(model => aggregateConnections(model, Object.values(before.models))).map(group => [group.id, group]));
  const currentGroups = Object.values(after.models).flatMap(model => aggregateConnections(model, Object.values(after.models)));
  const groupsByMember = new Map<string, Set<string>>();
  for (const group of currentGroups) for (const member of group.members) {
    const ids = groupsByMember.get(member.edge.id) ?? new Set<string>();
    ids.add(group.id); groupsByMember.set(member.edge.id, ids);
  }
  for (const previous of previousGroups.values()) {
    const destinations = new Set(previous.members.flatMap(member => {
      const next = raw.get(member.edge.id);
      return next ? [...groupsByMember.get(next) ?? []] : [];
    }));
    // Surviving members must all land in one visible relationship. This also
    // covers one edge becoming a bundle, or a bundle retaining one edge.
    if (destinations.size === 1) {
      const next = [...destinations][0]!;
      if (next !== previous.id) result[previous.id] = next;
    }
  }
  return result;
}
