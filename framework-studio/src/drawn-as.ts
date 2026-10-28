import type { ModeModel } from "../shared/model";
import { gatewaysOf } from "../shared/gateways";
import { inputGroupOf } from "./input-groups";

/** The one mapping shared by layout, links, selection, search and filtering. */
export function drawnAs(model: ModeModel): Readonly<Record<string, string>> {
  const representatives: Record<string, string> = {};
  for (const gateway of gatewaysOf(model)) {
    representatives[gateway.stackResource] = gateway.id;
    for (const resource of model.resources) if (resource.stackClass === (gateway.protocol === "http" ? "HttpApiGatewayStack" : "WebSocketApiStack")) representatives[resource.id] = gateway.id;
  }
  for (const route of model.routes) representatives[route.id] = route.kind === "agent" ? route.target : route.kind === "webSocket" ? "gateway:websocket" : "gateway:http";
  // A catalog group is one building: its inputs, secrets and nested groups stand in it, as fields stand in a stack.
  const resources = new Map(model.resources.map((resource) => [resource.id, resource]));
  for (const resource of model.resources) {
    const group = inputGroupOf(resource, resources);
    if (group) representatives[resource.id] = group.id;
  }
  for (const resource of model.resources) if (resource.kind === "member" && resource.parent && !(resource.networkId && resource.networkPlacement)) representatives[resource.id] = representatives[resource.parent] ?? resource.parent;
  return representatives;
}
