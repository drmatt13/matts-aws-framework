import { createYoga } from "graphql-yoga";
import { authenticated } from "@repo/framework/runtime/auth";
import { getHttpMethod, jsonResponse } from "@repo/framework/runtime/http";
import { getDatabaseUrl } from "@repo/framework/runtime/database";
import { getDatabase } from "@repo/database";
import type { GraphQLContext } from "./graphql-context";
import {
  getRequestBody,
  getRequestHeaders,
  getRequestUrl,
  toApiGatewayResult,
} from "./lib/api-gateway-fetch";
import { graphqlHardening } from "./lib/hardening";
import {
  persistedDocumentsOnly,
  resolvePersistedDocument,
} from "./lib/persisted-documents";
import { schema } from "./schema";

function isGraphiqlEnabled(): boolean {
  return process.env.GRAPHQL_GRAPHIQL_ENABLED === "true";
}

function createGraphQLYoga() {
  return createYoga<GraphQLContext>({
    schema,
    graphqlEndpoint: "/graphql",
    graphiql: isGraphiqlEnabled(),
    plugins: graphqlHardening({ allowIntrospection: isGraphiqlEnabled() }),
  });
}

let yoga: ReturnType<typeof createGraphQLYoga> | null = null;

function getYoga(): ReturnType<typeof createGraphQLYoga> {
  yoga ??= createGraphQLYoga();
  return yoga;
}

export const lambdaHandler = authenticated(async (event, session) => {
  try {
    const method = getHttpMethod(event)?.toUpperCase();

    if (method !== "POST" && method !== "GET") {
      return jsonResponse(405, { error: "Method Not Allowed" });
    }

    const headers = getRequestHeaders(event);
    let body = getRequestBody(event);
    if (persistedDocumentsOnly()) {
      const resolved =
        method === "POST"
          ? resolvePersistedDocument(body === undefined ? undefined : body.toString())
          : null;
      if (resolved === null) {
        return jsonResponse(400, {
          errors: [
            {
              message: "This API executes only the application's own operations.",
              extensions: { code: "PERSISTED_QUERY_NOT_FOUND" },
            },
          ],
        });
      }
      body = resolved;
      headers.delete("content-length");
    }

    // Resolved once per execution environment; the local lane hands the
    // handler the Compose Postgres URL instead of a secret.
    const database = getDatabase(await getDatabaseUrl());

    const response = await getYoga().fetch(
      getRequestUrl(event),
      {
        method,
        headers,
        body,
      },
      {
        session,
        database,
      },
    );

    return toApiGatewayResult(response);
  } catch (error) {
    console.error("GraphQL API error:", error);
    return jsonResponse(500, { error: "Internal Server Error" });
  }
});
