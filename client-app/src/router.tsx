import { Link, createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: DefaultNotFound,
  });

  return router;
}

function DefaultNotFound() {
  return (
    <main className="auth-stage">
      <div className="max-w-sm text-center">
        <p className="text-5xl font-semibold tracking-tight">404</p>
        <p className="mt-3 text-sm text-muted">
          This page does not exist or is no longer available.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm font-medium shadow-xs transition hover:bg-ink/5"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
