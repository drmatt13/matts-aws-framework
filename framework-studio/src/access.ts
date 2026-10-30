import type { DraftEdit } from "../shared/api";
import { grantOptions } from "../shared/grants";
import type { ModeModel, ModelEdge, ModelTarget, SourceIndex } from "../shared/model";
import type { ConnectionAuthorization } from "../shared/permissions";
import { ICONS, resourceIcon, targetIcon, type IconKey } from "./icons";
import { indexModel, titleOf, ROLE_LABEL, type ModelIndex } from "./lookup";

export type ConnectionEdit = Extract<DraftEdit, { kind: "connection" }>;

export interface AccessDestination {
  /** Absent for policies/principals that do not have a graph entity. */
  readonly id?: string;
  readonly title: string;
  readonly icon: IconKey;
  readonly subtitle?: string;
}

export interface AccessEntry {
  /** Stable across source modes; authorization state is deliberately excluded. */
  readonly id: string;
  readonly connection?: string;
  readonly edge?: ModelEdge;
  /** Contains only the grants belonging to this side of the relationship. */
  readonly authorization: ConnectionAuthorization;
  readonly destination: AccessDestination;
  readonly operation: string;
  /** A bounded source edit, still subject to the normal reviewed writer checks. */
  readonly remove?: ConnectionEdit;
}

export function accessDestination(id: string, model: ModeModel, index: ModelIndex = indexModel(model)): AccessDestination {
  const target = index.targets.get(id);
  if (target) return { id, title: titleOf(index, id), icon: targetIcon(target), subtitle: ROLE_LABEL[target.role] };
  const gateway = index.gateways.get(id);
  if (gateway) return { id, title: titleOf(index, id), icon: "gateway", subtitle: "API Gateway" };
  const route = index.routes.get(id);
  if (route && route.kind !== "agent") {
    return { id: route.kind === "webSocket" ? "gateway:websocket" : "gateway:http", title: route.kind === "webSocket" ? "WebSocket API" : "HTTP API", icon: "gateway", subtitle: route.browserPath ?? route.path };
  }
  const local = index.localServices.get(id);
  if (local) return { id, title: titleOf(index, id), icon: "postgres", subtitle: "Local database" };
  const resource = index.resources.get(id);
  if (resource) {
    const icon = resource.frameworkManaged === "database" ? "database" : resourceIcon(resource);
    return { id, title: titleOf(index, id), icon, subtitle: ICONS[icon][1] };
  }
  // Some source-only permission scopes do not produce graph resources.
  return { title: id, icon: "construct" };
}

function declaredTrue(target: ModelTarget, edge: ModelEdge, field: "database" | "userPool", model: ModeModel, source: SourceIndex): boolean {
  const entity = source.entities[target.ref];
  if (!entity) return false;
  const fact = model.fields[target.ref]?.find(item => item.path.length === 1 && item.path[0] === field);
  const editability = fact && source.editability[target.ref]?.[fact.field];
  if (fact?.authored === true && editability?.kind === "literal" && editability.text.trim() === "true") return true;
  const setting = edge.bindingSetting;
  return setting?.field === field && setting.value === true && setting.source.file === entity.value.file &&
    setting.source.start >= entity.value.start && setting.source.end <= entity.value.end;
}

/** Never derive a removal from a display label, IAM action list, or arrow direction alone. */
export function removalForConnection(target: ModelTarget, edge: ModelEdge, model: ModeModel, source?: SourceIndex): ConnectionEdit | undefined {
  if (target.kind === "workflow" || edge.from !== target.ref || edge.provenance === "source" || !source?.entities[target.ref]) return;
  const base = { kind: "connection", target: target.ref, enabled: false } as const;
  const destination = model.targets.find(item => item.ref === edge.to);
  if (edge.provenance === "declared") {
    if (edge.relation === "runsTask" && destination?.kind === "task" ||
        edge.relation === "startsWorkflow" && destination?.kind === "workflow" ||
        edge.relation === "invokesAgent" && destination?.kind === "agent") {
      return { ...base, connection: edge.relation as "runsTask" | "startsWorkflow" | "invokesAgent", destination: edge.to };
    }
    if (edge.relation === "usesTool" && target.kind === "agent" && destination?.role === "tool") return { ...base, connection: "tool", destination: edge.to };
    if (edge.relation === "grant" && edge.permissionContext?.kind === "native") {
      const context = edge.permissionContext;
      const types = source.triggerCapabilities?.find(item => item.resource === edge.to)?.canonicalTypes ?? [];
      const option = grantOptions(types).find(item => item.method === context.method);
      if (!option || !model.resources.some(item => item.id === edge.to)) return;
      const args = context.arguments;
      // The writer distinguishes no argument from a nonempty literal scope. An
      // explicit empty string, multiple arguments or computed values are source-owned.
      if (args.length > 1 || args.length === 1 && (!option.scope || typeof args[0] !== "string" || !args[0] || args[0].length > 256 || /[\r\n\0]/.test(args[0]))) return;
      const duplicates = model.edges.filter(item => item.from === target.ref && item.to === edge.to && item.relation === "grant" &&
        item.permissionContext?.kind === "native" && item.permissionContext.method === context.method &&
        JSON.stringify(item.permissionContext.arguments) === JSON.stringify(args));
      if (duplicates.length > 1) return;
      return { ...base, connection: "grant", destination: edge.to, grant: option.method, scope: args.length ? args[0] as string : "" };
    }
    if (edge.relation === "env" || edge.relation === "secret") {
      const resource = model.resources.find(item => item.id === edge.to);
      if (!resource || !["input", "secret"].includes(resource.kind) || !/^[A-Z][A-Z0-9_]*$/.test(edge.label)) return;
      const environment = target.environment.find(item => item.name === edge.label);
      const startup = target.secrets.find(item => item.name === edge.label);
      const container = target.kind === "service" || target.kind === "task";
      const matches = edge.relation === "secret"
        ? container && resource.kind === "secret" && startup?.resource === edge.to
        : !(container && resource.kind === "secret") && !environment?.via && environment?.value.kind === "reference" && environment.value.resource === edge.to;
      if (matches) return { ...base, connection: "resource", destination: edge.to, variable: edge.label };
    }
  }
  if (edge.relation === "database" && target.kind !== "agent" && edge.permissionContext?.kind === "database" &&
      edge.permissionContext.connection === "application" && declaredTrue(target, edge, "database", model, source)) return { ...base, connection: "database" };
  if (edge.relation === "env" && !["agent", "tool"].includes(target.role) && target.userPool &&
      target.environment.some(item => item.name === edge.label && item.via === "userPool" && item.value.kind === "reference" && item.value.resource === edge.to) &&
      declaredTrue(target, edge, "userPool", model, source)) return { ...base, connection: "userPool" };
  return;
}

export function accessOperation(authorization: ConnectionAuthorization, edge?: ModelEdge, source?: SourceIndex): string {
  if (authorization.grants.some(grant => grant.actions?.includes("states:SendTaskSuccess")) &&
      authorization.grants.every(grant => grant.actions?.every(action => action.startsWith("states:SendTask")))) return "Complete workflow callback";
  if (edge?.permissionContext?.kind === "native") {
    const method = edge.permissionContext.method;
    const types = source?.triggerCapabilities?.find(item => item.resource === edge.to)?.canonicalTypes ?? [];
    return grantOptions(types).find(item => item.method === method)?.label ?? authorization.operation;
  }
  switch (edge?.relation) {
    case "routes": case "authorizes": return "Invoke function";
    case "runsTask": return "Run task";
    case "startsWorkflow": return "Start workflow";
    case "invokesAgent": return "Invoke agent";
    case "usesTool": return "Call tool";
    case "database": return edge.permissionContext?.kind === "database" && edge.permissionContext.connection === "direct" ? "Connect directly to PostgreSQL" : "Connect to PostgreSQL";
    case "localReplay": return "Capture local replay";
    case "manageConnections": return "Send WebSocket replies";
    default: return authorization.operation;
  }
}

/** Ownership follows the receiving IAM principal, including pull triggers and
 * callback grants that run opposite the graph arrow. */
export function targetAccess(target: ModelTarget, model: ModeModel, source?: SourceIndex): { owned: AccessEntry[]; incoming: AccessEntry[] } {
  const index = indexModel(model), edges = new Map(model.edges.map(edge => [edge.id, edge]));
  const result: { owned: AccessEntry[]; incoming: AccessEntry[] } = { owned: [], incoming: [] };
  for (const item of target.authorizations ?? []) {
    const edge = item.connection ? edges.get(item.connection) : undefined;
    const authorization = item.authorization;
    const id = item.connection ?? `permission:${target.ref}:${authorization.kind}:${authorization.operation}:${JSON.stringify(authorization.grants)}`;
    const append = (side: "owned" | "incoming", selected: ConnectionAuthorization) => {
      const peer = side === "incoming" ? selected.grants.find(grant => grant.principalEntity && grant.principalEntity !== target.ref)?.principalEntity : undefined;
      const other = peer ?? (edge ? edge.from === target.ref ? edge.to : edge.from : undefined);
      const destination = other ? accessDestination(other, model, index) : {
        title: side === "owned" ? "IAM policy" : selected.grants[0]?.principal ?? "Event source",
        icon: "construct" as const,
        ...(side === "owned" ? { subtitle: selected.grants.map(grant => grant.scope).join(", ") } : {}),
      };
      result[side].push({ id, ...(item.connection ? { connection: item.connection } : {}), ...(edge ? { edge } : {}),
        authorization: selected, destination, operation: accessOperation(selected, edge, source),
        ...(side === "owned" && edge ? { remove: removalForConnection(target, edge, model, source) } : {}),
      });
    };
    if (authorization.kind === "iam") {
      const owned = authorization.grants.filter(grant => grant.principalEntity === target.ref);
      const incoming = authorization.grants.filter(grant => grant.principalEntity !== target.ref);
      if (owned.length) append("owned", { ...authorization, grants: owned });
      if (incoming.length) append("incoming", { ...authorization, grants: incoming });
    } else {
      append(edge && edge.from !== target.ref ? "incoming" : "owned", authorization);
    }
  }
  return result;
}
