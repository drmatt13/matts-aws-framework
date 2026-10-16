import { Lock } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModelResource, ModelTarget } from "../../shared/model";
import { layoutBoard, type BoardNode } from "../layout";
import { CATEGORY_LABEL, ROLE_LABEL, type EdgeCategory } from "../lookup";
import { useStudio } from "../studio";
import { LaneDots, LaneLegend } from "./LaneDots";

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
      <LaneDots lanes={target.lanes} />
    </>
  );
}

function ResourceNode(props: { readonly resource: ModelResource; readonly shape: BoardNode["shape"] }) {
  const { resource, shape } = props;
  const name = shape === "member" ? resource.path[resource.path.length - 1] : resource.path.join(".");
  const kind =
    resource.kind === "stack" ? resource.stackClass ?? "stack" : resource.kind === "secret" ? "secret" : resource.kind === "input" ? resource.fromEnv ?? "input" : resource.kind === "group" ? "group" : undefined;
  return (
    <>
      <span className="label">{name}</span>
      {shape === "member" && resource.typeText ? <span className="type">{resource.typeText}</span> : null}
      {shape !== "member" && kind ? <span className="type code muted">{kind}</span> : null}
    </>
  );
}

export function Board() {
  const { model, index, selected, select } = useStudio();
  const layout = useMemo(() => layoutBoard(model), [model]);
  const [shown, setShown] = useState<ReadonlySet<EdgeCategory>>(() => new Set(CATEGORIES));

  const read = useMemo(() => new Set(model.edges.map((edge) => edge.to)), [model]);
  const neighbours = useMemo(() => {
    if (!selected) return undefined;
    const ids = new Set([selected]);
    for (const edge of index.edges.get(selected) ?? []) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [index, selected]);

  if (model.targets.length === 0) {
    return <p className="empty">The {model.mode === "dev" ? "development" : "production"} graph did not load. Open configuration health for the reason.</p>;
  }

  const visible = layout.edges.filter((edge) => shown.has(edge.category));
  const lit = (edge: (typeof visible)[number]) => selected !== undefined && (edge.edge.from === selected || edge.edge.to === selected);

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
        <LaneLegend />
      </div>
      <div className="board" style={{ width: layout.width + 120, height: layout.height }} onClick={() => select(undefined)}>
        <svg className="edges" width={layout.width + 120} height={layout.height} aria-hidden>
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
                className={`edge ${edge.edge.provenance === "derived" ? "derived" : ""} ${selected ? "faded" : ""}`}
              />
            ))}
          {visible.filter(lit).map((edge) => (
            <g key={edge.edge.id} style={{ color: "var(--ink)" }}>
              <path d={edge.path} className={`edge lit ${edge.edge.provenance === "derived" ? "derived" : ""}`} markerEnd="url(#arrow)" />
              <text className="edge-label" x={edge.label.x} y={edge.label.y - 4} textAnchor="middle">
                {edge.edge.label}
              </text>
            </g>
          ))}
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
          const classes = [
            "node",
            node.shape,
            neighbours && !neighbours.has(node.id) ? "dimmed" : "",
            resource?.absent ? "absent" : "",
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
              {target ? <TargetNode target={target} /> : null}
              {route ? (
                <>
                  <span className="label">{route.kind === "webSocket" ? route.path : route.browserPath ?? route.path}</span>
                  {route.auth ? <Lock size={13} aria-label="Requires a signed-in user" /> : null}
                </>
              ) : null}
              {resource ? <ResourceNode resource={resource} shape={node.shape} /> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
