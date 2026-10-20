import ts from "typescript";
import { CLIENT_ENVIRONMENT_FILE, clientMappingsError, type ClientEnvironmentMappings } from "./client-environment-mapping";

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) current = current.expression;
  return current;
}
function literalKey(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
}

/** Interpret literal data only; mapping source is never executed by Studio. */
export function parseClientMappings(text: string) {
  const source = ts.createSourceFile(CLIENT_ENVIRONMENT_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error("Fix the client mapping file's TypeScript syntax.");
  const declarations = source.statements.filter(ts.isVariableStatement).filter((statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap((statement) => statement.declarationList.declarations).filter((item) => ts.isIdentifier(item.name) && item.name.text === "clientEnvironment");
  const initializer = declarations.length === 1 && declarations[0]!.initializer;
  const object = initializer && unwrap(initializer);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${CLIENT_ENVIRONMENT_FILE} must export const clientEnvironment as a literal object.`);
  const literal = (expression: ts.Expression): unknown => {
    const value = unwrap(expression);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(value)) return value.elements.map((item) => literal(item as ts.Expression));
    if (ts.isObjectLiteralExpression(value)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of value.properties) {
        const key = literalKey(property);
        if (!ts.isPropertyAssignment(property) || key === undefined || Object.hasOwn(result, key)) throw new Error("Mapping keys must be unique literals, without spreads.");
        result[key] = literal(property.initializer);
      }
      return result;
    }
    throw new Error("Client mappings accept literal references only; expressions and calls are not supported.");
  };
  const mappings = literal(object);
  const error = clientMappingsError(mappings);
  if (error) throw new Error(error);
  return { source, object, mappings: mappings as ClientEnvironmentMappings };
}

