import { ExternalLink, Maximize2, Minus, Plus, Search, Table2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { schemaLayout, TABLE_WIDTH } from "../schema-layout";
import { useStudio } from "../studio";

export function SchemaLink() {
  return <Link to="/database" search={{}} className="schema-link"><Table2 size={16} aria-hidden />View schema</Link>;
}

function SourceLink({ source }: { readonly source: SourceLocation }) {
  const { snapshot } = useStudio();
  return <a className="small" href={editorLink(snapshot.repositoryRoot, source)}>{source.file}:{source.line} <ExternalLink size={12} aria-hidden /></a>;
}

export function SchemaDetails() {
  const { snapshot, selected, select } = useStudio();
  const schema = snapshot.schema;
  const table = schema.tables.find((table) => table.id === selected);
  const relation = schema.relations.find((relation) => relation.id === selected);
  if (table) return <>
    <header><span className="kind">Declared table</span><h2>{table.table}</h2><code className="ref">{table.namespace}.{table.model}</code><SourceLink source={table.source} /></header>
    <section><h3>Columns</h3><dl className="schema-column-details">{table.columns.map((column) => <div key={column.name}>
      <dt><strong>{column.column}</strong> <code>{column.type}</code></dt>
      <dd>{column.name !== column.column ? <span>Model field: <code>{column.name}</code>. </span> : null}{column.nullable ? "Nullable" : "Required"}{column.primaryKey ? " · Primary key" : ""}{column.unique ? " · Unique" : ""}
        {column.default ? <p>Default: <code>{column.default}</code></p> : null}<SourceLink source={column.source} /></dd>
    </div>)}</dl></section>
    <section><h3>Keys and indexes</h3>{table.indexes.length ? table.indexes.map((index, position) => <div className="schema-index" key={position}>
      <strong>{index.name ?? `${index.kind} (${index.fields.join(", ")})`}</strong><code>{index.declaration}</code><SourceLink source={index.source} />
    </div>) : <p className="muted">No keys or indexes declared.</p>}</section>
    <section><h3>Relationships</h3>{schema.relations.filter((relation) => relation.from === table.id || relation.to === table.id).map((relation) => <button className="linkish" key={relation.id} onClick={() => select(relation.id)}>{relation.name} · {relation.cardinality}</button>)}</section>
  </>;
  if (relation) {
    const from = schema.tables.find((table) => table.id === relation.from)!;
    const to = schema.tables.find((table) => table.id === relation.to)!;
    return <><header><span className="kind">Declared relationship</span><h2>{from.model}.{relation.name}</h2><SourceLink source={relation.source} /></header>
      <section><h3>Foreign key</h3><p><button className="linkish" onClick={() => select(from.id)}>{from.table}</button> ({relation.fields.map((name) => from.columns.find((column) => column.name === name)?.column ?? name).join(", ")})</p>
        <p>references <button className="linkish" onClick={() => select(to.id)}>{to.table}</button> ({relation.references.map((name) => to.columns.find((column) => column.name === name)?.column ?? name).join(", ")})</p>
        <p>{relation.cardinality === "N:1" ? "Many to one" : "One to one"} · {relation.nullable ? "Optional" : "Required"}</p>
      </section><section><h3>Referential actions</h3><p>On delete: <strong>{relation.onDelete}</strong></p><p>On update: <strong>{relation.onUpdate}</strong></p></section></>;
  }
  return null;
}

export function Database() {
  const { snapshot, model, selected, select } = useStudio();
  const schema = snapshot.schema;
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const search = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => schemaLayout(schema), [schema]);
  const searched = query.trim().toLowerCase();
  const matches = new Set(schema.tables.filter((table) => `${table.model} ${table.table} ${table.columns.map((column) => `${column.name} ${column.column}`).join(" ")}`.toLowerCase().includes(searched)).map((table) => table.id));
  const chosenRelation = schema.relations.find((relation) => relation.id === selected);
  const related = new Set(schema.relations.filter((relation) => relation.id === selected || relation.from === selected || relation.to === selected).flatMap((relation) => [relation.from, relation.to]));
  const selectedSchema = schema.tables.some((table) => table.id === selected) || !!chosenRelation;
  const fit = () => { if (viewport.current) setZoom(Math.max(0.35, Math.min(1.25, (viewport.current.clientWidth - 30) / layout.width, (viewport.current.clientHeight - 30) / layout.height))); };
  return <div className="database-view">
    <header className="schema-heading"><div><span className="kind">Application database</span><h1>Declared schema</h1>
      {model.managedDatabase ? <p className="small"><button className="button" onClick={() => select(model.managedDatabase!.resource)}>Configure PostgreSQL</button> {model.managedDatabase.networkId} VPC · {model.managedDatabase.subnet} subnets</p> : null}
      <p className="muted">{schema.tables.length} tables · {schema.relations.length} relationships · Shared by local PostgreSQL and production RDS</p>
      <p className="small muted">Read from <code>{schema.file}</code>. This diagram does not inspect the live databases.</p>
    </div><div className="schema-zoom" role="group" aria-label="Schema view controls"><button className="icon-button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 0.35} onClick={() => setZoom((zoom) => Math.max(0.35, zoom / 1.2))}><Minus size={16} aria-hidden /></button><span>{Math.round(zoom * 100)}%</span><button className="icon-button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 1.6} onClick={() => setZoom((zoom) => Math.min(1.6, zoom * 1.2))}><Plus size={16} aria-hidden /></button><button className="icon-button" aria-label="Fit schema" title="Fit schema" onClick={fit}><Maximize2 size={16} aria-hidden /></button></div></header>
    <div className="schema-toolbar"><div className="schema-search" role="search" aria-label="Schema search"><Search size={15} aria-hidden /><input ref={search} aria-label="Find a table or column" type="search" placeholder="Find a table or column" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setQuery(""); } }} />{query ? <button className="icon-button" aria-label="Clear schema search" title="Clear schema search" onClick={() => { setQuery(""); search.current?.focus(); }}><X size={14} aria-hidden /></button> : null}</div><span className="small muted">PK primary key · FK foreign key · UQ unique</span>{searched ? <span className="small" role="status">{matches.size === 0 ? "No matching tables or columns" : `${matches.size} matching ${matches.size === 1 ? "table" : "tables"}`}</span> : null}</div>
    {schema.problems.length || snapshot.databaseProblems.length ? <div className="schema-problems" role="status">{[...schema.problems, ...snapshot.databaseProblems].map((problem, index) => <p key={index}>{problem}</p>)}</div> : null}
    {schema.tables.length ? <>
      <div className="schema-viewport" ref={viewport} tabIndex={0} aria-label="Database relationship diagram">
        <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <div className="schema-stage" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
            <svg className="schema-connectors" width={layout.width} height={layout.height} aria-hidden>
              <defs><marker id="schema-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8" fill="var(--dev)" /></marker></defs>
              {layout.edges.map(({ relation, path, label }) => {
                const active = relation.id === selected || relation.from === selected || relation.to === selected;
                return <g key={relation.id} className={`schema-connector ${active ? "active" : ""} ${!matches.has(relation.from) && !matches.has(relation.to) ? "faded" : ""}`}>
                  <path d={path} markerEnd="url(#schema-arrow)" /><path d={path} className="schema-edge-hit" onClick={() => select(relation.id)} /><text x={label.x} y={label.y} textAnchor="middle">{relation.cardinality}{relation.nullable ? " · optional" : ""}</text>
                </g>;
              })}
            </svg>
            {layout.tables.map(({ table, x, y }) => <article key={table.id} className={`schema-table ${selected === table.id || related.has(table.id) ? "active" : ""} ${!matches.has(table.id) || (selectedSchema && selected !== table.id && !related.has(table.id)) ? "faded" : ""}`} style={{ left: x, top: y, width: TABLE_WIDTH }}>
              <button className="schema-table-heading" aria-label={`Select table ${table.table}`} title={`${table.namespace}.${table.table} · ${table.model}`} aria-pressed={selected === table.id} onClick={() => select(table.id)}><span><strong>{table.table}</strong><span className="small muted">{table.namespace} · {table.model}</span></span><Table2 size={20} aria-hidden /></button>
              {table.columns.map((column) => {
                const foreign = schema.relations.some((relation) => relation.from === table.id && relation.fields.includes(column.name));
                const highlighted = chosenRelation && ((chosenRelation.from === table.id && chosenRelation.fields.includes(column.name)) || (chosenRelation.to === table.id && chosenRelation.references.includes(column.name)));
                return <button className={`schema-column ${highlighted ? "highlighted" : ""}`} key={column.name} onClick={() => select(table.id)} title={`${column.name} · ${column.type}${column.default ? ` · default ${column.default}` : ""}`}><span className="schema-key">{[column.primaryKey ? "PK" : "", foreign ? "FK" : "", column.unique && !column.primaryKey ? "UQ" : ""].filter(Boolean).join(" ")}</span><code>{column.column}</code><span className="schema-type">{column.type}</span></button>;
              })}
              <footer>{table.indexes.length} keys / indexes</footer>
            </article>)}
          </div>
        </div>
      </div>
      <section className="schema-relationships"><h2>Relationships</h2>{schema.relations.length ? schema.relations.map((relation) => {
        const from = schema.tables.find((table) => table.id === relation.from)!;
        const to = schema.tables.find((table) => table.id === relation.to)!;
        return <button key={relation.id} aria-pressed={selected === relation.id} onClick={() => select(relation.id)}><span><strong>{from.table}</strong> → <strong>{to.table}</strong> <span className="muted">{relation.name}</span></span><code>{relation.cardinality}</code><span className="small muted">Delete: {relation.onDelete}</span></button>;
      }) : <p className="muted">No foreign-key relationships declared.</p>}</section>
      {schema.enums.length ? <section className="schema-enums"><h2>Enums</h2>{schema.enums.map((item) => <p key={item.name}><strong>{item.name}</strong> <code>{item.values.join(" · ")}</code></p>)}</section> : null}
    </> : <p className="empty">{schema.problems.length ? "Fix the contract source to display its schema." : "No tables declared yet."}</p>}
  </div>;
}
