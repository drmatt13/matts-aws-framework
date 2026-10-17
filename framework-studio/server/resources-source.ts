import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { locateConfigSource } from "../../packages/framework/scripts/config-source";
import { SourceFiles } from "./source";
import type { ResourceIntent, RequirementRule } from "../shared/resources";
import type { ModelResource, ModelTarget } from "../shared/model";
import { editableFiles, toRelative } from "./files";
import { insertProperty, removeProperty } from "./edits/splice";
import { declarationObject, expressionAt, findProperty, literalKey, literalValue, parse, propertyAt, unwrap } from "./source/syntax";
import { parseOrigin } from "./model/origin";
import type { StudioState } from "./snapshot";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const fail = (message: string): never => { throw new Error(message); };
const replace = (text: string, node: ts.Node, value: string, file: ts.SourceFile) => text.slice(0, node.getStart(file)) + value + text.slice(node.end);

function property(object: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment {
  const found = findProperty(object, key);
  if (found.spread || !found.property || !ts.isPropertyAssignment(found.property)) return fail(`${key} is not an explicit property. Edit it in source.`);
  return found.property;
}
function catalog(file: string, text: string): { source: ts.SourceFile; object: ts.ObjectLiteralExpression } {
  const source = parse(file, text);
  const calls: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineResources") {
      const argument = node.arguments[0] && unwrap(node.arguments[0]);
      if (argument && ts.isObjectLiteralExpression(argument)) calls.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (calls.length !== 1) return fail("The catalog must use one literal defineResources({...}) call to edit it here.");
  return { source, object: calls[0]! };
}
function entry(object: ts.ObjectLiteralExpression, resourcePath: readonly string[]) {
  let container = object;
  for (const key of resourcePath.slice(0, -1)) {
    const value = unwrap(property(container, key).initializer);
    if (!ts.isObjectLiteralExpression(value)) return fail("This group is computed. Edit it in source.");
    container = value;
  }
  return { container, property: property(container, resourcePath.at(-1)!) };
}
function insertExpression(text: string, source: ts.SourceFile, object: ts.ObjectLiteralExpression, keys: readonly string[], expression: string): string {
  // Reuse the comment/indentation-aware splice, then replace only its fresh literal.
  const marker = `studio_${randomUUID().replaceAll("-", "")}`;
  return insertProperty(text, source, object, keys, marker, { after: [], before: [] }).replace(JSON.stringify(marker), expression);
}
function builderExpression(value: ts.Expression, resource: ModelResource, intent: ResourceIntent): string {
  const outer = unwrap(value);
  if (ts.isConditionalExpression(outer)) {
    // Preserve the authored deployment condition and its undefined branch.
    const left = outer.whenTrue.kind === ts.SyntaxKind.Identifier && outer.whenTrue.getText() === "undefined";
    const right = outer.whenFalse.kind === ts.SyntaxKind.Identifier && outer.whenFalse.getText() === "undefined";
    if (!left && !right) return fail("This conditional has two resource declarations. Edit it in source.");
    const branch = left ? outer.whenFalse : outer.whenTrue;
    const rewritten = builderExpression(branch, resource, intent);
    return left ? `${outer.condition.getText()} ? undefined : ${rewritten}` : `${outer.condition.getText()} ? ${rewritten} : undefined`;
  }
  let current = outer;
  const calls: { name: string; args: readonly ts.Expression[]; node: ts.CallExpression }[] = [];
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const call = current;
    const access = current.expression;
    calls.unshift({ name: access.name.text, args: [...call.arguments], node: call });
    const receiver = unwrap(access.expression);
    if (ts.isIdentifier(receiver) && receiver.text === "resource") {
      if (!["fromEnv", "secret"].includes(access.name.text)) return fail("This entry is not an authored input.");
      break;
    }
    current = receiver;
  }
  if (!calls.length || !["fromEnv", "secret"].includes(calls[0]!.name) || calls.some((call) => !["fromEnv", "secret", "enum", "default", "note"].includes(call.name))) return fail("This resource is computed. Edit its declaration in source.");
  for (const call of calls) for (const argument of call.args) if (typeof literalValue(argument)?.value !== "string") return fail("This resource uses computed arguments. Edit it in source.");
  if (intent.kind === resource.kind && intent.default === (resource.default ?? null)) {
    const original = outer.getText();
    if (calls[0]!.args.length) return original;
    const base = calls[0]!.node;
    const position = base.end - 1 - outer.getStart();
    return original.slice(0, position) + JSON.stringify(resource.fromEnv) + original.slice(position);
  }
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, outer.getText());
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) return fail("This resource declaration contains comments. Edit it in source to preserve them.");
  // Always keep the resolved env name explicit when moving between groups.
  let result = `resource.${intent.kind === "secret" ? "secret" : "fromEnv"}(${JSON.stringify(resource.fromEnv)})`;
  if (intent.kind === "input") {
    const choices = calls.find((call) => call.name === "enum");
    if (choices) result += `.enum(${choices.args.map((argument) => argument.getText()).join(", ")})`;
    if (intent.default !== null) result += `.default(${JSON.stringify(intent.default)})`;
  }
  for (const call of calls.filter((call) => call.name === "note")) result += `.note(${call.args.map((argument) => argument.getText()).join(", ")})`;
  return result;
}

/** TypeScript source only. These are references to the actual catalog, never strings/comments or unrelated fixture catalogs. */
function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage"]);
  const visit = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(item.name) || item.isSymbolicLink()) continue;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) visit(absolute);
      else if (item.isFile() && /\.tsx?$/.test(item.name) && !item.name.endsWith(".d.ts")) files.push(absolute);
    }
  };
  visit(root);
  return files;
}
function importedCatalog(file: string, specifier: string, catalogFile: string, root: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ""));
  return [resolved, `${resolved}.ts`].some((candidate) => candidate === catalogFile || candidate === path.join(root, "framework.config.ts"));
}
function accessPath(node: ts.Expression): string[] | undefined {
  const value = unwrap(node);
  if (ts.isIdentifier(value)) return [value.text];
  if (ts.isPropertyAccessExpression(value)) {
    const parent = accessPath(value.expression);
    return parent && [...parent, value.name.text];
  }
  if (ts.isElementAccessExpression(value) && value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression)) {
    const parent = accessPath(value.expression);
    return parent && [...parent, value.argumentExpression.text];
  }
  return undefined;
}

export function planResourceSource(root: string, state: StudioState, resource: ModelResource, intent: ResourceIntent): { overrides: Record<string, string>; nextResource: string } {
  if (!IDENTIFIER.test(intent.group || "ungrouped") || ["__proto__", "constructor", "prototype"].includes(intent.group)) return fail("A group must be a safe TypeScript property name, or empty for no group.");
  if (intent.kind === "secret" && intent.default !== null) return fail("Secrets cannot have a default in source. Author the value only in cdk-app/.env.");
  if (intent.default !== null && !intent.default.trim()) return fail("Use no default instead of a blank default.");
  if (intent.kind === "input" && intent.default !== null && resource.values && !resource.values.includes(intent.default)) return fail("The default must be one of the declared choices.");
  const facts = state.built.catalog.get(resource.path.join("."));
  if (!facts) return fail("This resource could not be located in source.");
  const file = path.join(root, facts.value.file);
  const original = readFileSync(file, "utf8");
  let { source, object } = catalog(file, original);
  const found = entry(object, resource.path);
  const nextPath = [...(intent.group ? [intent.group] : []), resource.path.at(-1)!];
  const moved = nextPath.join(".") !== resource.path.join(".");
  const metadataChanged = intent.kind !== resource.kind || intent.default !== (resource.default ?? null);
  let text = original;
  if (metadataChanged || moved) {
    const expression = builderExpression(found.property.initializer, resource, intent);
    if (moved) {
      text = removeProperty(text, source, found.container, found.property);
      ({ source, object } = catalog(file, text));
      if (resource.path.length > 1) {
        const old = property(object, resource.path[0]!);
        const value = unwrap(old.initializer);
        if (ts.isObjectLiteralExpression(value) && value.properties.length === 0) {
          text = removeProperty(text, source, object, old);
          ({ source, object } = catalog(file, text));
        }
      }
      if (intent.group) {
        const destination = findProperty(object, intent.group);
        if (destination.spread) return fail("The destination group comes from a spread. Edit it in source.");
        if (destination.property) {
          const group = ts.isPropertyAssignment(destination.property) && unwrap(destination.property.initializer);
          if (!group || !ts.isObjectLiteralExpression(group)) return fail("The destination is not an input group.");
          if (group.properties.some((item) => literalKey(item) === nextPath.at(-1)) || group.properties.some(ts.isSpreadAssignment)) return fail("The destination group already has this name or includes a spread.");
          text = insertExpression(text, source, group, [nextPath.at(-1)!], expression);
        } else text = insertExpression(text, source, object, nextPath, expression);
      } else {
        if (findProperty(object, nextPath[0]!).property || object.properties.some(ts.isSpreadAssignment)) return fail("An ungrouped entry already has this name or the catalog includes a spread.");
        text = insertExpression(text, source, object, nextPath, expression);
      }
    } else text = replace(text, found.property.initializer, expression, source);
  }
  const overrides: Record<string, string> = {};
  if (text !== original) overrides[file] = text;
  const targets = new Map([...state.snapshot.models.dev.targets, ...state.snapshot.models.prod.targets].map((target) => [target.ref, target]));
  // Each workload keeps all its other conditions. An override deliberately materializes
  // that workload's shared requirement list, which is shown in the preview.
  for (const [id, policy] of Object.entries(intent.requirements)) {
    const target = targets.get(id);
    if (!target || !consumesResource(target, resource.id)) return fail("Requirements can be edited only for workloads that consume this resource.");
    writeRequirements(root, state, overrides, target, resource.id, policy);
  }
  if (moved || intent.kind !== resource.kind) {
    for (const candidate of sourceFiles(root)) {
      const before = overrides[candidate] ?? readFileSync(candidate, "utf8");
      const parsed = parse(candidate, before);
      const aliases = new Set<string>();
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !importedCatalog(candidate, statement.moduleSpecifier.text, file, root)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) if ((binding.propertyName?.text ?? binding.name.text) === "resources") aliases.add(binding.name.text);
      }
      if (!aliases.size) continue;
      // Avoid rewriting an identically named function parameter/local binding.
      let shadowed = false;
      const shadow = (node: ts.Node): void => {
        if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && aliases.has(node.name.text)) shadowed = true;
        ts.forEachChild(node, shadow);
      };
      shadow(parsed);
      if (shadowed) return fail(`${toRelative(root, candidate)} shadows its catalog import. Rename that local binding before moving this resource.`);
      const edits: { start: number; end: number; text: string }[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isExpression(node)) {
          const segments = accessPath(node);
          if (segments && aliases.has(segments[0]!) && segments.slice(1).join(".") === resource.path.join(".")) {
            let end = node.end;
            let suffix = "";
            const parent = node.parent;
            if (intent.kind !== resource.kind && resource.kind === "secret" && ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "arn") end = parent.end;
            if (intent.kind !== resource.kind && intent.kind === "secret" && ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isObjectLiteralExpression(parent.parent) && ts.isPropertyAssignment(parent.parent.parent) && literalKey(parent.parent.parent) === "environment") suffix = ".arn";
            edits.push({ start: node.getStart(parsed), end, text: `${segments[0]}${nextPath.map((part) => `[${JSON.stringify(part)}]`).join("")}${suffix}` });
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      let after = before;
      for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
      if (after !== before) {
        const relative = toRelative(root, candidate);
        if (/\/generated\/|\.gen\.tsx?$/.test(relative)) return fail(`${relative} is generated. Change its source and regenerate before moving this resource.`);
        overrides[candidate] = after;
      }
    }
  }
  // Parsing is mandatory before evaluating code. A failed preview writes nothing.
  for (const [name, candidate] of Object.entries(overrides)) {
    const diagnostics = ts.transpileModule(candidate, { fileName: name, reportDiagnostics: true }).diagnostics ?? [];
    if (diagnostics.length) return fail(`The change does not parse in ${toRelative(root, name)}.`);
  }
  if (!Object.keys(overrides).length) return fail("This resource already has these settings.");
  return { overrides, nextResource: `resource:${nextPath.join(".")}` };
}

export function consumesResource(target: ModelTarget, id: string): boolean {
  return target.environment.some((item) => item.value.kind === "reference" && item.value.resource === id) || target.secrets.some((item) => item.resource === id) || (target.requirementRules ?? []).some((rule) => rule.require.includes(id) || rule.when?.resource === id);
}

function reference(id: string, alias = "studioResources"): string {
  if (!/^resource:[A-Za-z0-9_$.-]+$/.test(id)) return fail("This requirement contains a reference the editor cannot write.");
  return `${alias}${id.slice("resource:".length).split(".").map((part) => `[${JSON.stringify(part)}]`).join("")}`;
}
function ruleText(rule: RequirementRule, alias: string): string {
  return `{ ${rule.when ? `when: { resource: ${reference(rule.when.resource, alias)}, equals: ${JSON.stringify(rule.when.equals)} }, ` : ""}require: [${rule.require.map((id) => reference(id, alias)).join(", ")}]${rule.message ? `, message: ${JSON.stringify(rule.message)}` : ""} }`;
}
function writeRequirements(root: string, state: StudioState, overrides: Record<string, string>, target: ModelTarget, resource: string, policy: "required" | "optional"): void {
  const origin = target.origins[0] && parseOrigin(target.origins[0]);
  const locatedSource = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: new SourceFiles(new Map(Object.entries(overrides))).host() });
  const located = origin && origin.section !== "defaults" && locatedSource.sections[origin.section].find((item) => item.key === origin.key);
  if (!origin || !located) return fail(`Cannot locate ${target.ref} in source.`);
  const file = located.file;
  let text = overrides[file] ?? readFileSync(file, "utf8");
  // Locate again against the candidate, since earlier edits may have shifted spans.
  const source = parse(file, text);
  const value = expressionAt(source, located.valueSpan.start, located.valueSpan.end);
  if (!value) return fail(`Cannot locate ${target.ref}'s declaration.`);
  const declaration = declarationObject(value, origin.section, origin.chain);
  if ("unsupported" in declaration) return fail(declaration.unsupported);
  const position = propertyAt(declaration.object, ["cloud", "requirements"]);
  if (position.editability.kind === "spread" || position.editability.kind === "unsupported") return fail("The requirements are supplied by a spread. Edit them in source.");
  const rules = (target.requirementRules ?? []).map((rule) => ({ ...rule, require: rule.require.filter((id) => id !== resource) })).filter((rule) => rule.require.length);
  if (policy === "required") rules.push({ require: [resource] });
  let alias = "studioResources";
  for (let index = 2; new RegExp(`\\b${alias}\\b`).test(text); index += 1) alias = `studioResources${index}`;
  const expression = `[${rules.map((rule) => ruleText(rule, alias)).join(", ")}]`;
  if (position.property) {
    const written = position.property.initializer.getText(source);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, written);
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) return fail("This requirement list contains comments. Edit it in source to preserve them.");
    text = replace(text, position.property.initializer, expression, source);
  } else text = insertExpression(text, source, position.container, position.missing, expression);
  const catalogFile = [...state.built.catalog.values()][0]?.value.file;
  if (!catalogFile) return fail("The catalog module could not be located.");
  let specifier = path.relative(path.dirname(file), path.join(root, catalogFile)).replaceAll("\\", "/").replace(/\.ts$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  if (rules.length) text = `import { resources as ${alias} } from ${JSON.stringify(specifier)};\n${text}`;
  overrides[file] = text;
}

/** Type-check candidate modules and their imports, without writing or emitting. */
export function resourceTypeErrors(root: string, overrides: Readonly<Record<string, string>>): string[] {
  const configPath = path.join(root, "cdk-app/tsconfig.json");
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, types: ["node"] };
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options, noEmit: true };
  }
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  host.readFile = (name) => overrides[path.resolve(name)] ?? read(name);
  const roots = [...new Set([...editableFiles(root).map((name) => path.join(root, name)), ...Object.keys(overrides)])];
  const program = ts.createProgram(roots, options, host);
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).slice(0, 12).map((diagnostic) => `${diagnostic.file ? toRelative(root, diagnostic.file.fileName) + ": " : ""}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}

export function assertResourceFile(root: string, file: string): void {
  if (lstatSync(file).isSymbolicLink()) return fail("Resource configuration cannot be edited through a symbolic link.");
  const relative = path.relative(realpathSync(root), realpathSync(file)).replaceAll("\\", "/");
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.tsx?$/.test(file) || /(?:^|\/)(?:node_modules|generated|\.cache|\.git)(?:\/|$)|\.gen\.tsx?$/.test(relative)) return fail("This is not an authored resource configuration file.");
}
