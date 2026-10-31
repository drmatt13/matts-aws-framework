import {
  inspectorSectionClasses,
  inspectorTitleClasses,
  inspectorHeaderClasses,
} from "../inspector-ui";

import { buttonClasses } from "../ui/Button";
import { ExternalLink, Table2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { InspectorKind } from "./InspectorUI";

export function SchemaLink() {
  return (
    <Link
      to="/database"
      search={{}}
      className="flex items-center gap-2 font-semibold w-fit"
      data-slot="schema-link"
    >
      <Table2 size={16} aria-hidden />
      View schema
    </Link>
  );
}

function SourceLink({
  source,
  column = false,
}: {
  readonly source: SourceLocation;
  readonly column?: boolean;
}) {
  const { snapshot } = useStudio();
  return (
    <a
      className={column ? "block mt-1.5 text-caption wrap-anywhere" : "text-caption"}
      href={editorLink(snapshot.repositoryRoot, source)}
    >
      {source.file}:{source.line} <ExternalLink size={12} aria-hidden />
    </a>
  );
}

export function SchemaDetails() {
  const { snapshot, selected, select } = useStudio();
  const schema = snapshot.schema;
  const table = schema.tables.find((table) => table.id === selected);
  const relation = schema.relations.find((relation) => relation.id === selected);
  if (table)
    return (
      <>
        <header className={inspectorHeaderClasses}>
          <InspectorKind>Declared table</InspectorKind>
          <h2 className={inspectorTitleClasses}>{table.table}</h2>
          <code className="block text-graphite text-meta wrap-anywhere" data-slot="ref">
            {table.namespace}.{table.model}
          </code>
          <SourceLink source={table.source} />
        </header>
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Columns</h3>
          <dl className="m-0" data-slot="schema-column-details">
            {table.columns.map((column) => (
              <div className="py-3 border-b border-rule" key={column.name}>
                <dt className="flex flex-wrap justify-between gap-x-2 gap-y-1 wrap-anywhere">
                  <strong>{column.column}</strong> <code>{column.type}</code>
                </dt>
                <dd className="mt-1.5 mx-0 mb-0 text-graphite text-caption">
                  {column.name !== column.column ? (
                    <span>
                      Model field: <code>{column.name}</code>.{" "}
                    </span>
                  ) : null}
                  {column.nullable ? "Nullable" : "Required"}
                  {column.primaryKey ? " · Primary key" : ""}
                  {column.unique ? " · Unique" : ""}
                  {column.default ? (
                    <p className="mt-0 mb-2">
                      Default: <code>{column.default}</code>
                    </p>
                  ) : null}
                  <SourceLink column source={column.source} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Keys and indexes</h3>
          {table.indexes.length ? (
            table.indexes.map((index, position) => (
              <div
                className="grid [gap:6px] p-[12px_0] border-b border-rule wrap-anywhere"
                key={position}
                data-slot="schema-index"
              >
                <strong>{index.name ?? `${index.kind} (${index.fields.join(", ")})`}</strong>
                <code>{index.declaration}</code>
                <SourceLink source={index.source} />
              </div>
            ))
          ) : (
            <p className="mt-0 mb-2 text-graphite">No keys or indexes declared.</p>
          )}
        </section>
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Relationships</h3>
          {schema.relations
            .filter((relation) => relation.from === table.id || relation.to === table.id)
            .map((relation) => (
              <button
                className={buttonClasses({ variant: "link" })}
                key={relation.id}
                onClick={() => select(relation.id)}
              >
                {relation.name} · {relation.cardinality}
              </button>
            ))}
        </section>
      </>
    );
  if (relation) {
    const from = schema.tables.find((table) => table.id === relation.from)!;
    const to = schema.tables.find((table) => table.id === relation.to)!;
    return (
      <>
        <header className={inspectorHeaderClasses}>
          <InspectorKind>Declared relationship</InspectorKind>
          <h2 className={inspectorTitleClasses}>
            {from.model}.{relation.name}
          </h2>
          <SourceLink source={relation.source} />
        </header>
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Foreign key</h3>
          <p className="mt-0 mb-2">
            <button className={buttonClasses({ variant: "link" })} onClick={() => select(from.id)}>
              {from.table}
            </button>{" "}
            (
            {relation.fields
              .map((name) => from.columns.find((column) => column.name === name)?.column ?? name)
              .join(", ")}
            )
          </p>
          <p className="mt-0 mb-2">
            references{" "}
            <button className={buttonClasses({ variant: "link" })} onClick={() => select(to.id)}>
              {to.table}
            </button>{" "}
            (
            {relation.references
              .map((name) => to.columns.find((column) => column.name === name)?.column ?? name)
              .join(", ")}
            )
          </p>
          <p className="mt-0 mb-2">
            {relation.cardinality === "N:1" ? "Many to one" : "One to one"} ·{" "}
            {relation.nullable ? "Optional" : "Required"}
          </p>
        </section>
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Referential actions</h3>
          <p className="mt-0 mb-2">
            On delete: <strong>{relation.onDelete}</strong>
          </p>
          <p className="mt-0 mb-2">
            On update: <strong>{relation.onUpdate}</strong>
          </p>
        </section>
      </>
    );
  }
  return null;
}
