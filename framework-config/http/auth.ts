import type { HttpSection } from "../contracts";
import { resources } from "../resources";

/**
 * The Cognito sign-in flow: the endpoints that mint, verify, refresh and clear
 * the browser's auth cookie, plus the OAuth redirect Cognito calls back into.
 *
 * This flow is deployed and working. Leave it as it is unless you need
 * behavior it doesn't already have. If you do add a route, copy the shape of
 * an entry but not its `constructId` or `outputs` — those name resources that
 * already exist (a construct id is the CloudFormation logical id, so changing
 * one replaces the function). A new entry needs neither: the framework derives
 * a construct id from the target id and emits no outputs unless asked.
 */
const authEndpointEnvironment = {
  USER_POOL_ID: resources.cognito.userPool.userPoolId,
  USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
  TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv,
};

export const authRoutes = {
  "/sign-in": {
    directory: "/lambda_functions/http_functions/sign-in",
    methods: "*",
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "SignInLambdaArn" } },
    },
  },
  "/sign-out": {
    directory: "/lambda_functions/http_functions/sign-out",
    methods: "*",
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "SignOutLambdaArn" } },
    },
  },
  "/oauth/callback": {
    directory: "/lambda_functions/http_functions/oauth-callback",
    methods: "*",
    memorySize: 512,
    timeoutSeconds: 30,
    environment: {
      ...authEndpointEnvironment,
      COGNITO_DOMAIN_URL: resources.cognito.userPoolDomainUrl,
    },
    database: true,
    cloud: {
      constructId: "OAuthCallback",
      outputs: { arn: { id: "OAuthCallbackLambdaArn" } },
    },
  },
  "/verify-session": {
    directory: "/lambda_functions/http_functions/verify-session",
    methods: ["GET", "POST"],
    auth: true,
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "VerifySessionLambdaArn" } },
    },
  },
  "/refresh": {
    directory: "/lambda_functions/http_functions/refresh",
    methods: "*",
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "RefreshLambdaArn" } },
    },
  },
  // Authenticator-app enrollment for the signed-in user. Reads their MFA
  // status with AdminGetUser, which is the one grant it needs; setup and
  // verification use the user's own access token.
  "/mfa": {
    directory: "/lambda_functions/http_functions/mfa",
    methods: ["POST"],
    auth: true,
    environment: {
      ...authEndpointEnvironment,
      // The name an authenticator app shows beside the code.
      MFA_ISSUER: "matts-aws-framework",
    },
    cloud: {
      bindings: [resources.cognito.userPool.grant("cognito-idp:AdminGetUser")],
    },
  },
} satisfies HttpSection;
