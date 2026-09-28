import {
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  CognitoIdentityProviderClient,
  CognitoIdentityProviderServiceException,
  ForgotPasswordCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognitoClient = new CognitoIdentityProviderClient({
  region: import.meta.env.VITE_AWS_REGION,
});
const userPoolClientId = import.meta.env.VITE_USER_POOL_CLIENT_ID;

function mapSignUpError(error: unknown): string {
  if (!(error instanceof CognitoIdentityProviderServiceException)) {
    return "Failed to create account.";
  }

  switch (error.name) {
    case "UsernameExistsException":
      return "An account with this email already exists.";
    case "InvalidPasswordException":
      return "Password does not meet Cognito password requirements.";
    case "InvalidParameterException":
      return error.message || "One or more signup fields are invalid.";
    case "NotAuthorizedException":
      if (error.message?.toLowerCase().includes("secret hash")) {
        return "This Cognito app client requires a client secret. Use a public (no-secret) app client for browser signup, or perform signup on your backend.";
      }
      return error.message || "Sign up is not authorized for this app client.";
    default:
      return error.message || "Failed to create account.";
  }
}

function mapConfirmSignUpError(error: unknown): string {
  if (!(error instanceof CognitoIdentityProviderServiceException)) {
    return "Failed to verify your account.";
  }

  switch (error.name) {
    case "CodeMismatchException":
      return "Invalid verification code. Please try again.";
    case "ExpiredCodeException":
      return "Verification code has expired. Please request a new one.";
    case "TooManyFailedAttemptsException":
      return "Attempt limit exceeded. Please wait a few minutes and try again.";
    case "LimitExceededException":
      return "Attempt limit exceeded. Please request a new code and try again shortly.";
    case "TooManyRequestsException":
      return "Too many requests. Please wait a moment and try again.";
    case "NotAuthorizedException":
      return "Your account is already verified. Please sign in.";
    case "UserNotFoundException":
      return "Account not found. Please register first.";
    default:
      return error.message || "Failed to verify your account.";
  }
}

function mapResendCodeError(error: unknown): string {
  if (!(error instanceof CognitoIdentityProviderServiceException)) {
    return "Failed to resend verification code.";
  }

  switch (error.name) {
    case "TooManyRequestsException":
    case "LimitExceededException":
      return "Too many resend attempts. Please wait a bit before trying again.";
    case "UserNotFoundException":
      return "Account not found. Please register first.";
    default:
      return error.message || "Failed to resend verification code.";
  }
}

export async function signUpUser(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
) {
  const normalizedEmail = email.trim().toLowerCase();
  const command = new SignUpCommand({
    ClientId: userPoolClientId,
    Username: normalizedEmail,
    Password: password,
    UserAttributes: [
      { Name: "email", Value: normalizedEmail },
      { Name: "given_name", Value: firstName.trim() },
      { Name: "family_name", Value: lastName.trim() },
    ],
  });

  try {
    return await cognitoClient.send(command);
  } catch (error) {
    console.error("Raw Cognito signup error:", error);
    throw new Error(mapSignUpError(error));
  }
}

export async function confirmSignUpUser(usernameOrEmail: string, code: string) {
  const command = new ConfirmSignUpCommand({
    ClientId: userPoolClientId,
    Username: usernameOrEmail.trim().toLowerCase(),
    ConfirmationCode: code.trim(),
  });

  try {
    return await cognitoClient.send(command);
  } catch (error) {
    console.error("Raw Cognito confirm-signup error:", error);
    throw new Error(mapConfirmSignUpError(error));
  }
}

export async function resendConfirmationCodeUser(usernameOrEmail: string) {
  const command = new ResendConfirmationCodeCommand({
    ClientId: userPoolClientId,
    Username: usernameOrEmail.trim().toLowerCase(),
  });

  try {
    return await cognitoClient.send(command);
  } catch (error) {
    console.error("Raw Cognito resend-code error:", error);
    throw new Error(mapResendCodeError(error));
  }
}

export async function forgotPasswordUser(email: string) {
  const command = new ForgotPasswordCommand({
    ClientId: userPoolClientId,
    Username: email.trim().toLowerCase(),
  });

  try {
    return await cognitoClient.send(command);
  } catch (error) {
    if (error instanceof CognitoIdentityProviderServiceException) {
      switch (error.name) {
        case "UserNotFoundException":
          throw new Error(
            "If an account with that email exists, a reset code has been sent.",
          );
        case "LimitExceededException":
        case "TooManyRequestsException":
          throw new Error(
            "Too many attempts. Please wait a bit before trying again.",
          );
        default:
          throw new Error(
            error.message || "Failed to send password reset code.",
          );
      }
    }
    throw new Error("Failed to send password reset code.");
  }
}

export async function confirmForgotPasswordUser(
  email: string,
  code: string,
  newPassword: string,
) {
  const command = new ConfirmForgotPasswordCommand({
    ClientId: userPoolClientId,
    Username: email.trim().toLowerCase(),
    ConfirmationCode: code.trim(),
    Password: newPassword,
  });

  try {
    return await cognitoClient.send(command);
  } catch (error) {
    if (error instanceof CognitoIdentityProviderServiceException) {
      switch (error.name) {
        case "CodeMismatchException":
          throw new Error("Invalid reset code. Please try again.");
        case "ExpiredCodeException":
          throw new Error("Reset code has expired. Please request a new one.");
        case "InvalidPasswordException":
          throw new Error(
            "Password does not meet requirements. Use at least 12 characters.",
          );
        case "LimitExceededException":
        case "TooManyRequestsException":
          throw new Error(
            "Too many attempts. Please wait a bit before trying again.",
          );
        case "UserNotFoundException":
          throw new Error("Account not found. Please register first.");
        default:
          throw new Error(error.message || "Failed to reset password.");
      }
    }
    throw new Error("Failed to reset password.");
  }
}
