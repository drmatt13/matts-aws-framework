import { inspectorFieldClasses, inspectorNoteClasses } from "../inspector-ui";
import { TextInput } from "../ui/FormControls";

import { useId } from "react";
import type { ModelRoute, ModelTarget } from "../../shared/model";
import { useStudio } from "../studio";
import { InspectorSection } from "./InspectorUI";

function HttpRouteRow({ route }: { readonly route: ModelRoute }) {
  const id = useId();
  const { draft, draftState, live, model } = useStudio();
  const value = draft.route(route.id);
  const entry = draftState.entries.find(
    (entry) => entry.kind === "route" && entry.route === route.id,
  );
  return (
    <div className={inspectorFieldClasses} data-slot="http-route-editor">
      <label
        className="grid min-w-0 gap-1 text-label font-medium wrap-anywhere"
        data-slot="resource-control"
      >
        <span>Route path</span>
        <TextInput
          controlSize="panel"
          className="w-full"
          aria-label={`HTTP route ${route.path}`}
          aria-describedby={`${id}-path${entry?.error ? ` ${id}-error` : ""}`}
          value={value}
          onChange={(event) => draft.setRoute(route.id, event.target.value)}
          spellCheck={false}
          aria-invalid={!!entry?.error}
          disabled={!!draftState.busy || live.evaluating || model.stale}
        />
      </label>
      <p id={`${id}-path`} className={inspectorNoteClasses}>
        Browser path: <code>/api{value}</code>
        {entry ? " · Unsaved change" : ""}
      </p>
      {entry?.error ? (
        <p id={`${id}-error`} className="m-0 text-caption text-refuse wrap-anywhere" role="alert">
          {entry.error}
        </p>
      ) : null}
    </div>
  );
}
export function HttpRoutes({ target }: { readonly target: ModelTarget }) {
  const { model } = useStudio();
  const routes = model.routes.filter(
    (route) => route.kind === "http" && route.target === target.ref,
  );
  return target.kind === "lambda" && routes.length ? (
    <InspectorSection title="HTTP routes">
      {routes.map((route) => (
        <HttpRouteRow key={route.id} route={route} />
      ))}
    </InspectorSection>
  ) : null;
}
