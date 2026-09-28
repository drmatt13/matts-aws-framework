import {
  CognitoIdentityProviderClient,
  RevokeTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  clearAuthCookies,
  getCookieHeader,
  getHttpMethod,
  getUserPoolClientId,
  isTrustedBrowserRequest,
  jsonResponse,
  optionsResponse,
  parseCookies,
  type HttpEvent,
  type HttpResult,
} from "@repo/framework/runtime/http";

const cognito = new CognitoIdentityProviderClient({});

export const lambdaHandler = async (
  event: HttpEvent,
): Promise<HttpResult> => {
  if (getHttpMethod(event) === "OPTIONS") {
    return optionsResponse();
  }

  if (!isTrustedBrowserRequest(event)) {
    return jsonResponse(403, { success: false, error: "Forbidden origin" });
  }

  const refreshToken = parseCookies(getCookieHeader(event)).refreshToken;
  const clientId = getUserPoolClientId();

  if (refreshToken && clientId) {
    try {
      await cognito.send(
        new RevokeTokenCommand({ ClientId: clientId, Token: refreshToken }),
      );
    } catch (error) {
      // Sign-out is deliberately idempotent. Local cookie cleanup must succeed
      // even if Cognito is temporarily unavailable or the token is already dead.
      console.warn("Refresh-token revocation failed during sign-out", error);
    }
  }

  return jsonResponse(
    200,
    { success: true },
    {
      cookies: clearAuthCookies(),
    },
  );
};
