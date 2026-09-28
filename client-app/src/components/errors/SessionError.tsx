import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import Button from "#/components/Button";
import {
  prepareForReauthentication,
  retryAuthSession,
} from "#/lib/auth";

type SessionErrorProps = {
  kind: "expired" | "unavailable";
  onRetry?: () => Promise<void> | void;
};

const SessionError = ({ kind, onRetry }: SessionErrorProps) => {
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);

  const handleSignIn = async () => {
    prepareForReauthentication();
    await navigate({
      to: "/login",
      replace: true,
      search: { email: undefined, "account-verified": undefined },
    });
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const outcome = await retryAuthSession();
      if (outcome === "refreshed") await onRetry?.();
    } finally {
      setRetrying(false);
    }
  };

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
