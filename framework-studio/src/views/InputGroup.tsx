import { displayName } from "../naming";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorRelationRowClasses,
  inspectorRelationListClasses,
  tagDisclosureContentClasses,
} from "../inspector-ui";
import { useMemo } from "react";
import type { ModelResource } from "../../shared/model";
import { catalogAvailability } from "../deployment";
import { resourceIcon } from "../icons";
import { entryCount, groupEntries, groupUse, nameList } from "../input-groups";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";
import { EnvironmentPills } from "./DeploymentBadge";
import { EntityIcon } from "./EntityIcon";
import { InspectorDisclosure, InspectorResourceRow, InspectorSection } from "./InspectorUI";

/**
 * An input group owns no AWS resource. Its inspector reads the group through its entries,
 * so the building on the map answers what the group holds, which workloads read it and
 * where each value comes from. Every value control stays on the entry's own inspector.
 */

/** One entry's value in the viewed graph: names and presence, never the value itself. */
function entryStatus(
  entry: ModelResource,
  file: string,
): { readonly text: string; readonly tone?: "missing" } {
  if (entry.absent) return { text: "Absent in this graph" };
  if (entry.authoredValue !== undefined) return { text: `Value · ${entry.authoredValue}` };
  const status = entry.inputRequirement?.status;
  if (status === "configured") return { text: `Set in ${file}` };
  if (status === "default") return { text: `Default · ${entry.default ?? "declared default"}` };
  if (status === "missing") return { text: `Required value missing in ${file}`, tone: "missing" };
  if (status === "optional") return { text: `Not set · optional` };
  return { text: "Not checked in this graph" };
}

export function InputGroupEntries({ group }: { readonly group: ModelResource }) {
  const { snapshot, model, select, draft, draftState, live, index } = useStudio();
  const availability = useMemo(() => catalogAvailability(snapshot.models), [snapshot.models]);
  const children = model.resources.filter((resource) => resource.parent === group.id);
  const file =
    index.resources.get(`envfile:${model.mode}`)?.deploymentFile?.path ??
    `cdk-app/.env.${model.mode}`;
  // Creation writes one level of catalog group; a nested group is edited in source.
  const addable = group.path.length === 1;
  const disabled =
    !!draftState.busy ||
    live.evaluating ||
    Object.values(snapshot.models).some((item) => item.stale || item.status === "error");
  const add = () =>
    draft.requestNavigation(() => {
      draft.beginCreation("input");
      const entry = draft.creation();
      if (entry) draft.setCreation(entry.resourceKind, { ...entry.form, group: group.path[0]! });
    });
  return (
    <InspectorSection
      title="Entries"
      description={`${entryCount(groupEntries(group, model.resources))}. Select an entry to edit its source, value, requirements or consumers.`}
      actions={
        addable ? (
          <button className={buttonClasses({ variant: "quiet" })} disabled={disabled} onClick={add}>
            Add input
          </button>
        ) : undefined
      }
      data-slot="input-group-entries"
    >
      {children.length ? (
        <ul className={inspectorRelationListClasses} data-slot="relations">
          {children.map((child) => {
            const nested = child.kind === "group";
            const status = nested
              ? { text: entryCount(groupEntries(child, model.resources)) }
              : entryStatus(child, file);
            return (
              <InspectorResourceRow
                key={child.id}
                data-slot="input-group-entry"
                icon={<EntityIcon size={26} icon={resourceIcon(child)} />}
                title={
                  <button
                    className={buttonClasses({
                      variant: "link",
                      className: "max-w-none wrap-anywhere text-left",
                    })}
                    onClick={() => select(child.id)}
                    data-slot="input-group-entry-name"
                  >
                    {displayName(model, child.id, child.path.at(-1) ?? child.id)}
                  </button>
                }
                trailing={
                  <EnvironmentPills
                    availability={availability[child.id] ?? { dev: false, prod: false }}
                    label={`${child.path.at(-1)} environments`}
                    descriptions={{
                      dev: "declared in development",
                      prod: "declared in production",
                    }}
                    unavailableDescription="not declared"
                  />
                }
              >
                {child.fromEnv ? (
                  <code className="text-caption">{child.fromEnv}</code>
                ) : (
                  <span>
                    {nested ? "Input group" : child.kind === "secret" ? "Secret" : "Input"}
                  </span>
                )}
                <span
                  className={cx("flex items-center gap-1.5", status.tone ? status.tone : "")}
                  data-slot="local-input-status"
                >
                  <span className="size-1.5 flex-none rounded-full bg-graphite" aria-hidden />
                  <span className="grid min-w-0" data-slot="inspector-status-copy">
                    {child.kind === "secret" && !nested ? `Secret · ${status.text}` : status.text}
                  </span>
                </span>
              </InspectorResourceRow>
            );
          })}
        </ul>
      ) : (
        <p className="mt-0 mb-2 text-caption text-graphite">This group holds no entries yet.</p>
      )}
    </InspectorSection>
  );
}

export function InputGroupUse({ group }: { readonly group: ModelResource }) {
  const { model, index, select } = useStudio();
  const use = groupUse(group, model.edges);
  const entries = groupEntries(group, model.resources);
  const name = (id: string) => displayName(model, id, index.resources.get(id)?.path.at(-1) ?? id);
  const reads = (ids: readonly string[]) =>
    ids.length === entries.length && entries.length > 1
      ? `Reads all ${entries.length} entries`
      : `Reads ${nameList(ids.map(name))}`;
  return (
    <InspectorSection
      title="Used by"
      description={
        use.readers.length + use.feeds.length
          ? undefined
          : "Nothing reads these entries in this graph. Select an entry to connect a workload."
      }
      data-slot="input-group-use"
    >
      {use.readers.length + use.feeds.length ? (
        <ul className={inspectorRelationListClasses} data-slot="relations">
          {use.readers.map((reader) => (
            <li className={inspectorRelationRowClasses({ layout: "usage" })} key={reader.id}>
              <button
                className={buttonClasses({ variant: "link", className: "max-w-40 wrap-anywhere" })}
                onClick={() => select(reader.id)}
              >
                {titleOf(index, reader.id)}
              </button>
              <span className="text-right inspector-360:text-left text-caption text-graphite">
                {reads(reader.entries)}
              </span>
            </li>
          ))}
          {use.feeds.map((feed) => (
            <li className={inspectorRelationRowClasses({ layout: "usage" })} key={feed.id}>
              <button
                className={buttonClasses({ variant: "link", className: "max-w-40 wrap-anywhere" })}
                onClick={() => select(feed.id)}
              >
                {titleOf(index, feed.id)}
              </button>
              <span className="text-right inspector-360:text-left text-caption text-graphite">
                {feed.relation === "maps"
                  ? `Maps ${nameList(feed.entries.map(name))}`
                  : `Deploys when ${nameList(feed.entries.map(name))} matches`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </InspectorSection>
  );
}

/** Per environment file: how many of the group's names it assigns, without any value. */
export function InputGroupSources({ group }: { readonly group: ModelResource }) {
  const { model, select } = useStudio();
  const entries = groupEntries(group, model.resources);
  const files = new Map<string, { configured: number; defaulted: number; unset: number }>();
  for (const entry of entries)
    for (const source of entry.inputSources ?? []) {
      const counts = files.get(source.file) ?? { configured: 0, defaulted: 0, unset: 0 };
      if (source.entry.status === "configured") counts.configured += 1;
      else if (source.entry.defaulted) counts.defaulted += 1;
      else counts.unset += 1;
      files.set(source.file, counts);
    }
  if (!files.size) return null;
  return (
    <InspectorDisclosure title="Environment file sources" count={files.size}>
      <p className="mt-0 mb-2 text-caption text-graphite">
        Names and presence only. Open a file inspector to edit its local values.
      </p>
      <ul className={inspectorRelationListClasses} data-slot="relations">
        {[...files].map(([file, counts]) => (
          <li className={inspectorRelationRowClasses()} key={file}>
            <button
              className={buttonClasses({ variant: "link", className: "max-w-40 wrap-anywhere" })}
              onClick={() => select(file.endsWith(".dev") ? "envfile:dev" : "envfile:prod")}
            >
              {file}
            </button>
            <span className="text-caption text-graphite">
              {[
                counts.configured ? `${counts.configured} set` : "",
                counts.defaulted ? `${counts.defaulted} using defaults` : "",
                counts.unset ? `${counts.unset} not set` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </InspectorDisclosure>
  );
}

/** A group has no tags of its own; it shows what its entries carry. */
export function InputGroupTags({ group }: { readonly group: ModelResource }) {
  const { model } = useStudio();
  const entries = groupEntries(group, model.resources);
  const tags = new Map<string, number>();
  for (const entry of entries)
    for (const [key, value] of Object.entries(model.tagging?.[entry.id]?.effective ?? {})) {
      const tag = JSON.stringify([key, value]);
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  return (
    <InspectorDisclosure
      title="Tags"
      contentClassName={tagDisclosureContentClasses}
      count={tags.size}
      data-slot="declaration-tags"
    >
      <p className="m-0 text-caption leading-[1.5] text-graphite" data-slot="section-description">
        A group organizes catalog entries and owns no AWS resource, so it has no tags of its own.
        Tag each entry from its inspector.
      </p>
      {tags.size ? (
        <div className="grid gap-2" data-slot="inherited-tags">
          {[...tags].map(([tag, count]) => {
            const [key, value] = JSON.parse(tag) as [string, string];
            return (
              <div
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-[6px] text-caption wrap-anywhere"
                key={tag}
                data-slot="inherited-tag"
              >
                <code>{key}</code>
                <span>{value || "(empty)"}</span>
                <span className="text-caption text-graphite">
                  {count === entries.length ? "Every entry" : `${count} of ${entries.length}`}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="m-0 text-caption text-graphite">No entry carries a tag.</p>
      )}
    </InspectorDisclosure>
  );
}
