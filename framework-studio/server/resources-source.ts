import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { locateConfigSource } from "../../packages/framework/scripts/config-source";
import { SourceFiles } from "./source";
import { inputModeIntents, sameInputModes, type ResourceIntent, type RequirementRule } from "../shared/resources";
import type { Mode, ModelResource, ModelTarget } from "../shared/model";
import { editableFiles, toRelative } from "./files";
import { insertProperty, removeProperty } from "./edits/splice";
import { declarationHost } from "./source/declarations";
import { declarationObject, expressionAt, findProperty, hasComments, literalKey, literalValue, parse, propertyAt, unwrap } from "./source/syntax";
import { parseOrigin } from "./model/origin";
import type { StudioState } from "./snapshot";
import { readCatalogSource } from "./source/catalog";
import { CLIENT_ENVIRONMENT_FILE, isSplitMapping, type ClientEnvironmentBinding, type ClientEnvironmentMappings } from "../shared/client-environment";
import { parseClientMappings, rewriteClientMappings } from "./client-environment-source";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const MODES: readonly Mode[] = ["dev", "prod"];
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
export function insertExpression(text: string, source: ts.SourceFile, object: ts.ObjectLiteralExpression, keys: readonly string[], expression: string): string {
  // Reuse the comment/indentation-aware splice, then replace only its fresh literal.
  const marker = `studio_${randomUUID().replaceAll("-", "")}`;
  return insertProperty(text, source, object, keys, marker, { after: [], before: [] }).replace(JSON.stringify(marker), expression);
}
/** `.only()`, `.required()` and `.default()` in their shortest form, around the choice list. */
function policyCalls(modes: ResourceIntent["modes"], choices: string): string {
  const present = MODES.filter((mode) => modes[mode].present);
  const required = present.filter((mode) => modes[mode].required);
  const defaults = present.filter((mode) => modes[mode].default !== null);
  const shared = defaults.length === present.length && new Set(defaults.map((mode) => modes[mode].default)).size === 1;
  return (present.length === 1 ? `.only(${JSON.stringify(present[0])})` : "")
    + (!required.length ? "" : required.length === present.length ? ".required()" : `.required(${JSON.stringify(required[0])})`)
    + choices
    + (!defaults.length ? "" : shared ? `.default(${JSON.stringify(modes[defaults[0]!].default)})`
      : `.default({ ${defaults.map((mode) => `${mode}: ${JSON.stringify(modes[mode].default)}`).join(", ")} })`);
}
/** A literal argument: a string, or the per-mode object a default or source value takes. */
function literalArgument(call: string, argument: ts.Expression): boolean {
  const value = unwrap(argument);
  if ((call === "default" || call === "value") && ts.isObjectLiteralExpression(value)) return value.properties.every((property) => ts.isPropertyAssignment(property) && MODES.includes(literalKey(property) as Mode) && typeof literalValue(property.initializer)?.value === "string");
  return typeof literalValue(argument)?.value === "string";
}
function builderExpression(value: ts.Expression, resource: ModelResource, intent: ResourceIntent): string {
  const outer = unwrap(value);
  const current = inputModeIntents(resource);
  if (ts.isConditionalExpression(outer)) {
    // Preserve the authored deployment condition and its undefined branch. The condition decides
    // presence, so the branch states the one graph it is reached in without `.only()`.
    const left = outer.whenTrue.kind === ts.SyntaxKind.Identifier && outer.whenTrue.getText() === "undefined";
    const right = outer.whenFalse.kind === ts.SyntaxKind.Identifier && outer.whenFalse.getText() === "undefined";
    if (!left && !right) return fail("This conditional has two resource declarations. Edit it in source.");
    if (MODES.some((mode) => intent.modes[mode].present !== current[mode].present)) return fail("A conditional in source decides where this input is present. Replace it with .only() to change its environments here.");
    const reached = MODES.find((mode) => intent.modes[mode].present);
    const branchIntent = reached ? { ...intent, modes: { dev: intent.modes[reached], prod: intent.modes[reached] } } : intent;
    const branchPolicy = reached ? { present: true, required: current[reached].required,
      ...(current[reached].default === null ? {} : { default: current[reached].default! }),
      ...(current[reached].value == null ? {} : { value: current[reached].value! }) } : undefined;
    const branchResource = branchPolicy ? { ...resource, modes: { dev: branchPolicy, prod: branchPolicy } } : resource;
    const branch = left ? outer.whenFalse : outer.whenTrue;
    const rewritten = builderExpression(branch, branchResource, branchIntent);
    return left ? `${outer.condition.getText()} ? undefined : ${rewritten}` : `${outer.condition.getText()} ? ${rewritten} : undefined`;
  }
  let node = outer;
  const calls: { name: string; args: readonly ts.Expression[]; node: ts.CallExpression }[] = [];
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const call = node;
    const access = node.expression;
    calls.unshift({ name: access.name.text, args: [...call.arguments], node: call });
    const receiver = unwrap(access.expression);
    if (ts.isIdentifier(receiver) && receiver.text === "resource") {
      if (!["fromEnv", "secret", "value"].includes(access.name.text)) return fail("This entry is not an input parameter.");
      break;
    }
    node = receiver;
  }
  if (!calls.length || !["fromEnv", "secret", "value"].includes(calls[0]!.name) || calls.some((call) => !["fromEnv", "secret", "value", "enum", "default", "note", "required", "only"].includes(call.name))) return fail("This resource is computed. Edit its declaration in source.");
  for (const [index, call] of calls.entries()) for (const [argumentIndex, argument] of call.args.entries()) {
    if (index === 0 && argumentIndex === 1) {
      // Descriptor metadata is independent of the input value. Keep its exact
      // source while editing defaults/required, including authored tag maps.
      if (!ts.isObjectLiteralExpression(unwrap(argument))) return fail("This resource uses computed options. Edit it in source.");
    } else if (!literalArgument(call.name, argument)) return fail("This resource uses computed arguments. Edit it in source.");
  }
  const fromEnv = intent.fromEnv === undefined ? resource.fromEnv ?? null : intent.fromEnv;
  if (intent.kind === resource.kind && fromEnv === (resource.fromEnv ?? null) && sameInputModes(intent.modes, current)) {
    const original = outer.getText();
    if (calls[0]!.args.length) return original;
    const base = calls[0]!.node;
    const position = base.end - 1 - outer.getStart();
    return original.slice(0, position) + JSON.stringify(resource.fromEnv) + original.slice(position);
  }
  if (hasComments(outer.getText())) return fail("This resource declaration contains comments. Edit it in source to preserve them.");
  // Always keep the resolved env name explicit when moving between groups.
  const choices = calls.find((call) => call.name === "enum");
  const metadata = calls[0]!.args[1] ? `, ${calls[0]!.args[1]!.getText()}` : "";
  const choiceCall = intent.kind === "input" && choices ? `.enum(${choices.args.map((argument) => argument.getText()).join(", ")})` : "";
  let result: string;
  if (fromEnv === null) {
    const present = MODES.filter((mode) => intent.modes[mode].present);
    const shared = new Set(present.map((mode) => intent.modes[mode].value)).size === 1;
    const value = shared ? JSON.stringify(intent.modes[present[0]!].value)
      : `{ ${present.map((mode) => `${mode}: ${JSON.stringify(intent.modes[mode].value)}`).join(", ")} }`;
    result = `resource.value(${value}${metadata})${present.length === 1 ? `.only(${JSON.stringify(present[0])})` : ""}${choiceCall}`;
  } else {
    result = `resource.${intent.kind === "secret" ? "secret" : "fromEnv"}(${JSON.stringify(fromEnv)}${metadata})`;
    result += policyCalls(intent.modes, choiceCall);
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

/** Move the explicit catalog membership while its exported descriptor stays put. */
function moveImportedMembership(root: string, facts: { readonly key: import("../shared/model").SourceLocation }, declarationFile: string, exportName: string, nextPath: readonly string[], overrides: Record<string, string>): void {
  const read = (file: string) => overrides[file] ?? readFileSync(file, "utf8");
  const membershipFile = path.join(root, facts.key.file);
  let text = read(membershipFile);
  const source = parse(membershipFile, text);
  let membership: ts.ObjectLiteralElementLike | undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getStart(source) === facts.key.start && ts.isObjectLiteralExpression(node.parent)) membership = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!membership || !ts.isObjectLiteralExpression(membership.parent)) return fail("The catalog membership is ambiguous. Move it in source.");
  overrides[membershipFile] = removeProperty(text, source, membership.parent, membership);

  const facade = path.join(root, "framework-config/resources.ts");
  let destination = facade;
  text = read(facade);
  let parsed = catalog(facade, text);
  let object = parsed.object;
  let keys = nextPath;
  if (nextPath.length > 1) {
    const group = findProperty(object, nextPath[0]!);
    if (group.spread) return fail("The destination group comes from a spread. Move the membership in source.");
    if (group.property) {
      const call = object.parent;
      const entry = readCatalogSource(root, facade, { start: call.getStart(parsed.source), end: call.end }, read).get(nextPath[0]!);
      if (!entry) return fail("The destination group could not be located.");
      destination = path.join(root, entry.value.file);
      text = read(destination);
      const source = parse(destination, text);
      const value = expressionAt(source, entry.value.start, entry.value.end);
      if (!value || !ts.isObjectLiteralExpression(unwrap(value))) return fail("The destination group is computed. Move the membership in source.");
      parsed = { source, object: unwrap(value) as ts.ObjectLiteralExpression };
      object = parsed.object;
      keys = [nextPath.at(-1)!];
    }
  }
  if (object.properties.some(ts.isSpreadAssignment) || findProperty(object, keys[0]!).property) return fail("The destination catalog identity exists or includes a spread.");
  let alias = exportName;
  if (path.resolve(destination) !== path.resolve(declarationFile)) {
    const imported = parsed.source.statements.filter(ts.isImportDeclaration).find(statement => ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".") && path.resolve(path.dirname(destination), statement.moduleSpecifier.text.replace(/\.(?:js|ts)$/, "")) === declarationFile.replace(/\.ts$/, "") && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(binding => (binding.propertyName?.text ?? binding.name.text) === exportName));
    if (imported?.importClause?.namedBindings && ts.isNamedImports(imported.importClause.namedBindings)) alias = imported.importClause.namedBindings.elements.find(binding => (binding.propertyName?.text ?? binding.name.text) === exportName)!.name.text;
    else {
      for (let suffix = 2; new RegExp(`\\b${alias}\\b`).test(text); suffix++) alias = `${exportName}${suffix}`;
      let specifier = path.relative(path.dirname(destination), declarationFile).replaceAll("\\", "/").replace(/\.ts$/, "");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      const statement = `import { ${exportName}${alias === exportName ? "" : ` as ${alias}`} } from ${JSON.stringify(specifier)};\n`;
      text = statement + insertExpression(text, parsed.source, object, keys, alias);
      overrides[destination] = text;
      return;
    }
  }
  overrides[destination] = insertExpression(text, parsed.source, object, keys, alias);
}

/** Client recipes name inputs as data, so update their parsed bindings independently of TS references. */
function migrateClientInputReferences(root: string, resource: ModelResource, intent: ResourceIntent, nextPath: readonly string[], fromEnv: string | null, overrides: Record<string, string>): void {
  const nextId = `resource:${nextPath.join(".")}`;
  const names = new Map<string, string>();
  if (resource.id !== nextId) names.set(resource.id, nextId);
  if (resource.fromEnv && resource.fromEnv !== fromEnv) names.set(resource.fromEnv, nextId);
  const becomesSecret = resource.kind === "input" && intent.kind === "secret";
  if (!names.size && !becomesSecret) return;
  const file = path.join(root, CLIENT_ENVIRONMENT_FILE);
  if (!existsSync(file)) return;
  const before = overrides[file] ?? readFileSync(file, "utf8");
  const { mappings } = parseClientMappings(before);
  const previousNames = new Set([resource.id, ...(resource.fromEnv ? [resource.fromEnv] : [])]);
  const rename = (name: string): string => {
    if (becomesSecret && previousNames.has(name)) return fail("Remove this input's public client mappings before converting it to a secret.");
    return names.get(name) ?? name;
  };
  const binding = (value: ClientEnvironmentBinding): ClientEnvironmentBinding => ({ ...value,
    ...(value.kind === "input" ? { name: rename(value.name) } : {}),
    ...(value.kind === "endpoint" ? { port: rename(value.port), ...(value.override ? { override: rename(value.override) } : {}) } : {}),
    ...(value.when ? { when: { ...value.when, input: rename(value.when.input) } } : {}),
  });
  const next: ClientEnvironmentMappings = Object.fromEntries(Object.entries(mappings).map(([name, value]) => [name,
    isSplitMapping(value) ? { dev: binding(value.dev), prod: binding(value.prod) } : binding(value),
  ]));
  if (JSON.stringify(next) !== JSON.stringify(mappings)) overrides[file] = rewriteClientMappings(before, next);
}

export function planResourceSource(root: string, state: StudioState, resource: ModelResource, intent: ResourceIntent): { overrides: Record<string, string>; nextResource: string } {
  if (!IDENTIFIER.test(intent.group || "ungrouped") || ["__proto__", "constructor", "prototype"].includes(intent.group)) return fail("A group must be a safe TypeScript property name, or empty for no group.");
  if (!MODES.some((mode) => intent.modes[mode].present)) return fail("Keep this input in at least one environment, or delete it.");
  const fromEnv = intent.fromEnv === undefined ? resource.fromEnv ?? null : intent.fromEnv;
  if (fromEnv !== null && !ENVIRONMENT_VARIABLE.test(fromEnv)) return fail("Name one SCREAMING_SNAKE_CASE environment variable.");
  if (fromEnv === null && intent.kind === "secret") return fail("Secrets must be linked to an environment variable. Never author secret values in source.");
  if (fromEnv && fromEnv !== resource.fromEnv && [state.snapshot.models.dev, state.snapshot.models.prod].some((model) => model.resources.some((other) => other.id !== resource.id && other.fromEnv === fromEnv))) return fail("This environment variable is already declared by another input.");
  for (const mode of MODES) {
    const { present, required, default: fallback, value } = intent.modes[mode];
    if (fromEnv === null) {
      if (fallback !== null || required) return fail("A standalone input has a value, without an environment-file default or requirement.");
      if (!present && value != null) return fail(`${mode === "dev" ? "Development" : "Production"} does not hold this input, so it cannot have a value there.`);
      if (present && (typeof value !== "string" || !value.trim())) return fail("Enter a value for every environment that holds this standalone input.");
      if (present && resource.values && !resource.values.includes(value!)) return fail("The value must be one of the declared choices.");
      continue;
    }
    if (value != null) return fail("An environment-linked input has an optional default, not a standalone value.");
    if (!present && (required || fallback !== null)) return fail(`${mode === "dev" ? "Development" : "Production"} does not hold this input, so it cannot be required or have a default there.`);
    if (fallback === null) continue;
    if (intent.kind === "secret") return fail("Secrets cannot have a default in source. Author the value only in cdk-app/.env.");
    if (!fallback.trim()) return fail("Use no default instead of a blank default.");
    if (resource.values && !resource.values.includes(fallback)) return fail("The default must be one of the declared choices.");
  }
  const facts = state.built.catalog.get(resource.path.join("."));
  if (!facts) return fail("This resource could not be located in source.");
  const file = path.join(root, facts.value.file);
  const original = readFileSync(file, "utf8");
  const nextPath = [...(intent.group ? [intent.group] : []), resource.path.at(-1)!];
  const moved = nextPath.join(".") !== resource.path.join(".");
  const metadataChanged = intent.kind !== resource.kind || fromEnv !== (resource.fromEnv ?? null) || !sameInputModes(intent.modes, inputModeIntents(resource));
  let text = original;
  const overrides: Record<string, string> = {};
  const parsed = parse(file, original);
  const resolvedValue = expressionAt(parsed, facts.value.start, facts.value.end);
  const directDescriptor = resolvedValue && !(ts.isCallExpression(unwrap(resolvedValue)) && ts.isIdentifier((unwrap(resolvedValue) as ts.CallExpression).expression) && (unwrap(resolvedValue) as ts.CallExpression).expression.getText(parsed) === "defineResources");
  // A split catalog edits metadata where it was authored. Moving an exported
  // descriptor changes its explicit catalog membership without flattening it.
  if (!original.includes("defineResources(")) {
    if (!directDescriptor || !resolvedValue) return fail("This resource declaration could not be read.");
    if (metadataChanged) text = replace(text, resolvedValue, builderExpression(resolvedValue, resource, intent), parsed);
    if (moved) {
      const parent = resolvedValue.parent;
      if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name) || !ts.isVariableDeclarationList(parent.parent) || !ts.isVariableStatement(parent.parent.parent) || !parent.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return fail("This resource is inline inside its declaration group. Move its catalog membership in source, preserving any local fragments.");
      overrides[file] = text;
      const shifted = facts.key.file === toRelative(root, file) && facts.key.start >= resolvedValue.end
        ? { key: { ...facts.key, start: facts.key.start + text.length - original.length, end: facts.key.end + text.length - original.length } } : facts;
      moveImportedMembership(root, shifted, file, parent.name.text, nextPath, overrides);
      text = overrides[file] ?? text;
    }
  } else {
  let { source, object } = catalog(file, original);
  const found = entry(object, resource.path);
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
  }
  if (text !== original) overrides[file] = text;
  const targets = new Map([...state.snapshot.models.dev.targets, ...state.snapshot.models.prod.targets].map((target) => [target.ref, target]));
  // Each workload keeps all its other conditions. An override deliberately materializes
  // that workload's shared requirement list, which is shown in the preview.
  for (const [id, policy] of Object.entries(intent.requirements)) {
    const target = targets.get(id);
    if (!target || !consumesResource(target, resource.id)) return fail("Requirements can be edited only for workloads that consume this resource.");
    writeRequirements(root, overrides, target, resource.id, policy);
  }
  if (moved || intent.kind !== resource.kind) {
    for (const candidate of sourceFiles(root)) {
      const before = overrides[candidate] ?? readFileSync(candidate, "utf8");
      const parsed = parse(candidate, before);
      const aliases = new Set<string>();
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !importedCatalog(candidate, statement.moduleSpecifier.text, path.join(root, "framework-config/resources.ts"), root)) continue;
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
  migrateClientInputReferences(root, resource, intent, nextPath, fromEnv, overrides);
  // Parsing is mandatory before evaluating code. A failed preview writes nothing.
  for (const [name, candidate] of Object.entries(overrides)) {
    const diagnostics = ts.transpileModule(candidate, { fileName: name, reportDiagnostics: true }).diagnostics ?? [];
    if (diagnostics.length) return fail(`The change does not parse in ${toRelative(root, name)}.`);
  }
  if (!Object.keys(overrides).length) return fail("This resource already has these settings.");
  return { overrides, nextResource: `resource:${nextPath.join(".")}` };
}

export function consumesResource(target: ModelTarget, id: string): boolean {
  return target.lanes.when?.resource === id || target.environment.some((item) => item.value.kind === "reference" && item.value.resource === id) || target.secrets.some((item) => item.resource === id) || (target.requirementRules ?? []).some((rule) => rule.require.includes(id) || rule.when?.resource === id);
}

function reference(id: string, alias = "studioResources"): string {
  if (!/^resource:[A-Za-z0-9_$.-]+$/.test(id)) return fail("This requirement contains a reference the editor cannot write.");
  return `${alias}${id.slice("resource:".length).split(".").map((part) => `[${JSON.stringify(part)}]`).join("")}`;
}
function ruleText(rule: RequirementRule, alias: string): string {
  return `{ ${rule.when ? `when: { resource: ${reference(rule.when.resource, alias)}, equals: ${JSON.stringify(rule.when.equals)} }, ` : ""}require: [${rule.require.map((id) => reference(id, alias)).join(", ")}]${rule.message ? `, message: ${JSON.stringify(rule.message)}` : ""} }`;
}
function writeRequirements(root: string, overrides: Record<string, string>, target: ModelTarget, resource: string, policy: "required" | "optional"): void {
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
    if (hasComments(written)) return fail("This requirement list contains comments. Edit it in source to preserve them.");
    text = replace(text, position.property.initializer, expression, source);
  } else text = insertExpression(text, source, position.container, position.missing, expression);
  const catalogFile = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root }).properties.resources?.file;
  if (!catalogFile) return fail("The catalog module could not be located.");
  let specifier = path.relative(path.dirname(file), catalogFile).replaceAll("\\", "/").replace(/\.ts$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  if (rules.length) text = `import { resources as ${alias} } from ${JSON.stringify(specifier)};\n${text}`;
  overrides[file] = text;
}

/** Type-check candidate modules and their imports, without writing or emitting. */
export function resourceTypeErrors(root: string, overrides: Readonly<Record<string, string>>, deletedFiles: ReadonlySet<string> = new Set()): string[] {
  const configPath = path.join(root, "cdk-app/tsconfig.json");
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, types: ["node"] };
  if (existsSync(configPath)) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options, noEmit: true };
  }
  const host = declarationHost(root, options);
  const read = host.readFile;
  const exists = host.fileExists;
  const directoryExists = host.directoryExists?.bind(host);
  host.readFile = (name) => deletedFiles.has(path.resolve(name)) ? undefined : overrides[path.resolve(name)] ?? read(name);
  host.fileExists = (name) => !deletedFiles.has(path.resolve(name)) && (path.resolve(name) in overrides || exists(name));
  host.directoryExists = (name) => Object.keys(overrides).some((file) => file.startsWith(path.resolve(name) + path.sep)) || !!directoryExists?.(name);
  const roots = [...new Set([...editableFiles(root).map((name) => path.join(root, name)), ...Object.keys(overrides).filter((file) => /\.tsx?$/.test(file) && !path.relative(root, file).startsWith(`archived-workloads${path.sep}`))])].filter(file => !deletedFiles.has(file));
  const program = ts.createProgram(roots, options, host);
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).slice(0, 12).map((diagnostic) => `${diagnostic.file ? toRelative(root, diagnostic.file.fileName) + ": " : ""}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
}

export function assertResourceFile(root: string, file: string): void {
  if (lstatSync(file).isSymbolicLink()) return fail("Resource configuration cannot be edited through a symbolic link.");
  const relative = path.relative(realpathSync(root), realpathSync(file)).replaceAll("\\", "/");
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.tsx?$/.test(file) || /(?:^|\/)(?:node_modules|generated|\.cache|\.git)(?:\/|$)|\.gen\.tsx?$/.test(relative)) return fail("This is not an authored resource configuration file.");
}
