import { databaseConnection } from "@repo/framework/runtime/database";
import {
  getHttpMethod,
  isTrustedBrowserRequest,
  jsonResponse,
  makeRefreshSessionCookies,
  optionsResponse,
  parseJsonBody,
  type HttpEvent,
  type HttpResult,
} from "@repo/framework/runtime/http";
import {
  AuthUnavailableError,
  verifyCognitoIdToken,
} from "@repo/framework/runtime/auth";
import { ensureCognitoUser, getDatabase } from "@repo/database";

interface OAuthCallbackBody {
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  rememberMe?: boolean;
}

interface CognitoTokenResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function getRequiredCognitoConfig() {
  const {
    AWS_REGION,
    USER_POOL_ID,
    USER_POOL_CLIENT_ID,
    COGNITO_DOMAIN_URL,
  } = process.env;

  if (
    !AWS_REGION ||
    !USER_POOL_ID ||
    !USER_POOL_CLIENT_ID ||
    !COGNITO_DOMAIN_URL
  ) {
    throw new Error("Missing Cognito OAuth environment variables");
  }

  return {
    cognitoDomainUrl: COGNITO_DOMAIN_URL,
    userPoolClientId: USER_POOL_CLIENT_ID,
  };
}

export const lambdaHandler = async (
  event: HttpEvent,
): Promise<HttpResult> => {
  try {
    if (getHttpMethod(event) === "OPTIONS") {
      return optionsResponse();
    }

    if (!isTrustedBrowserRequest(event)) {
      return jsonResponse(403, { success: false, error: "Forbidden origin" });
    }

    let body: OAuthCallbackBody;
    try {
      body = parseJsonBody<OAuthCallbackBody>(event.body);
    } catch {
      return jsonResponse(400, {
        success: false,
        error: "Invalid request body",
      });
    }

    const code = body.code?.trim();
    const codeVerifier = body.codeVerifier?.trim();
    const redirectUri = body.redirectUri?.trim();
    const rememberMe = body.rememberMe === true;
    const cognitoConfig = getRequiredCognitoConfig();

    if (!code || !codeVerifier || !redirectUri) {
      return jsonResponse(400, {
        success: false,
        error: "Authorization code, PKCE verifier, and redirect URI are required",
      });
    }

    const tokenResponse = await fetch(
      `${cognitoConfig.cognitoDomainUrl.replace(/\/+$/, "")}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: cognitoConfig.userPoolClientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      },
    );

    const tokens = (await tokenResponse.json()) as CognitoTokenResponse;

    if (
      !tokenResponse.ok ||
      !tokens.id_token ||
      !tokens.refresh_token
    ) {
      return jsonResponse(401, {
        success: false,
        error:
          tokens.error_description ||
          tokens.error ||
          "Unable to complete OAuth sign in",
      });
    }

    const payload = await verifyCognitoIdToken(tokens.id_token);

    if (!payload) {
      return jsonResponse(401, { success: false, error: "Invalid ID token" });
    }

    const email = typeof payload.email === "string" ? payload.email : "";
    if (!email || payload.email_verified !== true) {
      return jsonResponse(401, {
        success: false,
        error: "OAuth provider did not return a verified email address",
      });
    }

    const firstName =
      typeof payload.given_name === "string" && payload.given_name.trim()
        ? payload.given_name.trim()
        : email.split("@")[0];
    const lastName =
      typeof payload.family_name === "string" && payload.family_name.trim()
        ? payload.family_name.trim()
        : "";
    const database = getDatabase(databaseConnection());

    await ensureCognitoUser(database.users, {
      cognitoSub: payload.sub,
      email,
      firstName,
      lastName,
    });

    return jsonResponse(
      200,
      {
        success: true,
        idToken: tokens.id_token,
      },
      {
        cookies: makeRefreshSessionCookies(tokens.refresh_token, rememberMe),
      },
    );
  } catch (error) {
    console.error("OAuth callback error:", error);
    // Cognito's keys were unreachable: a retry can succeed, and the browser
    // must not read this as a rejected sign-in.
    if (error instanceof AuthUnavailableError) {
      return jsonResponse(503, { success: false, error: "Sign in is temporarily unavailable" });
    }
    return jsonResponse(500, {
      success: false,
      error: "OAuth sign in failed",
    });
  }
};
