import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { API_ROUTE } from "@repo/api-contract";
import { ArrowRight } from "lucide-react";

import { useCurrentUserQuery } from "#/api/currentUser/hooks";
import Button from "#/components/Button";
import ProjectsPanel from "#/components/ProjectsPanel";
import SecurityPanel from "#/components/SecurityPanel";
import WorkflowsPanel from "#/components/WorkflowsPanel";
import { FrameworkHttpApiFetch, getCognitoIdToken } from "#/lib/auth";
import logout from "#/lib/logout";

// The guard, the layout chrome, and every auth/loading failure state belong to
// the _authenticated layout route, so this only renders the happy path.
export const Route = createFileRoute("/_authenticated/")({
  component: App,
});

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;

  return typeof body?.error === "string"
    ? body.error
    : `Request failed with status ${response.status}.`;
}

function App() {
  const navigate = useNavigate();
  const idToken = getCognitoIdToken();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isRunningTask, setIsRunningTask] = useState(false);
  const [invocationStatus, setInvocationStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // `user` is undefined only while the query is pending.
  const { data: user } = useCurrentUserQuery();

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

  async function handleRunTask() {
    setIsRunningTask(true);
    setInvocationStatus(null);

    try {
      const response = await FrameworkHttpApiFetch(
        API_ROUTE["/test/run-task"],
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Hello from the client app!" }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));

      // A 202 is an acknowledgement, not a result. The container is still
      // running when this resolves, and its outcome is read from its logs.
      setInvocationStatus({
        type: "success",
        message: "Task submitted.",
      });
    } catch (error) {
      setInvocationStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to run task.",
      });
    } finally {
      setIsRunningTask(false);
    }
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

      <section className="card mt-4">
        <h2 className="text-sm font-semibold">Invocation test</h2>
        <p className="mt-1.5 text-sm text-muted">
          Submits the declared container task directly, without a workflow
          around it.
        </p>
        <div className="mt-4">
          <Button
            text={isRunningTask ? "Running task..." : "Run test task"}
            onClick={handleRunTask}
            disabled={isRunningTask}
          />
        </div>
        {invocationStatus && (
          <p
            role={invocationStatus.type === "error" ? "alert" : "status"}
            className={`alert mt-4 ${
              invocationStatus.type === "error" ? "alert-bad" : "alert-ok"
            }`}
          >
            {invocationStatus.message}
          </p>
        )}
      </section>

      <WorkflowsPanel />
    </div>
  );
}
