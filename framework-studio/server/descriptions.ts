import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DESCRIPTION_FILE, descriptionError } from "../shared/descriptions";
import { insertProperty } from "./edits/splice";
import { literalKey, parse, unwrap } from "./source/syntax";

/** Parse literals only: documentation never executes as part of Studio or a deployment. */
export function parseDescriptions(text: string) {
  const source = parse(DESCRIPTION_FILE, text);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error(`${DESCRIPTION_FILE}: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ")}`);
  const declarations = source.statements.filter(ts.isVariableStatement)
    .filter((statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "descriptions");
  const initializer = declarations.length === 1 && declarations[0]!.initializer;
  const object = initializer && unwrap(initializer);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${DESCRIPTION_FILE} must export const descriptions as an object of string literals.`);
  const values: Record<string, string> = Object.create(null);
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    const key = literalKey(property);
    if (!ts.isPropertyAssignment(property) || key === undefined || properties.has(key)) throw new Error(`${DESCRIPTION_FILE} requires unique literal keys without spreads.`);
    const value = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(value)) throw new Error(`Description ${key} must be a string literal.`);
    const error = descriptionError(value.text);
    if (error) throw new Error(`Description ${key}: ${error}`);
    properties.set(key, property);
    values[key] = value.text;
  }
  return { source, object, values, properties };
}

export function readDescriptions(root: string): { readonly values: Readonly<Record<string, string>>; readonly problem?: string } {
  const file = path.join(root, DESCRIPTION_FILE);
  try {
    if (!existsSync(file)) return { values: {}, problem: `Create ${DESCRIPTION_FILE} with export const descriptions = {}; to enable descriptions.` };
    return { values: parseDescriptions(readFileSync(file, "utf8")).values };
  } catch (error) { return { values: {}, problem: error instanceof Error ? error.message : String(error) }; }
}

export function rewriteDescription(text: string, entity: string, value: string): string {
  const error = descriptionError(value);
  if (error) throw new Error(error);
  const { source, object, properties } = parseDescriptions(text);
  const property = properties.get(entity);
  // JSON encoding handles quotes, tabs, newlines and control characters without code interpolation.
  const after = !property && object.properties.length === 0
    ? text.slice(0, object.end - 1) + `\n  ${JSON.stringify(entity)}: ${JSON.stringify(value)},\n` + text.slice(object.end - 1)
    : property
    ? text.slice(0, property.initializer.getStart(source)) + JSON.stringify(value) + text.slice(property.initializer.end)
    : insertProperty(text, source, object, [entity], "", { after: [], before: [] });
  if (!property && object.properties.length > 0) return rewriteDescription(after, entity, value);
  if (parseDescriptions(after).values[entity] !== value) throw new Error("The description did not round trip as a string literal.");
  return after;
}

/** Route keys move simultaneously so path swaps preserve each route's documentation. */
export function renameRouteDescriptions(text: string, routes: readonly { before: string; after: string }[]): string {
  const { source, properties } = parseDescriptions(text);
  const moves = routes.filter((route) => route.before !== route.after).map((route) => ({ before: `route:http:${route.before}`, after: `route:http:${route.after}` }));
  const edits = moves.flatMap((move) => {
    const property = properties.get(move.before);
    if (!property) return [];
    if (properties.has(move.after) && !moves.some((other) => other.before === move.after)) throw new Error(`A description already exists for ${move.after}. Resolve it in ${DESCRIPTION_FILE} before renaming this route.`);
    return [{ start: property.name.getStart(source), end: property.name.end, value: JSON.stringify(move.after) }];
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  parseDescriptions(text);
  return text;
}
