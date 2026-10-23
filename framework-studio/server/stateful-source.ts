import ts from "typescript";
import type { Mode } from "../shared/model";
import type { StatefulKind, StatefulResourceSource } from "../shared/stateful-resources";
import { EditError } from "./edits/io";
import { insertProperty, removeProperty, replaceValue } from "./edits/splice";
import { hasComments, literalKey } from "./source/syntax";

export const STATEFUL_SOURCE_FILE = "framework-config/stateful-resources.ts";
const unsupported = () => new EditError(422, `Edit ${STATEFUL_SOURCE_FILE} in your editor: Studio requires an exported statefulResources object with literal dev/prod entries and no spreads, calls or computed values.`);
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function literal(node: ts.Expression): unknown {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => literal(item as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const entry of node.properties) {
      if (!ts.isPropertyAssignment(entry) || !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))) throw unsupported();
      const name = entry.name.text;
      if (["__proto__", "constructor", "prototype"].includes(name) || Object.hasOwn(result, name)) throw unsupported();
      result[name] = literal(entry.initializer);
    }
    return result;
  }
  throw unsupported();
}
export function readStatefulSource(text: string) {
  const source = ts.createSourceFile(STATEFUL_SOURCE_FILE, text, ts.ScriptTarget.Latest, true);
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) throw unsupported();
  const declarations = source.statements.flatMap(statement => ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? [...statement.declarationList.declarations].filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "statefulResources") : []);
  if (declarations.length !== 1 || !declarations[0]!.initializer) throw unsupported();
  const object = unwrap(declarations[0]!.initializer!);
  if (!ts.isObjectLiteralExpression(object)) throw unsupported();
  const value = literal(object) as Record<string, Record<string, StatefulResourceSource>>;
  if (Object.keys(value).some(key => !["dev", "prod"].includes(key))) throw unsupported();
  for (const environment of Object.values(value)) {
    if (!environment || Array.isArray(environment) || typeof environment !== "object" || Object.keys(environment).some(key => !["database", "cognito"].includes(key))) throw unsupported();
    for (const resource of Object.values(environment)) {
      if (!resource || Array.isArray(resource) || typeof resource !== "object" || Object.keys(resource).some(key => !["retention", "reference"].includes(key)) || resource.retention !== undefined && !["retain", "remove"].includes(resource.retention)) throw unsupported();
    }
  }
  return { source, object, value };
}
/** Edit only the selected policy property, preserving neighboring authored bytes. */
export function changeStatefulSource(text: string, mode: Mode, kind: StatefulKind, change: Partial<StatefulResourceSource>): string {
  if (!["dev", "prod"].includes(mode) || !["database", "cognito"].includes(kind) || Object.keys(change).some(key => key !== "retention" && key !== "reference")) throw unsupported();
  for (const key of Object.keys(change) as (keyof StatefulResourceSource)[]) {
    const { source, object } = readStatefulSource(text);
    const segments = [mode, kind, key];
    let container = object;
    let property: ts.PropertyAssignment | undefined;
    let missing = -1;
    for (let index = 0; index < segments.length; index++) {
      property = container.properties.find(entry => ts.isPropertyAssignment(entry) && literalKey(entry) === segments[index]) as ts.PropertyAssignment | undefined;
      if (!property) { missing = index; break; }
      if (index < segments.length - 1) {
        const inner = unwrap(property.initializer);
        if (!ts.isObjectLiteralExpression(inner)) throw unsupported();
        container = inner;
      }
    }
    const value = change[key];
    try {
      if (missing >= 0) {
        if (value === undefined) continue;
        if (key === "retention") text = insertProperty(text, source, container, segments.slice(missing), value as "retain" | "remove", { after: [], before: [] });
        else {
          // Insert a scalar using the shared comment/layout-aware splicer, then
          // replace exactly that freshly created initializer with the object.
          // Reparse instead of matching a quote-sensitive textual sentinel.
          text = insertProperty(text, source, container, segments.slice(missing), "", { after: [], before: [] });
          text = changeStatefulSource(text, mode, kind, { reference: value as StatefulResourceSource["reference"] });
        }
      } else if (property) {
        if (value === undefined) {
          if (hasComments(property.getText(source))) throw new Error("This lifecycle property contains source comments. Remove it in your editor so those comments are preserved deliberately.");
          text = removeProperty(text, source, container, property);
        } else if (key === "retention") text = replaceValue(text, source, property, value as "retain" | "remove");
        else {
          const initializer = unwrap(property.initializer);
          if (hasComments(initializer.getText(source))) throw new Error("This lifecycle reference contains source comments. Replace it in your editor so those comments are preserved deliberately.");
          const serialized = JSON.stringify(value, null, 2).replaceAll("\n", text.includes("\r\n") ? "\r\n" : "\n");
          text = text.slice(0, initializer.getStart(source)) + serialized + text.slice(initializer.end);
        }
      }
    } catch (error) { throw new EditError(422, error instanceof Error ? error.message : "Edit this lifecycle setting in source to preserve authored comments."); }
  }
  readStatefulSource(text);
  return text;
}
