import type { WebSocketSection } from "../contracts";
import { resources } from "../resources";

/** WebSocket declarations. Tags describe concerns independently of this module. */
export const webSocket = {
  $connect: {
    directory: "/lambda_functions/websocket_functions/ws-connect-route",
    deploy: { when: { resource: resources.enableWebSocketApi, equals: "true" } },
    cloud: {
      constructId: "ConnectRouteFunction",
      outputs: { arn: { id: "ConnectRouteFunctionArn" } },
    },
    authorizer: {
      directory: "/lambda_functions/websocket_functions/ws-authorizer",
      deploy: { when: { resource: resources.enableWebSocketApi, equals: "true" } },
      userPool: true,
      cloud: {
        constructId: "AuthorizerFunction",
        outputs: { arn: { id: "AuthorizerFunctionArn" } },
      },
      tags: { area: "realtime" },
    },
    tags: { area: "realtime" },
  },
  $default: {
    directory: "/lambda_functions/websocket_functions/ws-default-route",
    deploy: { when: { resource: resources.enableWebSocketApi, equals: "true" } },
    cloud: {
      constructId: "DefaultRouteFunction",
      outputs: { arn: { id: "DefaultRouteFunctionArn" } },
    },
    tags: { area: "realtime" },
  },
  $disconnect: {
    directory: "/lambda_functions/websocket_functions/ws-disconnect-route",
    deploy: { when: { resource: resources.enableWebSocketApi, equals: "true" } },
    timeoutSeconds: 10,
    cloud: {
      constructId: "DisconnectRouteFunction",
      outputs: { arn: { id: "DisconnectRouteFunctionArn" } },
    },
    tags: { area: "realtime" },
  },
  customAction: {
    directory: "/lambda_functions/websocket_functions/ws-custom-action-route",
    deploy: { when: { resource: resources.enableWebSocketApi, equals: "true" } },
    cloud: {
      constructId: "CustomActionRouteFunction",
      outputs: { arn: { id: "CustomActionRouteFunctionArn" } },
    },
    tags: { area: "realtime" },
  },
} satisfies WebSocketSection;
