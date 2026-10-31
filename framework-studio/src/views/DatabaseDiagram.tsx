import { workbenchNoticeClasses } from "./WorkbenchUI";
import { cx } from "../ui/classes";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { Minus, Plus, Scan, Search, Table2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DeclaredSchema, SchemaTable } from "../../shared/database";
import type { SourceLocation } from "../../shared/model";
import { schemaLayout, TABLE_WIDTH } from "../schema-layout";

export interface SchemaSelection {
  readonly table: string;
  readonly field?: string;
  readonly relation?: string;
}

/** A projection of the current valid draft; this component never authors source. */
export function DatabaseDiagram({
  schema,
  selection,
  onSelect,
  onLocate,
  retained = false,
}: {
  readonly schema: DeclaredSchema;
  readonly selection?: SchemaSelection;
  readonly onSelect: (selection: SchemaSelection) => void;
  readonly onLocate: (source: SourceLocation) => void;
  readonly retained?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(0.8);
  const [focus, setFocus] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => schemaLayout(schema), [schema]);
  const selected = schema.tables.find((table) => table.id === selection?.table);
  const relation = schema.relations.find((item) => item.id === selection?.relation);
  const related = new Set(
    schema.relations
      .filter((item) => item.from === selected?.id || item.to === selected?.id)
      .flatMap((item) => [item.from, item.to]),
  );
  const searched = query.trim().toLowerCase();
  const matches = new Set(
    schema.tables
      .filter((table) =>
        `${table.model} ${table.table} ${table.columns.map((column) => `${column.name} ${column.column}`).join(" ")}`
          .toLowerCase()
          .includes(searched),
      )
      .map((table) => table.id),
  );
  const fit = () => {
    if (viewport.current)
      setZoom(
        Math.max(
          0.15,
          Math.min(
            1.25,
            (viewport.current.clientWidth - 24) / layout.width,
            (viewport.current.clientHeight - 24) / layout.height,
          ),
        ),
      );
  };
  const choose = (
    table: SchemaTable,
    field?: string,
    source = field ? table.columns.find((column) => column.name === field)?.source : table.source,
  ) => {
    onSelect({ table: table.id, field });
    if (source && !retained) onLocate(source);
  };
  return (
    <div data-ui="workbench-diagram" className="flex min-h-0 flex-1 flex-col">
      <div
        data-ui="workbench-pane-toolbar"
        className="flex flex-wrap items-center justify-between gap-[5px] border-b border-rule p-2"
      >
        <div
          data-ui="schema-search"
          className="flex min-w-0 max-w-full flex-[1_1_120px] items-center gap-2 rounded-md border border-rule-strong bg-sheet px-2 focus-within:outline-2 focus-within:outline-prod focus-within:outline-offset-2"
        >
          <Search size={14} className="flex-none" aria-hidden />
          <input
            className="min-h-8 min-w-[40px] w-full border-0 bg-transparent px-0 py-1 text-caption text-ink outline-none placeholder:text-faint placeholder:opacity-100 [&::-webkit-search-cancel-button]:hidden"
            ref={search}
            type="search"
            aria-label="Find a table or column"
            placeholder="Find table or field…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
          {query ? (
            <button
              data-ui="icon-button"
              className={iconButtonClasses({
                variant: "quiet",
                size: "compact",
                className: "-mr-2",
              })}
              aria-label="Clear schema search"
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div
          data-ui="schema-zoom"
          className="flex shrink-0 items-center gap-[2px] text-caption"
          role="group"
          aria-label="Schema view controls"
        >
          <button
            data-ui="icon-button"
            className={iconButtonClasses({ size: "compact" })}
            aria-label="Zoom out"
            disabled={zoom <= 0.15}
            onClick={() => setZoom((value) => Math.max(0.15, value / 1.2))}
          >
            <Minus size={14} />
          </button>
          <span className="min-w-[4ch] text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            data-ui="icon-button"
            className={iconButtonClasses({ size: "compact" })}
            aria-label="Zoom in"
            disabled={zoom >= 1.6}
            onClick={() => setZoom((value) => Math.min(1.6, value * 1.2))}
          >
            <Plus size={14} />
          </button>
          <button
            data-ui="icon-button"
            className={iconButtonClasses({ size: "compact" })}
            aria-label="Fit schema"
            title="Fit schema to view"
            onClick={fit}
          >
            <Scan size={14} />
          </button>
        </div>
      </div>
      {retained ? (
        <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="status">
          Last valid diagram · current draft has not passed validation. Source navigation is paused.
        </div>
      ) : null}
      {searched ? (
        <p
          data-ui="workbench-search-status"
          className="m-0 px-[10px] py-1 text-caption text-graphite"
          role="status"
        >
          {matches.size} matching tables · other tables remain in place
        </p>
      ) : null}
      <div
        data-ui="schema-viewport"
        className="min-h-[160px] flex-1 overflow-auto border-0 bg-[radial-gradient(circle,var(--rule)_1px,transparent_1px)] bg-paper bg-size-[20px_20px] focus-visible:-outline-offset-[3px]"
        ref={viewport}
        tabIndex={0}
        aria-label="Database relationship diagram"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            setZoom((value) => Math.min(1.6, value * 1.2));
          }
          if (event.key === "-") {
            event.preventDefault();
            setZoom((value) => Math.max(0.15, value / 1.2));
          }
          if (event.key === "0") {
            event.preventDefault();
            fit();
          }
        }}
      >
        {schema.tables.length ? (
          <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div
              data-ui="schema-stage"
              className="relative origin-top-left"
              style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
            >
              <svg
                data-ui="schema-connectors"
                className="absolute inset-0 overflow-visible"
                width={layout.width}
                height={layout.height}
                aria-hidden
              >
                <defs>
                  <marker
                    id="workbench-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0 0 8 4 0 8" fill="var(--dev)" />
                  </marker>
                </defs>
                {layout.edges.map(({ relation: edge, path, label }) => (
                  <g
                    key={edge.id}
                    data-ui="schema-connector"
                    className={`${(!matches.has(edge.from) && !matches.has(edge.to)) || (focus && selected && !related.has(edge.from) && !related.has(edge.to)) ? "opacity-25" : ""}`}
                  >
                    <path
                      d={path}
                      markerEnd="url(#workbench-arrow)"
                      className={cx(
                        "fill-none stroke-dev",
                        edge.id === relation?.id ||
                          edge.from === selected?.id ||
                          edge.to === selected?.id
                          ? "stroke-[3px]"
                          : "stroke-[1.8px]",
                      )}
                    />
                    <path
                      d={path}
                      data-ui="schema-edge-hit"
                      className="cursor-pointer fill-none stroke-transparent stroke-[18px] [pointer-events:stroke]"
                      onClick={() => {
                        onSelect({ table: edge.from, relation: edge.id });
                        if (!retained) onLocate(edge.source);
                      }}
                    />
                    <text
                      className="fill-dev stroke-paper stroke-[6px] font-mono text-caption font-semibold [paint-order:stroke]"
                      x={label.x}
                      y={label.y}
                      textAnchor="middle"
                    >
                      {edge.cardinality}
                      {edge.nullable ? " · optional" : ""}
                    </text>
                  </g>
                ))}
              </svg>
              {layout.tables.map(({ table, x, y }) => (
                <article
                  key={table.id}
                  data-ui="schema-table"
                  className={`absolute overflow-hidden rounded-lg border bg-sheet ${table.id === selected?.id || (relation && [relation.from, relation.to].includes(table.id)) ? "border-dev shadow-[0_0_0_2px_color-mix(in_srgb,var(--dev)_22%,transparent)]" : "border-rule-strong shadow-[0_4px_14px_#0000000a]"} ${!matches.has(table.id) || (focus && selected && selected.id !== table.id && !related.has(table.id)) ? "opacity-25" : ""}`}
                  style={{ left: x, top: y, width: TABLE_WIDTH }}
                >
                  <button
                    data-ui="schema-table-heading"
                    className="flex h-[69px] w-full items-center justify-between rounded-none border-0 bg-wash px-4 py-3 text-left [&>svg]:flex-none"
                    aria-label={`Select table ${table.table}`}
                    aria-pressed={selected?.id === table.id}
                    onClick={() => choose(table)}
                    title={`${table.namespace}.${table.table}`}
                  >
                    <span className="min-w-0">
                      <strong className="mb-0.75 block truncate font-condensed text-[20px] font-semibold [line-height:normal]">
                        {table.model}
                      </strong>
                      <span data-ui="small" className="block truncate text-meta text-graphite">
                        {table.namespace}.{table.table}
                      </span>
                    </span>
                    <Table2 size={18} className="flex-none" aria-hidden />
                  </button>
                  {table.columns.map((column) => {
                    const foreign = schema.relations.some(
                      (item) => item.from === table.id && item.fields.includes(column.name),
                    );
                    const highlighted =
                      (selected?.id === table.id && selection?.field === column.name) ||
                      (relation &&
                        ((relation.from === table.id && relation.fields.includes(column.name)) ||
                          (relation.to === table.id && relation.references.includes(column.name))));
                    return (
                      <button
                        data-ui="schema-column"
                        className={`flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-none border-0 border-t border-rule px-3 py-0 text-left hover:bg-wash ${highlighted ? "bg-[color-mix(in_srgb,var(--dev)_15%,var(--sheet))]" : "bg-transparent"}`}
                        key={column.name}
                        aria-label={`Locate ${table.model}.${column.name}`}
                        onClick={() => choose(table, column.name)}
                        title={`${column.name} → ${column.column} · ${column.type} · ${column.nullable ? "nullable" : "required"}${column.default ? ` · default ${column.default}` : ""}`}
                      >
                        <span
                          data-ui="schema-key"
                          className="w-[31px] shrink-0 font-mono text-[9px] font-semibold text-dev [line-height:normal]"
                        >
                          {[
                            column.primaryKey ? "PK" : "",
                            foreign ? "FK" : "",
                            column.unique && !column.primaryKey ? "UQ" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        </span>
                        <code className="truncate text-meta">
                          {column.name}
                          {column.nullable ? "?" : ""}
                        </code>
                        <span
                          data-ui="schema-type"
                          className="ml-auto max-w-[155px] truncate font-mono text-micro text-graphite [line-height:normal]"
                        >
                          {column.type}
                        </span>
                      </button>
                    );
                  })}
                  <footer className="h-[34px] border-t border-rule px-[14px] py-[9px] text-micro text-graphite">
                    {table.indexes.length} keys / indexes
                  </footer>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <p data-ui="empty">No tables to display. Write a model in the source editor.</p>
        )}
      </div>
      <div
        data-ui="workbench-diagram-caption"
        className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-[10px] py-2 text-micro text-graphite"
      >
        <span>
          {schema.tables.length} tables · {schema.relations.length} relationships
        </span>
        <label className="flex items-center gap-1.5">
          <input
            className="m-0 size-[13px] shrink-0 accent-dev disabled:cursor-not-allowed disabled:opacity-55"
            type="checkbox"
            checked={focus}
            disabled={!selected}
            onChange={(event) => setFocus(event.target.checked)}
          />{" "}
          Focus selection
        </label>
      </div>
      <div
        data-ui="workbench-entity-details"
        className="max-h-[180px] shrink-0 overflow-auto border-t border-rule px-3 py-[10px] text-meta"
      >
        {selected ? (
          <>
            <div
              data-ui="workbench-detail-heading"
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <strong>
                {selected.model}
                {selection?.field ? `.${selection.field}` : ""}
              </strong>
              <span data-ui="small" className="text-caption text-graphite">
                {selected.namespace}.{selected.table}
              </span>
            </div>
            {selection?.field
              ? selected.columns
                  .filter((column) => column.name === selection.field)
                  .map((column) => (
                    <p key={column.name} className="my-1.5 only:m-0">
                      <code>{column.type}</code> · {column.nullable ? "Nullable" : "Required"} ·
                      column <code>{column.column}</code>
                      {column.default ? (
                        <>
                          {" "}
                          · default <code>{column.default}</code>
                        </>
                      ) : null}
                    </p>
                  ))
              : null}
            {relation ? (
              <p className="my-1.5 only:m-0">
                <strong>{relation.name}</strong> · ({relation.fields.join(", ")}) →{" "}
                {schema.tables.find((table) => table.id === relation.to)?.model} (
                {relation.references.join(", ")}) · {relation.cardinality} · on delete{" "}
                {relation.onDelete} · on update {relation.onUpdate}
              </p>
            ) : null}
            <div
              data-ui="workbench-inline-list"
              className="mt-[7px] flex flex-wrap gap-x-[14px] gap-y-[5px]"
            >
              {selected.indexes.map((index, position) => (
                <button
                  key={position}
                  data-ui="linkish"
                  className={cx(buttonClasses({ variant: "link" }), "text-meta")}
                  disabled={retained}
                  title={index.declaration}
                  onClick={() => onLocate(index.source)}
                >
                  {index.name ?? `${index.kind} (${index.fields.join(", ")})`}
                </button>
              ))}
              {schema.relations
                .filter((item) => item.from === selected.id || item.to === selected.id)
                .map((item) => (
                  <button
                    key={item.id}
                    data-ui="linkish"
                    className={cx(buttonClasses({ variant: "link" }), "text-meta")}
                    onClick={() => {
                      onSelect({ table: item.from, relation: item.id });
                      if (!retained) onLocate(item.source);
                    }}
                  >
                    {item.name} · {item.cardinality}
                  </button>
                ))}
            </div>
          </>
        ) : (
          <p data-ui="small" className="my-1.5 only:m-0 text-caption text-graphite">
            Select a table, field or relationship to locate its source. PK primary key · FK foreign
            key · UQ unique.
          </p>
        )}
        {schema.enums.length ? (
          <details>
            <summary>{schema.enums.length} enums</summary>
            {schema.enums.map((item) => (
              <p key={item.name} className="my-1.5">
                <strong>{item.name}</strong> <code>{item.values.join(" · ")}</code>
              </p>
            ))}
          </details>
        ) : null}
        {schema.problems.length ? (
          <details>
            <summary>Diagram capability notes ({schema.problems.length})</summary>
            {schema.problems.map((problem, index) => (
              <p key={index} data-ui="small" className="my-1.5 text-caption">
                {problem}
              </p>
            ))}
          </details>
        ) : null}
      </div>
    </div>
  );
}
