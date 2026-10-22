import type { WebSocketSection } from "../contracts";

/** WebSocket declarations. Tags describe concerns independently of this module. */
export const webSocket = {
  $connect: {
    directory: "/lambda_functions/websocket_functions/ws-connect-route",
    cloud: {
      constructId: "ConnectRouteFunction",
      outputs: { arn: { id: "ConnectRouteFunctionArn" } },
    },
    authorizer: {
      directory: "/lambda_functions/websocket_functions/ws-authorizer",
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
    cloud: {
      constructId: "DefaultRouteFunction",
      outputs: { arn: { id: "DefaultRouteFunctionArn" } },
    },
    tags: { area: "realtime" },
  },
  $disconnect: {
    directory: "/lambda_functions/websocket_functions/ws-disconnect-route",
    timeoutSeconds: 10,
    cloud: {
      constructId: "DisconnectRouteFunction",
      outputs: { arn: { id: "DisconnectRouteFunctionArn" } },
    },
    tags: { area: "realtime" },
  },
  customAction: {
    directory: "/lambda_functions/websocket_functions/ws-custom-action-route",
    cloud: {
      constructId: "CustomActionRouteFunction",
      outputs: { arn: { id: "CustomActionRouteFunctionArn" } },
    },
    tags: { area: "realtime" },
  },
} satisfies WebSocketSection;
