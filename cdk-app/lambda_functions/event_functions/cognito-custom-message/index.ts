import { CustomMessageTriggerEvent } from "aws-lambda";

export const lambdaHandler = async (event: CustomMessageTriggerEvent) => {
  const email = event.request.userAttributes?.email ?? "";
  const username = event.userName;
  const code = event.request.codeParameter;
  const frontendUrl = (process.env.FRONTEND_URL ?? "")
    .trim()
    .replace(/\/+$/, "");

  if (!frontendUrl) {
    return event;
  }

  if (
    event.triggerSource === "CustomMessage_SignUp" ||
    event.triggerSource === "CustomMessage_ResendCode"
  ) {
    const verifyUrl =
      `${frontendUrl}/verify-account` +
      `?username=${encodeURIComponent(username)}` +
      `&email=${encodeURIComponent(email)}` +
      `&code=${code}`;

    event.response.emailSubject = "matt's-aws-framework - Verify your email";
    event.response.emailMessage = `
      <p>Click this link to verify your email address:</p>
      <p><a href="${verifyUrl}">Verify Email</a></p>
      <p>Your verification code is: <strong>${code}</strong></p>
      <p>If the link does not work, open the app and paste this code manually.</p>
    `;
  }

  if (event.triggerSource === "CustomMessage_ForgotPassword") {
    const resetUrl =
      `${frontendUrl}/forgot-password` +
      `?email=${encodeURIComponent(email)}` +
      `&code=${code}`;

    event.response.emailSubject =
      "matt's-aws-framework - Reset your password";
    event.response.emailMessage = `
      <p>We received a request to reset your password.</p>
      <p><a href="${resetUrl}">Reset Password</a></p>
      <p>Your reset code is: <strong>${code}</strong></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    `;
  }

  return event;
};
