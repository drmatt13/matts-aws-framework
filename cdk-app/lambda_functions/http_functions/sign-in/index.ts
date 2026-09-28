import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
  type ChallengeNameType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  MfaChallengeNameSchema,
  SignInRequestSchema,
  type MfaChallengeName,
  type SignInRequest,
} from "./contract";
import {
  getHttpMethod,
  getUserPoolClientId,
  isTrustedBrowserRequest,
  jsonResponse,
  makeRefreshSessionCookies,
  optionsResponse,
  parseJsonBody,
  type HttpEvent,
  type HttpResult,
} from "@repo/framework/runtime/http";

const cognito = new CognitoIdentityProviderClient({});

interface CognitoAuthStep {
  AuthenticationResult?: AuthenticationResultType;
  ChallengeName?: ChallengeNameType;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

const MFA_RESPONSE_KEYS: Record<MfaChallengeName, string> = {
  SMS_MFA: "SMS_MFA_CODE",
  SOFTWARE_TOKEN_MFA: "SOFTWARE_TOKEN_MFA_CODE",
  EMAIL_OTP: "EMAIL_OTP_CODE",
  SMS_OTP: "SMS_OTP_CODE",
};

function getMfaChallenge(
  result: CognitoAuthStep,
  fallbackUsername: string,
) {
  const challenge = MfaChallengeNameSchema.safeParse(result.ChallengeName);
  if (!challenge.success || !result.Session) {
    return null;
  }

  return {
    name: challenge.data,
    session: result.Session,
    username:
      result.ChallengeParameters?.USER_ID_FOR_SRP ??
      result.ChallengeParameters?.USERNAME ??
      fallbackUsername,
    ...(result.ChallengeParameters?.CODE_DELIVERY_DESTINATION
      ? {
          destination:
            result.ChallengeParameters.CODE_DELIVERY_DESTINATION,
        }
      : {}),
  };
}

function successfulSignInResponse(
  auth: AuthenticationResultType,
  rememberMe: boolean,
): HttpResult | null {
  if (!auth.IdToken || !auth.AccessToken || !auth.RefreshToken) {
    return null;
  }

  return jsonResponse(
    200,
    {
      success: true,
      idToken: auth.IdToken,
    },
    {
      cookies: makeRefreshSessionCookies(auth.RefreshToken, rememberMe),
    },
  );
}

export const lambdaHandler = async (
  event: HttpEvent,
): Promise<HttpResult> => {
  const userPoolClientId = getUserPoolClientId();
  if (!userPoolClientId) {
    console.error("Missing USER_POOL_CLIENT_ID environment variable");
    return jsonResponse(500, {
      success: false,
      error: "Auth service is not configured",
    });
  }

  if (getHttpMethod(event) === "OPTIONS") {
    return optionsResponse();
  }

  if (!isTrustedBrowserRequest(event)) {
    return jsonResponse(403, { success: false, error: "Forbidden origin" });
  }

  let body: SignInRequest;
  try {
    body = SignInRequestSchema.parse(parseJsonBody<unknown>(event.body));
  } catch {
    return jsonResponse(400, { success: false, error: "Invalid request body" });
  }

  const rememberMe = body.rememberMe === true;

  try {
    const username =
      body.type === "password"
        ? body.email.trim().toLowerCase()
        : body.username;
    const result: CognitoAuthStep =
      body.type === "password"
        ? await cognito.send(
            new InitiateAuthCommand({
              AuthFlow: "USER_PASSWORD_AUTH",
              ClientId: userPoolClientId,
              AuthParameters: {
                USERNAME: username,
                PASSWORD: body.password,
              },
            }),
          )
        : await cognito.send(
            new RespondToAuthChallengeCommand({
              ClientId: userPoolClientId,
              ChallengeName: body.challengeName,
              Session: body.session,
              ChallengeResponses: {
                USERNAME: username,
                [MFA_RESPONSE_KEYS[body.challengeName]]: body.code.trim(),
              },
            }),
          );

    if (result.AuthenticationResult) {
      const response = successfulSignInResponse(
        result.AuthenticationResult,
        rememberMe,
      );
      if (response) {
        return response;
      }
    }

    const challenge = getMfaChallenge(result, username);
    if (challenge) {
      return jsonResponse(200, { success: false, challenge });
    }

    return jsonResponse(401, {
      success: false,
      error: result.ChallengeName
        ? `Unsupported sign-in challenge: ${result.ChallengeName}`
        : "Authentication failed",
    });
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };

    if (
      err.name === "NotAuthorizedException" ||
      err.name === "UserNotFoundException"
    ) {
      return jsonResponse(401, {
        success: false,
        error: "Incorrect email or password",
      });
    }

    if (err.name === "UserNotConfirmedException") {
      return jsonResponse(403, {
        success: false,
        error: "Please verify your email before signing in",
      });
    }

    if (
      err.name === "CodeMismatchException" ||
      err.name === "ExpiredCodeException"
    ) {
      return jsonResponse(401, {
        success: false,
        error: "The verification code is incorrect or expired",
      });
    }

    console.error("Sign-in error:", err);
    return jsonResponse(500, {
      success: false,
      error: "Internal server error",
    });
  }
};
