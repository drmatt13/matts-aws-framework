import type { ModeModel } from "../shared/model";
import { gatewaysOf } from "../shared/gateways";

/** The one mapping shared by layout, links, selection, search and filtering. */
export function drawnAs(model: ModeModel): Readonly<Record<string, string>> {
  const representatives: Record<string, string> = {};
  for (const gateway of gatewaysOf(model)) {
    representatives[gateway.stackResource] = gateway.id;
    for (const resource of model.resources) if (resource.stackClass === (gateway.protocol === "http" ? "HttpApiGatewayStack" : "WebSocketApiStack")) representatives[resource.id] = gateway.id;
  }
  for (const route of model.routes) representatives[route.id] = route.kind === "agent" ? route.target : route.kind === "webSocket" ? "gateway:websocket" : "gateway:http";
  for (const resource of model.resources) if (resource.kind === "member" && resource.parent && !(resource.networkId && resource.networkPlacement)) representatives[resource.id] = representatives[resource.parent] ?? resource.parent;
  return representatives;
}
