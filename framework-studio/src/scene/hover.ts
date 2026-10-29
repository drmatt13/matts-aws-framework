import type { Lanes, Mode, ModeModel, ModelResource, ModelRoute, ModelTarget } from "../../shared/model";
import { titleOf, type ModelIndex } from "../lookup";
import { entryCount, groupEntries, groupUse, nameList } from "../input-groups";
import type { SceneNode } from "./build";
import type { Availability } from "../deployment";

/**
 * What a hover label says about an item beyond its authored description: where
 * each environment deploys it, and whether the framework (rather than the
 * application's own declarations) owns it. Both environments are always read,
 * so the answer does not change with the Dev/Prod switch.
 */
export interface HoverPlace {
  readonly env: Mode;
  readonly where: string;
}

export interface HoverFacts {
  /** Every environment that deploys it, development first. An environment not listed is not deployed there. */
  readonly places: readonly HoverPlace[];
  /** A specific reason nothing deploys it ("Not added to the CDK app"); only when `places` is empty. */
  readonly notDeployed?: string;
  readonly frameworkManaged: boolean;
}

export type ModelIndexes = Readonly<Record<Mode, ModelIndex>>;

export interface HoverEntryDetail {
  readonly text: string;
  readonly kind: "detail" | "permission";
  readonly tone?: "warning";
  readonly modes?: readonly Mode[];
}

export interface HoverEntry {
  readonly id: string;
  readonly label: string;
  readonly availability: Availability;
  readonly note?: string;
  readonly details?: readonly HoverEntryDetail[];
}

const detailKey = (detail: HoverEntryDetail): string => JSON.stringify([detail.text, detail.kind, detail.tone]);

/** "Dev" only distinguishes a fact from another environment that holds the same entry. */
function qualified(detail: HoverEntryDetail, modes: readonly Mode[], held: readonly Mode[]): HoverEntryDetail {
  const { modes: _modes, ...rest } = detail;
  return held.every(mode => modes.includes(mode)) ? rest : { ...rest, modes };
}

/** A value's presence in one graph, without ever projecting the value or its default. An absent entry's unlit pill already says so. */
function groupEntryDetail(entry: ModelResource | undefined, mode: Mode, index: ModelIndex): HoverEntryDetail | undefined {
  const detail = (text: string, warning = false): HoverEntryDetail => ({ text, kind: "detail", ...(warning ? { tone: "warning" as const } : {}), modes: [mode] });
  if (!entry || entry.absent) return undefined;
  const requirement = entry.inputRequirement;
  switch (requirement?.status) {
    case "configured": return undefined;
    case "default": return detail("Uses the declaration default.");
    case "optional": return detail("Not set · optional.");
    case "missing": {
      const name = requirement.name || entry.fromEnv || entry.path.at(-1)!;
      const file = requirement.file || index.resources.get(`envfile:${mode}`)?.deploymentFile?.path || `cdk-app/.env.${mode}`;
      return detail(`Required value missing: ${name} · ${file}`, true);
    }
    case "unknown":
    default: return detail("Value status unavailable.");
  }
}

function combineEntryDetails(details: readonly HoverEntryDetail[]): readonly HoverEntryDetail[] {
  const combined = new Map<string, HoverEntryDetail>();
  for (const detail of details) {
    const previous = combined.get(detailKey(detail));
    combined.set(detailKey(detail), previous ? { ...detail, modes: MODES.filter(mode => previous.modes?.includes(mode) || detail.modes?.includes(mode)) } : detail);
  }
  return [...combined.values()];
}

function rawGroupHoverEntries(group: ModelResource, indexes: ModelIndexes): readonly HoverEntry[] {
  const entries = new Map(MODES.flatMap(mode => groupEntries(group, indexes[mode].resources.values()).map(entry => [entry.id, entry] as const)));
  return [...entries.values()].map(entry => {
    const dev = indexes.dev.resources.get(entry.id), prod = indexes.prod.resources.get(entry.id);
    const details = combineEntryDetails(MODES.flatMap(mode => {
      const detail = groupEntryDetail(indexes[mode].resources.get(entry.id), mode, indexes[mode]);
      return detail ? [detail] : [];
    }));
    return { id: entry.id, label: entry.path.slice(group.path.length).join("."), availability: { dev: !!dev && !dev.absent, prod: !!prod && !prod.absent }, ...(details.length ? { details } : {}) };
  });
}

/** Shared status belongs once below the list, rather than under every parameter name. An entry a graph does not declare has no status there. */
function commonGroupDetails(entries: readonly HoverEntry[]): readonly HoverEntryDetail[] {
  const candidates = new Map(entries.flatMap(entry => entry.details ?? []).map(detail => [detailKey(detail), detail]));
  return [...candidates.values()].flatMap(detail => {
    const modes = MODES.filter(mode => entries.some(entry => entry.availability[mode])
      && entries.every(entry => !entry.availability[mode] || entry.details?.some(candidate => detailKey(candidate) === detailKey(detail) && candidate.modes?.includes(mode))));
    return modes.length ? [{ ...detail, modes }] : [];
  });
}

/** Entries retain individual declarations and exceptional value states across both graphs. */
export function groupHoverEntries(group: ModelResource, indexes: ModelIndexes): readonly HoverEntry[] {
  const entries = rawGroupHoverEntries(group, indexes);
  const common = commonGroupDetails(entries);
  return entries.map(entry => {
    const held = MODES.filter(mode => entry.availability[mode]);
    const details = (entry.details ?? []).flatMap(detail => {
      const shared = common.find(candidate => detailKey(candidate) === detailKey(detail));
      const modes = detail.modes?.filter(mode => !shared?.modes?.includes(mode));
      return modes?.length ? [qualified(detail, modes, held)] : [];
    });
    const { details: _details, ...identity } = entry;
    return { ...identity, ...(details.length ? { details } : {}) };
  });
}

const GROUP_STATUS: Readonly<Record<string, string>> = {
  "Uses the declaration default.": "Every entry uses its declaration default.",
  "Not set · optional.": "Every entry is unset and optional.",
  "Value status unavailable.": "Value status is unavailable for every entry.",
};

export function groupHoverDetails(group: ModelResource, indexes: ModelIndexes): readonly HoverEntryDetail[] {
  const entries = rawGroupHoverEntries(group, indexes);
  const held = MODES.filter(mode => entries.some(entry => entry.availability[mode]));
  return commonGroupDetails(entries).map(detail => qualified({ ...detail, text: GROUP_STATUS[detail.text] ?? detail.text }, detail.modes ?? [], held));
}

const MODES: readonly Mode[] = ["dev", "prod"];
const NOT_DEPLOYED = "Not deployed";

/** One environment's answer: where it deploys, or why it does not. */
type Where = { readonly where: string } | { readonly reason: string };

function targetHome(target: ModelTarget): string {
  const placement = target.placement;
  const subnet = placement.kind === "vpc" ? ` · ${placement.subnet} subnet` : "";
  switch (target.compute.kind) {
    case "lambda": return `AWS Lambda${placement.kind === "outside" ? " · outside the VPC" : subnet}`;
    case "container": return `Amazon ECS${subnet}`;
    case "workflow": return "AWS Step Functions";
    case "agent": return "AgentCore Runtime";
  }
}

function routeHome(route: ModelRoute, target: ModelTarget): string {
  if (route.kind === "webSocket") return "API Gateway WebSocket API";
  return route.kind === "agent" ? targetHome(target) : "API Gateway HTTP API";
}

/** Development runs on your machine, in AWS, or both; production only runs in AWS. */
function laneWhere(lanes: Lanes, mode: Mode, home: string): Where {
  const places = [mode === "dev" && lanes.local ? "Your machine" : undefined, (mode === "dev" ? lanes.dev : lanes.prod) ? home : undefined].filter(Boolean);
  return places.length ? { where: places.join(" + ") } : { reason: NOT_DEPLOYED };
}

/** A framework stack or the configured database, or a field of one. */
function frameworkManaged(resource: ModelResource, index: ModelIndex): boolean {
  let current: ModelResource | undefined = resource;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current.frameworkManaged || current.frameworkStack) return true;
    current = current.parent ? index.resources.get(current.parent) : undefined;
  }
  return false;
}

function resourceWhere(resource: ModelResource | undefined, index: ModelIndex, mode: Mode): Where {
  if (!resource || resource.absent) return { reason: NOT_DEPLOYED };
  if (resource.deploymentFile) return { where: `Local file · ${resource.deploymentFile.path}` };
  if (resource.clientEnvironment) return { where: `Client environment mappings · ${resource.clientEnvironment.path}` };
  switch (resource.kind) {
    case "stack":
      return resource.stackUsage?.status === "unreferenced" ? { reason: "Not added to the CDK app" } : { where: "CloudFormation stack" };
    case "member": {
      if (resource.frameworkManaged === "database") return { where: `Amazon RDS${resource.networkPlacement ? ` · ${resource.networkPlacement} subnet` : ""}` };
      const parent = resource.parent ? index.resources.get(resource.parent) : undefined;
      return { where: parent ? `In stack ${parent.path.join(".")}` : "CloudFormation stack member" };
    }
    case "secret": return { where: "AWS Secrets Manager" };
    case "construct": return { where: "CDK construct" };
    // An input is supplied wherever its graph declares it, from the file that environment's synthesis reads.
    case "input": return { where: `CDK input · ${index.resources.get(`envfile:${mode}`)?.deploymentFile?.path ?? "environment file"}` };
    // A group owns nothing itself: it is wherever its graph holds any of its entries.
    case "group": {
      const entries = groupEntries(resource, index.resources.values());
      const held = entries.filter((entry) => !entry.absent);
      const count = held.length === entries.length ? entryCount(held) : `${held.length} of ${entryCount(entries)}`;
      return { where: `${count} · ${index.resources.get(`envfile:${mode}`)?.deploymentFile?.path ?? "environment file"}` };
    }
    default: return { reason: "Not deployed" };
  }
}

function combine(results: Readonly<Record<Mode, Where>>, managed: boolean): HoverFacts {
  const places = MODES.flatMap((env): HoverPlace[] => { const result = results[env]; return "where" in result ? [{ env, where: result.where }] : []; });
  if (places.length) return { places, frameworkManaged: managed };
  // Two dark pills already say "not deployed"; only a more specific reason is worth a line.
  const reason = MODES.map((env) => (results[env] as { readonly reason: string }).reason).find((candidate) => candidate !== NOT_DEPLOYED);
  return { places, ...(reason ? { notDeployed: reason } : {}), frameworkManaged: managed };
}

const eachMode = (answer: (mode: Mode) => Where): Readonly<Record<Mode, Where>> => ({ dev: answer("dev"), prod: answer("prod") });

export function nodeHoverFacts(node: SceneNode, indexes: ModelIndexes): HoverFacts {
  switch (node.entity) {
    case "gateway":
      return combine(eachMode(mode => {
        const gateway = indexes[mode].gateways.get(node.id);
        return gateway ? laneWhere(gateway.lanes, mode, `API Gateway ${gateway.title}`) : { reason: NOT_DEPLOYED };
      }), true);
    case "target":
      return combine(eachMode((mode) => {
        const target = indexes[mode].targets.get(node.id);
        return target ? laneWhere(target.lanes, mode, targetHome(target)) : { reason: NOT_DEPLOYED };
      }), false);
    case "route":
      return combine(eachMode((mode) => {
        const route = indexes[mode].routes.get(node.id);
        const target = route && indexes[mode].targets.get(route.target);
        return route && target ? laneWhere(target.lanes, mode, routeHome(route, target)) : { reason: NOT_DEPLOYED };
      }), false);
    case "resource":
      return combine(eachMode((mode) => resourceWhere(indexes[mode].resources.get(node.id), indexes[mode], mode)),
        MODES.some((mode) => { const resource = indexes[mode].resources.get(node.id); return !!resource && frameworkManaged(resource, indexes[mode]); }));
    case "local":
      return combine(eachMode((mode) => {
        const service = indexes[mode].localServices.get(node.id);
        if (mode === "prod") return { reason: NOT_DEPLOYED };
        return service?.enabled ? { where: "Your machine · Docker Compose" } : { reason: "Docker Compose service, not enabled" };
      }), true);
  }
}

/**
 * What an input group's building stands for, in the viewed graph: its entries, the workloads
 * that read them and what they feed. Missing required values are notes, never values.
 */
export function groupHoverLines(group: ModelResource, model: ModeModel, index: ModelIndex): { readonly lines: readonly string[]; readonly notes: readonly string[] } {
  const entries = groupEntries(group, model.resources);
  const use = groupUse(group, model.edges);
  const name = (id: string) => index.resources.get(id)?.path.at(-1) ?? id;
  const lines = [
    entries.length ? undefined : "Holds no inputs or secrets.",
    use.readers.length ? `Read by ${nameList(use.readers.map((reader) => titleOf(index, reader.id)))}.` : undefined,
    ...use.feeds.filter((feed) => feed.relation === "maps").map((feed) => `Maps ${nameList(feed.entries.map(name))} into ${titleOf(index, feed.id)}.`),
    use.feeds.some((feed) => feed.relation === "deployWhen") ? `Controls deployment of ${nameList(use.feeds.filter((feed) => feed.relation === "deployWhen").map((feed) => titleOf(index, feed.id)))}.` : undefined,
    !use.readers.length && !use.feeds.length && entries.some((entry) => !entry.absent) ? "No workload reads these entries yet." : undefined,
  ].filter((line): line is string => !!line);
  return { lines, notes: [] };
}

/** Gateways and endpoints exist only because the framework builds the declared network, and only a production deployment builds it. */
export function propHoverFacts(models: Readonly<Record<Mode, ModeModel>>, id: string): HoverFacts {
  return models.prod.networks?.find(network => id.startsWith(`prop:vpc:${network.id}:`))?.builtInProd
    ? { places: [{ env: "prod", where: "AWS VPC" }], frameworkManaged: true }
    : { places: [], notDeployed: "Not built: nothing is placed in the VPC", frameworkManaged: true };
}
