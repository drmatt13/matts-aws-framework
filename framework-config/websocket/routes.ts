import type { WebSocketSection } from "../contracts";

export const webSocketRoutes = {
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
    },
  },
  $default: {
    directory: "/lambda_functions/websocket_functions/ws-default-route",
    cloud: {
      constructId: "DefaultRouteFunction",
      outputs: { arn: { id: "DefaultRouteFunctionArn" } },
    },
  },
  $disconnect: {
    directory: "/lambda_functions/websocket_functions/ws-disconnect-route",
    timeoutSeconds: 10,
    cloud: {
      constructId: "DisconnectRouteFunction",
      outputs: { arn: { id: "DisconnectRouteFunctionArn" } },
    },
  },
  customAction: {
    directory: "/lambda_functions/websocket_functions/ws-custom-action-route",
    cloud: {
      constructId: "CustomActionRouteFunction",
      outputs: { arn: { id: "CustomActionRouteFunctionArn" } },
    },
  },
} satisfies WebSocketSection;
