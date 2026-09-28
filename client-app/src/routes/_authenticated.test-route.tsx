import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/test-route")({
  component: AuthenticatedTestRoute,
});

function AuthenticatedTestRoute() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Authenticated test route
      </h1>
      <p className="mt-1.5 text-sm text-muted">
        A second protected page, here to prove the guard and the layout apply to
        the whole subtree.
      </p>
      <Link
        to="/"
        className="mt-8 inline-flex items-center gap-1.5 text-sm link"
      >
        <ArrowLeft className="size-4" />
        Back to home
      </Link>
    </div>
  );
}
