import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";

import AppLayout from "#/components/layouts/AppLayout";
import LoadingSpinner from "#/components/LoadingSpinner";
import SessionError from "#/components/errors/SessionError";
import { currentUserQuery } from "#/api/currentUser/operations";
import {
  getAuthSnapshot,
  isAuthServiceUnavailableError,
  isSessionExpiredError,
  requireAuth,
  subscribeAuthState,
} from "#/lib/auth";

/**
 * Pathless layout route owning the guard and every auth failure state for the
 * protected subtree. Child routes declare no `beforeLoad` of their own.
 */
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: requireAuth,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { data, isPending, error, refetch } = useQuery(currentUserQuery);

  // Auth failures arrive from two directions: pushed from the background
  // renewal timer via this snapshot, or pulled from a request that just threw.
  // Reading both means the UI reacts either way.
  const authState = useSyncExternalStore(
    subscribeAuthState,
    getAuthSnapshot,
    getAuthSnapshot,
  );

  if (authState.status === "expired" || isSessionExpiredError(error)) {
    return <SessionError kind="expired" />;
  }

  // Signed out, here or in another tab. The cache is already gone (see
  // lib/queryClient.ts); nothing below this layout may render without a user.
  if (authState.status === "signed-out") {
    return (
      <Navigate
        to="/login"
        search={{ email: undefined, "account-verified": undefined }}
        replace
      />
    );
  }

  if (
    authState.status === "reconnect-required" ||
    isAuthServiceUnavailableError(error)
  ) {
    return (
      <SessionError
        kind="unavailable"
        onRetry={async () => {
          await refetch();
        }}
      />
    );
  }

  if (isPending) {
    return (
      <div className="app-stage flex items-center justify-center text-muted">
        <LoadingSpinner />
      </div>
    );
  }

  // The session is valid but the user is not: retrying alone can loop forever
  // on a permanent failure, so this state also offers a way to sign out.
  if (error || !data) {
    return (
      <SessionError
        kind="account"
        onRetry={async () => {
          await refetch();
        }}
      />
    );
  }

  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  );
}
