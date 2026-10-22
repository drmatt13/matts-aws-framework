import { applicationVpc } from "../networks/application";
import type { HttpSection } from "../contracts";
import { resources } from "../resources";
import { PROD_DEPLOYMENT } from "@repo/framework/config/source";
import { runsTask, startsWorkflow } from "@repo/framework/config";

/** Http declarations. Tags describe concerns independently of this module. */
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
  TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv,
};

export const http = {
  "/sign-in": {
    directory: "/lambda_functions/http_functions/sign-in",
    methods: "*",
    userPool: true,
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "SignInLambdaArn" } },
    },
    tags: { area: "auth" },
  },
  "/sign-out": {
    directory: "/lambda_functions/http_functions/sign-out",
    methods: "*",
    userPool: true,
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "SignOutLambdaArn" } },
    },
    tags: { area: "auth" },
  },
  "/oauth/callback": {
    directory: "/lambda_functions/http_functions/oauth-callback",
    methods: "*",
    memorySize: 512,
    timeoutSeconds: 30,
    userPool: true,
    environment: {
      ...authEndpointEnvironment,
      COGNITO_DOMAIN_URL: resources.cognito.userPoolDomainUrl,
    },
    vpc: applicationVpc,
    database: true,
    cloud: {
      constructId: "OAuthCallback",
      outputs: { arn: { id: "OAuthCallbackLambdaArn" } },
    },
    tags: { area: "auth" },
  },
  "/verify-session": {
    directory: "/lambda_functions/http_functions/verify-session",
    methods: ["GET", "POST"],
    auth: true,
    userPool: true,
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "VerifySessionLambdaArn" } },
    },
    tags: { area: "auth" },
  },
  "/refresh": {
    directory: "/lambda_functions/http_functions/refresh",
    methods: "*",
    userPool: true,
    environment: { ...authEndpointEnvironment },
    cloud: {
      outputs: { arn: { id: "RefreshLambdaArn" } },
    },
    tags: { area: "auth" },
  },
  // Authenticator-app enrollment for the signed-in user. Reads their MFA
  // status with AdminGetUser, which is the one grant it needs; setup and
  // verification use the user's own access token.
  "/mfa": {
    directory: "/lambda_functions/http_functions/mfa",
    methods: ["POST"],
    auth: true,
    userPool: true,
    environment: {
      ...authEndpointEnvironment,
      // The name an authenticator app shows beside the code.
      MFA_ISSUER: "matts-aws-framework",
    },
    cloud: {
      bindings: [resources.cognito.userPool.grant("cognito-idp:AdminGetUser")],
    },
    tags: { area: "auth" },
  },

  /** The GraphQL API: one route in front of the Pothos schema and the database. */

  "/graphql": {
    directory: "/lambda_functions/http_functions/graphql-api",
    methods: ["GET", "POST"],
    auth: true,
    memorySize: 512,
    timeoutSeconds: 30,
    bundling: { sourceMap: false },
    environment: {
      GRAPHQL_GRAPHIQL_ENABLED: PROD_DEPLOYMENT ? "false" : "true",
      // "true" executes only the operations in the client's generated
      // persisted-documents.json and refuses every other query. Deploy the
      // client with the API when it is on: a tab still running an older build
      // needs a reload once an operation it sends has changed.
      GRAPHQL_PERSISTED_DOCUMENTS_ONLY: "false",
    },
    userPool: true,
    vpc: applicationVpc,
    database: true,
    cloud: { constructId: "GraphQLApi" },
    tags: { area: "graphql" },
  },

  /**
   * Reference endpoints kept deployable on purpose, so the paths a new handler
   * copies are ones that are known to build.
   */

  "/examples/python": {
    directory: "/lambda_functions/http_functions/python-example",
    methods: ["POST"],
    auth: true,
    packaging: "container",
    tags: { area: "examples" },
  },

  /** The authenticated starter used by the frontend's Workflows panel. */

  "/test/start-workflow": {
    directory: "/lambda_functions/http_functions/test-start-workflow",
    methods: ["POST"],
    auth: true,
    memorySize: 256,
    timeoutSeconds: 15,
    deploy: "both",
    userPool: true,
    environment: { TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv },
    cloud: { bindings: [startsWorkflow("invocation-test-workflow")] },
    tags: { area: "workflows" },
  },

  /** The authenticated starter used by the frontend's Tasks panel. */

  "/test/run-task": {
    directory: "/lambda_functions/http_functions/test-run-task",
    methods: ["POST"],
    auth: true,
    // The AWS SDK's first ECS call is not free on a cold start.
    memorySize: 256,
    timeoutSeconds: 15,
    deploy: "both",
    userPool: true,
    environment: { TRUSTED_FRONTEND_ORIGINS: resources.cognito.trustedOriginsCsv },
    cloud: { bindings: [runsTask("invocation-test-task")] },
    tags: { area: "tasks" },
  },
} satisfies HttpSection;
