import path from "node:path";
import ts from "typescript";
import type { ConnectionEvidence, ModeModel, SourceIndex, SourceLocation } from "../../shared/model";
import type { CatalogEntrySource } from "./catalog";
import { SourceFiles } from "./index";
import { expressionAt, lineAndColumn, literalKey, literalValue, unwrap } from "./syntax";

/** Follow literal objects and their imports/spreads without evaluating application code. */
export class AuthoredSource {
  constructor(readonly files: SourceFiles) {}

  resolve(node: ts.Expression, seen = new Set<ts.Node>()): ts.Expression {
    const value = unwrap(node);
    if (seen.has(value)) return value;
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const source = value.getSourceFile();
      for (const statement of source.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === value.text && declaration.initializer) return this.resolve(declaration.initializer, seen);
        }
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const bindings = statement.importClause?.namedBindings;
        const binding = bindings && ts.isNamedImports(bindings) ? bindings.elements.find((item) => item.name.text === value.text) : undefined;
        if (!binding || !statement.moduleSpecifier.text.startsWith(".")) continue;
        const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, source.fileName, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule;
        if (!resolved || !/\.tsx?$/.test(resolved.resolvedFileName)) continue;
        const imported = this.files.get(resolved.resolvedFileName);
        for (const entry of imported.statements) if (ts.isVariableStatement(entry)) for (const declaration of entry.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === (binding.propertyName?.text ?? binding.name.text) && declaration.initializer) return this.resolve(declaration.initializer, seen);
        }
      }
    }
    if (ts.isPropertyAccessExpression(value)) {
      const property = this.property(value.expression, value.name.text, seen);
      if (property) return this.resolve(ts.isPropertyAssignment(property) ? property.initializer : property.name, seen);
    }
    return value;
  }

  property(node: ts.Expression, name: string, seen = new Set<ts.Node>()): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
    const object = this.resolve(node, seen);
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    for (const property of [...object.properties].reverse()) {
      if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && literalKey(property) === name) return property;
      if (ts.isSpreadAssignment(property)) {
        const found = this.property(property.expression, name, new Set(seen));
        if (found) return found;
        // An unresolved spread might override an earlier property.
        if (!ts.isObjectLiteralExpression(this.resolve(property.expression))) return undefined;
      }
    }
    return undefined;
  }

  at(node: ts.Expression, names: readonly string[]): ts.Expression | undefined {
    let current: ts.Expression | undefined = node;
    for (const name of names) {
      const property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined = current && this.property(current, name);
      current = property ? ts.isPropertyAssignment(property) ? property.initializer : property.name : undefined;
    }
    return current;
  }
}

function locate(root: string, node: ts.Node): SourceLocation {
  const source = node.getSourceFile();
  const start = node.getStart(source);
  return { file: path.relative(root, source.fileName).replaceAll("\\", "/"), ...lineAndColumn(source, start), start, end: node.end };
}

/** A single source line. Literal contents and comments are never copied as evidence. */
export function sourceEvidence(root: string, files: SourceFiles, role: ConnectionEvidence["role"], location: SourceLocation): ConnectionEvidence | undefined {
  if (!/\.tsx?$/.test(location.file) || path.basename(location.file).startsWith(".env")) return undefined;
  const absolute = path.resolve(root, location.file);
  if (path.relative(root, absolute).startsWith("..") || path.isAbsolute(path.relative(root, absolute))) return undefined;
  const source = files.get(absolute);
  const start = source.getLineStarts()[source.getLineAndCharacterOfPosition(location.start).line]!;
  const lineEnd = source.text.indexOf("\n", location.start);
  const end = lineEnd < 0 ? source.text.length : lineEnd;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.text);
  const changes: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (node.end < start || node.getStart(source) >= end) return;
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)) {
      // A property name and the catalog's declared input name are identifiers, not values.
      const parent = node.parent;
      const propertyName = parent && "name" in parent && parent.name === node;
      const catalogName = role === "catalog" && ts.isCallExpression(parent) && parent.arguments[0] === node && ts.isPropertyAccessExpression(parent.expression) && ["fromEnv", "secret"].includes(parent.expression.name.text);
      if (!propertyName && !catalogName) changes.push({ start: node.getStart(source), end: node.end, text: '"…"' });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (scanner.getTokenPos() >= end) break;
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) changes.push({ start: scanner.getTokenPos(), end: scanner.getTextPos(), text: "" });
  }
  let excerpt = source.text.slice(start, end);
  for (const change of changes.filter((item) => item.end > start && item.start < end).sort((a, b) => b.start - a.start)) {
    excerpt = excerpt.slice(0, Math.max(0, change.start - start)) + change.text + excerpt.slice(Math.min(end, change.end) - start);
  }
  return { role, location, excerpt: excerpt.trim() };
}

/** Enriched only in memory; this is deliberately separate from the disposable CDK index. */
export function withConnectionEvidence(root: string, model: ModeModel, index: SourceIndex, catalog: ReadonlyMap<string, CatalogEntrySource>, files = new SourceFiles()): ModeModel {
  const authored = new AuthoredSource(files);
  return { ...model, edges: model.edges.map((edge) => {
    if (!["env", "secret", "grant", "database", "trigger", "manageConnections"].includes(edge.relation)) return edge;
    const evidence: ConnectionEvidence[] = [];
    const add = (role: ConnectionEvidence["role"], location?: SourceLocation) => {
      if (!location || evidence.some((item) => item.role === role && item.location.file === location.file && item.location.start === location.start)) return;
      const item = sourceEvidence(root, files, role, location);
      if (item) evidence.push(item);
    };
    if (edge.relation === "trigger" && edge.provenance === "source") {
      add("wired", edge.source);
      return { ...edge, evidence };
    }
    const entity = index.entities[edge.relation === "trigger" ? edge.to : edge.from];
    const declaration = entity && expressionAt(files.get(path.join(root, entity.value.file)), entity.value.start, entity.value.end);
    if (declaration) {
      if (edge.relation === "trigger" || edge.permissionContext?.kind === "trigger-dlq") {
        const triggers = authored.at(declaration, ["triggers"]);
        if (triggers) {
          const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
              const settings = node.arguments[ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "adapter" ? 2 : 1];
              const id = settings && authored.at(settings, ["id"]);
              if (id && literalValue(id)?.value === edge.attachment?.split("/").at(-1)) add("declared", locate(root, node));
            }
            ts.forEachChild(node, visit);
          };
          visit(authored.resolve(triggers));
        }
      }
      const target = model.targets.find((target) => target.ref === edge.from);
      const derived = edge.provenance === "derived";
      const names = edge.relation === "manageConnections" ? ["cloud", "manageConnections"] : edge.permissionContext?.kind === "trigger-dlq" ? ["triggers"] : edge.relation === "database" ? ["database"] : derived ? [target?.role === "agent" || target?.role === "tool" ? "auth" : "userPool"] : [edge.relation === "secret" ? "secrets" : "environment", edge.label];
      const parent = names.length === 1 ? declaration : authored.at(declaration, names.slice(0, -1));
      const property = parent && authored.property(parent, names.at(-1)!);
      if (property) add(derived ? "derived" : "declared", locate(root, property));
      if (edge.relation === "grant") {
        const bindings = authored.at(declaration, ["cloud", "bindings"]);
        if (bindings) {
          const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === edge.label.split("(")[0] && node.expression.expression.getText().endsWith(edge.to.replace("resource:", ""))) add("declared", locate(root, node));
            ts.forEachChild(node, visit);
          };
          visit(authored.resolve(bindings));
        }
      }
    }
    const catalogPath = (edge.relation === "trigger" ? edge.from : edge.to).replace(/^resource:/, "");
    const owner = [...catalog.keys()].filter((key) => catalogPath === key || catalogPath.startsWith(`${key}.`)).sort((a, b) => b.length - a.length)[0];
    if (owner) {
      const entry = catalog.get(owner)!;
      add("catalog", entry.key);
      const member = entry.stack?.members.find((item) => catalogPath === `${owner}.${item.name}`);
      add("field", member?.location);
      for (const assignment of member?.assignments ?? []) add("assigned", assignment);
      if (member && entry.stack?.location) {
        const source = files.get(path.join(root, entry.stack.location.file));
        const visit = (node: ts.Node): void => {
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword && node.left.name.text === member.name) add("assigned", locate(root, node));
          ts.forEachChild(node, visit);
        };
        const stack = source.statements.find((item) => ts.isClassDeclaration(item) && item.name?.text === entry.stack?.className);
        if (stack) visit(stack);
      }
      for (const link of index.links[owner] ?? []) add("linked", link);
    }
    if (edge.relation === "trigger") add("wired", edge.source);
    return { ...edge, evidence };
  }) };
}
