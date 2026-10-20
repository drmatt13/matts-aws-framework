import type { Mode, ModeModel, ModelEdge, Snapshot } from "../shared/model";
import { availabilityBadge, connectionDisabledEndpoints, type Availability, type DeploymentBadgeKind } from "./deployment";
import { indexModel } from "./lookup";

export function edgeAvailability(edge: ModelEdge, models: Snapshot["models"]): Availability {
  const enabled = (mode: Mode) => {
    const version = models[mode].edges.find((candidate) => candidate.id === edge.id);
    return !!version && connectionDisabledEndpoints(indexModel(models[mode]), mode, version).length === 0;
  };
  return { dev: enabled("dev"), prod: enabled("prod") };
}

export interface ConnectionMember {
  readonly edge: ModelEdge;
  /** Retain each graph's evidence and requirement status, including differences under the same id. */
  readonly models: Readonly<Partial<Record<Mode, ModelEdge>>>;
  readonly availability: Availability;
}

export interface ConnectionGroup {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Representative for styling; original relationships remain in members. */
  readonly edge: ModelEdge;
  readonly members: readonly ConnectionMember[];
  readonly availability: Availability;
  readonly badge?: DeploymentBadgeKind;
  readonly otherLens?: Mode;
}

/** Group directed relationships by the nodes the landscape actually draws, across both graphs. */
export function aggregateConnections(model: ModeModel, layoutModels: readonly ModeModel[] = [model]): readonly ConnectionGroup[] {
  const models = [model, ...layoutModels.filter((other) => other.mode !== model.mode)];
  const indexes = new Map(models.map((item) => [item.mode, indexModel(item)]));
  const representatives = new Map(models.flatMap((item) => item.resources.flatMap((resource) =>
    resource.kind === "member" && resource.parent && !(resource.frameworkManaged && resource.networkPlacement) ? [[resource.id, resource.parent] as const] : [])));
  const members = new Map<string, Partial<Record<Mode, ModelEdge>>>();
  for (const item of models) for (const edge of item.edges) {
    const versions = members.get(edge.id) ?? {};
    versions[item.mode] = edge;
    members.set(edge.id, versions);
  }
  const groups = new Map<string, { from: string; to: string; members: ConnectionMember[] }>();
  for (const versions of members.values()) {
    const edge = versions[model.mode] ?? versions.dev ?? versions.prod!;
    const from = representatives.get(edge.from) ?? edge.from;
    const to = representatives.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    const group = groups.get(key) ?? { from, to, members: [] };
    const enabled = (mode: Mode) => {
      const version = versions[mode], index = indexes.get(mode);
      return !!version && !!index && connectionDisabledEndpoints(index, mode, version).length === 0;
    };
    group.members.push({ edge, models: versions, availability: { dev: enabled("dev"), prod: enabled("prod") } });
    groups.set(key, group);
  }
  return [...groups.values()].map(({ from, to, members }): ConnectionGroup => {
    members.sort((a, b) => a.edge.id.localeCompare(b.edge.id));
    // Missing inputs remain visible; permission/secret links retain their guarded style in mixed groups.
    const priority = (member: ConnectionMember) => (member.models[model.mode] ? 0 : 10) +
      (member.edge.inputRequirement?.status === "missing" ? 0 : member.edge.relation === "grant" || member.edge.relation === "secret" ? 1 : 2);
    const edge = [...members].sort((a, b) => priority(a) - priority(b))[0]!.edge;
    const availability = { dev: members.some((item) => item.availability.dev), prod: members.some((item) => item.availability.prod) };
    const otherLens = members.some((item) => item.models[model.mode]) ? undefined : models.find((item) => item.mode !== model.mode)?.mode;
    return { id: members.length === 1 ? edge.id : `connection:${encodeURIComponent(from)}:${encodeURIComponent(to)}`,
      from, to, edge, members, availability, badge: availabilityBadge(availability), ...(otherLens ? { otherLens } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export const missingConnectionInput = (connection: ConnectionGroup): boolean =>
  connection.members.some((member) => member.edge.inputRequirement?.status === "missing");

export function connectionLabel(connection: ConnectionGroup): string {
  return [connection.members.length > 1 ? String(connection.members.length) : undefined,
    connection.badge === "dev" ? "Dev" : connection.badge === "prod" ? "Prod" : connection.badge === "off" ? "Off" : undefined].filter(Boolean).join(" · ");
}

