import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { TriggerAdapterMetadata, TriggerCapability } from "../../shared/triggers";
import type { SourceLocation } from "../../shared/model";
import { sha256 } from "../files";
import { typeScriptFiles, type CatalogEntrySource, type StackMember } from "./catalog";
import { declarationHost } from "./declarations";
import { lineAndColumn, literalKey, unwrap } from "./syntax";
import { triggerFacts } from "./trigger-facts";

interface Discovery { readonly catalog: ReadonlyMap<string, CatalogEntrySource>; readonly capabilities: readonly TriggerCapability[]; readonly files: Readonly<Record<string, string>> }
// Only serializable type/source facts are retained. No program, excerpts or evaluated resource values.
const cache = new Map<string, { key: string; result: Discovery }>();

export function discoverCapabilities(root: string, catalog: ReadonlyMap<string, CatalogEntrySource>, adapters: readonly TriggerAdapterMetadata[]): Discovery {
  const fileNames = [...new Set([
    ...[...catalog.values()].map((entry) => path.join(root, entry.value.file)),
    ...typeScriptFiles(path.join(root, "cdk-app/lib")), ...typeScriptFiles(path.join(root, "cdk-app/bin")),
    ...typeScriptFiles(path.join(root, "packages/framework/src/config")),
    path.join(root, "package-lock.json"), path.join(root, "cdk-app/tsconfig.json"),
  ])].filter(existsSync).sort();
  const hashes = Object.fromEntries(fileNames.map((file) => [path.relative(root, file).replaceAll("\\", "/"), sha256(readFileSync(file, "utf8"))]));
  const key = sha256(JSON.stringify([hashes, adapters, [...catalog].map(([id, entry]) => [id, entry.value])]));
  const previous = cache.get(root);
  if (previous?.key === key) return previous.result;
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true };
  const configPath = path.join(root, "cdk-app/tsconfig.json");
  if (existsSync(configPath)) options = { ...ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath)).options, noEmit: true };
  const roots = [...new Set([...catalog.values()].map((entry) => path.join(root, entry.value.file)).concat(typeScriptFiles(path.join(root, "cdk-app/bin"))))];
  const program = ts.createProgram(roots, options, declarationHost(root, options));
  const checker = program.getTypeChecker();
  const canonical = new Map<string, ts.Symbol>();
  const canonicalSymbol = (module: string, name: string): ts.Symbol | undefined => {
    const id = `${module}:${name}`;
    if (canonical.has(id)) return canonical.get(id);
    const specifier = module === "constructs" || module === "aws-cdk-lib" ? module : `aws-cdk-lib/${module}`;
    const resolved = ts.resolveModuleName(specifier, roots[0]!, options, ts.sys).resolvedModule;
    const source = resolved && program.getSourceFile(resolved.resolvedFileName);
    const symbol = source && checker.getSymbolAtLocation(source);
    let found = symbol && checker.getExportsOfModule(symbol).find((item) => item.name === name);
    if (found?.flags && found.flags & ts.SymbolFlags.Alias) found = checker.getAliasedSymbol(found);
    if (found) canonical.set(id, found);
    return found;
  };
  const matches = (type: ts.Type, symbol: ts.Symbol | undefined, seen = new Set<ts.Type>()): boolean => {
    if (!symbol || seen.has(type)) return false;
    seen.add(type);
    if (type.isUnion()) return type.types.filter((part) => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))).every((part) => matches(part, symbol, new Set(seen)));
    if (type.getSymbol() === symbol || (type as ts.TypeReference).target?.getSymbol() === symbol) return true;
    for (const declaration of type.getSymbol()?.declarations ?? []) if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
      for (const clause of declaration.heritageClauses ?? []) for (const base of clause.types) if (matches(checker.getTypeAtLocation(base), symbol, seen)) return true;
    }
    return false;
  };
  const stackSymbol = canonicalSymbol("aws-cdk-lib", "Stack");
  const baseMembers = new Set(stackSymbol ? checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(stackSymbol)).map((item) => item.name) : []);
  const constructSymbol = canonicalSymbol("constructs", "IConstruct") ?? canonicalSymbol("constructs", "Construct");
  const secretSymbol = canonicalSymbol("aws-secretsmanager", "ISecret");
  const locate = (node: ts.Node): SourceLocation => {
    const source = node.getSourceFile(), start = node.getStart(source);
    return { file: path.relative(root, source.fileName).replaceAll("\\", "/"), ...lineAndColumn(source, start), start, end: node.end };
  };
  const initialization = (member: ts.PropertyDeclaration | ts.PropertySignature | ts.GetAccessorDeclaration): { expression?: ts.Expression; assignment?: ts.Node } => {
    if (ts.isPropertyDeclaration(member) && member.initializer) return { expression: unwrap(member.initializer), assignment: member };
    if (!ts.isClassDeclaration(member.parent) || !member.name || !ts.isIdentifier(member.name)) return {};
    const constructor = member.parent.members.find(ts.isConstructorDeclaration);
    const variables = new Map<string, ts.Expression>();
    for (const statement of constructor?.body?.statements ?? []) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) variables.set(declaration.name.text, declaration.initializer);
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
        const value = statement.expression;
        if (value.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(value.left) && value.left.expression.kind === ts.SyntaxKind.ThisKeyword && value.left.name.text === member.name.text) {
          const expression = unwrap(value.right);
          return { expression: ts.isIdentifier(expression) ? variables.get(expression.text) ?? expression : expression, assignment: value };
        }
      }
    }
    return {};
  };
  const resultCatalog = new Map(catalog);
  const capabilities: TriggerCapability[] = [];
  for (const [id, entry] of catalog) {
    const source = program.getSourceFile(path.join(root, entry.value.file));
    let argument: ts.TypeNode | undefined;
    const visit = (node: ts.Node): void => {
      if (node.end < entry.value.start || node.getStart(source) > entry.value.end) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "stack" && node.typeArguments?.[0]) argument = node.typeArguments[0];
      ts.forEachChild(node, visit);
    };
    if (source) visit(source);
    if (!argument) continue;
    const type = checker.getTypeFromTypeNode(argument);
    const declaration = type.getSymbol()?.declarations?.find(ts.isClassDeclaration);
    if (!declaration || !matches(type, stackSymbol)) continue;
    const members: StackMember[] = [];
    for (const symbol of checker.getPropertiesOfType(type)) {
      if (baseMembers.has(symbol.name)) continue;
      const member = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!member || (!ts.isPropertyDeclaration(member) && !ts.isPropertySignature(member) && !ts.isGetAccessorDeclaration(member))) continue;
      if (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) continue;
      const fieldType = checker.getTypeOfSymbolAtLocation(symbol, member);
      if (fieldType.getCallSignatures().length) continue;
      const parts = fieldType.isUnion() ? fieldType.types.filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) : [fieldType];
      const value = parts.length > 0 && parts.every((part) => !!(part.flags & ts.TypeFlags.StringLike));
      const secret = matches(fieldType, secretSymbol);
      const category = secret ? "secret" : value ? "value" : "construct";
      if (!value && !secret && !matches(fieldType, constructSymbol) && !(fieldType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) continue;
      const location = locate(member.name ?? member);
      const initial = initialization(member);
      const signature = initial.expression && ts.isCallExpression(initial.expression) ? checker.getResolvedSignature(initial.expression)?.declaration : undefined;
      const imported = initial.expression && ts.isCallExpression(initial.expression) && ts.isPropertyAccessExpression(initial.expression.expression) && initial.expression.expression.name.text.startsWith("from") && signature?.getSourceFile().fileName.replaceAll("\\", "/").includes("/node_modules/aws-cdk-lib/");
      const owned = !imported && adapters.some((adapter) => adapter.types.some((item) => item.mutable && matches(fieldType, canonicalSymbol(item.module, item.name))));
      const typeText = value ? "string" : member.type?.getText() ?? fieldType.getSymbol()?.name ?? "unknown";
      const original = entry.stack?.members.find((item) => item.name === symbol.name);
      members.push({ ...original, name: symbol.name, typeText, category, location, assignments: initial.assignment ? [locate(initial.assignment)] : [] });
      if (category !== "construct") continue;
      const matching = adapters.filter((adapter) => adapter.types.some((item) => matches(fieldType, canonicalSymbol(item.module, item.name))));
      const canonicalTypes = [...new Set(adapters.flatMap((adapter) => adapter.types).filter((item) => matches(fieldType, canonicalSymbol(item.module, item.name))).map((item) => `${item.module}:${item.name}`))];
      // Include queue types used by option pickers even before a queue-source adapter is loaded.
      for (const field of adapters.flatMap((adapter) => adapter.fields)) if (field.resourceType && matches(fieldType, canonicalSymbol(field.resourceType.module, field.resourceType.name))) canonicalTypes.push(`${field.resourceType.module}:${field.resourceType.name}`);
      const mutableClass = parts.some((part) => part.getSymbol()?.declarations?.some(ts.isClassDeclaration));
      const fieldOwned = !imported && (owned || mutableClass);
      let manual = declaration.getSourceFile().isDeclarationFile;
      if (member.parent !== declaration) {
        const native = (node: ts.Node): void => {
          if ((ts.isPropertyAssignment(node) && literalKey(node) === "lambdaTriggers") || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["addTrigger", "addEventSource", "addSubscription", "addEventNotification"].includes(node.expression.name.text))) manual = true;
          ts.forEachChild(node, native);
        };
        native(member.parent);
      }
      capabilities.push({ resource: `resource:${id}.${symbol.name}`, stack: `resource:${id}`, name: symbol.name, location, owned: fieldOwned, canonicalTypes, facts: triggerFacts(member, symbol.name, initial.expression, matching),
        adapters: matching.map((adapter) => ({ kind: adapter.kind, ...(manual ? { reason: "Manual wiring, review required: inherited native wiring or unavailable stack implementation." } : adapter.requiresOwned && !owned ? { reason: "Imported or immutable public type; an owned mutable construct is required." } : fieldType.isUnion() && fieldType.types.length !== parts.length ? { reason: "Public field may be absent; review required." } : {}) })),
      });
    }
    const sites: SourceLocation[] = [];
    const classSymbol = declaration.name && checker.getSymbolAtLocation(declaration.name);
    for (const file of program.getSourceFiles().filter((file) => path.resolve(file.fileName).startsWith(path.join(root, "cdk-app/bin") + path.sep))) {
      const visitNew = (node: ts.Node): void => {
        if (ts.isNewExpression(node)) {
          let symbol = checker.getSymbolAtLocation(node.expression);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          if (symbol && symbol === classSymbol) sites.push(locate(node));
        }
        ts.forEachChild(node, visitNew);
      };
      visitNew(file);
    }
    resultCatalog.set(id, { ...entry, ...(sites.length ? { stackUsage: { status: "referenced" as const, sites } } : {}), stack: { ...entry.stack, className: declaration.name?.text ?? entry.stack?.className ?? "Stack", location: locate(declaration.name ?? declaration), members } });
  }
  const result = { catalog: resultCatalog, capabilities, files: hashes };
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  cache.set(root, { key, result });
  return result;
}
