import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { networkFixtureIds } from "../../shared/descriptions";
import { aggregateConnections } from "../connections";
import {
  captureInspectorPresentation,
  restoreInspectorPresentation,
} from "../inspector-navigation";
import { inspectorPanelClasses, inspectorContentClasses } from "../inspector-ui";
import { useStudio } from "../studio";
import { iconButtonClasses } from "../ui/IconButton";
import { ConnectionMap } from "./ConnectionMap";
import { DraftFooter } from "./DraftControls";
import { GatewayView } from "./GatewayView";
import { StackInfrastructure } from "./Infrastructure";
import { ConnectionView } from "./InputRequirement";
import { InspectorNavigationControls } from "./InspectorNavigation";
import { IslandInspector } from "./IslandInspector";
import { ManagedDatabaseInspector } from "./ManagedDatabaseInspector";
import { SchemaDetails } from "./SchemaDetails";
import {
  LocalDatabaseView,
  NetworkFixtureView,
  ResourceView,
} from "./inspector/ResourceInspectors";
import { RouteView, TargetView } from "./inspector/WorkloadInspector";

/** The right-hand inspector beside Database. Isometric hosts the same content in its workspace panel. */
export function Inspector() {
  const { selected, select } = useStudio();
  if (!selected) return null;
  return (
    <aside
      className={inspectorPanelClasses}
      aria-label="Inspector"
      data-slot="inspector"
      data-inspector-context
    >
      <div
        className="flex justify-between items-center gap-2 flex-none [min-height:44px] p-[var(--space-1)_var(--space-4)_var(--space-1)_var(--panel-padding)] border-b border-rule text-graphite text-meta font-semibold"
        data-slot="inspector-toolbar"
      >
        <InspectorNavigationControls />
        <button
          className={iconButtonClasses({ variant: "quiet" })}
          onClick={() => select(undefined)}
          aria-label="Close the inspector"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <InspectorContent selected={selected} />
    </aside>
  );
}

/** Every section, setting, action and source link for one selection, with its pending-change footer. */
export function InspectorContent({ selected }: { readonly selected: string }) {
  const { index, snapshot, model, inspectorNavigation } = useStudio();
  const content = useRef<HTMLDivElement>(null);
  const memory = inspectorNavigation.presentation;
  useLayoutEffect(() => {
    const element = content.current!;
    const focus = inspectorNavigation.restore
      ? restoreInspectorPresentation(element, memory)
      : undefined;
    if (inspectorNavigation.restore || inspectorNavigation.focus) {
      const back = element
        .closest("aside")
        ?.querySelector<HTMLElement>('[data-ui="workspace-panel-back"]');
      focus?.focus({ preventScroll: true });
      if (!focus || document.activeElement !== focus) back?.focus({ preventScroll: true });
    }
    const remember = () => captureInspectorPresentation(element, memory);
    element.addEventListener("toggle", remember, true);
    return () => {
      remember();
      element.removeEventListener("toggle", remember, true);
    };
  }, [selected, inspectorNavigation.key, memory]);
  const gateway = index.gateways.get(selected);
  const target = index.targets.get(selected);
  const route = index.routes.get(selected);
  const resource = index.resources.get(selected);
  const localDatabase = index.localServices.get(selected);
  const connection = model.edges.find((edge) => edge.id === selected);
  const groupedConnection = aggregateConnections(model, Object.values(snapshot.models)).find(
    (group) => group.id === selected,
  );
  // The map also draws the other environment's own connections, faintly marked; selecting one opens it here.
  const otherLens = connection
    ? undefined
    : (["dev", "prod"] as const)
        .filter((candidate) => candidate !== model.mode)
        .map((candidate) => ({
          mode: candidate,
          edge: snapshot.models[candidate].edges.find((edge) => edge.id === selected),
        }))
        .find((entry) => entry.edge);
  const schemaEntity =
    snapshot.schema.tables.some((table) => table.id === selected) ||
    snapshot.schema.relations.some((relation) => relation.id === selected);
  const island = selected.startsWith("island:");
  const fixture = (model.networks ?? []).flatMap(networkFixtureIds).includes(selected);
  return (
    <>
      <div
        className={inspectorContentClasses}
        key={selected}
        data-slot="inspector-content"
        ref={content}
        onFocusCapture={() => {
          if (content.current) captureInspectorPresentation(content.current, memory);
        }}
        onScroll={() => {
          if (content.current) captureInspectorPresentation(content.current, memory);
        }}
      >
        {gateway ? <GatewayView gateway={gateway} /> : null}
        {target ? <TargetView target={target} /> : null}
        {route ? <RouteView route={route} /> : null}
        {resource ? (
          resource.id === model.managedDatabase?.resource ? (
            <ManagedDatabaseInspector resource={resource} />
          ) : (
            <ResourceView resource={resource} />
          )
        ) : null}
        {groupedConnection && groupedConnection.members.length > 1 ? (
          <ConnectionMap connection={groupedConnection} />
        ) : connection ? (
          <ConnectionView edge={connection} availability={groupedConnection?.availability} />
        ) : otherLens?.edge ? (
          <ConnectionView
            edge={otherLens.edge}
            onlyIn={otherLens.mode}
            availability={groupedConnection?.availability}
          />
        ) : null}
        {localDatabase ? (
          model.managedDatabase ? (
            <ManagedDatabaseInspector local={localDatabase} />
          ) : (
            <LocalDatabaseView database={localDatabase} />
          )
        ) : null}
        {schemaEntity ? <SchemaDetails /> : null}
        {island ? <IslandInspector id={selected} key={selected} /> : null}
        {fixture ? <NetworkFixtureView id={selected} /> : null}
        {resource?.kind === "stack" && !resource.frameworkStack ? (
          <StackInfrastructure id={resource.id} />
        ) : null}
        {!gateway &&
        !target &&
        !route &&
        !resource &&
        !connection &&
        !groupedConnection &&
        !otherLens &&
        !localDatabase &&
        !schemaEntity &&
        !island &&
        !fixture ? (
          <p className="mt-0 mb-2 px-6 py-10 text-graphite">{selected} is not in this graph.</p>
        ) : null}
      </div>
      <DraftFooter />
    </>
  );
}
