import { useMemo } from "react";
import type { ConnectionGroup } from "../connections";
import { presentConnectionHover, type ConnectionHoverPresentation } from "../connection-presentation";
import { indexModel } from "../lookup";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { HoverDetails, HoverEntries } from "./ResourceHoverContent";

/** One hierarchy for every relation, including members absent from the selected graph. */
export function ConnectionHoverContent({ connection }: { readonly connection: ConnectionGroup }) {
  const { snapshot } = useStudio();
  const indexes = useMemo(() => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }), [snapshot.models]);
  const content = presentConnectionHover(connection, indexes);
  return <ConnectionTooltipContent content={content} supply={connection.edge.relation === "supplies"} />;
}

/** Pure content also supports exhaustive presentation fixtures without source evaluation. */
export function ConnectionTooltipContent({ content, supply = false }: { readonly content: ConnectionHoverPresentation; readonly supply?: boolean }) {
  return <div className="landscape-hover-content connection-hover-content">
    <div className="landscape-hover-heading"><strong>{content.title}</strong>
      {!content.aggregated ? <span className="landscape-hover-tags"><EnvironmentPills availability={content.availability} unavailableDescription="connection not enabled" /></span> : null}
    </div>
    <dl className="landscape-hover-endpoints">{([['From', content.from], ['To', content.to]] as const).map(([direction, endpoint]) => <div key={direction}>
      <dt>{direction}</dt><dd><span className="landscape-hover-endpoint-name">{endpoint.label}</span><span className="landscape-hover-endpoint-kind">{endpoint.kind}</span></dd>
    </div>)}</dl>
    {content.aggregated ? <HoverEntries entries={content.rows} context={supply ? "supply" : "connection"} label="Connection members" /> : null}
    <HoverDetails details={content.details} shared={content.aggregated && content.details.length > 0} />
  </div>;
}
