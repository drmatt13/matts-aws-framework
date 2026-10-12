import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import Button from "#/components/Button";
import {
  prepareForReauthentication,
  retryAuthSession,
} from "#/lib/auth";
import logout from "#/lib/logout";

type SessionErrorProps = {
  // account: the session is valid but the signed-in user could not be loaded.
  kind: "expired" | "unavailable" | "account";
  onRetry?: () => Promise<void> | void;
};

const SessionError = ({ kind, onRetry }: SessionErrorProps) => {
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const handleSignIn = async () => {
    prepareForReauthentication();
    await navigate({
      to: "/login",
      replace: true,
      search: { email: undefined, "account-verified": undefined },
    });
  };

  // An account that will not load may never load: the login page redirects a
  // valid session straight back here, so signing out is the only way to reach
  // it without clearing cookies by hand.
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      await navigate({
        to: "/login",
        replace: true,
        search: { email: undefined, "account-verified": undefined },
      });
    } finally {
      setSigningOut(false);
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      if (kind === "account") {
        await onRetry?.();
        return;
      }
      const outcome = await retryAuthSession();
      if (outcome === "refreshed") await onRetry?.();
    } finally {
      setRetrying(false);
    }
  };

  if (kind === "account") {
    return (
      <div className="auth-stage">
        <div className="auth-card max-w-md text-center">
          <p className="text-lg font-semibold tracking-tight">
            We couldn't load your account
          </p>
          <p className="mt-2 text-sm text-muted">
            You are still signed in. Try again, or sign out and sign in with a
            different account.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <Button
              style="secondary"
              text={retrying ? "Trying again..." : "Try again"}
              disabled={retrying || signingOut}
              onClick={handleRetry}
            />
            <Button
              style="primary"
              text={signingOut ? "Signing out..." : "Sign out"}
              disabled={signingOut}
              onClick={handleSignOut}
            />
          </div>
        </div>
      </div>
    );
  }

  const expired = kind === "expired";

  return (
    <div className="auth-stage">
      <div className="auth-card max-w-md text-center">
        <p className="text-lg font-semibold tracking-tight">
          {expired ? "Your session has expired" : "We couldn't reconnect"}
        </p>
        <p className="mt-2 text-sm text-muted">
          {expired
            ? "Sign in again to continue. We'll return you to this page."
            : "Your session is still preserved. Check your connection or wait for the service to restart, then try again."}
        </p>
        <div className="mt-4 flex justify-center">
          {expired ? (
            <Button style="primary" text="Sign in again" onClick={handleSignIn} />
          ) : (
            <Button
              style="primary"
              text={retrying ? "Reconnecting..." : "Try again"}
              disabled={retrying}
              onClick={handleRetry}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default SessionError;
