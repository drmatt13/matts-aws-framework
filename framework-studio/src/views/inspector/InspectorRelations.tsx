import type { ModelEdge } from "../../../shared/model";
import { presentRelationship } from "../../connection-presentation";
import { edgeAvailability } from "../../connections";
import { inspectorRelationListClasses, inspectorRelationRowClasses } from "../../inspector-ui";
import { endpointLabel } from "../../lookup";
import { useStudio } from "../../studio";
import { buttonClasses } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { EnvironmentPills } from "../DeploymentBadge";
import { InspectorDisclosure } from "../InspectorUI";

export function Relations(props: { readonly id: string }) {
  const { index, select, snapshot } = useStudio();
  // A stack's fields and a group's entries share their owner's building and connections.
  const owner = ["stack", "group"].includes(index.resources.get(props.id)?.kind ?? "");
  const owns = (id: string) => id === props.id || (owner && id.startsWith(`${props.id}.`));
  const edges = [
    ...new Map(
      [...index.edges.entries()]
        .filter(([id]) => owns(id))
        .flatMap(([, edges]) => edges)
        .map((edge) => [edge.id, edge]),
    ).values(),
  ];
  if (edges.length === 0) return null;
  const outgoing = edges.filter((edge) => owns(edge.from));
  const incoming = edges.filter((edge) => owns(edge.to) && !owns(edge.from));
  // The connection leads, as on the map; the other end is its supporting line.
  const row = (edge: ModelEdge, other: string, verb: string) => (
    <li
      className={inspectorRelationRowClasses({ layout: "connection" })}
      key={`${edge.id}:${verb}`}
    >
      <button
        className={cx(
          buttonClasses({ variant: "link" }),
          "max-w-none justify-self-start text-left wrap-anywhere",
        )}
        onClick={() => select(edge.id)}
        data-slot="relation-title"
      >
        {presentRelationship(edge, index).title}
      </button>
      <EnvironmentPills
        className="col-start-2 col-span-1 row-start-1 inspector-300:col-span-full inspector-300:row-auto"
        availability={edgeAvailability(edge, snapshot.models)}
      />
      <span
        className="col-span-full text-graphite wrap-anywhere text-caption"
        data-slot="relation-endpoint"
      >
        {verb}{" "}
        <button className={buttonClasses({ variant: "link" })} onClick={() => select(other)}>
          {endpointLabel(index, other)}
        </button>
        {edge.provenance === "derived" ? " (derived)" : null}
        {edge.provenance === "source"
          ? ` (${edge.relation === "supplies" ? "input file" : "CDK source"})`
          : null}
      </span>
    </li>
  );
  return (
    <InspectorDisclosure title="Connections" count={edges.length}>
      {edges.some((edge) => edge.relation === "cdk" && edge.provenance === "source") ? (
        <p className="mt-0 mb-2 text-caption text-graphite">
          CDK links are inferred from direct source references. Helpers and conditional wiring may
          add connections this view cannot resolve.
        </p>
      ) : null}
      <ul className={inspectorRelationListClasses} data-slot="connection-relations">
        {outgoing.map((edge) => row(edge, edge.to, "To"))}
        {incoming.map((edge) => row(edge, edge.from, "From"))}
      </ul>
    </InspectorDisclosure>
  );
}
