import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";

/**
 * Cognito ID-token verification, shared by every entry point that accepts a
 * user: `runtime/auth` for HTTP handlers, `runtime/agentcore` for agents and
 * `runtime/tools` for user tools. One verifier, so a token means the same thing
 * to a route, an agent and a tool. Internal: import it through those entry
 * points, which keep their bundles independent of one another.
 */

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

/**
 * The pool's issuer. AWS_REGION where the runtime sets it, as Lambda does;
 * otherwise the region a pool id begins with (`us-east-1_…`), which is the
 * pool's own — AgentCore Runtime does not document setting AWS_REGION.
 */
export function cognitoIssuer(environment: {
  readonly AWS_REGION?: string;
  readonly USER_POOL_ID?: string;
}): string | undefined {
  const { USER_POOL_ID } = environment;
  if (!USER_POOL_ID) return undefined;
  const region = environment.AWS_REGION || /^([a-z]{2}(?:-[a-z]+)+-\d+)_/.exec(USER_POOL_ID)?.[1];
  return region ? `https://cognito-idp.${region}.amazonaws.com/${USER_POOL_ID}` : undefined;
}

const getCognitoAuthConfig = (): CognitoAuthConfig => {
  if (cognitoAuthConfig) {
    return cognitoAuthConfig;
  }

  const { USER_POOL_CLIENT_ID } = process.env;
  const issuer = cognitoIssuer(process.env);

  if (!issuer || !USER_POOL_CLIENT_ID) {
    throw new Error("Missing Cognito environment variables");
  }

  cognitoAuthConfig = {
    audience: USER_POOL_CLIENT_ID,
    issuer,
    jwks: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
  };

  return cognitoAuthConfig;
};

const getBearerTokenFromAuthorizationHeader = (
  authorizationHeader: string | null | undefined,
): string | null => {
  const authorization = authorizationHeader?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
};

/** The verified Cognito session behind an Authorization header, or `null`. */
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
