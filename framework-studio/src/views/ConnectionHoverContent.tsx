import { environmentStyle, environmentTextClasses } from "./map-styles";
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
  // An aggregation's rows carry their own pairs, except a CDK environment file's, which share one.
  const headingPair = !content.aggregated || !!content.environmentFile;
  return <div data-ui="landscape-hover-content connection-hover-content" className="grid min-w-0 gap-3 ">
    <div data-ui="landscape-hover-heading" className={`grid min-w-0 gap-[3px] [&>strong]:font-sans [&>strong]:text-step0 [&>strong]:leading-[1.35] [&>strong]:font-semibold [&>strong]:text-map-title [&>strong]:wrap-anywhere${headingPair ? " grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 [&_[data-hover-tags]]:-my-px" : ""}`}><strong>{content.title}</strong>
      {headingPair ? <span data-ui="landscape-hover-tags" data-hover-tags className="flex flex-wrap gap-2"><EnvironmentPills availability={content.availability}
        {...content.environmentFile ? { descriptions: { dev: "supplied by this file in development", prod: "supplied by this file in production" }, unavailableDescription: "not supplied by this file" } : { unavailableDescription: "connection not enabled" }} /></span> : null}
    </div>
    <dl data-ui="landscape-hover-endpoints" className="m-0 grid gap-[2px] leading-[1.4] [&>div]:grid [&>div]:grid-cols-[34px_minmax(0,1fr)] [&>div]:items-baseline [&>div]:gap-2 [&_dt]:text-caption [&_dt]:font-medium [&_dt]:text-map-muted [&_dd]:m-0 [&_dd]:flex [&_dd]:min-w-0 [&_dd]:flex-wrap [&_dd]:items-baseline [&_dd]:gap-x-2 [&_dd]:gap-y-0.5">{([['From', content.from], ['To', content.to]] as const).map(([direction, endpoint]) => <div key={direction}>
      <dt>{direction}</dt><dd>{endpoint.variants ? endpoint.variants.map(variant => <div data-ui="landscape-hover-endpoint-variant" className="grid w-full grid-cols-[26px_minmax(0,1fr)] gap-1" key={variant.mode}>
        <span data-ui="landscape-hover-detail-mode" style={environmentStyle(variant.mode)} className={`flex-none text-meta font-semibold ${environmentTextClasses}`}>{variant.mode === "dev" ? "Dev" : "Prod"}</span>
        <span><span data-ui="landscape-hover-endpoint-name" className="min-w-0 text-[#dfe5ed] wrap-anywhere">{variant.label}</span>{" "}<span data-ui="landscape-hover-endpoint-kind" className="text-caption text-map-muted">{variant.kind}</span></span>
      </div>) : <><span data-ui="landscape-hover-endpoint-name" className="min-w-0 text-[#dfe5ed] wrap-anywhere">{endpoint.label}</span><span data-ui="landscape-hover-endpoint-kind" className="text-caption text-map-muted">{endpoint.kind}</span></>}</dd>
    </div>)}</dl>
    {content.aggregated ? <HoverEntries entries={content.rows} context={supply ? "supply" : "connection"} label="Connection members" pills={!content.environmentFile} /> : null}
    <HoverDetails details={content.details} />
  </div>;
}
