import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import LoginLayout from "#/components/layouts/LoginLayout";
import {
  completeOAuthSignIn,
  consumePostAuthReturnTo,
  redirectIfAuthenticated,
} from "#/lib/auth";

export const Route = createFileRoute("/auth/callback")({
  beforeLoad: redirectIfAuthenticated,
  validateSearch: (search) => ({
    code: typeof search.code === "string" ? search.code : "",
    error: typeof search.error === "string" ? search.error : "",
    error_description:
      typeof search.error_description === "string"
        ? search.error_description
        : "",
    state: typeof search.state === "string" ? search.state : "",
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const {
    code,
    error,
    error_description: errorDescription,
    state,
  } = Route.useSearch();
  const [message, setMessage] = useState("Completing sign in...");
  // Presentation only: decides between the spinner and the error styling.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;

    function fail(reason: string) {
      setFailed(true);
      setMessage(reason);
    }

    async function completeSignIn() {
      if (error) {
        fail(errorDescription || error);
        return;
      }

      if (!code || !state) {
        fail("Missing sign-in response. Please try again.");
        return;
      }

      try {
        const result = await completeOAuthSignIn(code, state);

        if (!active) {
          return;
        }

        if (!result.success) {
          fail(result.error ?? "Sign in failed.");
          return;
        }

        // Cast: returnTo is a runtime string the route-tree-typed `to` cannot
        // prove. isSafeReturnTo validates it on both write and read.
        const returnTo = consumePostAuthReturnTo();
        await navigate({ to: returnTo, replace: true } as Parameters<
          typeof navigate
        >[0]);
      } catch (caughtError) {
        if (!active) {
          return;
        }

        fail(
          caughtError instanceof Error ? caughtError.message : "Sign in failed.",
        );
      }
    }

    void completeSignIn();

    return () => {
      active = false;
    };
  }, [code, error, errorDescription, navigate, state]);

  return (
    <LoginLayout
      title={failed ? "We couldn't sign you in" : "Signing you in"}
      subtitle={failed ? undefined : "Finishing up with your provider."}
    >
      {failed ? (
        <p role="alert" className="alert alert-bad mt-5">
          {message}
        </p>
      ) : (
        <p className="mt-6 flex items-center gap-2.5 text-sm text-muted">
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          {message}
        </p>
      )}
    </LoginLayout>
  );
}
