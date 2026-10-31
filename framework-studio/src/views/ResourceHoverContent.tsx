import { cx } from "../ui/classes";
import {
  environmentStyle,
  environmentTextClasses,
  hoverTitleClasses,
  hoverFactRowClasses,
  hoverFactValueClasses,
} from "./map-styles";
import { useMemo } from "react";
import { indexModel } from "../lookup";
import { kindText, type Prop, type SceneNode } from "../scene/build";
import {
  groupHoverDetails,
  groupHoverEntries,
  groupHoverLines,
  nodeHoverFacts,
  propHoverFacts,
  type HoverEntry,
  type HoverEntryDetail,
  type HoverFacts,
} from "../scene/hover";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { FrameworkManagedStatus } from "./ResourceStatus";

/** The map and Resources panel describe the same entity, including staged edits. */
export function ResourceHoverContent({ resource }: { readonly resource: SceneNode | Prop }) {
  const { draft, snapshot, model } = useStudio();
  const indexes = useMemo(
    () => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }),
    [snapshot.models],
  );
  const node = "entity" in resource ? resource : undefined;
  const facts = node ? nodeHoverFacts(node, indexes) : propHoverFacts(snapshot.models, resource.id);
  const description = draft.description(resource.id).trim();
  const group =
    node?.entity === "resource" ? indexes[model.mode].resources.get(node.id) : undefined;
  const contents =
    group?.kind === "group" ? groupHoverLines(group, model, indexes[model.mode]) : undefined;
  const lines = node ? [...(contents?.lines ?? [])] : description ? [] : (resource as Prop).caption;
  const entries = group?.kind === "group" ? groupHoverEntries(group, indexes) : undefined;
  const details = group?.kind === "group" ? groupHoverDetails(group, indexes) : undefined;
  const warnings = node?.sourceProblems?.length
    ? [...node.sourceProblems.slice(0, 3), "Select this resource to review implementation repairs."]
    : undefined;
  const kindLabel = node?.kindLabel ?? (resource as Prop).kindLabel;
  return (
    <HoverContent
      title={resource.label}
      subtitle={kindLabel ? kindText(kindLabel, resource.label) : undefined}
      facts={entries ? undefined : facts}
      description={description}
      entries={entries}
      details={details}
      lines={lines}
      notes={contents?.notes}
      warnings={warnings}
      unavailableDescription={
        group?.kind === "input" || group?.kind === "secret" ? "not declared" : undefined
      }
      emptyDescription={!!node && !description}
      showLocations={
        node?.entity === "target" ||
        node?.entity === "route" ||
        node?.entity === "local" ||
        node?.entity === "gateway"
      }
    />
  );
}

/** Structured supporting facts preserve their environment and semantic emphasis. */
export function HoverDetails({ details }: { readonly details?: readonly HoverEntryDetail[] }) {
  if (!details?.length) return null;
  return (
    <div data-ui="landscape-hover-details" className="col-span-full grid min-w-0 gap-2">
      {details.map((detail, at) => (
        <p
          key={`${detail.text}:${detail.modes?.join()}:${at}`}
          data-ui="landscape-hover-detail"
          className={`m-0 flex items-baseline gap-2 text-caption${detail.tone === "warning" ? " border-l-2 border-[#e5a68d] pl-2 text-[#ffc3ad]" : detail.kind === "permission" ? " border-l-2 border-[#637d9b] pl-2 text-[#aeb9c8]" : " text-[#aeb9c8]"}`}
        >
          {detail.modes?.length && detail.modes.length < 2 ? (
            <span
              data-ui="landscape-hover-detail-mode"
              style={environmentStyle(detail.modes[0])}
              className={`flex-none text-meta font-semibold ${environmentTextClasses}`}
            >
              {detail.modes[0] === "dev" ? "Dev" : "Prod"}
            </span>
          ) : null}
          <span>
            {detail.kind === "permission" ? (
              <>
                <span
                  data-ui="landscape-hover-section-label"
                  className="block text-meta font-medium text-map-muted"
                >
                  Permissions
                </span>
                <span
                  data-ui="landscape-hover-permission-copy"
                  className="block text-[#b6c4d6] wrap-anywhere"
                >
                  {detail.text.replace(/^IAM:\s*/, "")}
                </span>
              </>
            ) : (
              detail.text
            )}
          </span>
        </p>
      ))}
    </div>
  );
}

/** Every member keeps its own Dev and Prod pair, beside its name. */
export function HoverEntries({
  entries,
  context = "declaration",
  label = "Input parameters and secrets",
  pills = true,
}: {
  readonly entries: readonly HoverEntry[];
  readonly context?: "declaration" | "supply" | "connection";
  readonly label?: string;
  /** False when the heading's pair already describes every entry. */
  readonly pills?: boolean;
}) {
  if (!entries.length) return null;
  const descriptions =
    context === "supply"
      ? { dev: "supplied by this file in development", prod: "supplied by this file in production" }
      : context === "connection"
        ? { dev: "connection enabled in development", prod: "connection enabled in production" }
        : { dev: "declared in development", prod: "declared in production" };
  return (
    <ul
      data-ui="landscape-hover-entries"
      className="group/entries m-0 grid list-none border-y border-[#ffffff14] p-0 last:border-b-0"
      aria-label={label}
    >
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-[#ffffff0d] py-2 not-first:border-t group-last/entries:last:pb-0"
        >
          <span
            data-ui="landscape-hover-entry-name"
            className="min-w-0 pt-px text-[#dfe5ed] wrap-anywhere"
          >
            {entry.label}
          </span>
          {pills ? (
            <EnvironmentPills
              availability={entry.availability}
              label={`${entry.label} environments`}
              descriptions={descriptions}
              unavailableDescription={
                context === "supply"
                  ? "not supplied by this file"
                  : context === "connection"
                    ? "connection not enabled"
                    : "not declared"
              }
            />
          ) : null}
          {entry.note ? (
            <p
              data-ui="landscape-hover-entry-note landscape-hover-note"
              className="col-span-full m-0 text-caption text-[#a6b0bf]"
            >
              {entry.note}
            </p>
          ) : null}
          <HoverDetails details={entry.details} />
        </li>
      ))}
    </ul>
  );
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
  const resourceType = facts?.frameworkManaged
    ? subtitle?.replace(/^framework[-\s]managed\s*/i, "")
    : subtitle;
  return (
    <div data-ui="landscape-hover-content" className="grid min-w-0 gap-3">
      <div
        data-ui="landscape-hover-heading"
        className={cx(
          "grid min-w-0 gap-0.75",
          facts && "grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3",
        )}
      >
        <strong className={hoverTitleClasses}>{title}</strong>
        {facts ? (
          <span
            data-ui="landscape-hover-tags"
            data-hover-tags
            className="-my-px flex flex-wrap gap-2"
          >
            <EnvironmentPills
              availability={{
                dev: facts.places.some((place) => place.env === "dev"),
                prod: facts.places.some((place) => place.env === "prod"),
              }}
              descriptions={Object.fromEntries(
                facts.places.map((place) => [place.env, place.where]),
              )}
              unavailableDescription={props.unavailableDescription}
            />
          </span>
        ) : null}
        {resourceType || facts?.frameworkManaged ? (
          <div
            data-ui="landscape-hover-resource-meta"
            className="col-span-full grid justify-items-start gap-2"
          >
            {resourceType ? (
              <span
                data-ui="landscape-hover-subtitle"
                className="text-caption leading-[1.35] text-map-muted"
              >
                {resourceType}
              </span>
            ) : null}
            {facts?.frameworkManaged ? (
              <FrameworkManagedStatus appearance="map" placement="inline" />
            ) : null}
          </div>
        ) : null}
      </div>
      {facts?.notDeployed ? (
        <p
          data-ui="landscape-hover-note"
          className="m-0 border-l-2 border-[#e5a68d] pl-2 text-caption text-[#ffc3ad]"
        >
          {facts.notDeployed}
        </p>
      ) : null}
      {props.warnings?.length ? (
        <div data-ui="landscape-hover-warnings" className="grid min-w-0 gap-2">
          {props.warnings.map((warning) => (
            <p
              key={warning}
              data-ui="landscape-hover-detail"
              className="m-0 flex items-baseline gap-2 border-l-2 border-[#e5a68d] pl-2 text-caption text-[#ffc3ad]"
            >
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      {description ? (
        <p
          data-ui="landscape-hover-description"
          className="m-0 line-clamp-5 leading-[1.55] text-[#dfe5ec] wrap-anywhere"
        >
          {description}
        </p>
      ) : props.emptyDescription ? (
        <p data-ui="landscape-hover-note" className="m-0 text-caption text-[#a6b0bf]">
          No description yet. Select it to write one.
        </p>
      ) : null}
      {props.showLocations && facts?.places.length ? (
        <dl
          data-ui="landscape-hover-locations"
          className="m-0 grid gap-0.5 text-caption leading-[1.4]"
        >
          {facts.places.map((place) => (
            <div key={place.env} className={hoverFactRowClasses}>
              <dt
                className={cx("font-medium", environmentTextClasses)}
                style={environmentStyle(place.env)}
              >
                {place.env === "dev" ? "Dev" : "Prod"}
              </dt>
              <dd className={hoverFactValueClasses}>{place.where}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {props.entries?.length ? <HoverEntries entries={props.entries} /> : null}
      <HoverDetails details={props.details} />
      {lines.some(Boolean) ? (
        <div data-ui="landscape-hover-copy" className="grid min-w-0 gap-2">
          {lines.filter(Boolean).map((line) => (
            <p key={line} className="m-0">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {props.notes?.length ? (
        <div data-ui="landscape-hover-details" className="col-span-full grid min-w-0 gap-2">
          {props.notes.map((note) => (
            <p
              data-ui="landscape-hover-note"
              className="m-0 text-caption text-[#a6b0bf]"
              key={note}
            >
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
