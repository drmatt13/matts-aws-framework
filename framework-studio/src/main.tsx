import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { useSnapshot } from "./api";
import { StudioProvider } from "./studio";
import { Shell } from "./views/Shell";
import { Database } from "./views/Database";
// This stylesheet also styles shared inspector controls. Preserve its original
// cascade order while loading the Deploy component only when its route opens.
import "./views/deploy/deploy.css";
import "./styles.css";
import "./inspector.css";

interface Search {
  readonly select?: string;
}

function Root() {
  const { data, error, isPending, refetch, isFetching } = useSnapshot();
  const search = useSearch({ from: rootRoute.id });
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | undefined) => void navigate({ to: ".", search: (previous: Search) => ({ ...previous, select: id }) }),
    [navigate],
  );
  if (isPending) return <main className="startup-state" aria-busy="true"><h1>AWS Studio</h1><p role="status">Evaluating the repository’s configuration…</p><p className="small muted">Loading the Development and Production maps.</p></main>;
  if (!data) {
    return <main className="startup-state"><h1>Studio couldn’t load the configuration</h1><p role="alert">{error instanceof Error ? error.message : "The server returned no snapshot."}</p><p className="muted">Check that <code>npm run studio</code> is running in this checkout, then try again.</p><button className="primary" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Connecting…" : "Try again"}</button></main>;
  }
  return (
    <StudioProvider response={data} selected={search.select} select={select}>
      <Shell notice={error ? <><span role="status">Studio couldn’t refresh the configuration. Your current map and draft are preserved.</span><button className="quiet" disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Connecting…" : "Try again"}</button></> : undefined}>
        <Outlet />
      </Shell>
    </StudioProvider>
  );
}

const rootRoute = createRootRoute({
  component: Root,
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.select === "string" ? { select: search.select } : {},
});
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: lazyRouteComponent(() => import("./views/Board"), "Board") });
const isometricRoute = createRoute({ getParentRoute: () => rootRoute, path: "/isometric", component: lazyRouteComponent(() => import("./views/Isometric"), "Isometric") });
const databaseRoute = createRoute({ getParentRoute: () => rootRoute, path: "/database", component: Database });
const deployRoute = createRoute({ getParentRoute: () => rootRoute, path: "/deploy", component: lazyRouteComponent(() => import("./views/Deploy"), "Deploy") });
const router = createRouter({ routeTree: rootRoute.addChildren([boardRoute, isometricRoute, databaseRoute, deployRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
