import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { useSnapshot } from "./api";
import { StudioProvider } from "./studio";
import { Board } from "./views/Board";
import { Lanes } from "./views/Lanes";
import { Shell } from "./views/Shell";
import "./styles.css";

interface Search {
  readonly select?: string;
}

function Root() {
  const { data, error, isPending } = useSnapshot();
  const search = useSearch({ from: rootRoute.id });
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | undefined) => void navigate({ to: ".", search: (previous: Search) => ({ ...previous, select: id }) }),
    [navigate],
  );
  if (isPending) return <p className="empty">Evaluating the repository's configuration…</p>;
  if (error || !data) {
    return <p className="empty">The studio server did not answer: {error instanceof Error ? error.message : "no snapshot"}. Restart it with npm run studio.</p>;
  }
  return (
    <StudioProvider response={data} selected={search.select} select={select}>
      <Shell>
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
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Board });
const lanesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/lanes", component: Lanes });
const router = createRouter({ routeTree: rootRoute.addChildren([boardRoute, lanesRoute]) });

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
