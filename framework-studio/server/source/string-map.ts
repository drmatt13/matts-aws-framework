import ts from "typescript";
import { literalKey, parse, unwrap } from "./syntax";

interface StringMapOptions {
  readonly file: string;
  readonly exportName: string;
  readonly label: string;
  readonly validate: (value: string) => string | undefined;
}

/** Shared literal-only reader for Studio's description and display-name maps.
 * Return the original AST nodes so their writers preserve neighboring source bytes. */
export function parseStringMap(text: string, options: StringMapOptions) {
  const { file, exportName, label, validate } = options;
  const source = parse(file, text);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ")}`);
  const declarations = source.statements.filter(ts.isVariableStatement)
    .filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(statement => statement.declarationList.declarations)
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === exportName);
  const initializer = declarations.length === 1 && declarations[0]!.initializer;
  const object = initializer && unwrap(initializer);
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${file} must export const ${exportName} as an object of string literals.`);
  const values: Record<string, string> = Object.create(null);
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    const key = literalKey(property);
    if (!ts.isPropertyAssignment(property) || key === undefined || properties.has(key)) throw new Error(`${file} requires unique literal keys without spreads.`);
    const value = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(value)) throw new Error(`${label} ${key} must be a string literal.`);
    const error = validate(value.text);
    if (error) throw new Error(`${label} ${key}: ${error}`);
    properties.set(key, property);
    values[key] = value.text;
  }
  return { source, object, properties, values };
}
