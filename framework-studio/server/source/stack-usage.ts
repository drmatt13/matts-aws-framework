import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModelResource, SourceLocation } from "../../shared/model";
import type { CatalogEntrySource } from "./catalog";
import { lineAndColumn, parse } from "./syntax";

/** Find constructor references reachable through the CDK entry point's local runtime imports.
 * Conditions and function calls are not executed: a reference is source evidence only.
 */
export function readStackUsage(repositoryRoot: string, catalog: ReadonlyMap<string, CatalogEntrySource>): Map<string, NonNullable<ModelResource["stackUsage"]>> {
  const files = new Map<string, ts.SourceFile>();
  let complete = true;
  const moduleFile = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.resolve(path.dirname(from), specifier).replace(/\.[cm]?js$/, "");
    const file = [base, `${base}.ts`, `${base}.mts`, `${base}.cts`, path.join(base, "index.ts")].find((item) => existsSync(item) && /\.[cm]?ts$/.test(item));
    if (!file) complete = false;
    return file;
  };
  const visit = (file: string): void => {
    if (files.has(file)) return;
    const source = parse(file, readFileSync(file, "utf8"));
    files.set(file, source);
    const follow = (specifier: string) => { const target = moduleFile(file, specifier); if (target) visit(target); };
    const walk = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (!clause?.isTypeOnly && (clause?.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((item) => !item.isTypeOnly))) follow(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some((item) => !item.isTypeOnly))) follow(node.moduleSpecifier.text);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) follow(node.arguments[0].text);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  try {
    const config = JSON.parse(readFileSync(path.join(repositoryRoot, "cdk-app/cdk.json"), "utf8")) as { app?: string };
    const entry = config.app?.match(/(?:^|\s)["']?(bin\/[\w./-]+\.[cm]?[jt]s)["']?(?:\s|$)/)?.[1];
    if (entry && existsSync(path.join(repositoryRoot, "cdk-app", entry))) visit(path.resolve(repositoryRoot, "cdk-app", entry));
    else complete = false;
  } catch { complete = false; }

  // Resolve imported aliases and barrel exports without loading or executing CDK.
  const resolve = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const source = files.get(file);
    if (!source) return undefined;
    for (const statement of source.statements) {
      if (ts.isClassDeclaration(statement) && statement.name && (statement.name.text === name || (name === "default" && statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword)))) return `${file}#${statement.name.text}`;
      if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = moduleFile(file, statement.moduleSpecifier.text);
        const bindings = statement.importClause?.namedBindings;
        if (target && statement.importClause?.name?.text === name) return resolve(target, "default", seen);
        if (target && bindings && ts.isNamedImports(bindings)) {
          const binding = bindings.elements.find((item) => !item.isTypeOnly && item.name.text === name);
          if (binding) return resolve(target, binding.propertyName?.text ?? binding.name.text, seen);
        }
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? moduleFile(file, statement.moduleSpecifier.text) : file;
        if (!target) continue;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const binding = statement.exportClause.elements.find((item) => !item.isTypeOnly && item.name.text === name);
          if (binding) return resolve(target, binding.propertyName?.text ?? binding.name.text, seen);
        } else if (!statement.exportClause) {
          const found = resolve(target, name, seen);
          if (found) return found;
        }
      }
    }
    return undefined;
  };
  const constructors = new Map<string, SourceLocation[]>();
  for (const [file, source] of files) {
    const walk = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        let identity: string | undefined;
        if (ts.isIdentifier(node.expression)) identity = resolve(file, node.expression.text);
        else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
          const namespace = node.expression.expression.text;
          const declaration = source.statements.find((item): item is ts.ImportDeclaration => ts.isImportDeclaration(item) && !item.importClause?.isTypeOnly && !!item.importClause?.namedBindings && ts.isNamespaceImport(item.importClause.namedBindings) && item.importClause.namedBindings.name.text === namespace);
          const target = declaration && ts.isStringLiteral(declaration.moduleSpecifier) ? moduleFile(file, declaration.moduleSpecifier.text) : undefined;
          if (target) identity = resolve(target, node.expression.name.text);
        }
        if (identity) {
          const start = node.getStart(source);
          constructors.set(identity, [...(constructors.get(identity) ?? []), { file: path.relative(repositoryRoot, file).replaceAll("\\", "/"), ...lineAndColumn(source, start), start, end: node.end }]);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return new Map([...catalog].filter(([, entry]) => entry.stack).map(([id, entry]) => {
    const stack = entry.stack!;
    const sites = stack.location ? constructors.get(`${path.resolve(repositoryRoot, stack.location.file)}#${stack.className}`) ?? [] : [];
    return [id, { status: sites.length ? "referenced" : complete && stack.location ? "unreferenced" : "unknown", sites }];
  }));
}
