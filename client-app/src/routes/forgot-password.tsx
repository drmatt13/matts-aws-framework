import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import Button from "#/components/Button";
import LoginLayout from "#/components/layouts/LoginLayout";

import {
  redirectIfAuthenticated,
  forgotPasswordUser,
  confirmForgotPasswordUser,
} from "#/lib/auth";

// The user pool's rule (cdk-app/lib/app/cognito-stack.ts): length, not
// character classes.
const PASSWORD_POLICY_REGEX = /^.{12,}$/u;
const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 12 characters.";

export const Route = createFileRoute("/forgot-password")({
  beforeLoad: redirectIfAuthenticated,
  validateSearch: (search) => ({
    email: (search.email as string) || "",
    code: (search.code as string) || "",
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const { email: emailFromUrl, code: codeFromUrl } = Route.useSearch();

  const [step, setStep] = useState<"request" | "reset">(
    codeFromUrl ? "reset" : "request",
  );
  const [email, setEmail] = useState(emailFromUrl);
  const [code, setCode] = useState(codeFromUrl);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setStatus("Please enter your email address.");
      return;
    }

    setIsSubmitting(true);
    setStatus(null);
    setSuccessMessage(null);

    try {
      await forgotPasswordUser(email.trim());
      setSuccessMessage(
        `If an account exists for ${email.trim()}, a reset code has been sent.`,
      );
      setStep("reset");
    } catch (error) {
      // For security, don't reveal if user exists
      setSuccessMessage(
        `If an account exists for ${email.trim()}, a reset code has been sent.`,
      );
      setStep("reset");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setSuccessMessage(null);

    if (!code.trim()) {
      setStatus("Please enter the reset code.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setStatus("Passwords do not match.");
      return;
    }

    if (!PASSWORD_POLICY_REGEX.test(newPassword)) {
      setStatus(PASSWORD_POLICY_MESSAGE);
      return;
    }

    setIsSubmitting(true);

    try {
      await confirmForgotPasswordUser(email.trim(), code.trim(), newPassword);
      setSuccessMessage(
        "Password reset successfully. Redirecting to sign in...",
      );
      setStatus(null);
      setTimeout(() => {
        navigate({
          to: "/login",
          search: {
            email: email.trim().toLowerCase(),
            "account-verified": undefined,
          },
        });
      }, 1500);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Failed to reset password.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <LoginLayout
      title="Reset your password"
      subtitle={
        step === "request"
          ? "Enter your email and we'll send you a reset code"
          : "Enter the code and your new password"
      }
      footer={
        <>
          Remember your password?{" "}
          <Link
            to="/login"
            search={{ "account-verified": undefined, email: undefined }}
            className="link"
          >
            Back to sign in
          </Link>
        </>
      }
    >
      {(successMessage || status) && (
        <div className="mt-5 space-y-3">
          {successMessage && (
            <p className="alert alert-ok">{successMessage}</p>
          )}
          {status && <p className="alert alert-bad">{status}</p>}
        </div>
      )}

      {step === "request" && (
        <form onSubmit={handleRequestReset} className="mt-6 space-y-4">
          <div>
            <label htmlFor="forgot-password-email" className="label">
              Email
            </label>
            <input
              type="email"
              id="forgot-password-email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
              placeholder="name@firm.com"
            />
          </div>
          <Button
            submit={true}
            text={isSubmitting ? "Sending..." : "Send reset code"}
            fullWidth={true}
            style="primary"
            disabled={isSubmitting}
          />
        </form>
      )}

      {step === "reset" && (
        <form onSubmit={handleResetPassword} className="mt-6 space-y-4">
          <div>
            <label htmlFor="reset-email" className="label">
              Email
            </label>
            <input
              type="email"
              id="reset-email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
              placeholder="name@firm.com"
            />
          </div>
          <div>
            <label htmlFor="reset-code" className="label">
              Reset code
            </label>
            <input
              type="text"
              id="reset-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="field"
              placeholder="Enter 6-digit code"
            />
          </div>
          <div>
            <label htmlFor="reset-new-password" className="label">
              New password
            </label>
            <input
              type="password"
              id="reset-new-password"
              autoComplete="new-password"
              required
              minLength={12}
              title={PASSWORD_POLICY_MESSAGE}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="field"
              placeholder="••••••••"
            />
          </div>
          <div>
            <label htmlFor="reset-confirm-password" className="label">
              Confirm new password
            </label>
            <input
              type="password"
              id="reset-confirm-password"
              autoComplete="new-password"
              required
              minLength={12}
              title={PASSWORD_POLICY_MESSAGE}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="field"
              placeholder="••••••••"
            />
          </div>
          <Button
            submit={true}
            text={isSubmitting ? "Resetting..." : "Reset password"}
            fullWidth={true}
            style="primary"
            disabled={isSubmitting}
          />
          <Button
            text="Resend reset code"
            style="secondary"
            fullWidth={true}
            onClick={() => {
              setStep("request");
              setCode("");
              setStatus(null);
              setSuccessMessage(null);
            }}
          />
        </form>
      )}
    </LoginLayout>
  );
}
