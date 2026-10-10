import type { HttpSection } from "../contracts";
import { resources } from "../resources";
import { PROD_DEPLOYMENT } from "@repo/framework/config/source";

/** The GraphQL API: one route in front of the Pothos schema and the database. */
export const graphqlRoutes = {
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
      USER_POOL_ID: resources.cognito.userPool.userPoolId,
      USER_POOL_CLIENT_ID: resources.cognito.userPoolClient.userPoolClientId,
    },
    database: true,
    cloud: { constructId: "GraphQLApi" },
  },
} satisfies HttpSection;
