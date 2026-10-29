import { IDENTITY_TAGS } from "@repo/framework/deploy";
import * as cdk from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import {
  getFrameworkTargets, isCdkResource, isCdkResourceGroup, isResourceReference,
  mergeTags, sameTags, validateTags, validateRdsTags,
  type DeclarationTags, type FrameworkConfig,
} from "@repo/framework/config";
import { INFRASTRUCTURE_OWNER, type InfrastructureOwner } from "../../../scripts/infrastructure-types";

/**
 * Reuse the synth inventory's explicit ownership marks. References never add
 * ownership: the producer's construct subtree is the only propagation boundary.
 */
export function applyFrameworkTags(root: IConstruct, config: FrameworkConfig, identity?: Readonly<Record<string, string>>): void {
  const targets = new Map(getFrameworkTargets(config).map(target => [target.reference as string, target.tags]));
  const catalog = (path: string): unknown => path.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, config.resources);
  const resolve = (entity: string): DeclarationTags => {
    if (targets.has(entity)) return targets.get(entity)!;
    if (entity.startsWith("island:vpc:")) return validateTags(config.networks?.find(network => network.id === entity.slice("island:vpc:".length))?.tags, entity);
    if (!entity.startsWith("resource:")) return validateTags(undefined);
    const path = entity.slice("resource:".length);
    const reference = catalog(path);
    if (!isCdkResource(reference) && !isCdkResourceGroup(reference) && !isResourceReference(reference)) return validateTags(undefined);
    const tags = reference.effectiveTags ?? reference.tags;
    // defineDatabase is the explicit primary database owner. Its own tags
    // override its public catalog member, which overrides its stack.
    return config.database?.resource.path.join(".") === path ? mergeTags(entity, tags, config.database.tags) : validateTags(tags, entity);
  };
  const own = new Map<IConstruct, DeclarationTags>();
  for (const node of root.node.findAll()) {
    const claims = node.node.metadata.filter(entry => entry.type === INFRASTRUCTURE_OWNER).map(entry => entry.data as InfrastructureOwner).filter(owner => !owner.external);
    if (!claims.length) continue;
    const first = claims[0]!; const tags = resolve(first.entity);
    for (const next of claims.slice(1)) {
      if (!sameTags(tags, resolve(next.entity))) throw new Error(`${node.node.path} is owned by ${first.entity} and ${next.entity} with different tags. A shared native resource must have one explicit tag owner, or aliases with identical tags.`);
    }
    own.set(node, tags);
  }
  // A stack without a catalog entry is tagged by its class's stacks entry,
  // as the outermost layer, exactly as a catalog stack's tags are.
  for (const stack of root.node.findAll().filter(cdk.Stack.isStack)) {
    const declared = config.stacks?.[stack.constructor.name];
    if (!declared) continue;
    if (own.has(stack)) throw new Error(`${stack.node.path} is linked to the resource catalog, so stacks.${stack.constructor.name} cannot tag it. Declare its tags on that resource.stack() entry.`);
    own.set(stack, validateTags(declared.tags, `stacks.${stack.constructor.name}.tags`));
  }
  for (const node of root.node.findAll()) {
    if (!cdk.CfnResource.isCfnResource(node) && !cdk.Stack.isStack(node)) continue;
    const manager = cdk.TagManager.of(node);
    if (!manager) continue; // Logical values and unsupported AWS types have no tag manager.
    const layers: DeclarationTags[] = [];
    for (let parent: IConstruct | undefined = node; parent; parent = parent.node.scope) {
      const tags = own.get(parent); if (tags) layers.unshift(tags);
    }
    const tags = mergeTags(node.node.path, ...layers);
    if (cdk.CfnResource.isCfnResource(node) && node.cfnResourceType.startsWith("AWS::RDS::")) {
      validateRdsTags(tags, node.node.path);
    }
    for (const [key, value] of Object.entries(tags)) manager.setTag(key, value, 500);
    node.node.addValidation({ validate: () => {
      const rendered: unknown = manager.renderTags();
      // TagManager's L1 render uses lower-case key/value while synthesized
      // CloudFormation uses Key/Value. Its canonical map works for both L1
      // tag encodings (array and map) and includes completed tag aspects.
      const actual: Readonly<Record<string, string>> = manager.tagValues();
      const problems: string[] = [];
      for (const [key, value] of Object.entries(tags)) if (actual[key] !== value) problems.push(`${node.node.path}: native CDK tagging overrides declaration tag ${JSON.stringify(key)}. Remove the conflicting native tag or its higher-priority aspect so the declaration remains authoritative.`);
      if (identity) for (const [key, value] of Object.entries(identity)) {
        if ((cdk.Stack.isStack(node) || Object.prototype.hasOwnProperty.call(actual, key)) && actual[key] !== value) problems.push(`${node.node.path}: native tag ${JSON.stringify(key)} conflicts with protected framework deployment ownership. Remove the native override; deployment identity is managed by the framework.`);
      }
      const count = Array.isArray(rendered) ? rendered.length : rendered && typeof rendered === "object" ? Object.keys(rendered).length : 0;
      const present = new Set(Object.keys(actual));
      const ownershipSlots = Object.values(IDENTITY_TAGS).filter(key => !present.has(key)).length;
      if (count + ownershipSlots > 50) problems.push(`${node.node.path} has ${count} native/declaration tags plus ${ownershipSlots} reserved deployment tags; AWS permits 50. Remove tags from the owning declaration.`);
      return problems;
    } });
  }
}
