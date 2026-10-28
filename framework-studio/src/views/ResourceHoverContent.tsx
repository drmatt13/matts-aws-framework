import { useMemo } from "react";
import { indexModel } from "../lookup";
import type { Prop, SceneNode } from "../scene/build";
import { groupHoverEntries, groupHoverLines, nodeHoverFacts, propHoverFacts, type HoverEntry, type HoverFacts } from "../scene/hover";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";

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
    ? [...(node.sourceProblems?.length ? [...node.sourceProblems.slice(0, 3), "Select this resource to review implementation repairs."] : []), ...(contents?.lines ?? []), ...(description ? [] : ["No description yet. Select it to write one."])]
    : description ? [] : (resource as Prop).caption;
  const entries = group?.kind === "group" ? groupHoverEntries(group, indexes) : undefined;
  return <HoverContent title={resource.label} subtitle={node?.kindLabel} facts={entries ? undefined : facts} description={description} entries={entries} lines={lines} notes={contents?.notes} />;
}

export function HoverContent(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly facts?: HoverFacts;
  readonly description?: string;
  readonly lines: readonly (string | undefined)[];
  readonly notes?: readonly string[];
  readonly entries?: readonly HoverEntry[];
  readonly entryContext?: "declaration" | "supply";
}) {
  const { title, subtitle, facts, description, lines } = props;
  const details = lines.filter(Boolean).map(line => <span key={line}>{line}</span>);
  return <>
    <strong>{title}</strong>
    {subtitle ? <span>{subtitle}</span> : null}
    {facts ? <>
      <span className="landscape-hover-tags">
        <EnvironmentPills availability={{ dev: facts.places.some(place => place.env === "dev"), prod: facts.places.some(place => place.env === "prod") }} descriptions={Object.fromEntries(facts.places.map(place => [place.env, place.where]))} />
        {facts.frameworkManaged ? <span className="hover-tag managed">Framework-managed</span> : null}
      </span>
      {facts.notDeployed ? <span className="landscape-hover-note">{facts.notDeployed}</span> : null}
    </> : null}
    {description ? <span className="landscape-hover-description">{description}</span> : null}
    {props.entryContext === "supply" ? details : null}
    {props.entries?.length ? <ul className="landscape-hover-entries" aria-label="Input parameters and secrets">{props.entries.map(entry => <li key={entry.id}>
      <span className="landscape-hover-entry-name">{entry.label}</span>
      <EnvironmentPills availability={entry.availability} label={`${entry.label} environments`}
        descriptions={props.entryContext === "supply" ? { dev: "supplied by this file in development", prod: "supplied by this file in production" } : { dev: "declared in development", prod: "declared in production" }}
        unavailableDescription={props.entryContext === "supply" ? "not supplied by this file" : "not declared"} />
      {entry.note ? <span className="landscape-hover-entry-note landscape-hover-note">{entry.note}</span> : null}
    </li>)}</ul> : null}
    {props.entryContext !== "supply" ? details : null}
    {props.notes?.map(note => <span className="landscape-hover-note" key={note}>{note}</span>)}
  </>;
}
