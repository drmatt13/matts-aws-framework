import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  Context,
} from "aws-lambda";
import { jsonResponse, type HttpEvent, type HttpResult } from "./response";
import {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
  type AuthenticatedCognitoPayload,
  type AuthenticatedCognitoSession,
} from "./cognito";

// The verifier lives in ./cognito, shared with the agent and tool entry points;
// this entry point's API is unchanged.
export {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
  verifyCognitoIdToken,
  type AuthenticatedCognitoPayload,
  type AuthenticatedCognitoSession,
  type HttpAuthSessionInput,
} from "./cognito";

type ApiGatewayJwtAuthorizerContext = {
  jwt?: {
    claims?: Record<string, unknown>;
  };
};

const getAuthorizationHeader = (
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): string => event.headers.authorization ?? event.headers.Authorization ?? "";

const getVerifiedAuthorizerPayload = (
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): AuthenticatedCognitoPayload | null => {
  const requestContext = event.requestContext as {
    authorizer?: ApiGatewayJwtAuthorizerContext;
  };
  const authorizer = requestContext.authorizer;
  const claims = authorizer?.jwt?.claims;

  if (!claims || claims.token_use !== "id" || typeof claims.sub !== "string") {
    return null;
  }

  return claims as AuthenticatedCognitoPayload;
};

/**
 * The verified Cognito session behind a request, or `null` when there is none.
 *
 * Throws {@link AuthUnavailableError} when the token could not be judged at
 * all. Most handlers want {@link authenticated} instead, which answers both
 * cases for them.
 */
export async function getAuthenticatedSession(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): Promise<AuthenticatedCognitoSession | null> {
  const session = await getAuthenticatedHttpSession({
    authorizationHeader: getAuthorizationHeader(event),
  });

  if (!session) {
    return null;
  }

  const verifiedAuthorizerPayload = getVerifiedAuthorizerPayload(event);
  if (
    verifiedAuthorizerPayload &&
    verifiedAuthorizerPayload.sub !== session.payload.sub
  ) {
    return null;
  }

  return session;
}

export async function getAuthenticatedUser(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): Promise<AuthenticatedCognitoPayload | null> {
  return (await getAuthenticatedSession(event))?.payload ?? null;
}

export async function getAuthenticatedSub(
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): Promise<string | null> {
  return (await getAuthenticatedUser(event))?.sub ?? null;
}

/** A handler that only runs for a signed-in caller, and is handed the session. */
export type AuthenticatedHttpHandler = (
  event: HttpEvent,
  session: AuthenticatedCognitoSession,
  context: Context,
) => Promise<HttpResult>;

/**
 * An HTTP route handler that requires a signed-in user.
 *
 *   export const lambdaHandler = authenticated(async (event, session) => {
 *     return jsonResponse(200, { sub: session.payload.sub });
 *   });
 *
 * No session answers 401 `{"message":"Unauthorized"}` — the body API
 * Gateway's own authorizer sends, so a client sees one shape whichever of the
 * two refused it. Unreadable Cognito keys answer 503, which the browser treats
 * as "try again" rather than as a signed-out session.
 *
 * Pair it with `auth: true` on the route: the gateway authorizer refuses
 * obvious garbage before a Lambda is ever invoked, and this verifies the token
 * again in the handler, where the application's own code relies on it.
 */
export function authenticated(
  handler: AuthenticatedHttpHandler,
): (event: HttpEvent, context: Context) => Promise<HttpResult> {
  return async (event, context) => {
    let session: AuthenticatedCognitoSession | null;
    try {
      session = await getAuthenticatedSession(event);
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        console.error(error.message, error.reason);
        return jsonResponse(503, { message: "Service Unavailable" });
      }
      throw error;
    }
    if (!session) {
      return jsonResponse(401, { message: "Unauthorized" });
    }
    return handler(event, session, context);
  };
}
