import { Lock } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModelResource, ModelTarget } from "../../shared/model";
import { layoutBoard, type BoardNode } from "../layout";
import { CATEGORY_LABEL, ROLE_LABEL, type EdgeCategory } from "../lookup";
import { useStudio } from "../studio";
import { DeploymentBadge, DeploymentLegend } from "./DeploymentBadge";
import { availabilityBadge, catalogAvailability, deploymentBadge, type DeploymentBadgeKind } from "../deployment";
import { EntityIcon } from "./EntityIcon";
import { resourceBadge, resourceIcon, routeIcon, targetIcon } from "../icons";

const CATEGORIES = Object.keys(CATEGORY_LABEL) as EdgeCategory[];

function TargetNode(props: { readonly target: ModelTarget }) {
  const { target } = props;
  return (
    <>
      <span className="label">
        {target.title}
        <span className="sub">
          {ROLE_LABEL[target.role]}
          {target.title !== target.id ? `, ${target.id}` : ""}
        </span>
      </span>
      <DeploymentBadge kind={deploymentBadge(target.lanes)} />
    </>
  );
}

function ResourceNode(props: { readonly resource: ModelResource; readonly shape: BoardNode["shape"]; readonly badge?: DeploymentBadgeKind }) {
  const { resource, shape } = props;
  const name = shape === "member" ? resource.path[resource.path.length - 1] : resource.path.join(".");
  const kind =
    resource.kind === "stack" ? resource.stackClass ?? "stack" : resource.kind === "secret" ? "secret" : resource.kind === "input" ? resource.fromEnv ?? "input" : resource.kind === "group" ? "group" : undefined;
  return (
    <>
      <span className="label">{name}</span>
      {shape === "member" && resource.typeText ? <span className="type">{resource.typeText}</span> : null}
      {shape !== "member" && kind ? <span className="type code muted">{kind}</span> : null}
      <DeploymentBadge kind={props.badge} />
    </>
  );
}

export function Board() {
  const { model, index, selected, select, snapshot } = useStudio();
  const availability = useMemo(() => catalogAvailability(snapshot.models), [snapshot.models]);
  const layout = useMemo(() => layoutBoard(model), [model]);
  const [shown, setShown] = useState<ReadonlySet<EdgeCategory>>(() => new Set(CATEGORIES));

  const read = useMemo(() => new Set(model.edges.map((edge) => edge.to)), [model]);
  const neighbours = useMemo(() => {
    if (!selected) return undefined;
    const ids = new Set([selected]);
    const connection = model.edges.find((edge) => edge.id === selected);
    if (connection) { ids.add(connection.from); ids.add(connection.to); }
    for (const edge of index.edges.get(selected) ?? []) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [index, model.edges, selected]);

  if (model.targets.length === 0) {
    return <p className="empty">The {model.mode === "dev" ? "development" : "production"} graph did not load. Open configuration health for the reason.</p>;
  }

  const visible = layout.edges.filter((edge) => shown.has(edge.category));
  const lit = (edge: (typeof visible)[number]) => selected !== undefined && (edge.edge.id === selected || edge.edge.from === selected || edge.edge.to === selected);

  return (
    <>
      <div className="board-head">
        <div className="chips" role="group" aria-label="Relations shown">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              className="chip"
              aria-pressed={shown.has(category)}
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
        <span className="spacer" />
        <DeploymentLegend />
      </div>
      <div className="board" style={{ width: layout.width + 120, height: layout.height }} onClick={() => select(undefined)}>
        <svg className="edges" width={layout.width + 120} height={layout.height} aria-label="Resource connections">
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>
          {visible
            .filter((edge) => !lit(edge))
            .map((edge) => (
              <path
                key={edge.edge.id}
                d={edge.path}
                className={`edge ${edge.edge.inputRequirement?.status === "missing" ? "missing" : ""} ${edge.edge.provenance !== "declared" ? "derived" : ""} ${selected ? "faded" : ""}`}
              />
            ))}
          {visible.filter(lit).map((edge) => (
            <g key={edge.edge.id} style={{ color: "var(--ink)" }}>
              <path d={edge.path} className={`edge lit ${edge.edge.inputRequirement?.status === "missing" ? "missing" : ""} ${edge.edge.provenance !== "declared" ? "derived" : ""}`} markerEnd="url(#arrow)" />
              <text className="edge-label" x={edge.label.x} y={edge.label.y - 4} textAnchor="middle">
                {edge.edge.label}
              </text>
            </g>
          ))}
          {visible.filter(({ edge }) => edge.inputRequirement?.status === "missing").map(({ edge, path, label }) => <g key={`missing:${edge.id}`} role="button" tabIndex={0} aria-label={`Resolve required ${edge.label} in .env.${edge.inputRequirement!.mode}`} className="missing-connection" onClick={(event) => { event.stopPropagation(); select(edge.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(edge.id); } }}>
            <path d={path} fill="none" stroke="transparent" strokeWidth={14} style={{ pointerEvents: "stroke" }} />
            <circle cx={label.x} cy={label.y} r={9} fill="var(--paper)" stroke="#ff5f6d" />
            <path d={`M ${label.x - 3} ${label.y - 3} l 6 6 m -6 0 l 6 -6`} stroke="#ff5f6d" strokeWidth={2} />
          </g>)}
        </svg>
        {layout.titles.map((title) => (
          <span
            key={`${title.kind}:${title.text}:${title.x}`}
            className={title.kind === "column" ? "column-title" : "group-title"}
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
          const classes = [
            "node",
            node.shape,
            neighbours && !neighbours.has(node.id) ? "dimmed" : "",
            resource?.absent || (localService && !localService.enabled) ? "absent" : "",
            resource && node.shape === "member" && !read.has(node.id) ? "unread" : "",
          ].join(" ");
          return (
            <button
              key={node.id}
              className={classes}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              aria-current={selected === node.id}
              onClick={(event) => {
                event.stopPropagation();
                select(selected === node.id ? undefined : node.id);
              }}
              title={resource?.absent ? `Absent in the ${model.mode === "dev" ? "development" : "production"} graph` : undefined}
            >
              <EntityIcon icon={localService ? "postgres" : target ? targetIcon(target) : route ? routeIcon(route) : resourceIcon(resource!)} badge={resource ? resourceBadge(resource) : undefined} />
              {localService ? <><span className="label">{localService.title}<span className="sub">{localService.image} · Compose</span></span><DeploymentBadge kind="dev" /></> : null}
              {target ? <TargetNode target={target} /> : null}
              {route ? (
                <>
                  <span className="label">{route.kind === "webSocket" ? route.path : route.browserPath ?? route.path}</span>
                  <DeploymentBadge kind={index.targets.has(route.target) ? deploymentBadge(index.targets.get(route.target)!.lanes) : undefined} />
                  {route.auth ? <Lock size={13} aria-label="Requires a signed-in user" /> : null}
                </>
              ) : null}
              {resource ? <ResourceNode resource={resource} shape={node.shape} badge={availabilityBadge(availability[resource.id] ?? { dev: false, prod: false })} /> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
