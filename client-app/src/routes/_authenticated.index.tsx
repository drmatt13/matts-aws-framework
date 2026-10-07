import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { currentUserQuery } from "#/api/currentUser/operations";
import AgentCorePanel from "#/components/AgentCorePanel";
import Button from "#/components/Button";
import EcsServicePanel from "#/components/EcsServicePanel";
import HttpLambdaPanel from "#/components/HttpLambdaPanel";
import InvocationTestPanel from "#/components/InvocationTestPanel";
import ProjectsPanel from "#/components/ProjectsPanel";
import SecurityPanel from "#/components/SecurityPanel";
import WorkflowsPanel from "#/components/WorkflowsPanel";
import { getCognitoIdToken } from "#/lib/auth";
import logout from "#/lib/logout";

// The guard, the layout chrome, and every auth/loading failure state belong to
// the _authenticated layout route, so this only renders the happy path.
export const Route = createFileRoute("/_authenticated/")({
  component: App,
});

function App() {
  const navigate = useNavigate();
  const idToken = getCognitoIdToken();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [testerLinkError, setTesterLinkError] = useState<string | null>(null);
  const wsTesterUrl = import.meta.env.VITE_WS_TESTER_URL as string | undefined;

  // `user` is undefined only while the query is pending.
  const { data: user } = useQuery(currentUserQuery);

  async function handleLogout() {
    setIsLoggingOut(true);

    try {
      await logout();
      await navigate({
        to: "/login",
        replace: true,
        search: { email: undefined, "account-verified": undefined },
      });
    } finally {
      setIsLoggingOut(false);
    }
  }

  function openWebSocketTester(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const token = getCognitoIdToken();
    if (!token || !wsTesterUrl) {
      setTesterLinkError("The WebSocket tester URL or your sign-in token is unavailable.");
      return;
    }

    const destination = new URL(wsTesterUrl);
    destination.hash = new URLSearchParams({ token }).toString();
    window.open(destination.toString(), "_blank", "noopener,noreferrer");
    setTesterLinkError(null);
  }

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome, {user?.firstName}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            You are signed in. This page is your starting point.
          </p>
        </div>
        <Button
          text={isLoggingOut ? "Logging out..." : "Log out"}
          style="secondary"
          onClick={handleLogout}
          disabled={isLoggingOut}
        />
      </header>

      <section className="card mt-8">
        <h2 className="text-sm font-semibold">Session</h2>
        <dl className="mt-4 space-y-4">
          <div>
            <dt className="text-xs font-medium tracking-wider text-muted uppercase">
              User ID
            </dt>
            <dd className="mt-1.5 w-max max-w-full rounded-lg bg-ink/5 px-3 py-2 font-mono text-sm break-all">
              {user?.id}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wider text-muted uppercase">
              Cognito ID token
            </dt>
            {/* Capped and scrollable -- a JWT is long enough to eat the page. */}
            <dd className="mt-1.5 max-h-32 overflow-y-auto rounded-lg bg-ink/5 px-3 py-2 font-mono text-xs leading-relaxed break-all">
              {idToken}
            </dd>
          </div>
        </dl>
      </section>

      <a
        href={wsTesterUrl || "#"}
        target="_blank"
        rel="noopener noreferrer"
        onClick={openWebSocketTester}
        className="card mt-4 flex items-center justify-between gap-4 transition hover:border-brand/40"
      >
        <span>
          <span className="text-sm font-medium">WebSocket tester</span>
          <span className="mt-0.5 block text-sm text-muted">
            Open the connection and payload tester with your sign-in token.
          </span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted" />
      </a>
      {testerLinkError && <p role="alert" className="alert alert-bad mt-2">{testerLinkError}</p>}

      <Link
        to="/test-route"
        className="card mt-4 flex items-center justify-between gap-4 transition hover:border-brand/40"
      >
        <span>
          <span className="text-sm font-medium">Authenticated test route</span>
          <span className="mt-0.5 block text-sm text-muted">
            Check that the guard covers the whole protected subtree.
          </span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted" />
      </Link>

      <SecurityPanel />

      <ProjectsPanel />

      <HttpLambdaPanel />

      <EcsServicePanel />

      <WorkflowsPanel />

      <InvocationTestPanel />

      <AgentCorePanel />
    </div>
  );
}
