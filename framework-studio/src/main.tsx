/// <reference types="vite/client" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { useSnapshot } from "./api";
import { StudioProvider } from "./studio";
import { Shell } from "./views/Shell";
// This stylesheet also styles shared inspector controls. Preserve its original
// cascade order while loading the Deploy component only when its route opens.
import "./views/deploy/deploy.css";
import "./styles.css";
import "./inspector.css";
import "./views/database-workbench.css";
import "./views/prisma-editor.css";
import "./views/stateful-resources.css";

interface Search {
  readonly select?: string;
}

// An exported component gives the entry a React Refresh boundary.
export function Root() {
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
const databaseRoute = createRoute({ getParentRoute: () => rootRoute, path: "/database", component: lazyRouteComponent(() => import("./views/Database"), "Database") });
const deployRoute = createRoute({ getParentRoute: () => rootRoute, path: "/deploy", component: lazyRouteComponent(() => import("./views/Deploy"), "Deploy") });
const cognitoRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cognito", component: lazyRouteComponent(() => import("./views/AuthenticationWorkspace"), "AuthenticationWorkspace") });
const userPoolsRoute = createRoute({ getParentRoute: () => cognitoRoute, path: "user-pools", component: () => null });
const identityPoolsRoute = createRoute({ getParentRoute: () => cognitoRoute, path: "identity-pools", component: () => null });
const providersRoute = createRoute({ getParentRoute: () => cognitoRoute, path: "providers", component: () => null });
const permissionsRoute = createRoute({ getParentRoute: () => cognitoRoute, path: "permissions", component: () => null });
const identityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/identity-pools", beforeLoad: () => { throw redirect({ to: "/cognito/identity-pools", replace: true }); } });
const legacyIdentityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/identity", beforeLoad: () => { throw redirect({ to: "/cognito/identity-pools", replace: true }); } });
const domainsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/domains", component: lazyRouteComponent(() => import("./views/IdentityWorkspace"), "Domains") });
const routeTree = rootRoute.addChildren([boardRoute, isometricRoute, databaseRoute, deployRoute, cognitoRoute.addChildren([userPoolsRoute, identityPoolsRoute, providersRoute, permissionsRoute]), identityRoute, legacyIdentityRoute, domainsRoute]);
function createStudioRouter() { return createRouter({ routeTree }); }
interface Application {
  readonly root: ReturnType<typeof createRoot>;
  readonly queryClient: QueryClient;
  readonly router: ReturnType<typeof createStudioRouter>;
}
const previous = import.meta.hot?.data.application as Application | undefined;
const router = previous?.router ?? createStudioRouter();
if (previous) router.update({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const application = previous ?? { root: createRoot(document.getElementById("root")!), queryClient: new QueryClient(), router };
if (import.meta.hot) {
  // Replacing an entry must retain React ownership, caches and the mounted draft.
  // React Refresh updates components; unmount only when the entry is removed.
  import.meta.hot.dispose(data => { data.application = application; });
  import.meta.hot.prune(() => {
    application.root.unmount();
    application.queryClient.clear();
    application.router.history.destroy();
  });
}

if (!previous) application.root.render(
  <StrictMode>
    <QueryClientProvider client={application.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
