import { useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import Button from "#/components/Button";
import LoginLayout from "#/components/layouts/LoginLayout";
import {
  confirmSignUpUser,
  resendConfirmationCodeUser,
  redirectIfAuthenticated,
} from "#/lib/auth";

export const Route = createFileRoute("/verify-account")({
  beforeLoad: redirectIfAuthenticated,
  component: RouteComponent,
  validateSearch: (search) => ({
    code: (search.code as string) || "",
    email: (search.email as string) || "",
    username: (search.username as string) || "",
  }),
});

function RouteComponent() {
  const navigate = useNavigate();
  const { code: codeFromUrl, email, username } = Route.useSearch();

  const [manualCode, setManualCode] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >(codeFromUrl ? "loading" : "idle");
  const [message, setMessage] = useState(
    codeFromUrl ? "Verifying your account..." : "",
  );
  const [resendStatus, setResendStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!codeFromUrl) return;

    const signInIdentifier = username.trim() || email.trim().toLowerCase();

    if (!signInIdentifier) {
      setStatus("error");
      setMessage("Missing account identifier. Please enter your code below.");
      return;
    }

    const verify = async () => {
      try {
        await confirmSignUpUser(signInIdentifier, String(codeFromUrl));
        setStatus("success");
        setMessage("Your account is verified. Redirecting to sign in...");
        setTimeout(() => {
          navigate({
            to: "/login",
            replace: true,
            search: { email, "account-verified": true },
          });
        }, 1500);
      } catch (error) {
        setStatus("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "Failed to verify your account.",
        );
      }
    };

    void verify();
  }, [codeFromUrl, email, navigate, username]);

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedCode = manualCode.trim();
    const signInIdentifier = username.trim() || email.trim().toLowerCase();

    if (!trimmedCode) {
      setStatus("error");
      setMessage("Please enter the verification code.");
      return;
    }

    if (!signInIdentifier) {
      setStatus("error");
      setMessage("Missing account identifier.");
      return;
    }

    setIsSubmitting(true);
    setStatus("loading");
    setMessage("Verifying your account...");

    try {
      await confirmSignUpUser(signInIdentifier, trimmedCode);
      setStatus("success");
      setMessage("Your account is verified. Redirecting to sign in...");
      setTimeout(() => {
        navigate({
          to: "/login",
          replace: true,
          search: { email, "account-verified": true },
        });
      }, 1500);
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to verify your account.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResendCode = async () => {
    const signInIdentifier = username.trim() || email.trim().toLowerCase();
    if (!signInIdentifier) {
      setResendStatus(
        "Unable to resend code because account identifier is missing.",
      );
      return;
    }

    setResendStatus("Resending verification code...");
    try {
      await resendConfirmationCodeUser(signInIdentifier);
      setResendStatus(
        `A new verification code was sent to ${email || signInIdentifier}.`,
      );
    } catch (error) {
      setResendStatus(
        error instanceof Error
          ? error.message
          : "Failed to resend verification code.",
      );
    }
  };

  const isPending = status === "loading" || status === "success";

  return (
    <LoginLayout
      title="Verify your account"
      subtitle={
        status === "loading"
          ? "Verifying your account..."
          : email
            ? `Enter the verification code sent to ${email}`
            : "Enter the verification code from your email"
      }
      footer={
        <>
          Already verified?{" "}
          <Link
            to="/login"
            search={{ email: undefined, "account-verified": undefined }}
            className="link"
          >
            Sign in
          </Link>
        </>
      }
    >
      {status === "success" && (
        <p className="alert alert-ok mt-5">{message}</p>
      )}
      {status === "error" && <p className="alert alert-bad mt-5">{message}</p>}

      {!isPending && (
        <>
          <form onSubmit={handleManualSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="verification-code" className="label">
                Verification code
              </label>
              <input
                type="text"
                id="verification-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                className="field"
                placeholder="Enter 6-digit code"
              />
            </div>
            <Button
              submit={true}
              fullWidth={true}
              text={isSubmitting ? "Verifying..." : "Verify account"}
              style="primary"
              disabled={isSubmitting}
            />
          </form>

          <div className="mt-5 text-center text-sm">
            <button
              type="button"
              onClick={handleResendCode}
              className="link cursor-pointer"
            >
              Resend verification code
            </button>
            {resendStatus && (
              <p className="mt-2 text-muted">{resendStatus}</p>
            )}
          </div>
        </>
      )}
    </LoginLayout>
  );
}
