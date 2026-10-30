import type { ModelResource, ModeModel } from "./model";
import { gatewaysOf } from "./gateways";
import { networkFixtureIds } from "./descriptions";

/** Ownership follows declared stack parents, independently of availability or file existence. */
export function isFrameworkManagedResource(resource: ModelResource, resources?: ReadonlyMap<string, ModelResource>): boolean {
  const visited = new Set<string>();
  let current: ModelResource | undefined = resource;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.frameworkManaged || current.frameworkStack || current.deploymentFile) return true;
    current = current.parent ? resources?.get(current.parent) : undefined;
  }
  return false;
}

/** Route wiring is generated; workload implementations, inputs, secrets and client mappings are application-owned. */
export function frameworkManagedIds(model: ModeModel): ReadonlySet<string> {
  const resources = new Map(model.resources.map(resource => [resource.id, resource]));
  return new Set([
    ...model.resources.filter(resource => isFrameworkManagedResource(resource, resources)).map(resource => resource.id),
    ...gatewaysOf(model).map(gateway => gateway.id),
    ...model.routes.map(route => route.id),
    ...(model.localServices ?? []).map(service => service.id),
    ...(model.networks ?? []).flatMap(networkFixtureIds),
  ]);
}
