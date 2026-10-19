import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModelResource, SourceLocation } from "../../shared/model";
import { expressionAt, lineAndColumn, literalKey, parse, unwrap } from "./syntax";

/**
 * What the catalog's source says that its evaluated value cannot.
 *
 * `resource.stack<T>()` mints members on access, so the evaluated catalog knows
 * only the members something reads. The class `T` knows them all: its public
 * fields are the catalog's entries, exactly as `StackResourceKeys<T>` reads
 * them. And a catalog entry is bound to its construct by a `linkResources`
 * call in application CDK, which only that source shows.
 */

export interface StackMember {
  readonly name: string;
  readonly typeText: string;
  readonly category: "construct" | "value" | "secret";
  readonly location: SourceLocation;
  readonly assignments?: readonly SourceLocation[];
  readonly networkPlacement?: ModelResource["networkPlacement"];
}

export interface CatalogEntrySource {
  /** The entry's declaration in resources.ts. */
  readonly key: SourceLocation;
  readonly value: SourceLocation;
  /** `PROD_DEPLOYMENT ? … : undefined`: the condition under which the entry exists. */
  readonly condition?: string;
  /** For `resource.stack<T>()`, the class and its public members. */
  readonly stack?: { readonly className: string; readonly location?: SourceLocation; readonly members: readonly StackMember[] };
  readonly stackUsage?: ModelResource["stackUsage"];
}

function relative(repositoryRoot: string, file: string): string {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function locate(repositoryRoot: string, sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  const start = node.getStart(sourceFile);
  return { file: relative(repositoryRoot, sourceFile.fileName), ...lineAndColumn(sourceFile, start), start, end: node.end };
}

function moduleFile(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  return [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate));
}

function importedFrom(sourceFile: ts.SourceFile, name: string): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === name)) {
      return statement.moduleSpecifier.text;
    }
  }
  return undefined;
}

/** The `T` of `resource.stack<T>()` anywhere inside an entry's value. */
function stackClassName(value: ts.Expression): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "resource" &&
      node.expression.name.text === "stack"
    ) {
      const argument = node.typeArguments?.[0];
      if (argument && ts.isTypeReferenceNode(argument)) found = argument.typeName.getText();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(value);
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function categorize(typeText: string): StackMember["category"] {
  if (typeText === "string") return "value";
  if (/\bI?Secret\b/.test(typeText)) return "secret";
  return "construct";
}

/** A stack class's public fields and getters: the members `StackResourceKeys<T>` would read. */
export function stackMembers(repositoryRoot: string, file: string, className: string) {
  const sourceFile = parse(file, readFileSync(file, "utf8"));
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!declaration) return undefined;
  const placements = new Map<string, ModelResource["networkPlacement"]>();
  const readPlacement = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isNewExpression(node.right)) {
      const options = node.right.arguments?.[2];
      const property = (value: ts.Node | undefined, name: string) => value && ts.isObjectLiteralExpression(value) ? value.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && literalKey(item) === name)?.initializer : undefined;
      const selection = property(property(options, "vpcSubnets"), "subnetType");
      const subnetTypes: Readonly<Record<string, NonNullable<ModelResource["networkPlacement"]>>> = { PUBLIC: "public", PRIVATE_WITH_EGRESS: "private", PRIVATE_ISOLATED: "isolated" };
      const subnet = selection && ts.isPropertyAccessExpression(selection) ? subnetTypes[selection.name.text] : undefined;
      if (subnet) placements.set(node.left.name.text, subnet);
    }
    ts.forEachChild(node, readPlacement);
  };
  readPlacement(declaration);
  const members: StackMember[] = [];
  for (const member of declaration.members) {
    if (!ts.isPropertyDeclaration(member) && !ts.isGetAccessorDeclaration(member)) continue;
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    if ([ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword].some((kind) => hasModifier(member, kind))) {
      continue;
    }
    const typeText = member.type?.getText(sourceFile) ?? "unknown";
    members.push({ name: member.name.text, typeText, category: categorize(typeText), location: locate(repositoryRoot, sourceFile, member.name), networkPlacement: placements.get(member.name.text) });
  }
  return { className, location: locate(repositoryRoot, sourceFile, declaration.name ?? declaration), members };
}

/**
 * Every catalog entry's source, keyed by catalog path (`cognito`, `langgraph.modelProvider`).
 *
 * `span` is where `defineResources(...)` is, as the config-source locator found it.
 */
export function readCatalogSource(
  repositoryRoot: string,
  file: string,
  span: { readonly start: number; readonly end: number },
): Map<string, CatalogEntrySource> {
  const entries = new Map<string, CatalogEntrySource>();
  const sourceFile = parse(file, readFileSync(file, "utf8"));
  const call = expressionAt(sourceFile, span.start, span.end);
  const unwrapped = call ? unwrap(call) : undefined;
  if (!unwrapped || !ts.isCallExpression(unwrapped)) return entries;
  const argument = unwrapped.arguments[0] ? unwrap(unwrapped.arguments[0]) : undefined;
  if (!argument || !ts.isObjectLiteralExpression(argument)) return entries;

  const visit = (object: ts.ObjectLiteralExpression, prefix: readonly string[]): void => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = literalKey(property);
      if (name === undefined) continue;
      const path = [...prefix, name];
      const value = unwrap(property.initializer);
      const condition = ts.isConditionalExpression(value) ? value.condition.getText(sourceFile) : undefined;
      const className = stackClassName(value);
      const classFile = className ? moduleFile(file, importedFrom(sourceFile, className) ?? "") : undefined;
      const stack = className
        ? classFile
          ? stackMembers(repositoryRoot, classFile, className) ?? { className, members: [] }
          : { className, members: [] }
        : undefined;
      entries.set(path.join("."), {
        key: locate(repositoryRoot, sourceFile, property.name),
        value: locate(repositoryRoot, sourceFile, property.initializer),
        ...(condition ? { condition } : {}),
        ...(stack ? { stack } : {}),
      });
      if (ts.isObjectLiteralExpression(value) && prefix.length === 0) visit(value, path);
    }
  };
  visit(argument, []);
  return entries;
}

const LINK_CALLS = new Set(["linkResources", "linkResource", "bindPostgresDatabase"]);

export function typeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "cdk.out") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...typeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(absolute);
  }
  return files;
}

/**
 * Where application CDK binds each catalog entry to its construct.
 *
 * Keyed by the catalog path the call names: `linkResources(this,
 * resources.cognito)` binds `cognito`; `linkResource(this,
 * resources.jobs, queue)` binds `jobs`.
 */
export function readLinkSites(repositoryRoot: string, read: (file: string) => string = (file) => readFileSync(file, "utf8")): Map<string, SourceLocation[]> {
  const sites = new Map<string, SourceLocation[]>();
  const files = [
    ...typeScriptFiles(path.join(repositoryRoot, "cdk-app", "lib")),
    ...typeScriptFiles(path.join(repositoryRoot, "cdk-app", "bin")),
  ];
  for (const file of files) {
    const text = read(file);
    if (![...LINK_CALLS].some((call) => text.includes(call))) continue;
    const sourceFile = parse(file, text);
    const callNames = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const resolved = moduleFile(file, statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (!resolved || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const original = element.propertyName?.text ?? element.name.text;
        const expected = original === "bindPostgresDatabase" ? "framework-database.ts" : "framework-resources.ts";
        if (LINK_CALLS.has(original) && path.resolve(resolved) === path.resolve(repositoryRoot, "cdk-app", "lib", "framework", expected)) callNames.add(element.name.text);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && callNames.has(node.expression.text)) {
        const reference = node.arguments[1]?.getText(sourceFile);
        const match = reference ? /^resources\.([A-Za-z0-9_.]+)$/.exec(reference) : null;
        if (match) {
          const key = match[1]!;
          const list = sites.get(key) ?? [];
          list.push(locate(repositoryRoot, sourceFile, node));
          sites.set(key, list);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}
