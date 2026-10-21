import path from "node:path";
import ts from "typescript";
import { locateConfigSource, type LocatedConfigSource } from "../../../packages/framework/scripts/config-source";

const names = (binding: ts.BindingName): string[] => ts.isIdentifier(binding) ? [binding.text] : binding.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : names(element.name));

function shadows(node: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(node) && node.parameters.some(parameter => names(parameter.name).includes(name))) return true;
  if (ts.isCatchClause(node) && node.variableDeclaration && names(node.variableDeclaration.name).includes(name)) return true;
  if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.some(declaration => names(declaration.name).includes(name))) return true;
  return ts.isBlock(node) && node.statements.some(statement =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations.some(declaration => names(declaration.name).includes(name))
      : (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name);
}

function shadowed(name: string, expression: ts.Node): boolean {
  for (let node: ts.Node | undefined = expression.parent; node; node = node.parent) {
    if (shadows(node, name)) return true;
  }
  return false;
}

/** Resolve only real imports of registered declarations; never accept arbitrary source expressions. */
export function importedVpc(root: string, file: string, source: ts.SourceFile, expression: ts.Expression, located: LocatedConfigSource): string | undefined {
  if (!ts.isIdentifier(expression) || shadowed(expression.text, expression)) return undefined;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const binding = bindings.elements.find(binding => binding.name.text === expression.text && !binding.isTypeOnly);
    if (!binding) continue;
    const base = path.resolve(path.dirname(file), statement.moduleSpecifier.text);
    return located.networks.find(network => network.exportName === (binding.propertyName?.text ?? binding.name.text) && [base, `${base}.ts`, path.join(base, "index.ts")].includes(network.file))?.id;
  }
  return undefined;
}

/** Bounded source evidence: direct frameworkVpc calls and simple local aliases only. */
export function nativeVpcReferences(root: string, source: ts.SourceFile, scope: ts.Node = source): { resolve(value: ts.Expression | undefined): string | undefined; used: Set<string> } {
  let located: LocatedConfigSource;
  try { located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root }); }
  catch { return { resolve: () => undefined, used: new Set() }; }
  const aliases = new Map<string, ts.VariableDeclaration | undefined>();
  const helpers = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".") && path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text).replace(/\.[jt]s$/, "") === path.join(root, "cdk-app/lib/framework/framework-network") && !statement.importClause?.isTypeOnly) {
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) for (const name of names.elements) if ((name.propertyName?.text ?? name.name.text) === "frameworkVpc" && !name.isTypeOnly) helpers.add(name.name.text);
    }
  }
  const scan = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const constant = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(node.parent.parent);
      aliases.set(node.name.text, constant && !aliases.has(node.name.text) ? node : undefined);
    }
    ts.forEachChild(node, scan);
  };
  scan(scope);
  if (scope !== source) for (const statement of source.statements) if (ts.isVariableStatement(statement)) scan(statement);
  const aliasValue = (value: ts.Identifier): ts.Expression | undefined => {
    const alias = aliases.get(value.text);
    if (!alias) return undefined;
    const owner = alias.parent.parent.parent;
    for (let node: ts.Node | undefined = value.parent; node; node = node.parent) {
      if (node === owner) return alias.initializer;
      if (shadows(node, value.text)) return undefined;
    }
    return undefined;
  };
  const declaration = (value: ts.Expression, depth = 0): string | undefined => {
    if (depth > 8) return undefined;
    const imported = importedVpc(root, source.fileName, source, value, located);
    if (imported) return imported;
    const alias = ts.isIdentifier(value) ? aliasValue(value) : undefined;
    return alias ? declaration(alias, depth + 1) : undefined;
  };
  const resolve = (value: ts.Expression | undefined, depth = 0): string | undefined => {
    if (!value || depth > 8) return undefined;
    if (ts.isIdentifier(value)) return resolve(aliasValue(value), depth + 1);
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && helpers.has(value.expression.text) && !shadowed(value.expression.text, value.expression) && value.arguments[1]) return declaration(value.arguments[1]);
    return undefined;
  };
  const used = new Set<string>();
  const collect = (node: ts.Node): void => { if (ts.isCallExpression(node)) { const id = resolve(node); if (id) used.add(id); } ts.forEachChild(node, collect); };
  collect(scope);
  return { resolve, used };
}
