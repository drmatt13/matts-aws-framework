import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  Context,
} from "aws-lambda";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { jsonResponse, type HttpEvent, type HttpResult } from "./response";

type CognitoAuthConfig = {
  audience: string;
  issuer: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

export type AuthenticatedCognitoPayload = JWTPayload & {
  sub: string;
  token_use: string;
};

export type AuthenticatedCognitoSession = {
  idToken: string;
  payload: AuthenticatedCognitoPayload;
};

export type HttpAuthSessionInput = {
  authorizationHeader?: string | null;
};

type ApiGatewayJwtAuthorizerContext = {
  jwt?: {
    claims?: Record<string, unknown>;
  };
};

/**
 * Cognito's signing keys could not be read, so no token could be judged.
 *
 * Distinct from a bad token on purpose. A bad token is a 401, and the browser
 * answers a 401 by treating the session as over. An outage is a 503, which the
 * browser treats as "try again" — a JWKS timeout must never sign anybody out.
 */
export class AuthUnavailableError extends Error {
  /** What failed underneath: a timeout, a network error, an unreadable key set. */
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super("Cognito signing keys are unavailable; the token could not be verified.");
    this.name = "AuthUnavailableError";
    this.reason = reason;
  }
}

/**
 * jose's codes for a token that is simply not acceptable: malformed, expired,
 * for another audience, signed by a key this pool does not publish. Anything
 * else — a timeout, a failed fetch, an unreadable key set — says nothing about
 * the token and is reported as {@link AuthUnavailableError}.
 */
const INVALID_TOKEN_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
]);

let cognitoAuthConfig: CognitoAuthConfig | null = null;

const getCognitoAuthConfig = (): CognitoAuthConfig => {
  if (cognitoAuthConfig) {
    return cognitoAuthConfig;
  }

  const { AWS_REGION, USER_POOL_ID, USER_POOL_CLIENT_ID } = process.env;

  if (!AWS_REGION || !USER_POOL_ID || !USER_POOL_CLIENT_ID) {
    throw new Error("Missing Cognito environment variables");
  }

  const issuer = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${USER_POOL_ID}`;

  cognitoAuthConfig = {
    audience: USER_POOL_CLIENT_ID,
    issuer,
    jwks: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
  };

  return cognitoAuthConfig;
};

const getAuthorizationHeader = (
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
): string => event.headers.authorization ?? event.headers.Authorization ?? "";

const getBearerTokenFromAuthorizationHeader = (
  authorizationHeader: string | null | undefined,
): string | null => {
  const authorization = authorizationHeader?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
};

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

/** {@link getAuthenticatedSession} for a caller holding only the header. */
export async function getAuthenticatedHttpSession({
  authorizationHeader,
}: HttpAuthSessionInput): Promise<AuthenticatedCognitoSession | null> {
  // Bearer header only. The ID token is never written to a cookie, so a
  // cookie fallback could only ever match a stale one left over from the
  // pre-rotation model -- an ambient credential this design exists to remove.
  const idToken = getBearerTokenFromAuthorizationHeader(authorizationHeader);

  if (!idToken) {
    return null;
  }

  const payload = await verifyCognitoIdToken(idToken);
  if (!payload) {
    return null;
  }

  return {
    idToken,
    payload,
  };
}

/**
 * The token's claims when it is a valid ID token for this pool and client, or
 * `null` when it is not. Throws {@link AuthUnavailableError} when the pool's
 * signing keys could not be read.
 */
export async function verifyCognitoIdToken(
  idToken: string,
): Promise<AuthenticatedCognitoPayload | null> {
  const { audience, issuer, jwks } = getCognitoAuthConfig();
  let payload: JWTPayload;

  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer,
      audience,
    }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && INVALID_TOKEN_CODES.has(code)) {
      return null;
    }
    throw new AuthUnavailableError(error);
  }

  if (payload.token_use !== "id" || !payload.sub) {
    return null;
  }

  return payload as AuthenticatedCognitoPayload;
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
