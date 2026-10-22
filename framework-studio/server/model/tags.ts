import { isCdkResource, isCdkResourceGroup, isFrameworkDatabase, isResourceReference, type FrameworkConfig, type NormalizedTarget } from "@repo/framework/config";
import type { ModeModel, ModelRoute, TagFacts } from "../../shared/model";

type Tags = Readonly<Record<string, string>>;
interface Metadata { readonly tags?: Tags; readonly effectiveTags?: Tags; readonly memberTags?: Readonly<Record<string, Tags>> }

/** Metadata only. Never resolves a catalog reference or reads environment values. */
export function tagFacts(entity: string, authored: Tags = {}, aws: TagFacts["aws"], inherited?: { readonly entity: string; readonly tags: Tags }): TagFacts {
  const effective = { ...inherited?.tags, ...authored };
  return { authored: { ...authored }, effective, ...(inherited ? { inherited: { entity: inherited.entity, values: { ...inherited.tags } } } : {}),
    provenance: Object.fromEntries(Object.keys(effective).map(key => [key, { entity: Object.hasOwn(authored, key) ? entity : inherited!.entity, kind: Object.hasOwn(authored, key) ? "declared" : "inherited" }])), aws };
}

export const STACK_MEMBER_TAGGING: TagFacts["aws"] = { kind: "linked", note: "Applied only to taggable constructs owned by this stack. Imported resources and public string values keep metadata without AWS changes; native ownership is checked during synthesis." };

/** An absent placeholder has no builder options; the other graph can retain
 * that same declaration's authored metadata without making the resource present. */
export function withAbsentTagging(model: ModeModel, other: ModeModel): ModeModel {
  const tagging = { ...model.tagging };
  for (const resource of model.resources) {
    if (!resource.absent || !other.resources.some(item => item.id === resource.id && !item.absent)) continue;
    for (const [id, facts] of Object.entries(other.tagging ?? {})) if (id === resource.id || id.startsWith(`${resource.id}.`)) tagging[id] = facts;
  }
  if (model.managedDatabase) {
    const entity = `database:${model.managedDatabase.id}`, own = tagging[entity], counterpart = other.tagging?.[entity];
    if (own && counterpart?.inherited && model.resources.some(resource => resource.id === model.managedDatabase!.resource && resource.absent)) tagging[entity] = tagFacts(entity, own.authored, own.aws, { entity: counterpart.inherited.entity, tags: counterpart.inherited.values });
  }
  return { ...model, tagging };
}

export function projectTagging(config: FrameworkConfig, targets: readonly NormalizedTarget[], routes: readonly ModelRoute[]): Record<string, TagFacts> {
  const result: Record<string, TagFacts> = {};
  for (const target of targets) {
    result[target.reference] = tagFacts(target.reference, target.tags, { kind: "owned", note: "Applied to this workload's owned, taggable compute and supporting resources. Shared infrastructure keeps its producer's tags." });
  }
  for (const route of routes) result[route.id] = tagFacts(route.id, {}, { kind: "logical", note: "Routes have no independently taggable AWS resource. Tags follow the workload declaration." }, { entity: route.target, tags: result[route.target]?.effective ?? {} });
  for (const network of config.networks ?? []) {
    const entity = `island:vpc:${network.id}`;
    result[entity] = tagFacts(entity, (network as Metadata).tags, { kind: "owned", note: "Applied to owned, taggable VPC resources, subnets, gateways and endpoints when this network is built." });
  }
  if (isFrameworkDatabase(config.database)) {
    const entity = `database:${config.database.id}`;
    result[entity] = tagFacts(entity, (config.database as Metadata).tags, { kind: "owned", note: "Applied to the owned database and taggable database support resources. Local PostgreSQL has no AWS tagging capability." });
  }
  const visit = (group: Record<string, unknown>, prefix: readonly string[]): void => {
    for (const [name, entry] of Object.entries(group)) {
      const path = [...prefix, name], entity = `resource:${path.join(".")}`;
      if (isCdkResourceGroup(entry)) {
        const metadata = entry as Metadata;
        result[entity] = tagFacts(entity, metadata.tags, { kind: "owned", note: "Stack tags apply to its owned, taggable descendants. Public members inherit these tags and may override individual keys." });
        for (const [member, tags] of Object.entries(metadata.memberTags ?? {})) {
          const id = `${entity}.${member}`;
          result[id] = tagFacts(id, tags, STACK_MEMBER_TAGGING, { entity, tags: result[entity]!.effective });
        }
      } else if (isCdkResource(entry)) result[entity] = tagFacts(entity, (entry as Metadata).tags, { kind: "linked", note: "AWS tags apply only if the linked construct is owned by this application and supports tagging. Imported resources retain metadata without AWS changes; ownership is checked during synthesis." });
      else if (isResourceReference(entry)) result[entity] = tagFacts(entity, (entry as Metadata).tags, entry.kind === "secret"
        ? { kind: "owned", note: "Applied when the authored secret is provisioned by deploy:resources. Source editing never reads or writes its secret value." }
        : { kind: "logical", note: "Configuration values have no independently taggable AWS resource." });
      else if (entry && typeof entry === "object") {
        result[entity] = tagFacts(entity, {}, { kind: "logical", note: "Catalog namespaces group declarations; they do not own an AWS resource. Tag the individual entries." });
        visit(entry as Record<string, unknown>, path);
      }
    }
  };
  visit((config.resources ?? {}) as Record<string, unknown>, []);
  if (isFrameworkDatabase(config.database)) {
    const database = config.database, id = `resource:${database.resource.path.join(".")}`, owner = `resource:${database.resource.path.slice(0, -1).join(".")}`;
    const authored = (database.resource as Metadata).tags ?? {};
    const primary = tagFacts(id, authored, STACK_MEMBER_TAGGING, { entity: owner, tags: result[owner]?.effective ?? {} });
    const dedicated = result[`database:${database.id}`]!;
    result[`database:${database.id}`] = tagFacts(`database:${database.id}`, dedicated.authored, dedicated.aws, { entity: id, tags: primary.effective });
    result[id] = { ...primary, effective: { ...primary.effective, ...dedicated.effective }, provenance: { ...primary.provenance, ...Object.fromEntries(Object.keys(dedicated.effective).map(key => [key, { entity: `database:${database.id}`, kind: "inherited" as const }])) } };
  }
  return result;
}
