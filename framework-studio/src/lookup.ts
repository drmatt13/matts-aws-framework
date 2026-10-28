import { drawnAs } from "./drawn-as";
import { gatewaysOf, type ModelGateway } from "../shared/gateways";
import type { ModeModel, ModelDefaults, ModelEdge, ModelResource, ModelRoute, ModelTarget, Relation, SourceLocation, TargetRole } from "../shared/model";
import type { LocalDatabase } from "../shared/database";

/** Lookups over one mode's model, built once per snapshot. */
export interface ModelIndex {
  readonly representatives: Readonly<Record<string, string>>;
  readonly gateways: ReadonlyMap<string, ModelGateway>;
  readonly defaults: ReadonlyMap<string, ModelDefaults>;
  readonly localServices: ReadonlyMap<string, LocalDatabase>;
  readonly targets: ReadonlyMap<string, ModelTarget>;
  readonly routes: ReadonlyMap<string, ModelRoute>;
  readonly resources: ReadonlyMap<string, ModelResource>;
  /** Every edge touching an entity, in either direction. */
  readonly edges: ReadonlyMap<string, readonly ModelEdge[]>;
}

export function indexModel(model: ModeModel): ModelIndex {
  const edges = new Map<string, ModelEdge[]>();
  const add = (id: string, edge: ModelEdge) => {
    const list = edges.get(id) ?? [];
    list.push(edge);
    edges.set(id, list);
  };
  for (const edge of model.edges) {
    add(edge.from, edge);
    if (edge.to !== edge.from) add(edge.to, edge);
  }
  return {
    representatives: drawnAs(model),
    gateways: new Map(gatewaysOf(model).map(gateway => [gateway.id, gateway])),
    defaults: new Map((model.defaults ?? []).map((group) => [group.ref, group])),
    localServices: new Map((model.localServices ?? []).map((service) => [service.id, service])),
    targets: new Map(model.targets.map((target) => [target.ref, target])),
    routes: new Map(model.routes.map((route) => [route.id, route])),
    resources: new Map(model.resources.map((resource) => [resource.id, resource])),
    edges,
  };
}

export const ROLE_LABEL: Readonly<Record<TargetRole, string>> = {
  http: "HTTP Lambda",
  webSocket: "WebSocket Lambda",
  webSocketAuthorizer: "WebSocket authorizer",
  event: "Event Lambda",
  tool: "Agent tool",
  agent: "AgentCore agent",
  service: "Container service",
  task: "Container task",
  workflow: "Workflow",
};

/** How compute is grouped on the board. */
export const ROLE_GROUPS: readonly { readonly title: string; readonly roles: readonly TargetRole[] }[] = [
  { title: "HTTP Lambdas", roles: ["http"] },
  { title: "WebSocket Lambdas", roles: ["webSocket", "webSocketAuthorizer"] },
  { title: "Event Lambdas", roles: ["event"] },
  { title: "Agents", roles: ["agent"] },
  { title: "Agent tools", roles: ["tool"] },
  { title: "Container services", roles: ["service"] },
  { title: "Container tasks", roles: ["task"] },
  { title: "Workflows", roles: ["workflow"] },
];

export type EdgeCategory = "routes" | "inputs" | "interactions" | "structure";

export const CATEGORY_LABEL: Readonly<Record<EdgeCategory, string>> = {
  routes: "Routes and events",
  inputs: "Environment and secrets",
  interactions: "Resource interactions",
  structure: "Resource structure",
};

export const CATEGORY_DESCRIPTION: Readonly<Record<EdgeCategory, string>> = {
  routes: "API routes, authorizers, event triggers, subscriptions and event delivery",
  inputs: "Input values, environment variables and secrets",
  interactions: "Resource grants, database access, workload calls, workflow steps and local replay",
  structure: "Resource ownership and references between constructs",
};

export const RELATION_CATEGORY: Readonly<Record<Relation, EdgeCategory>> = {
  deployWhen: "inputs",
  contains: "structure",
  routes: "routes",
  authorizes: "routes",
  env: "inputs",
  supplies: "inputs",
  maps: "inputs",
  secret: "inputs",
  grant: "interactions",
  database: "interactions",
  localReplay: "interactions",
  trigger: "routes",
  completesCallback: "interactions",
  manageConnections: "interactions",
  runsTask: "interactions",
  startsWorkflow: "interactions",
  invokesAgent: "interactions",
  usesTool: "interactions",
  step: "interactions",
  integration: "interactions",
  cdk: "structure",
};

/** Events describe delivery, even when represented by an underlying CDK reference or grant. */
export function isEventConnection(edge: Pick<ModelEdge, "relation" | "permissionContext">): boolean {
  const kind = edge.permissionContext?.kind;
  return edge.relation === "trigger" || kind === "trigger" || kind === "subscription" || kind === "trigger-dlq" || kind === "failure";
}

export function edgeCategory(edge: Pick<ModelEdge, "relation" | "permissionContext">): EdgeCategory {
  return isEventConnection(edge) ? "routes" : RELATION_CATEGORY[edge.relation];
}

/** The name a person reads for any entity id. */
export function titleOf(index: ModelIndex, id: string): string {
  const gateway = index.gateways.get(id);
  if (gateway) return gateway.title;
  const defaults = index.defaults.get(id);
  if (defaults) return `${defaults.title} defaults`;
  const localService = index.localServices.get(id);
  if (localService) return localService.title;
  const target = index.targets.get(id);
  if (target) return target.title;
  const route = index.routes.get(id);
  if (route) return route.browserPath ?? route.path;
  const resource = index.resources.get(id);
  if (resource) return resource.path.join(".");
  return id;
}

/** Connections need a type as well as a name: routes and handlers often share both. */
export function endpointLabel(index: ModelIndex, id: string): string {
  const title = titleOf(index, id);
  if (index.routes.has(id)) return `API: ${title}`;
  const target = index.targets.get(id);
  if (target) return `${target.role === "http" ? "HTTP" : target.role === "webSocket" ? "WebSocket" : ROLE_LABEL[target.role]}: ${title}`;
  if (index.localServices.has(id)) return `Database: ${title}`;
  if (index.defaults.has(id)) return `Defaults: ${title}`;
  const resource = index.resources.get(id);
  if (resource) {
    if (resource.kind === "member" && resource.frameworkManaged === "database") return `Database: ${title}`;
    const labels = { envFile: "Environment file", stack: "Stack", member: "Stack member", construct: "Construct", input: "Input", secret: "Secret", group: "Input group" };
    return `${labels[resource.kind]}: ${title}`;
  }
  return title;
}

/** An editor link that opens the declaration where it was written. */
export function editorLink(repositoryRoot: string, location: SourceLocation): string {
  const absolute = `${repositoryRoot.replaceAll("\\", "/")}/${location.file}`;
  return `vscode://file/${encodeURI(absolute)}:${location.line}:${location.column}`;
}

export function describeValue(value: string | number | boolean | null | undefined): string {
  return value === undefined ? "not written" : typeof value === "string" ? `"${value}"` : String(value);
}
