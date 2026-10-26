import { useMemo } from "react";
import { indexModel } from "../lookup";
import type { Prop, SceneNode } from "../scene/build";
import { nodeHoverFacts, propHoverFacts, type HoverFacts } from "../scene/hover";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";

/** The map and Resources panel describe the same entity, including staged edits. */
export function ResourceHoverContent({ resource }: { readonly resource: SceneNode | Prop }) {
  const { draft, snapshot } = useStudio();
  const indexes = useMemo(() => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }), [snapshot.models]);
  const node = "entity" in resource ? resource : undefined;
  const facts = node ? nodeHoverFacts(node, indexes) : propHoverFacts(snapshot.models, resource.id);
  const description = draft.description(resource.id).trim();
  const lines = node
    ? [...(node.sourceProblems?.length ? [...node.sourceProblems.slice(0, 3), "Select this resource to review implementation repairs."] : []), ...(description ? [] : ["No description yet. Select it to write one."])]
    : description ? [] : (resource as Prop).caption;
  return <HoverContent title={resource.label} subtitle={node?.kindLabel} facts={facts} description={description} lines={lines} />;
}

export function HoverContent(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly facts?: HoverFacts;
  readonly description?: string;
  readonly lines: readonly (string | undefined)[];
  readonly notes?: readonly string[];
}) {
  const { title, subtitle, facts, description, lines } = props;
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
    {lines.filter(Boolean).map(line => <span key={line}>{line}</span>)}
    {props.notes?.map(note => <span className="landscape-hover-note" key={note}>{note}</span>)}
  </>;
}
