import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  clearAuthCookies,
  getHttpMethod,
  getCookieHeader,
  getUserPoolClientId,
  hasPersistentSessionCookie,
  isTrustedBrowserRequest,
  jsonResponse,
  makeRefreshSessionCookies,
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

  const userPoolClientId = getUserPoolClientId();
  if (!userPoolClientId) {
    console.error("Missing USER_POOL_CLIENT_ID environment variable");
    return jsonResponse(500, {
      success: false,
      error: "Auth service is not configured",
    });
  }

  const cookies = parseCookies(getCookieHeader(event));
  const refreshToken = cookies["refreshToken"];

  if (!refreshToken) {
    return jsonResponse(
      401,
      { success: false, error: "Missing refresh token" },
      { cookies: clearAuthCookies() },
    );
  }

  try {
    const result = await cognito.send(
      new GetTokensFromRefreshTokenCommand({
        ClientId: userPoolClientId,
        RefreshToken: refreshToken,
      }),
    );

    const auth = result.AuthenticationResult;
    if (!auth?.IdToken || !auth.RefreshToken) {
      console.error("Cognito refresh response did not contain rotated tokens");
      return jsonResponse(502, {
        success: false,
        error: "Auth service returned an invalid response",
      });
    }

    return jsonResponse(
      200,
      {
        success: true,
        idToken: auth.IdToken,
      },
      {
        cookies: makeRefreshSessionCookies(
          auth.RefreshToken,
          hasPersistentSessionCookie(cookies),
        ),
      },
    );
  } catch (error: unknown) {
    const err = error as { name?: string };

    if (
      err.name === "NotAuthorizedException" ||
      err.name === "RefreshTokenReuseException" ||
      err.name === "UserNotFoundException"
    ) {
      return jsonResponse(
        401,
        { success: false, error: "Refresh token expired or invalid" },
        { cookies: clearAuthCookies() },
      );
    }

    if (err.name === "TooManyRequestsException") {
      return jsonResponse(429, {
        success: false,
        error: "Too many refresh attempts",
      });
    }

    console.error("Refresh error:", error);
    return jsonResponse(500, {
      success: false,
      error: "Internal server error",
    });
  }
};
