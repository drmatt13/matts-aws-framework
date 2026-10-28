import { useMemo } from "react";
import { indexModel } from "../lookup";
import type { Prop, SceneNode } from "../scene/build";
import { groupHoverDetails, groupHoverEntries, groupHoverLines, nodeHoverFacts, propHoverFacts, type HoverEntry, type HoverEntryDetail, type HoverFacts } from "../scene/hover";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { FrameworkManagedStatus } from "./ResourceStatus";

/** The map and Resources panel describe the same entity, including staged edits. */
export function ResourceHoverContent({ resource }: { readonly resource: SceneNode | Prop }) {
  const { draft, snapshot, model } = useStudio();
  const indexes = useMemo(() => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }), [snapshot.models]);
  const node = "entity" in resource ? resource : undefined;
  const facts = node ? nodeHoverFacts(node, indexes) : propHoverFacts(snapshot.models, resource.id);
  const description = draft.description(resource.id).trim();
  const group = node?.entity === "resource" ? indexes[model.mode].resources.get(node.id) : undefined;
  const contents = group?.kind === "group" ? groupHoverLines(group, model, indexes[model.mode]) : undefined;
  const lines = node
    ? [...(contents?.lines ?? [])]
    : description ? [] : (resource as Prop).caption;
  const entries = group?.kind === "group" ? groupHoverEntries(group, indexes) : undefined;
  const details = group?.kind === "group" ? groupHoverDetails(group, indexes) : undefined;
  const warnings = node?.sourceProblems?.length ? [...node.sourceProblems.slice(0, 3), "Select this resource to review implementation repairs."] : undefined;
  return <HoverContent title={resource.label} subtitle={node?.kindLabel} facts={entries ? undefined : facts} description={description}
    entries={entries} details={details} lines={lines} notes={contents?.notes} warnings={warnings}
    unavailableDescription={group?.kind === "input" || group?.kind === "secret" ? "not declared" : undefined}
    emptyDescription={!!node && !description} showLocations={node?.entity === "target" || node?.entity === "route" || node?.entity === "local" || node?.entity === "gateway"} />;
}

/** Structured supporting facts preserve their environment and semantic emphasis. */
export function HoverDetails({ details, shared = false }: { readonly details?: readonly HoverEntryDetail[]; readonly shared?: boolean }) {
  if (!details?.length) return null;
  return <div className="landscape-hover-details">{shared ? <span className="landscape-hover-section-label">Applies to every entry</span> : null}
    {details.map((detail, at) => <p key={`${detail.text}:${detail.modes?.join()}:${at}`} className={`landscape-hover-detail${detail.tone === "warning" ? " warning" : ""}${detail.kind === "permission" ? " permission" : ""}`}>
      {detail.modes?.length && detail.modes.length < 2 ? <span className={`landscape-hover-detail-mode ${detail.modes[0]}`}>{detail.modes[0] === "dev" ? "Dev" : "Prod"}</span> : null}
      <span>{detail.kind === "permission" ? <><span className="landscape-hover-section-label">Permissions</span><span className="landscape-hover-permission-copy">{detail.text.replace(/^IAM:\s*/, "")}</span></> : detail.text}</span>
    </p>)}
  </div>;
}

export function HoverEntries({ entries, context = "declaration", label = "Input parameters and secrets" }: {
  readonly entries: readonly HoverEntry[];
  readonly context?: "declaration" | "supply" | "connection";
  readonly label?: string;
}) {
  if (!entries.length) return null;
  const descriptions = context === "supply" ? { dev: "supplied by this file in development", prod: "supplied by this file in production" }
    : context === "connection" ? { dev: "connection enabled in development", prod: "connection enabled in production" } : { dev: "declared in development", prod: "declared in production" };
  return <ul className="landscape-hover-entries" aria-label={label}>{entries.map(entry => <li key={entry.id}>
    <span className="landscape-hover-entry-name">{entry.label}</span>
    <EnvironmentPills availability={entry.availability} label={`${entry.label} environments`} descriptions={descriptions}
      unavailableDescription={context === "supply" ? "not supplied by this file" : context === "connection" ? "connection not enabled" : "not declared"} />
    {entry.note ? <p className="landscape-hover-entry-note landscape-hover-note">{entry.note}</p> : null}
    <HoverDetails details={entry.details} />
  </li>)}</ul>;
}

export function HoverContent(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly facts?: HoverFacts;
  readonly description?: string;
  readonly lines: readonly (string | undefined)[];
  readonly notes?: readonly string[];
  readonly entries?: readonly HoverEntry[];
  readonly details?: readonly HoverEntryDetail[];
  readonly warnings?: readonly string[];
  readonly emptyDescription?: boolean;
  readonly showLocations?: boolean;
  readonly unavailableDescription?: string;
}) {
  const { title, subtitle, facts, description, lines } = props;
  const resourceType = facts?.frameworkManaged ? subtitle?.replace(/^framework[-\s]managed\s*/i, "") : subtitle;
  return <div className="landscape-hover-content">
    <div className={`landscape-hover-heading${facts ? " resource-heading-with-environments" : ""}`}><strong>{title}</strong>
    {facts ?
      <span className="landscape-hover-tags">
        <EnvironmentPills availability={{ dev: facts.places.some(place => place.env === "dev"), prod: facts.places.some(place => place.env === "prod") }} descriptions={Object.fromEntries(facts.places.map(place => [place.env, place.where]))} unavailableDescription={props.unavailableDescription} />
      </span>
    : null}
    {resourceType || facts?.frameworkManaged ? <div className="landscape-hover-resource-meta">
      {resourceType ? <span className="landscape-hover-subtitle">{resourceType}</span> : null}
      {facts?.frameworkManaged ? <FrameworkManagedStatus /> : null}
    </div> : null}
    </div>
    {facts?.notDeployed ? <p className="landscape-hover-note warning">{facts.notDeployed}</p> : null}
    {props.warnings?.length ? <div className="landscape-hover-warnings">{props.warnings.map(warning => <p key={warning} className="landscape-hover-detail warning">{warning}</p>)}</div> : null}
    {description ? <p className="landscape-hover-description">{description}</p> : props.emptyDescription ? <p className="landscape-hover-note">No description yet. Select it to write one.</p> : null}
    {props.showLocations && facts?.places.length ? <dl className="landscape-hover-locations">{facts.places.map(place => <div key={place.env}><dt className={place.env}>{place.env === "dev" ? "Dev" : "Prod"}</dt><dd>{place.where}</dd></div>)}</dl> : null}
    {props.entries?.length ? <HoverEntries entries={props.entries} /> : null}
    <HoverDetails details={props.details} />
    {lines.some(Boolean) ? <div className="landscape-hover-copy">{lines.filter(Boolean).map(line => <p key={line}>{line}</p>)}</div> : null}
    {props.notes?.length ? <div className="landscape-hover-details">{props.notes.map(note => <p className="landscape-hover-note" key={note}>{note}</p>)}</div> : null}
  </div>;
}
