import type { ModelRoute, ModelTarget } from "../../shared/model";
import { useStudio } from "../studio";

function HttpRouteRow({ route }: { readonly route: ModelRoute }) {
  const { draft, draftState, live, model } = useStudio();
  const value = draft.route(route.id);
  const entry = draftState.entries.find((entry) => entry.kind === "route" && entry.route === route.id);
  return <div className="http-route-editor">
    <label className="resource-control"><span>Route path</span><input aria-label={`HTTP route ${route.path}`} value={value} onChange={(event) => draft.setRoute(route.id, event.target.value)} spellCheck={false} aria-invalid={!!entry?.error} disabled={!!draftState.busy || live.evaluating || model.stale} /></label>
    <p className="small muted">Browser path: <code>/api{value}</code>{entry ? " · Unsaved change" : ""}</p>
    {entry?.error ? <p className="reason" role="alert">{entry.error}</p> : null}
  </div>;
}
export function HttpRoutes({ target }: { readonly target: ModelTarget }) {
  const { model } = useStudio();
  const routes = model.routes.filter((route) => route.kind === "http" && route.target === target.ref);
  return target.kind === "lambda" && routes.length ? <section><h3>HTTP routes</h3>{routes.map((route) => <HttpRouteRow key={route.id} route={route} />)}</section> : null;
}
