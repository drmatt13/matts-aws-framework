import { Maximize2, Minus, Plus, Search, Table2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DeclaredSchema, SchemaTable } from "../../shared/database";
import type { SourceLocation } from "../../shared/model";
import { schemaLayout, TABLE_WIDTH } from "../schema-layout";

export interface SchemaSelection { readonly table: string; readonly field?: string; readonly relation?: string }

/** A projection of the current valid draft; this component never authors source. */
export function DatabaseDiagram({ schema, selection, onSelect, onLocate, retained = false }: {
  readonly schema: DeclaredSchema;
  readonly selection?: SchemaSelection;
  readonly onSelect: (selection: SchemaSelection) => void;
  readonly onLocate: (source: SourceLocation) => void;
  readonly retained?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(.8);
  const [focus, setFocus] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => schemaLayout(schema), [schema]);
  const selected = schema.tables.find(table => table.id === selection?.table);
  const relation = schema.relations.find(item => item.id === selection?.relation);
  const related = new Set(schema.relations.filter(item => item.from === selected?.id || item.to === selected?.id).flatMap(item => [item.from, item.to]));
  const searched = query.trim().toLowerCase();
  const matches = new Set(schema.tables.filter(table => `${table.model} ${table.table} ${table.columns.map(column => `${column.name} ${column.column}`).join(" ")}`.toLowerCase().includes(searched)).map(table => table.id));
  const fit = () => { if (viewport.current) setZoom(Math.max(.15, Math.min(1.25, (viewport.current.clientWidth - 24) / layout.width, (viewport.current.clientHeight - 24) / layout.height))); };
  const choose = (table: SchemaTable, field?: string, source = field ? table.columns.find(column => column.name === field)?.source : table.source) => {
    onSelect({ table: table.id, field });
    if (source && !retained) onLocate(source);
  };
  return <div className="workbench-diagram">
    <div className="workbench-pane-toolbar">
      <div className="schema-search"><Search size={14} aria-hidden /><input ref={search} type="search" aria-label="Find a table or column" placeholder="Find table or field…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setQuery(""); }} />{query ? <button className="icon-button" aria-label="Clear schema search" onClick={() => { setQuery(""); search.current?.focus(); }}><X size={13} /></button> : null}</div>
      <div className="schema-zoom" role="group" aria-label="Schema view controls">
        <button className="icon-button" aria-label="Zoom out" disabled={zoom <= .15} onClick={() => setZoom(value => Math.max(.15, value / 1.2))}><Minus size={14} /></button>
        <span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Zoom in" disabled={zoom >= 1.6} onClick={() => setZoom(value => Math.min(1.6, value * 1.2))}><Plus size={14} /></button>
        <button className="icon-button" aria-label="Fit schema" onClick={fit}><Maximize2 size={14} /></button>
      </div>
    </div>
    {retained ? <div className="workbench-notice warning" role="status">Last valid diagram · current draft has not passed validation. Source navigation is paused.</div> : null}
    {searched ? <p className="workbench-search-status small muted" role="status">{matches.size} matching tables · other tables remain in place</p> : null}
    <div className="schema-viewport" ref={viewport} tabIndex={0} aria-label="Database relationship diagram" onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom(value => Math.min(1.6, value * 1.2)); }
      if (event.key === "-") { event.preventDefault(); setZoom(value => Math.max(.15, value / 1.2)); }
      if (event.key === "0") { event.preventDefault(); fit(); }
    }}>
      {schema.tables.length ? <div style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="schema-stage" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
        <svg className="schema-connectors" width={layout.width} height={layout.height} aria-hidden>
          <defs><marker id="workbench-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8" fill="var(--dev)" /></marker></defs>
          {layout.edges.map(({ relation: edge, path, label }) => <g key={edge.id} className={`schema-connector ${edge.id === relation?.id || edge.from === selected?.id || edge.to === selected?.id ? "active" : ""} ${!matches.has(edge.from) && !matches.has(edge.to) || focus && selected && !related.has(edge.from) && !related.has(edge.to) ? "faded" : ""}`}>
            <path d={path} markerEnd="url(#workbench-arrow)" /><path d={path} className="schema-edge-hit" onClick={() => { onSelect({ table: edge.from, relation: edge.id }); if (!retained) onLocate(edge.source); }} /><text x={label.x} y={label.y} textAnchor="middle">{edge.cardinality}{edge.nullable ? " · optional" : ""}</text>
          </g>)}
        </svg>
        {layout.tables.map(({ table, x, y }) => <article key={table.id} className={`schema-table ${table.id === selected?.id || relation && [relation.from, relation.to].includes(table.id) ? "active" : ""} ${!matches.has(table.id) || focus && selected && selected.id !== table.id && !related.has(table.id) ? "faded" : ""}`} style={{ left: x, top: y, width: TABLE_WIDTH }}>
          <button className="schema-table-heading" aria-label={`Select table ${table.table}`} aria-pressed={selected?.id === table.id} onClick={() => choose(table)} title={`${table.namespace}.${table.table}`}><span><strong>{table.model}</strong><span className="small muted">{table.namespace}.{table.table}</span></span><Table2 size={18} aria-hidden /></button>
          {table.columns.map(column => {
            const foreign = schema.relations.some(item => item.from === table.id && item.fields.includes(column.name));
            const highlighted = selected?.id === table.id && selection?.field === column.name || relation && (relation.from === table.id && relation.fields.includes(column.name) || relation.to === table.id && relation.references.includes(column.name));
            return <button className={`schema-column ${highlighted ? "highlighted" : ""}`} key={column.name} aria-label={`Locate ${table.model}.${column.name}`} onClick={() => choose(table, column.name)} title={`${column.name} → ${column.column} · ${column.type} · ${column.nullable ? "nullable" : "required"}${column.default ? ` · default ${column.default}` : ""}`}><span className="schema-key">{[column.primaryKey ? "PK" : "", foreign ? "FK" : "", column.unique && !column.primaryKey ? "UQ" : ""].filter(Boolean).join(" ")}</span><code>{column.name}{column.nullable ? "?" : ""}</code><span className="schema-type">{column.type}</span></button>;
          })}<footer>{table.indexes.length} keys / indexes</footer>
        </article>)}
      </div></div> : <p className="empty">No tables to display. Write a model in the source editor.</p>}
    </div>
    <div className="workbench-diagram-caption"><span>{schema.tables.length} tables · {schema.relations.length} relationships</span><label><input type="checkbox" checked={focus} disabled={!selected} onChange={event => setFocus(event.target.checked)} /> Focus selection</label></div>
    <div className="workbench-entity-details">
      {selected ? <><div className="workbench-detail-heading"><strong>{selected.model}{selection?.field ? `.${selection.field}` : ""}</strong><span className="small muted">{selected.namespace}.{selected.table}</span></div>
        {selection?.field ? selected.columns.filter(column => column.name === selection.field).map(column => <p key={column.name}><code>{column.type}</code> · {column.nullable ? "Nullable" : "Required"} · column <code>{column.column}</code>{column.default ? <> · default <code>{column.default}</code></> : null}</p>) : null}
        {relation ? <p><strong>{relation.name}</strong> · ({relation.fields.join(", ")}) → {schema.tables.find(table => table.id === relation.to)?.model} ({relation.references.join(", ")}) · {relation.cardinality} · on delete {relation.onDelete} · on update {relation.onUpdate}</p> : null}
        <div className="workbench-inline-list">{selected.indexes.map((index, position) => <button key={position} className="linkish small" disabled={retained} title={index.declaration} onClick={() => onLocate(index.source)}>{index.name ?? `${index.kind} (${index.fields.join(", ")})`}</button>)}{schema.relations.filter(item => item.from === selected.id || item.to === selected.id).map(item => <button key={item.id} className="linkish small" onClick={() => { onSelect({ table: item.from, relation: item.id }); if (!retained) onLocate(item.source); }}>{item.name} · {item.cardinality}</button>)}</div>
      </> : <p className="small muted">Select a table, field or relationship to locate its source. PK primary key · FK foreign key · UQ unique.</p>}
      {schema.enums.length ? <details><summary>{schema.enums.length} enums</summary>{schema.enums.map(item => <p key={item.name}><strong>{item.name}</strong> <code>{item.values.join(" · ")}</code></p>)}</details> : null}
      {schema.problems.length ? <details><summary>Diagram capability notes ({schema.problems.length})</summary>{schema.problems.map((problem, index) => <p key={index} className="small">{problem}</p>)}</details> : null}
    </div>
  </div>;
}
