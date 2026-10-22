import path from "node:path";
import ts from "typescript";
import { locateConfigSource, type SourceSpan } from "../../../packages/framework/scripts/config-source";
import type { SourceFiles } from "./index";
import { expressionAt, findProperty, unwrap } from "./syntax";

export interface LocatedManagedDatabase {
  readonly id: string;
  readonly file: string;
  readonly span: SourceSpan;
  readonly line: number;
  readonly column: number;
  readonly source: ts.SourceFile;
  readonly object: ts.ObjectLiteralExpression;
}

/** Follow only the composition root's imported, directly declared database. */
export function locateManagedDatabase(root: string, files: SourceFiles): LocatedManagedDatabase | undefined {
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const entry = located.properties.database;
  if (!entry) return undefined;
  const source = files.get(entry.file);
  const value = expressionAt(source, entry.span.start, entry.span.end);
  const call = value && unwrap(value);
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.arguments.length !== 1) return undefined;
  const imported = source.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !["@repo/framework/config", "@repo/framework/config/database"].includes(statement.moduleSpecifier.text) || statement.importClause?.isTypeOnly) return false;
    const bindings = statement.importClause?.namedBindings;
    return !!bindings && ts.isNamedImports(bindings) && bindings.elements.some(binding => !binding.isTypeOnly && (binding.propertyName ?? binding.name).text === "defineDatabase" && binding.name.text === call.expression.getText(source));
  });
  if (!imported) return undefined;
  const owners = source.statements.filter(ts.isVariableStatement).filter(statement => !!(statement.declarationList.flags & ts.NodeFlags.Const) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).flatMap(statement => [...statement.declarationList.declarations]).filter(declaration => declaration.initializer && unwrap(declaration.initializer) === call);
  if (owners.length !== 1) return undefined;
  const object = unwrap(call.arguments[0]!);
  if (!ts.isObjectLiteralExpression(object) || object.properties.some(ts.isSpreadAssignment)) return undefined;
  const id = findProperty(object, "id");
  if (!id.property || !ts.isPropertyAssignment(id.property)) return undefined;
  const identity = unwrap(id.property.initializer);
  if (!ts.isStringLiteral(identity) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(identity.text)) return undefined;
  // Placement in a directory is a convention, not declaration identity. Keep
  // writes inside the configuration tree while supporting cohesive modules.
  const inside = path.relative(path.join(root, "framework-config"), entry.file);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  return { id: identity.text, file: entry.file, span: entry.span, line: entry.line, column: entry.column, source, object };
}
