import ts from "typescript";
import { followingComma, removeWithComments } from "./comments";

const lineStart = (text: string, position: number) => text.lastIndexOf("\n", position - 1) + 1;

/** Removes a whole statement and its line, sharing property removal's comment decisions. */
export function removeStatement(text: string, statement: ts.Statement, source: ts.SourceFile): string {
  const start = statement.getStart(source), first = lineStart(text, start);
  const newline = text.indexOf("\n", statement.end);
  const whole = text.slice(first, start).trim() === "" && text.slice(statement.end, newline === -1 ? text.length : newline).trim() === "";
  return removeWithComments(text, source, statement, [{ from: whole ? first : start, to: whole ? newline === -1 ? text.length : newline + 1 : statement.end }]);
}

/** Removes one array element and its separator, keeping the surrounding layout. */
export function removeElement(text: string, array: ts.ArrayLiteralExpression, element: ts.Expression, source: ts.SourceFile): string {
  return removeListElement(text, array.elements, element, source);
}

function removeListElement(text: string, elements: readonly ts.Node[], element: ts.Node, source: ts.SourceFile): string {
  const index = elements.indexOf(element);
  const previous = elements[index - 1];
  const spans = [{ from: element.getStart(source), to: element.end }];
  const following = followingComma(text, element.end);
  let trailing = element.end;
  if (following) {
    trailing = following.to;
    spans[0]!.to = trailing;
    if (index < elements.length - 1) while (text[spans[0]!.to] === " " || text[spans[0]!.to] === "\t") spans[0]!.to++;
    // When the last element has a trailing comma, keep the previous separator's
    // style without leaving the removed element's leading whitespace behind.
    if (index === elements.length - 1 && previous) {
      const separator = followingComma(text, previous.end);
      if (separator && /^\s*$/.test(text.slice(separator.to, spans[0]!.from))) spans[0]!.from = separator.to;
    }
  } else if (previous) {
    const separator = followingComma(text, previous.end);
    if (/^\s*,\s*$/.test(text.slice(previous.end, spans[0]!.from))) spans[0]!.from = previous.end;
    else if (separator) spans.push(separator);
  }
  return removeWithComments(text, source, element, spans, trailing);
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
    text = removeListElement(text, bindings.elements, element, source);
  }
}
