// Client-app variable references, edited through Studio review/apply.
// One recipe serves both environments; { dev, prod } only where the sources differ.
// Where a field gets a value follows its sources: the local URLs read development-only
// inputs, so they are blank in production. Values are resolved during generation.
export const clientEnvironment = {
  VITE_API_GATEWAY_URL: {
    dev: { kind: "endpoint", protocol: "http", port: "LOCAL_API_DEV_SERVER_HOST_PORT", override: "VITE_API_GATEWAY_URL" },
    prod: { kind: "output", stack: "FrontendWebsiteS3Stack", outputs: ["CloudFrontUrl", "FrontendWebsiteUrl"] },
  },
  VITE_LOCAL_WS_URL: { kind: "endpoint", protocol: "ws", port: "LOCAL_WS_DEV_SERVER_HOST_PORT", when: { input: "ENABLE_WEBSOCKET_API", equals: "true" } },
  VITE_API_GATEWAY_WS_URL: { kind: "output", stack: "WebSocketApiStack", outputs: ["WebSocketAPIEndpoint"], optional: true },
  VITE_WS_TESTER_URL: { kind: "endpoint", protocol: "http", port: "WS_TESTER_HOST_PORT" },
  // Cognito's deployment region can differ from LOCAL_AWS_REGION (the local SDK region).
  VITE_AWS_REGION: { kind: "region", stack: "CognitoStack" },
  VITE_USER_POOL_ID: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolId"] },
  VITE_USER_POOL_CLIENT_ID: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolClientId"] },
  VITE_COGNITO_DOMAIN: { kind: "output", stack: "CognitoStack", outputs: ["UserPoolDomainUrl"] },
} as const;
