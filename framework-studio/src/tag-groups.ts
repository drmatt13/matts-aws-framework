import type { ModeModel, TagFacts } from "../shared/model";
import { environments } from "./deployment";
import { indexModel, type ModelIndex } from "./lookup";

/** Brackets cannot occur in an authored tag key, so this view option cannot collide with metadata. */
export const UNTAGGED_FILTER = "[untagged]";

function entityTagFacts(model: ModeModel, id: string, index?: ModelIndex): TagFacts | undefined {
  if ((index ? index.localServices.has(id) : model.localServices?.some(service => service.id === id)) && model.managedDatabase) return model.tagging?.[model.managedDatabase.resource] ?? model.tagging?.[`database:${model.managedDatabase.id}`];
  return model.tagging?.[id];
}
export const entityTagValue = (model: ModeModel, id: string, key: string, index?: ModelIndex): string | null => entityTagFacts(model, id, index)?.effective[key] ?? null;
/** Plain parameters, file metadata and framework-owned projections do not need application tags. */
function isUntaggedCandidate(id: string, index: ModelIndex): boolean {
  if (index.localServices.has(id)) return false;
  const resource = index.resources.get(id);
  if (!resource) return true;
  const owner = resource.parent ? index.resources.get(resource.parent) : undefined;
  return resource.kind !== "input" && resource.kind !== "envFile" && resource.kind !== "group"
    && !resource.frameworkStack && !resource.frameworkManaged && !owner?.frameworkStack && !owner?.frameworkManaged;
}
export const matchesTagFilter = (model: ModeModel, id: string, key: string, value: string | null, index: ModelIndex): boolean => key === UNTAGGED_FILTER
  ? isUntaggedCandidate(id, index) && Object.keys(entityTagFacts(model, id, index)?.effective ?? {}).length === 0
  : (value !== null || isUntaggedCandidate(id, index)) && entityTagValue(model, id, key, index) === value;
export const tagValueLabel = (value: string | null): string => value === null ? "Untagged" : value === "" ? "(empty value)" : value === "Untagged" ? '"Untagged" (value)' : value;
export const compareTagValues = (a: string | null, b: string | null): number => a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
export function tagKeys(model: ModeModel, index = indexModel(model)): readonly string[] {
  return [...new Set(tagMembers(model).flatMap(member => Object.keys(entityTagFacts(model, member.id, index)?.effective ?? {})))].sort();
}

export interface TagMember { readonly id: string; readonly label: string; readonly kind: string; readonly placement?: string }
export interface TagGroup { readonly value: string | null; readonly members: readonly TagMember[] }

/** Count active-mode entities, even when union topology keeps their inactive counterparts on the map. */
function tagMembers(model: ModeModel): readonly TagMember[] {
  const targets = model.targets.filter(target => environments(target.lanes)[model.mode]);
  const targetIds = new Set(targets.map(target => target.ref));
  return [
    ...targets.map(target => ({ id: target.ref, label: target.title, kind: target.role, placement: target.placement.kind === "vpc" ? `${target.placement.networkId} · ${target.placement.subnet}` : target.placement.kind === "managed" ? "AWS managed" : "Outside VPCs" })),
    ...model.routes.filter(route => targetIds.has(route.target)).map(route => ({ id: route.id, label: route.browserPath ?? route.path, kind: `${route.kind} route` })),
    ...model.resources.filter(resource => resource.kind !== "group" && !resource.absent).map(resource => ({ id: resource.id, label: resource.path.join("."), kind: resource.kind, placement: resource.networkId ? `${resource.networkId} · ${resource.networkPlacement ?? "VPC"}` : undefined })),
    ...(model.localServices ?? []).filter(service => service.enabled).map(service => ({ id: service.id, label: service.title, kind: "local service" })),
    ...(model.networks ?? []).filter(network => model.mode === "prod" && network.builtInProd).map(network => ({ id: `island:vpc:${network.id}`, label: network.name ?? network.id, kind: "VPC" })),
  ];
}

/** Logical membership crosses kinds/files; each active entity occurs once. */
export function tagGroups(model: ModeModel, key: string, index = indexModel(model)): readonly TagGroup[] {
  if (key === UNTAGGED_FILTER) return [{ value: null, members: tagMembers(model).filter(member => matchesTagFilter(model, member.id, key, null, index)).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)) }];
  const groups = new Map<string | null, TagMember[]>();
  for (const member of tagMembers(model)) {
    const value = entityTagValue(model, member.id, key, index);
    if (value === null && !isUntaggedCandidate(member.id, index)) continue;
    const members = groups.get(value);
    if (members) members.push(member); else groups.set(value, [member]);
  }
  return [...groups].sort(([a], [b]) => compareTagValues(a, b)).map(([value, members]) => ({ value, members: members.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)) }));
}
