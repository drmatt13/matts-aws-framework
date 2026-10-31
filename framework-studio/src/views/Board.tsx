import { cx } from "../ui/classes";
import { workspaceToolbarClasses } from "../ui/Surface";
import { AlertTriangle, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelEdge, ModelResource, ModelTarget } from "../../shared/model";
import { layoutBoard, type BoardNode } from "../layout";
import { CATEGORY_DESCRIPTION, CATEGORY_LABEL, ROLE_LABEL, type EdgeCategory } from "../lookup";
import { AddMenu } from "./AddMenu";
import { useStudio } from "../studio";
import { DeploymentBadge, DeploymentLegend } from "./DeploymentBadge";
import {
  availabilityBadge,
  catalogAvailability,
  deploymentBadge,
  type DeploymentBadgeKind,
} from "../deployment";
import { EntityIcon } from "./EntityIcon";
import { resourceBadge, resourceIcon, routeIcon, targetIcon } from "../icons";
import { presentRelationship } from "../connection-presentation";

const CATEGORIES = Object.keys(CATEGORY_LABEL) as EdgeCategory[];

function boardEdgeClasses(edge: ModelEdge, faded: boolean, lit = false): string {
  return cx(
    "fill-none transition-[stroke,opacity] duration-120 motion-reduce:transition-none",
    lit ? "stroke-[1.75px]" : "stroke-[1.25px]",
    edge.inputRequirement?.status === "missing"
      ? "stroke-[#ff5f6d] opacity-95"
      : cx(lit ? "stroke-ink" : "stroke-rule-strong", faded && "opacity-18"),
    edge.provenance !== "declared" && "[stroke-dasharray:4_4]",
  );
}

function TargetNode(props: { readonly target: ModelTarget }) {
  const { target } = props;
  return (
    <>
      <span data-ui="label" className="min-w-0 flex-1 truncate">
        {target.title}
        <span data-ui="sub" className="block truncate text-step-minus1 text-graphite">
          {ROLE_LABEL[target.role]}
          {target.title !== target.id ? `, ${target.id}` : ""}
        </span>
      </span>
      <DeploymentBadge kind={deploymentBadge(target.lanes)} />
      {target.implementation?.ready === false ? (
        <AlertTriangle
          size={15}
          data-ui="source-problem"
          className="shrink-0 text-refuse"
          aria-label="Implementation needs attention"
        />
      ) : null}
    </>
  );
}

function ResourceNode(props: {
  readonly resource: ModelResource;
  readonly shape: BoardNode["shape"];
  readonly badge?: DeploymentBadgeKind;
  readonly unread: boolean;
}) {
  const { resource, shape } = props;
  const name =
    shape === "member" ? resource.path[resource.path.length - 1] : resource.path.join(".");
  const kind =
    resource.kind === "stack"
      ? (resource.stackClass ?? "stack")
      : resource.kind === "secret"
        ? "secret"
        : resource.kind === "input"
          ? (resource.fromEnv ?? "input")
          : resource.kind === "group"
            ? "group"
            : undefined;
  return (
    <>
      <span
        data-ui="label"
        className={cx("min-w-0 flex-1 truncate", props.unread && "text-graphite")}
      >
        {name}
      </span>
      {shape === "member" && resource.typeText ? (
        <span
          data-ui="type"
          className="max-w-[40%] min-w-0 truncate font-mono text-caption text-faint"
        >
          {resource.typeText}
        </span>
      ) : null}
      {shape !== "member" && kind ? (
        <span
          data-ui="type"
          className={cx(
            "font-mono text-[0.86em] text-graphite",
            shape === "stack" && "max-w-[40%] min-w-0 truncate",
          )}
        >
          {kind}
        </span>
      ) : null}
      <DeploymentBadge kind={props.badge} />
    </>
  );
}

/** Set aside: not routed while the isometric landscape serves `/`. Kept, with its tests, to revive or retire. */
export function Board() {
  const { model, index, selected, select, snapshot, created } = useStudio();
  const board = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (created)
      [...(board.current?.querySelectorAll<HTMLElement>("[data-entity-id]") ?? [])]
        .find((element) => element.dataset.entityId === created.id)
        ?.scrollIntoView?.({ block: "center", inline: "center", behavior: "smooth" });
  }, [created]);
  const availability = useMemo(() => catalogAvailability(snapshot.models), [snapshot.models]);
  const layout = useMemo(() => layoutBoard(model), [model]);
  const [shown, setShown] = useState<ReadonlySet<EdgeCategory>>(() => new Set(CATEGORIES));

  const read = useMemo(() => new Set(model.edges.map((edge) => edge.to)), [model]);
  const neighbours = useMemo(() => {
    if (!selected) return undefined;
    const ids = new Set([selected]);
    const connection = model.edges.find((edge) => edge.id === selected);
    if (connection) {
      ids.add(connection.from);
      ids.add(connection.to);
    }
    for (const edge of index.edges.get(selected) ?? []) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [index, model.edges, selected]);

  if (layout.nodes.length === 0) {
    return (
      <p data-ui="empty">
        The {model.mode === "dev" ? "development" : "production"} graph did not load. Open
        configuration health for the reason.
      </p>
    );
  }

  const visible = layout.edges.filter((edge) => shown.has(edge.category));
  const availableCategories = new Set(layout.edges.map((edge) => edge.category));
  const lit = (edge: (typeof visible)[number]) =>
    selected !== undefined &&
    (edge.edge.id === selected || edge.edge.from === selected || edge.edge.to === selected);

  return (
    <>
      <div
        data-ui="workspace-toolbar"
        className={cx(
          workspaceToolbarClasses,
          "sticky top-0 left-0 z-3 flex flex-wrap items-center gap-3",
        )}
      >
        <div
          data-ui="chips"
          className="flex flex-wrap gap-1 vp-700:-m-0.75 vp-700:max-w-full vp-700:flex-nowrap vp-700:overflow-x-auto vp-700:p-0.75"
          role="group"
          aria-label="Relations shown"
        >
          {CATEGORIES.filter((category) => availableCategories.has(category)).map((category) => (
            <button
              key={category}
              data-ui="chip"
              className="min-h-(--control-height) cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-step-minus1 text-graphite hover:bg-wash hover:text-ink aria-pressed:border-rule-strong aria-pressed:bg-wash aria-pressed:text-ink vp-700:whitespace-nowrap"
              aria-pressed={shown.has(category)}
              title={CATEGORY_DESCRIPTION[category]}
              onClick={() =>
                setShown((current) => {
                  const next = new Set(current);
                  if (next.has(category)) next.delete(category);
                  else next.add(category);
                  return next;
                })
              }
            >
              {CATEGORY_LABEL[category]}
            </button>
          ))}
        </div>
        <div
          data-ui="board-actions"
          className="ml-auto flex items-center gap-4 vp-700:flex-wrap vp-700:justify-end vp-700:gap-2"
        >
          <DeploymentLegend />
          <AddMenu presentation="toolbar" />
        </div>
      </div>
      <div
        ref={board}
        data-ui="board"
        className={cx(
          "relative mx-(--workspace-gutter) mt-5 mb-16",
          model.stale && "opacity-55 grayscale-[0.6]",
        )}
        role="group"
        aria-label="Application architecture"
        style={{ width: layout.width + 120, height: layout.height }}
        onClick={() => select(undefined)}
      >
        <svg
          data-ui="edges"
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width + 120}
          height={layout.height}
          aria-label="Resource connections"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {visible
            .filter((edge) => !lit(edge))
            .map((edge) => (
              <path
                key={edge.edge.id}
                d={edge.path}
                className={boardEdgeClasses(edge.edge, !!selected)}
              />
            ))}
          {visible.filter(lit).map((edge) => (
            <g key={edge.edge.id} style={{ color: "var(--ink)" }}>
              <path
                d={edge.path}
                className={boardEdgeClasses(edge.edge, false, true)}
                markerEnd="url(#arrow)"
              />
              <text
                data-ui="edge-label"
                className="fill-ink stroke-paper stroke-[4px] font-mono text-[10.5px] [paint-order:stroke]"
                x={edge.label.x}
                y={edge.label.y - 4}
                textAnchor="middle"
              >
                {presentRelationship(edge.edge, index).title}
              </text>
            </g>
          ))}
          {visible
            .filter(({ edge }) => edge.inputRequirement?.status === "missing")
            .map(({ edge, path, label }) => (
              <g
                key={`missing:${edge.id}`}
                role="button"
                tabIndex={0}
                aria-label={`Resolve required ${edge.label} in .env.${edge.inputRequirement!.mode}`}
                data-ui="missing-connection"
                className="group/missing cursor-pointer [pointer-events:all]"
                onClick={(event) => {
                  event.stopPropagation();
                  select(edge.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(edge.id);
                  }
                }}
              >
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ pointerEvents: "stroke" }}
                />
                <circle
                  className="group-focus/missing:stroke-[3px]"
                  cx={label.x}
                  cy={label.y}
                  r={9}
                  fill="var(--paper)"
                  stroke="#ff5f6d"
                />
                <path
                  d={`M ${label.x - 3} ${label.y - 3} l 6 6 m -6 0 l 6 -6`}
                  stroke="#ff5f6d"
                  strokeWidth={2}
                />
              </g>
            ))}
        </svg>
        {layout.titles.map((title) => (
          <span
            key={`${title.kind}:${title.text}:${title.x}`}
            className={
              title.kind === "column"
                ? "absolute font-condensed text-step1 font-semibold"
                : "absolute text-step-minus1 font-medium text-graphite"
            }
            style={{ left: title.x, top: title.y }}
          >
            {title.text}
          </span>
        ))}
        {layout.nodes.map((node) => {
          const target = index.targets.get(node.id);
          const route = index.routes.get(node.id);
          const resource = index.resources.get(node.id);
          const localService = index.localServices.get(node.id);
          const classes = cx(
            "absolute flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-0 text-left hover:border-graphite aria-current:border-ink aria-current:shadow-[0_0_0_1px_var(--ink)]",
            target?.implementation?.ready === false ? "border-refuse" : "border-rule-strong",
            node.shape === "stack" && "font-condensed font-semibold",
            neighbours && !neighbours.has(node.id) && "opacity-38",
            resource?.absent || (localService && !localService.enabled)
              ? "border-dashed bg-transparent text-graphite"
              : node.shape === "stack"
                ? "bg-wash"
                : "bg-sheet",
          );
          return (
            <button
              key={node.id}
              data-entity-id={node.id}
              data-ui="node"
              data-shape={node.shape}
              data-unread={!!(resource && node.shape === "member" && !read.has(node.id))}
              className={classes}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              aria-current={selected === node.id}
              onClick={(event) => {
                event.stopPropagation();
                select(selected === node.id ? undefined : node.id);
              }}
              title={[
                target?.title,
                route?.browserPath ?? route?.path,
                resource
                  ? `${resource.path.join(".")}${resource.typeText ? ` · ${resource.typeText}` : ""}`
                  : undefined,
                localService?.title,
                resource?.absent
                  ? `Absent in the ${model.mode === "dev" ? "development" : "production"} graph`
                  : undefined,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <EntityIcon
                size={node.shape === "member" ? 20 : 26}
                icon={
                  localService
                    ? "postgres"
                    : target
                      ? targetIcon(target)
                      : route
                        ? routeIcon(route)
                        : resourceIcon(resource!)
                }
                badge={
                  resource
                    ? resourceBadge(resource, index.resources)
                    : localService || route
                      ? "managed"
                      : undefined
                }
              />
              {localService ? (
                <>
                  <span data-ui="label" className="min-w-0 flex-1 truncate">
                    {localService.title}
                    <span data-ui="sub" className="block truncate text-step-minus1 text-graphite">
                      {localService.image} · Compose
                    </span>
                  </span>
                  <DeploymentBadge kind="dev" />
                </>
              ) : null}
              {target ? <TargetNode target={target} /> : null}
              {route ? (
                <>
                  <span
                    data-ui="label"
                    className="min-w-0 flex-1 truncate font-mono text-[0.82rem]"
                  >
                    {route.kind === "webSocket" ? route.path : (route.browserPath ?? route.path)}
                  </span>
                  <DeploymentBadge
                    kind={
                      index.targets.has(route.target)
                        ? deploymentBadge(index.targets.get(route.target)!.lanes)
                        : undefined
                    }
                  />
                  {route.auth ? <Lock size={13} aria-label="Requires a signed-in user" /> : null}
                </>
              ) : null}
              {resource ? (
                <ResourceNode
                  resource={resource}
                  shape={node.shape}
                  unread={node.shape === "member" && !read.has(node.id)}
                  badge={availabilityBadge(
                    availability[resource.id] ?? { dev: false, prod: false },
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
