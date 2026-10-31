import { inspectorSectionClasses, inspectorHeaderClasses } from "../inspector-ui";

import { EntityName } from "./EntityName";
import { buttonClasses } from "../ui/Button";
import { NetworkControls } from "./NetworkControls";
import { useMemo } from "react";
import { catalogAvailability } from "../deployment";
import { buildScene } from "../scene/build";
import { useStudio } from "../studio";
import { InspectorDisclosure, InspectorKind, InspectorSection } from "./InspectorUI";
import { InfrastructurePanel } from "./Infrastructure";
import { SharedDefaults } from "./SharedDefaults";
import { FrameworkManagedStatus, ResourceStatus } from "./ResourceStatus";
import { RouteStatus } from "./RouteStatus";
import { Description } from "./Description";
import {
  CLIENT_ENVIRONMENT_ISLAND,
  ENVIRONMENT_FILES_ISLAND,
} from "../../shared/client-environment";
import { Tags } from "./Tags";
import { DeploymentSection, DeploymentOwnership } from "./Deployment";

const LAMBDAS = ["lambda", "http", "webSocket", "events", "tools"];
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "island:apis": ["http", "webSocket", "container"],
  "island:lambda": LAMBDAS,
  "island:agentcore": ["tools"],
};

/** Island membership comes from the same layout as the canvas, never a second graph. */
export function IslandInspector({ id: selection }: { readonly id: string }) {
  const id = selection === CLIENT_ENVIRONMENT_ISLAND ? ENVIRONMENT_FILES_ISLAND : selection;
  const { model, snapshot, select, index, mode, draft, draftState, live } = useStudio();
  const scene = useMemo(
    () =>
      buildScene(model, {
        resourceAvailability: catalogAvailability(snapshot.models),
        conditions: Object.fromEntries(
          Object.entries(snapshot.source.catalog).map(([key, value]) => [key, value.condition]),
        ),
      }),
    [model, snapshot.models, snapshot.source.catalog],
  );
  const island = scene.islands.find((island) => island.id === id);
  const members = scene.nodes.filter((node) => node.island === id);
  const resources = catalogAvailability(snapshot.models);
  const groups = GROUPS[id] ?? [];
  const network = id.startsWith("island:vpc:");
  const availability = network
    ? {
        dev: false,
        prod: !!snapshot.models.prod.networks?.find((item) => id === `island:vpc:${item.id}`)
          ?.builtInProd,
      }
    : {
        dev: members.some((node) =>
          node.lanes ? node.lanes.local || node.lanes.dev : resources[node.id]?.dev,
        ),
        prod: members.some((node) => (node.lanes ? node.lanes.prod : resources[node.id]?.prod)),
      };
  if (!island)
    return (
      <p className="mt-0 mb-2 px-6 py-10 text-graphite">
        This island has no entries in this environment.
      </p>
    );
  const entries = (
    <InspectorDisclosure title="Island entries" count={members.length}>
      <ul className="p-0 list-none m-0" data-slot="island-members">
        {members.map((node) => {
          const route = index.routes.get(node.id);
          const resource = index.resources.get(node.id);
          return (
            <li className="m-0 grid gap-0.75 border-b border-rule py-2.5" key={node.id}>
              <button
                className={buttonClasses({ variant: "link" })}
                onClick={() => select(node.id)}
              >
                {resource?.clientEnvironment ? "client-app/.env" : node.label}
              </button>
              <span className="text-caption text-graphite">{node.kindLabel}</span>
              <ResourceStatus resource={resource} placement="inline" />
              {route ? <RouteStatus route={route} placement="inline" /> : null}
            </li>
          );
        })}
      </ul>
    </InspectorDisclosure>
  );
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind>Island settings</InspectorKind>
        <EntityName entity={id} fallback={island.title} />
        {network ? <FrameworkManagedStatus /> : null}
        <p className="last:mb-0 mt-0 mb-0 text-caption text-graphite">
          {members.length} {members.length === 1 ? "entry" : "entries"}
        </p>
      </header>
      <Tags entity={id} />
      <Description entity={id} />
      {id !== "island:inputs" && id !== "island:environment" && id !== CLIENT_ENVIRONMENT_ISLAND ? (
        <DeploymentSection
          availability={availability}
          locations={network ? { prod: "In AWS" } : undefined}
        >
          <DeploymentOwnership
            reason={
              network
                ? "Production creates this VPC when its database, native resources or enabled workloads require it. Configure those owners; local Compose networking remains shared."
                : "This island groups resources. Configure deployment on its entries."
            }
            owners={members
              .filter(
                (node) =>
                  model.targets.some((target) => target.ref === node.id) ||
                  model.resources.some((resource) => resource.id === node.id),
              )
              .map((node) => ({ id: node.id, title: node.label }))}
          />
        </DeploymentSection>
      ) : null}
      <NetworkControls id={id} />
      {id === "island:inputs" ? (
        <InspectorSection
          title="Add an input"
          description="Declare an input parameter or secret, then review the source changes. Environment values are configured separately."
        >
          <button
            className={buttonClasses({ variant: "quiet" })}
            disabled={
              !!draftState.busy ||
              live.evaluating ||
              Object.values(snapshot.models).some(
                (model) => model.stale || model.status === "error",
              )
            }
            onClick={() => draft.requestNavigation(() => draft.beginCreation("input"))}
          >
            Create input parameter or secret
          </button>
        </InspectorSection>
      ) : null}
      {id === "island:stacks" ? (
        <InspectorSection title="CDK infrastructure">
          <InfrastructurePanel key={mode} onNavigate={select} />
        </InspectorSection>
      ) : null}
      {groups.length ? (
        <SharedDefaults
          families={groups}
          note={
            id === "island:agentcore"
              ? "These defaults configure Lambda tools used by agents. AgentCore runtimes have individual settings."
              : undefined
          }
        />
      ) : id.startsWith("island:vpc:") ||
        id === "island:environment" ||
        id === "island:inputs" ||
        id === "island:stacks" ||
        id === CLIENT_ENVIRONMENT_ISLAND ? null : (
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Settings</h3>
          <p className="mt-0 mb-2 text-caption">
            The framework has no shared defaults for this island. Select an entry below to configure
            it.
          </p>
        </section>
      )}
      {entries}
    </>
  );
}
