import type { ModeModel } from "../../shared/model";

/** Retain an absent declaration's known type without making it present in this mode. */
export function withCatalogContext(model: ModeModel, other: ModeModel): ModeModel {
  const peers = new Map(other.resources.map(resource => [resource.id, resource]));
  return { ...model, resources: model.resources.map(resource => {
    const peer = peers.get(resource.id);
    return resource.absent && peer && !peer.absent && peer.kind !== "stack" ? { ...peer, absent: true } : resource;
  }) };
}
