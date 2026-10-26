// Client-app variable references, edited through Studio review/apply.
// Each environment keeps its own bindings. Values are resolved during generation.
export const clientEnvironment = {
  VITE_API_GATEWAY_URL: {
    dev: { kind: "endpoint", protocol: "http", port: "LOCAL_API_DEV_SERVER_HOST_PORT", override: "VITE_API_GATEWAY_URL" },
    prod: { kind: "output", stack: "FrontendWebsiteS3Stack", outputs: ["CloudFrontUrl", "FrontendWebsiteUrl"] },
  },
  VITE_LOCAL_WS_URL: {
    dev: { kind: "endpoint", protocol: "ws", port: "LOCAL_WS_DEV_SERVER_HOST_PORT", when: { input: "ENABLE_WEBSOCKET_API", equals: "true" } },
    prod: { kind: "empty" },
  },
  VITE_API_GATEWAY_WS_URL: {
    dev: { kind: "output", stack: "WebSocketApiStack", outputs: ["WebSocketAPIEndpoint"], optional: true },
    prod: { kind: "output", stack: "WebSocketApiStack", outputs: ["WebSocketAPIEndpoint"], optional: true },
  },
  VITE_WS_TESTER_URL: {
    dev: { kind: "endpoint", protocol: "http", port: "WS_TESTER_HOST_PORT" },
    prod: { kind: "empty" },
  },
  // Cognito's deployment region can differ from LOCAL_AWS_REGION (the local SDK region).
  VITE_AWS_REGION: {
    dev: { kind: "region", stack: "CognitoStack" },
    prod: { kind: "region", stack: "CognitoStack" },
  },
  VITE_USER_POOL_ID: {
    dev: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolId"] },
    prod: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolId"] },
  },
  VITE_USER_POOL_CLIENT_ID: {
    dev: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolClientId"] },
    prod: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolClientId"] },
  },
  VITE_COGNITO_DOMAIN: {
    dev: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolDomainUrl"] },
    prod: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolDomainUrl"] },
  },
} as const;
