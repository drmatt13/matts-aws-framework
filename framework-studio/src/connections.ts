import { drawnAs } from "./drawn-as";
import { CDK_ENVIRONMENT_ID } from "../shared/deployment-inputs";
import type { Mode, ModeModel, ModelEdge, Snapshot } from "../shared/model";
import { availabilityBadge, connectionDisabledEndpoints, type Availability, type DeploymentBadgeKind } from "./deployment";
import { CATEGORY_LABEL, edgeCategory, indexModel, type EdgeCategory, type ModelIndex } from "./lookup";

export function edgeAvailability(edge: ModelEdge, models: Snapshot["models"], indexes?: Readonly<Record<Mode, ModelIndex>>): Availability {
  const enabled = (mode: Mode) => {
    const version = models[mode].edges.find((candidate) => candidate.id === edge.id);
    return !!version && connectionDisabledEndpoints(indexes?.[mode] ?? indexModel(models[mode]), mode, version).length === 0;
  };
  return { dev: enabled("dev"), prod: enabled("prod") };
}

/** Group by meaning, never by a display title or the incidental underlying CDK relation. */
export function connectionType(edge: Pick<ModelEdge, "relation" | "permissionContext">): string {
  const kind = edge.permissionContext?.kind;
  return kind === "subscription" ? kind : kind === "trigger-dlq" || kind === "failure" ? "failure-delivery" : edge.relation;
}

export interface ConnectionMember {
  readonly edge: ModelEdge;
  /** Physical relationships retained when one input joins its development and production sources. */
  readonly sourceIds?: readonly string[];
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
  /** Every relationship category in the union topology, independent of the styling representative. */
  readonly categories: readonly EdgeCategory[];
  readonly availability: Availability;
  readonly badge?: DeploymentBadgeKind;
  readonly otherLens?: Mode;
  readonly enabledInLens?: boolean;
  readonly mode?: Mode;
}

export const connectionHasSource = (connection: Pick<ConnectionGroup, "members">, id: string): boolean =>
  connection.members.some(member => member.edge.id === id || member.sourceIds?.includes(id));

/** Bundle only the same relationship type between visible nodes, across both graphs. */
export function aggregateConnections(model: ModeModel, layoutModels: readonly ModeModel[] = [model]): readonly ConnectionGroup[] {
  const models = [model, ...layoutModels.filter((other) => other.mode !== model.mode)];
  const indexes = new Map(models.map((item) => [item.mode, indexModel(item)]));
  const representatives = Object.assign({}, ...models.map(drawnAs)) as Readonly<Record<string, string>>;
  const members = new Map<string, Partial<Record<Mode, ModelEdge>>>();
  for (const item of models) for (const edge of item.edges) {
    const file = indexes.get(item.mode)!.resources.get(edge.from)?.deploymentFile;
    const combined = edge.relation === "supplies" && !!file && representatives[edge.from] === CDK_ENVIRONMENT_ID;
    // Both raw graphs retain both files as source evidence. A logical member takes each
    // physical file only from its own graph, keeping requirements and availability independent.
    if (combined && item.mode !== file.mode && indexes.has(file.mode)) continue;
    const key = combined ? JSON.stringify([CDK_ENVIRONMENT_ID, edge.to, edge.label]) : edge.id;
    const versions = members.get(key) ?? {};
    versions[combined ? file.mode : item.mode] = edge;
    members.set(key, versions);
  }
  const groups = new Map<string, { from: string; to: string; type: string; members: ConnectionMember[] }>();
  for (const versions of members.values()) {
    const edge = versions[model.mode] ?? versions.dev ?? versions.prod!;
    const from = representatives[edge.from] ?? edge.from;
    const to = representatives[edge.to] ?? edge.to;
    if (from === to) continue;
    const type = connectionType(edge);
    const key = JSON.stringify([from, to, type]);
    const group = groups.get(key) ?? { from, to, type, members: [] };
    const enabled = (mode: Mode) => {
      const version = versions[mode], index = indexes.get(mode);
      return !!version && !!index && connectionDisabledEndpoints(index, mode, version).length === 0;
    };
    group.members.push({ edge, models: versions,
      ...(from === CDK_ENVIRONMENT_ID ? { sourceIds: [...new Set(Object.values(versions).map(version => version.id))].sort() } : {}),
      availability: { dev: enabled("dev"), prod: enabled("prod") } });
    groups.set(key, group);
  }
  return [...groups.values()].map(({ from, to, type, members }): ConnectionGroup => {
    const order = (member: ConnectionMember) => member.sourceIds ? JSON.stringify([member.edge.to, member.edge.label]) : member.edge.id;
    members.sort((a, b) => order(a).localeCompare(order(b)));
    // Keep missing-input and permission evidence first; scene styling considers every member separately.
    const priority = (member: ConnectionMember) => (member.models[model.mode] ? 0 : 10) +
      (member.edge.inputRequirement?.status === "missing" ? 0 : member.edge.relation === "grant" || member.edge.relation === "secret" ? 1 : 2);
    const edge = [...members].sort((a, b) => priority(a) - priority(b))[0]!.edge;
    const availability = { dev: members.some((item) => item.availability.dev), prod: members.some((item) => item.availability.prod) };
    const otherLens = members.some((item) => item.models[model.mode]) ? undefined : models.find((item) => item.mode !== model.mode)?.mode;
    const presentCategories = new Set(members.flatMap((member) => Object.values(member.models).map(edgeCategory)));
    const categories = (Object.keys(CATEGORY_LABEL) as EdgeCategory[]).filter((category) => presentCategories.has(category));
    return { id: members.length === 1 && from !== CDK_ENVIRONMENT_ID ? edge.id : `connection:${encodeURIComponent(from)}:${encodeURIComponent(to)}:${type}`,
      from, to, edge, members, categories, availability, mode: model.mode, enabledInLens: availability[model.mode], badge: availabilityBadge(availability), ...(otherLens ? { otherLens } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export const missingConnectionInput = (connection: Pick<ConnectionGroup, "members" | "mode">): boolean => {
  const own = connection.mode && connection.members.some(member => member.models[connection.mode!]);
  return connection.members.some(member => (own ? member.models[connection.mode!] : member.edge)?.inputRequirement?.status === "missing");
};

export function connectionLabel(connection: ConnectionGroup): string {
  return [connection.members.length > 1 ? String(connection.members.length) : undefined,
    connection.badge === "dev" ? "Dev" : connection.badge === "prod" ? "Prod" : connection.badge === "off" ? "Off" : undefined].filter(Boolean).join(" · ");
}

