import { useEffect, useState } from "react";
import type { ModelRoute, ModelTarget } from "../../shared/model";
import { useStudio } from "../studio";

function HttpRouteRow({ route }: { readonly route: ModelRoute }) {
  const { previewRoute, live, model } = useStudio();
  const [draft, setDraft] = useState(route.path);
  const [checking, setChecking] = useState(false);
  useEffect(() => setDraft(route.path), [route.path]);
  const submit = async () => {
    setChecking(true);
    try { await previewRoute(route.id, draft); }
    finally { setChecking(false); }
  };
  return <form className="http-route-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label className="resource-control"><span>Route path</span><input aria-label={`HTTP route ${route.path}`} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} disabled={checking || live.evaluating || model.stale} /></label>
    <p className="small muted">Browser path: <code>/api{draft}</code></p>
    <button className="primary" type="submit" disabled={draft === route.path || !draft.startsWith("/") || checking || live.evaluating || model.stale}>{checking ? "Checking…" : "Preview route change"}</button>
  </form>;
}

export function HttpRoutes({ target }: { readonly target: ModelTarget }) {
  const { model } = useStudio();
  const routes = model.routes.filter((route) => route.kind === "http" && route.target === target.ref);
  if (target.kind !== "lambda" || !routes.length) return null;
  return <section><h3>HTTP routes</h3>{routes.map((route) => <HttpRouteRow key={route.id} route={route} />)}</section>;
}
