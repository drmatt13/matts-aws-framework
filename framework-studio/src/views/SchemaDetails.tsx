import { buttonClasses } from "../ui/Button";
import { ExternalLink, Table2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";

export function SchemaLink() {
  return <Link to="/database" search={{}} className={"flex items-center gap-2 font-semibold w-fit"} data-slot="schema-link"><Table2 size={16} aria-hidden />View schema</Link>;
}

function SourceLink({ source }: { readonly source: SourceLocation }) {
  const { snapshot } = useStudio();
  return <a className={"text-caption"} href={editorLink(snapshot.repositoryRoot, source)}>{source.file}:{source.line} <ExternalLink size={12} aria-hidden /></a>;
}

export function SchemaDetails() {
  const { snapshot, selected, select } = useStudio();
  const schema = snapshot.schema;
  const table = schema.tables.find((table) => table.id === selected);
  const relation = schema.relations.find((relation) => relation.id === selected);
  if (table) return <>
    <header><span className={"text-graphite text-meta font-medium tracking-[.03em]"}>Declared table</span><h2>{table.table}</h2><code className={"block text-graphite text-meta wrap-anywhere"} data-slot="ref">{table.namespace}.{table.model}</code><SourceLink source={table.source} /></header>
    <section><h3>Columns</h3><dl className={"m-0 [&>div]:p-[12px_0] [&>div]:border-b [&>div]:border-rule [&_dt]:flex [&_dt]:flex-wrap [&_dt]:justify-between [&_dt]:gap-[var(--space-1)_var(--space-2)] [&_dt]:wrap-anywhere [&_dd]:m-[6px_0_0] [&_dd]:text-graphite [&_dd]:text-caption [&_a]:block [&_a]:mt-1.5 [&_a]:wrap-anywhere"} data-slot="schema-column-details">{table.columns.map((column) => <div key={column.name}>
      <dt><strong>{column.column}</strong> <code>{column.type}</code></dt>
      <dd>{column.name !== column.column ? <span>Model field: <code>{column.name}</code>. </span> : null}{column.nullable ? "Nullable" : "Required"}{column.primaryKey ? " · Primary key" : ""}{column.unique ? " · Unique" : ""}
        {column.default ? <p>Default: <code>{column.default}</code></p> : null}<SourceLink source={column.source} /></dd>
    </div>)}</dl></section>
    <section><h3>Keys and indexes</h3>{table.indexes.length ? table.indexes.map((index, position) => <div className={"grid [gap:6px] p-[12px_0] border-b border-rule wrap-anywhere"} key={position} data-slot="schema-index">
      <strong>{index.name ?? `${index.kind} (${index.fields.join(", ")})`}</strong><code>{index.declaration}</code><SourceLink source={index.source} />
    </div>) : <p className={"text-graphite"}>No keys or indexes declared.</p>}</section>
    <section><h3>Relationships</h3>{schema.relations.filter((relation) => relation.from === table.id || relation.to === table.id).map((relation) => <button className={buttonClasses({ variant: "link" })} key={relation.id} onClick={() => select(relation.id)}>{relation.name} · {relation.cardinality}</button>)}</section>
  </>;
  if (relation) {
    const from = schema.tables.find((table) => table.id === relation.from)!;
    const to = schema.tables.find((table) => table.id === relation.to)!;
    return <><header><span className={"text-graphite text-meta font-medium tracking-[.03em]"}>Declared relationship</span><h2>{from.model}.{relation.name}</h2><SourceLink source={relation.source} /></header>
      <section><h3>Foreign key</h3><p><button className={buttonClasses({ variant: "link" })} onClick={() => select(from.id)}>{from.table}</button> ({relation.fields.map((name) => from.columns.find((column) => column.name === name)?.column ?? name).join(", ")})</p>
        <p>references <button className={buttonClasses({ variant: "link" })} onClick={() => select(to.id)}>{to.table}</button> ({relation.references.map((name) => to.columns.find((column) => column.name === name)?.column ?? name).join(", ")})</p>
        <p>{relation.cardinality === "N:1" ? "Many to one" : "One to one"} · {relation.nullable ? "Optional" : "Required"}</p>
      </section><section><h3>Referential actions</h3><p>On delete: <strong>{relation.onDelete}</strong></p><p>On update: <strong>{relation.onUpdate}</strong></p></section></>;
  }
  return null;
}

