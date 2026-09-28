import { useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import Button from "#/components/Button";
import LoginLayout from "#/components/layouts/LoginLayout";

import {
  consumeAuthNotice,
  consumePostAuthReturnTo,
  isSsoProviderEnabled,
  redirectIfAuthenticated,
  respondToMfaChallenge,
  signInUser,
  signInWithProvider,
  type SignInChallenge,
  type SsoProviderId,
} from "#/lib/auth";
import { SSO_PROVIDERS_UI } from "#/components/auth/ssoProviders";

export const Route = createFileRoute("/login")({
  beforeLoad: redirectIfAuthenticated,
  validateSearch: (search) => {
    const email = typeof search.email === "string" ? search.email : undefined;
    const accountVerified =
      search["account-verified"] === true ||
      search["account-verified"] === "true";

    return {
      email,
      "account-verified": accountVerified ? true : undefined,
    };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { email: userEmail, "account-verified": accountVerified } =
    Route.useSearch();
  const navigate = useNavigate();

  const [email, setEmail] = useState(userEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<SignInChallenge | null>(null);
  const [verificationCode, setVerificationCode] = useState("");

  useEffect(() => {
    if (consumeAuthNotice() === "session-expired") {
      setNotice(
        "Your session expired. Sign in again to continue where you left off.",
      );
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const result = challenge
        ? await respondToMfaChallenge(challenge, verificationCode, rememberMe)
        : await signInUser(email, password, rememberMe);

      if (!result.success) {
        if (result.challenge) {
          setChallenge(result.challenge);
          setPassword("");
          setError(result.error ?? null);
          return;
        }
        if (result.error === "USER_NOT_CONFIRMED") {
          await navigate({
            to: "/verify-account",
            search: {
              email: email.trim().toLowerCase(),
              username: email.trim().toLowerCase(),
              code: "",
            },
          });
          return;
        }
        setError(result.error ?? "Sign in failed");
        return;
      }

      // Cast: returnTo is a runtime string, which the route-tree-typed `to`
      // cannot prove. It is validated by isSafeReturnTo before being stored.
      const returnTo = consumePostAuthReturnTo();
      await navigate({ to: returnTo } as Parameters<typeof navigate>[0]);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleProviderSignIn(provider: SsoProviderId, name: string) {
    setError(null);

    try {
      await signInWithProvider(provider, rememberMe);
    } catch {
      setError(`${name} sign in is not configured yet.`);
    }
  }

  const enabledProviders = SSO_PROVIDERS_UI.filter((provider) =>
    isSsoProviderEnabled(provider.id),
  );
  const challengeMessage = challenge?.destination
    ? `Enter the verification code sent to ${challenge.destination}.`
    : challenge?.name === "SOFTWARE_TOKEN_MFA"
      ? "Enter the code from your authenticator app."
      : "Enter your verification code.";

  return (
    <LoginLayout
      title={challenge ? "Verify it's you" : "Welcome back"}
      subtitle={challenge ? challengeMessage : "Sign in to your workspace"}
      footer={
        challenge ? undefined : (
          <>
            Don't have an account?{" "}
            <Link to="/register" className="link">
              Register now
            </Link>
          </>
        )
      }
    >
      <form onSubmit={handleSubmit} id="login-form" className="mt-6 space-y-4">
        {accountVerified && (
          <p className="alert alert-ok">Account verified. You can sign in now.</p>
        )}
        {notice && (
          <p role="status" className="alert alert-info">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="alert alert-bad">
            {error}
          </p>
        )}

        {challenge ? (
          <div>
            <label htmlFor="verification-code" className="label">
              Verification code
            </label>
            <input
              type="text"
              id="verification-code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              className="field"
              placeholder="123456"
              autoFocus
            />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="email" className="label">
                Email
              </label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="field"
                placeholder="name@firm.com"
              />
            </div>
            <div>
              <label htmlFor="password" className="label">
                Password
              </label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="field"
                placeholder="••••••••"
              />
            </div>
          </>
        )}

        <div className="flex items-center justify-between gap-3 text-sm">
          <label className="flex items-center gap-2 text-muted select-none">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setRememberMe(e.target.checked)
              }
              className="size-4 rounded border-line accent-brand"
              aria-label="Remember me"
            />
            Remember me
          </label>
          {!challenge && (
            <Link
              to="/forgot-password"
              search={{ email: "", code: "" }}
              className="link"
            >
              Forgot password?
            </Link>
          )}
        </div>

        <Button
          submit={true}
          fullWidth={true}
          text={
            isSubmitting
              ? challenge
                ? "Verifying..."
                : "Signing in..."
              : challenge
                ? "Verify code"
                : "Sign in"
          }
          style="primary"
          disabled={isSubmitting}
        />

        {challenge ? (
          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              setVerificationCode("");
              setError(null);
            }}
            className="link block w-full cursor-pointer text-center text-sm"
          >
            Sign in with a different account
          </button>
        ) : (
          enabledProviders.length > 0 && (
            <>
              <div className="flex items-center gap-3 pt-1">
                <span className="h-px flex-1 bg-line" />
                <span className="text-xs tracking-wider text-muted uppercase">
                  or
                </span>
                <span className="h-px flex-1 bg-line" />
              </div>

              {enabledProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    void handleProviderSignIn(provider.id, provider.name);
                  }}
                  className="flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm font-medium shadow-xs transition hover:bg-ink/5"
                >
                  <provider.Icon />
                  {provider.label}
                </button>
              ))}
            </>
          )
        )}
      </form>
    </LoginLayout>
  );
}
