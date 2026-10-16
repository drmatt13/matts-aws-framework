import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CdkLinkIndex, ModelEdge, SourceLocation } from "../../shared/model";
import { sha256 } from "../files";
import type { CatalogEntrySource } from "./catalog";
import { lineAndColumn, literalKey, parse, unwrap } from "./syntax";

/** Conservative syntax scan of linked stack constructors. Never imports or synthesizes CDK. */
export function scanCdkLinks(
  repositoryRoot: string,
  catalog: ReadonlyMap<string, CatalogEntrySource>,
  links: Readonly<Record<string, readonly SourceLocation[]>>,
): CdkLinkIndex {
  const files: Record<string, string> = {};
  const edges: ModelEdge[] = [];
  const notes = ["Source inference only: direct constructor statements, public members, constructor references, SNS SQS subscriptions and EventBridge rules with explicit resource references. Helpers, conditions, loops, dynamic names and runtime behavior are not resolved."];
  for (const [catalogPath, entry] of catalog) {
    const stack = entry.stack;
    if (!stack?.location) continue;
    const file = stack.location.file;
    const text = readFileSync(path.join(repositoryRoot, file), "utf8");
    files[file] = sha256(text);
    const source = parse(file, text);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) {
      notes.push(`${file}: syntax errors; relationships omitted.`);
      continue;
    }
    const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === stack.className);
    const constructor = declaration?.members.find(ts.isConstructorDeclaration);
    if (!constructor?.body || !constructor.body.statements.some((statement) => ts.isExpressionStatement(statement) &&
      links[catalogPath]?.some((site) => site.file === file && site.start === statement.expression.getStart(source) && site.end === statement.expression.end))) continue;
    const members = new Set(stack.members.map((member) => member.name));
    const aliases = new Map<string, string>();
    const namespaces = new Map<string, string>();
    const imports = new Map<string, { module: string; name: string }>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
        imports.set(element.name.text, { module: statement.moduleSpecifier.text, name: element.propertyName?.text ?? element.name.text });
      }
    }
    const isConstructor = (node: ts.NewExpression, module: string, name: string): boolean => {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return namespaces.get(expression.expression.text) === `aws-cdk-lib/${module}` && expression.name.text === name;
      const imported = ts.isIdentifier(expression) ? imports.get(expression.text) : undefined;
      return imported?.module === `aws-cdk-lib/${module}` && imported.name === name;
    };
    const ref = (node: ts.Expression): string | undefined => {
      const value = unwrap(node);
      if (ts.isIdentifier(value)) return aliases.get(value.text);
      if (!ts.isPropertyAccessExpression(value)) return undefined;
      if (value.expression.kind === ts.SyntaxKind.ThisKeyword && members.has(value.name.text)) return `resource:${catalogPath}.${value.name.text}`;
      return ref(value.expression);
    };
    const references = (node: ts.Node): string[] => {
      const found = new Set<string>();
      const visit = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        const id = ts.isExpression(child) ? ref(child) : undefined;
        if (id) { found.add(id); return; }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return [...found];
    };
    const add = (from: string, to: string, label: string, node: ts.Node): void => {
      if (from === to) return;
      const start = node.getStart(source);
      const location = { file, ...lineAndColumn(source, start), start, end: node.end };
      const id = `cdk:${from}->${to}#${file}:${start}:${label}`;
      if (edges.some((edge) => edge.id === id)) return;
      edges.push({ id, relation: "cdk", from, to, label, provenance: "source", source: location, detail: `Inferred from CDK source · ${file}:${location.line}` });
    };
    const properties = (expression: ts.Expression | undefined): readonly ts.ObjectLiteralElementLike[] => {
      const value = expression && unwrap(expression);
      return value && ts.isObjectLiteralExpression(value) ? value.properties : [];
    };
    const property = (expression: ts.Expression | undefined, name: string): ts.Expression | undefined => {
      const prop = properties(expression).find((item) => literalKey(item) === name);
      return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
    };
    const inspect = (expression: ts.Expression, owner?: string): void => {
      const value = unwrap(expression);
      if (ts.isNewExpression(value)) {
        const props = value.arguments?.[2];
        if (owner && props) {
          for (const prop of properties(props)) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const name = literalKey(prop);
            for (const target of references(prop.initializer)) add(owner, target, name === "deadLetterQueue" ? "Dead-letter queue" : `CDK reference · ${name ?? "property"}`, prop);
          }
        }
        if (isConstructor(value, "aws-events", "Rule")) {
          const pattern = property(props, "eventPattern");
          const targets = property(props, "targets");
          if (pattern && targets) for (const from of references(pattern)) for (const to of references(targets)) add(from, to, "EventBridge rule", value);
        }
      }
      if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
        const from = ref(value.expression.expression);
        const subscription = value.arguments[0] && unwrap(value.arguments[0]);
        if (from && value.expression.name.text === "addSubscription" && subscription && ts.isNewExpression(subscription) && isConstructor(subscription, "aws-sns-subscriptions", "SqsSubscription")) {
          const to = subscription.arguments?.[0] && ref(subscription.arguments[0]);
          if (to) add(from, to, "SNS subscription", value);
        }
      }
    };
    for (const member of declaration!.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && members.has(member.name.text) && member.initializer) inspect(member.initializer, `resource:${catalogPath}.${member.name.text}`);
    }
    // Do not descend into branches or nested functions and imply they always execute.
    for (const statement of constructor.body.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const variable of statement.declarationList.declarations) {
          if (!variable.initializer) continue;
          const id = ref(variable.initializer);
          if (id && ts.isIdentifier(variable.name)) aliases.set(variable.name.text, id);
          inspect(variable.initializer);
        }
      }
      if (!ts.isExpressionStatement(statement)) continue;
      const value = unwrap(statement.expression);
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) inspect(value.right, ref(value.left));
      else inspect(value);
    }
  }
  return { version: 1, files, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), notes };
}
