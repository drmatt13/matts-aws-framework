import ts from "typescript";

const lineStart = (text: string, position: number) => text.lastIndexOf("\n", position - 1) + 1;
const comments = (text: string, node: ts.Node) => (ts.getLeadingCommentRanges(text, node.pos) ?? []).length > 0;

/** Removes a whole statement and its line. Refuses one carrying a comment, as removeProperty does. */
export function removeStatement(text: string, statement: ts.Statement, source: ts.SourceFile): string {
  if (comments(text, statement) || (ts.getTrailingCommentRanges(text, statement.end) ?? []).length) throw new Error("This wiring has a comment beside it. Remove it in your editor, so the comment's fate is your decision.");
  const start = statement.getStart(source), first = lineStart(text, start);
  const newline = text.indexOf("\n", statement.end);
  const whole = text.slice(first, start).trim() === "" && text.slice(statement.end, newline === -1 ? text.length : newline).trim() === "";
  return whole ? text.slice(0, first) + text.slice(newline === -1 ? text.length : newline + 1) : text.slice(0, start) + text.slice(statement.end);
}

/** Removes one array element and its separator, keeping the surrounding layout. */
export function removeElement(text: string, array: ts.ArrayLiteralExpression, element: ts.Expression, source: ts.SourceFile): string {
  if (comments(text, element)) throw new Error("This target has a comment beside it. Remove it in your editor.");
  const index = array.elements.indexOf(element);
  const next = array.elements[index + 1], previous = array.elements[index - 1];
  if (next) return text.slice(0, element.getStart(source)) + text.slice(next.getStart(source));
  // The last element: remove from the previous element's end, keeping any trailing comma style.
  const trailing = text.slice(element.end, array.end - 1).match(/^\s*,/)?.[0].length ?? 0;
  return text.slice(0, previous!.end) + (trailing ? "," : "") + text.slice(element.end + trailing);
}

/** Names bound by an import, so a removal can drop only what it left unused. */
function importedNames(statement: ts.ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((item) => item.name.text));
  return names;
}
function uses(source: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

/** Drops import bindings the edit made unused. A binding unused before the edit is left alone. */
export function pruneImports(file: string, before: string, after: string): string {
  const old = uses(ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true));
  let text = after;
  for (;;) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const current = uses(source);
    const orphan = (name: string) => (old.get(name) ?? 0) > 0 && !current.get(name);
    const statement = source.statements.find((item): item is ts.ImportDeclaration => ts.isImportDeclaration(item) && importedNames(item).some(orphan));
    if (!statement) return text;
    const names = importedNames(statement);
    const bindings = statement.importClause?.namedBindings;
    if (names.every(orphan) || !bindings || !ts.isNamedImports(bindings)) {
      if (!names.every(orphan)) return text;
      text = removeStatement(text, statement, source);
      continue;
    }
    const element = bindings.elements.find((item) => orphan(item.name.text));
    if (!element) return text;
    const index = bindings.elements.indexOf(element), next = bindings.elements[index + 1];
    text = next ? text.slice(0, element.getStart(source)) + text.slice(next.getStart(source)) : text.slice(0, bindings.elements[index - 1]!.end) + text.slice(element.end);
  }
}
