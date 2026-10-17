import type { DeclaredSchema, SchemaTable } from "../shared/database";

export const TABLE_WIDTH = 340;
export const TABLE_HEADER = 70;
export const COLUMN_HEIGHT = 30;
export const tableHeight = (table: SchemaTable) => TABLE_HEADER + table.columns.length * COLUMN_HEIGHT + 34;

/** Deterministic table cards and column-to-column FK connectors, including self references. */
export function schemaLayout(schema: DeclaredSchema) {
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(schema.tables.length))));
  const tables: { table: SchemaTable; x: number; y: number; height: number }[] = [];
  let y = 52;
  for (let start = 0; start < schema.tables.length; start += columns) {
    const row = schema.tables.slice(start, start + columns);
    row.forEach((table, index) => tables.push({ table, x: 48 + index * (TABLE_WIDTH + 160), y, height: tableHeight(table) }));
    y += Math.max(...row.map(tableHeight)) + 110;
  }
  const positions = new Map(tables.map((entry) => [entry.table.id, entry]));
  const edges = schema.relations.flatMap((relation, index) => {
    const from = positions.get(relation.from);
    const to = positions.get(relation.to);
    if (!from || !to) return [];
    const columnY = (entry: typeof from, field: string) => entry.y + TABLE_HEADER + Math.max(0, entry.table.columns.findIndex((column) => column.name === field)) * COLUMN_HEIGHT + COLUMN_HEIGHT / 2;
    const y1 = columnY(from, relation.fields[0]!);
    const y2 = columnY(to, relation.references[0]!);
    const goesRight = to.x > from.x;
    const sameColumn = to.x === from.x;
    const x1 = from.x + (goesRight || sameColumn ? TABLE_WIDTH : 0);
    const x2 = to.x + (goesRight ? 0 : TABLE_WIDTH);
    const bend = sameColumn ? Math.max(x1, x2) + 65 + (index % 4) * 16 : (x1 + x2) / 2 + (index % 4) * 12;
    const path = relation.from === relation.to
      ? `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y1 - 44}, ${x1} ${y1 - 44} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`;
    return [{ relation, path, label: { x: sameColumn ? bend + 6 : (x1 + x2) / 2, y: (y1 + y2) / 2 - 10 } }];
  });
  return { tables, edges, width: Math.max(480, columns * (TABLE_WIDTH + 160)), height: Math.max(350, y) };
}
