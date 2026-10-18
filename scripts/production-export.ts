import { collectDeploymentStacks, type DeploymentStack } from "./resource-export";
import { clientEnvironment, renderClientEnvironmentFile } from "./environment-export";

/** Explicit public outputs only: resource descriptors and secret references stay out. */
const publicOutputs = {
  CognitoStack: {
    heading: "Cognito / OAuth",
    outputs: {
      UserPoolId: "USER_POOL_ID",
      UserPoolClientId: "USER_POOL_CLIENT_ID",
      UserPoolDomainUrl: "COGNITO_DOMAIN_URL",
      OAuthProviderRedirectUri: "OAUTH_PROVIDER_REDIRECT_URI",
    },
  },
  FrontendWebsiteS3Stack: {
    heading: "Frontend / CloudFront",
    outputs: {
      FrontendWebsiteBucketName: "FRONTEND_WEBSITE_BUCKET_NAME",
      CloudFrontUrl: "CLOUDFRONT_URL",
      CloudFrontDomainName: "CLOUDFRONT_DOMAIN_NAME",
      CloudFrontId: "CLOUDFRONT_ID",
    },
  },
  HttpApiGatewayStack: { heading: "APIs", outputs: { HttpApiUrl: "HTTP_API_URL" } },
  WebSocketApiStack: { heading: "APIs", outputs: { WebSocketAPIEndpoint: "WEBSOCKET_API_URL" } },
} as const;

export function collectProductionOutputs(stacks: readonly DeploymentStack[], deployment: string) {
  const { identity, stacks: selected } = collectDeploymentStacks(stacks, deployment);
  if (identity.mode !== "prod") throw new Error("Production output export requires a production deployment.");
  const outputs: Record<string, string> = {};
  for (const [suffix, { outputs: mappings }] of Object.entries(publicOutputs)) {
    const matching = selected.filter(stack => stack.StackName === `${deployment}-${suffix}`);
    if (matching.length > 1) throw new Error(`Duplicate deployed stack ${deployment}-${suffix}.`);
    for (const output of matching[0]?.Outputs ?? []) {
      const name = (mappings as Readonly<Record<string, string>>)[output.OutputKey ?? ""];
      if (!name || output.OutputValue === undefined) continue;
      if (Object.hasOwn(outputs, name)) throw new Error(`Duplicate public output ${name}.`);
      outputs[name] = output.OutputValue;
    }
  }
  for (const name of ["USER_POOL_ID", "USER_POOL_CLIENT_ID", "COGNITO_DOMAIN_URL", "FRONTEND_WEBSITE_BUCKET_NAME", "CLOUDFRONT_URL", "CLOUDFRONT_ID"]) {
    if (!outputs[name]) throw new Error(`Required production output ${name} is missing. Existing local files were preserved.`);
  }
  const websocket = outputs.WEBSOCKET_API_URL;
  if (selected.some(stack => stack.StackName === `${deployment}-WebSocketApiStack`) && !websocket) throw new Error("The deployed WebSocket stack has no endpoint. Existing local files were preserved.");
  if (websocket && new URL(websocket).protocol !== "wss:") throw new Error("The deployed WebSocket endpoint must use wss.");
  return {
    document: { ...identity, outputs },
    client: clientEnvironment({
      region: identity.region,
      userPoolId: outputs.USER_POOL_ID,
      userPoolClientId: outputs.USER_POOL_CLIENT_ID,
      cognitoDomainUrl: outputs.COGNITO_DOMAIN_URL,
      // CloudFront serves /api and the agent routes on the paths the local API
      // server does, and strips /api before the HTTP API. HTTP_API_URL has no
      // /api prefix, so it cannot stand in for the local server.
      apiUrl: outputs.CLOUDFRONT_URL,
      // local-ws-dev-server and the tester are Compose services; production has neither.
      localWebSocketUrl: "",
      apiGatewayWebSocketUrl: websocket ?? "",
      webSocketTesterUrl: "",
    }),
  };
}

/**
 * The client settings a production build reads (client-app/.env.production.local).
 * A production export writes this and .framework/prod/outputs.json, never the
 * root .env, which belongs to local development.
 */
export function renderProductionClientFile(result: ReturnType<typeof collectProductionOutputs>): string {
  return renderClientEnvironmentFile(result.client, { deployment: result.document.deployment, mode: "prod" });
}
