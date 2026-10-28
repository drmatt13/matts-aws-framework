import { useMemo } from "react";
import type { ConnectionGroup } from "../connections";
import { presentConnectionHover, type ConnectionHoverPresentation } from "../connection-presentation";
import { indexModel } from "../lookup";
import { sharedAvailability } from "../scene/hover";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { entryPillCopy, HoverDetails, HoverEntries } from "./ResourceHoverContent";

/** One hierarchy for every relation, including members absent from the selected graph. */
export function ConnectionHoverContent({ connection }: { readonly connection: ConnectionGroup }) {
  const { snapshot } = useStudio();
  const indexes = useMemo(() => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }), [snapshot.models]);
  const content = presentConnectionHover(connection, indexes);
  return <ConnectionTooltipContent content={content} supply={connection.edge.relation === "supplies"} />;
}

/** Pure content also supports exhaustive presentation fixtures without source evaluation. */
export function ConnectionTooltipContent({ content, supply = false }: { readonly content: ConnectionHoverPresentation; readonly supply?: boolean }) {
  const context = supply ? "supply" : "connection";
  // Members that share one availability take a single pair beside the title; differing members keep their own.
  const pair = content.aggregated ? sharedAvailability(content.rows) : content.availability;
  return <div className="landscape-hover-content connection-hover-content">
    <div className={`landscape-hover-heading${pair ? " single-connection-heading" : ""}`}><strong>{content.title}</strong>
      {pair ? <span className="landscape-hover-tags"><EnvironmentPills availability={pair} {...(content.aggregated ? entryPillCopy(context) : { unavailableDescription: "connection not enabled" })} /></span> : null}
    </div>
    <dl className="landscape-hover-endpoints">{([['From', content.from], ['To', content.to]] as const).map(([direction, endpoint]) => <div key={direction}>
      <dt>{direction}</dt><dd>{endpoint.variants ? endpoint.variants.map(variant => <div className="landscape-hover-endpoint-variant" key={variant.mode}>
        <span className={`landscape-hover-detail-mode ${variant.mode}`}>{variant.mode === "dev" ? "Dev" : "Prod"}</span>
        <span><span className="landscape-hover-endpoint-name">{variant.label}</span>{" "}<span className="landscape-hover-endpoint-kind">{variant.kind}</span></span>
      </div>) : <><span className="landscape-hover-endpoint-name">{endpoint.label}</span><span className="landscape-hover-endpoint-kind">{endpoint.kind}</span></>}</dd>
    </div>)}</dl>
    {content.aggregated ? <HoverEntries entries={content.rows} context={context} label="Connection members" pills={!pair} /> : null}
    <HoverDetails details={content.details} />
  </div>;
}
