import type { Lanes, Mode, ModeModel, ModelResource, ModelRoute, ModelTarget } from "../../shared/model";
import type { ModelIndex } from "../lookup";
import type { SceneNode } from "./build";

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
    case "group": return { where: "CDK input group" };
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
      }), false);
  }
}

/** Gateways and endpoints exist only because the framework builds the declared network, and only a production deployment builds it. */
export function propHoverFacts(models: Readonly<Record<Mode, ModeModel>>): HoverFacts {
  return models.prod.network?.builtInProd
    ? { places: [{ env: "prod", where: "AWS VPC" }], frameworkManaged: true }
    : { places: [], notDeployed: "Not built: nothing is placed in the VPC", frameworkManaged: true };
}
