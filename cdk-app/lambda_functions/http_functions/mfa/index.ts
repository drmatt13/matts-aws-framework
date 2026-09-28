import {
  AdminGetUserCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
  SetUserMFAPreferenceCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  authenticated,
  verifyCognitoIdToken,
  type AuthenticatedCognitoSession,
} from "@repo/framework/runtime/auth";
import {
  getCookieHeader,
  getUserPoolClientId,
  hasPersistentSessionCookie,
  isTrustedBrowserRequest,
  jsonResponse,
  makeRefreshSessionCookies,
  parseCookies,
  parseJsonBody,
  type HttpEvent,
  type HttpResult,
} from "@repo/framework/runtime/http";
import { MfaRequestSchema, type MfaRequest, type MfaResponse } from "./contract";

const cognito = new CognitoIdentityProviderClient({});

/**
 * An access token for the signed-in user, obtained here and never sent to the
 * browser.
 *
 * Cognito's TOTP enrollment calls take an access token, and this app keeps
 * only the ID token in the browser. The refresh cookie is already the session's
 * root credential, so it is exchanged here for a fresh token set; the rotated
 * refresh token goes back as the same cookies /refresh would set.
 */
async function accessTokenFor(
  event: HttpEvent,
  session: AuthenticatedCognitoSession,
): Promise<{ accessToken: string; cookies: string[] } | null> {
  const clientId = getUserPoolClientId();
  const cookies = parseCookies(getCookieHeader(event));
  if (!clientId || !cookies.refreshToken) return null;

  const { AuthenticationResult: auth } = await cognito.send(
    new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: cookies.refreshToken,
    }),
  );
  if (!auth?.AccessToken || !auth.IdToken || !auth.RefreshToken) return null;

  // The cookie and the bearer token must be the same person.
  const refreshed = await verifyCognitoIdToken(auth.IdToken);
  if (refreshed?.sub !== session.payload.sub) return null;

  return {
    accessToken: auth.AccessToken,
    cookies: makeRefreshSessionCookies(
      auth.RefreshToken,
      hasPersistentSessionCookie(cookies),
    ),
  };
}

function respond(statusCode: number, body: MfaResponse, cookies?: string[]): HttpResult {
  return jsonResponse(statusCode, body, cookies ? { cookies } : {});
}

async function totpEnabled(session: AuthenticatedCognitoSession): Promise<boolean> {
  const username = session.payload["cognito:username"];
  if (typeof username !== "string") return false;
  const user = await cognito.send(
    new AdminGetUserCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: username,
    }),
  );
  return user.UserMFASettingList?.includes("SOFTWARE_TOKEN_MFA") ?? false;
}

function otpauthUri(secret: string, account: string): string {
  const issuer = process.env.MFA_ISSUER ?? "App";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

export const lambdaHandler = authenticated(async (event, session) => {
  // This route spends the refresh cookie, so it gets the same origin gate as
  // every other cookie-bearing auth endpoint.
  if (!isTrustedBrowserRequest(event)) {
    return respond(403, { error: "Forbidden origin" });
  }

  let request: MfaRequest;
  try {
    request = MfaRequestSchema.parse(parseJsonBody<unknown>(event.body));
  } catch {
    return respond(400, { error: "Invalid request body" });
  }

  try {
    if (request.action === "status") {
      return respond(200, { totpEnabled: await totpEnabled(session) });
    }

    const access = await accessTokenFor(event, session);
    if (!access) {
      return respond(401, { error: "Sign in again to change two-step verification." });
    }

    if (request.action === "setup") {
      const { SecretCode } = await cognito.send(
        new AssociateSoftwareTokenCommand({ AccessToken: access.accessToken }),
      );
      if (!SecretCode) {
        return respond(502, { error: "Cognito did not issue a secret." });
      }
      const account =
        typeof session.payload.email === "string" ? session.payload.email : session.payload.sub;
      return respond(
        200,
        { secretCode: SecretCode, otpauthUri: otpauthUri(SecretCode, account) },
        access.cookies,
      );
    }

    const verified = await cognito.send(
      new VerifySoftwareTokenCommand({
        AccessToken: access.accessToken,
        UserCode: request.code,
        FriendlyDeviceName: "Authenticator app",
      }),
    );
    if (verified.Status !== "SUCCESS") {
      return respond(400, { error: "That code didn't match. Try the next one." }, access.cookies);
    }
    await cognito.send(
      new SetUserMFAPreferenceCommand({
        AccessToken: access.accessToken,
        SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
      }),
    );
    return respond(200, { totpEnabled: true }, access.cookies);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "CodeMismatchException" || name === "EnableSoftwareTokenMFAException") {
      return respond(400, { error: "That code didn't match. Try the next one." });
    }
    if (name === "NotAuthorizedException") {
      return respond(401, { error: "Sign in again to change two-step verification." });
    }
    console.error("MFA error:", error);
    return respond(500, { error: "Internal server error" });
  }
});
