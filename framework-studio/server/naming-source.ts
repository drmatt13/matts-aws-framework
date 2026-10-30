import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "../../packages/framework/scripts/config-source";
import { codeNameError, type RenameIssue } from "../shared/naming";
import type { ModelResource, SourceLocation } from "../shared/model";
import { inputModeIntents } from "../shared/resources";
import { CLIENT_ENVIRONMENT_FILE, isSplitMapping, type ClientEnvironmentBinding } from "../shared/client-environment";
import { parseClientMappings } from "./client-environment-source";
import { readCatalogSource, type CatalogEntrySource } from "./source/catalog";
import { SourceFiles } from "./source";
import { expressionAt, findProperty, literalKey, parse, unwrap } from "./source/syntax";
import type { StudioState } from "./snapshot";
import { planResourceSource } from "./resources-source";
import { formatLiteral, insertProperty, quoteOf } from "./edits/splice";
import { namingLocation, namingProgramIndex, namingReferences, type NamingProgramIndex, type NamingSeed, type NamingTextEdit } from "./naming-program";
export { namingSourceFingerprint } from "./naming-program";

export interface ResourceRenameResult {
  readonly entityRemap: Record<string, string>;
  readonly issues: RenameIssue[];
  readonly referenceCount: number;
  readonly sourceHashes: Record<string, string>;
  readonly sourceFiles: readonly string[];
  readonly sourceFingerprint: string;
}
interface CatalogView { readonly entries: Map<string, CatalogEntrySource>; readonly files: SourceFiles }
interface RenameOwner {
  readonly resource: ModelResource;
  readonly facts: CatalogEntrySource;
  readonly membership: ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
  readonly declaration?: ts.VariableDeclaration & { readonly name: ts.Identifier };
  readonly source: SourceLocation;
}

function catalogView(root: string, overrides: ReadonlyMap<string, string>): CatalogView {
  const files = new SourceFiles(overrides);
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const item = located.properties.resources;
  if (!item) throw new Error("The resource catalog could not be located in source.");
  return { entries: readCatalogSource(root, item.file, item.span, file => files.text(file)), files };
}

function nodeAt(source: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (node.getStart(source) > position || node.end < position) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function ownerOf(root: string, state: StudioState, entity: string, overrides: ReadonlyMap<string, string>): RenameOwner {
  const resource = Object.values(state.snapshot.models).flatMap(model => model.resources).find(value => value.id === entity && !value.absent)
    ?? Object.values(state.snapshot.models).flatMap(model => model.resources).find(value => value.id === entity);
  if (!resource || !["input", "secret", "group"].includes(resource.kind)) throw new Error("Code renaming is available for authored inputs, secrets, and input groups. Other code identities remain source-owned.");
  if (resource.kind === "group" && Object.values(state.snapshot.models).some(model => model.resources.some(child => child.id.startsWith(`${entity}.`) && !["input", "secret", "group"].includes(child.kind)))) throw new Error("This group contains native or deployed resource identities. Rename its display name instead; its code identity remains source-owned.");
  const view = catalogView(root, overrides);
  const facts = view.entries.get(resource.path.join("."));
  if (!facts) throw new Error("This catalog membership is computed or cannot be uniquely located. Resolve it in your editor.");
  const source = view.files.get(path.join(root, facts.key.file));
  const name = nodeAt(source, facts.key.start);
  const membership = name?.parent;
  if (!membership || !ts.isPropertyAssignment(membership) && !ts.isShorthandPropertyAssignment(membership) || !ts.isObjectLiteralExpression(membership.parent) || membership.parent.properties.some(ts.isSpreadAssignment)) throw new Error("This catalog membership includes a computed or spread source shape. Resolve it in your editor.");
  const sameOwner = [...view.entries.entries()].filter(([, item]) => item.value.file === facts.value.file && item.value.start === facts.value.start && item.value.end === facts.value.end);
  if (sameOwner.length > 1) throw new Error("This declaration is shared by more than one catalog identity. Separate its ownership in your editor before renaming it.");
  const declarationSource = view.files.get(path.join(root, facts.value.file));
  const value = expressionAt(declarationSource, facts.value.start, facts.value.end);
  if (!value) throw new Error("The declaration's source expression is unavailable. Reload source before renaming.");
  let parent: ts.Node = value;
  while (parent.parent && (ts.isParenthesizedExpression(parent.parent) || ts.isAsExpression(parent.parent) || ts.isSatisfiesExpression(parent.parent) || ts.isNonNullExpression(parent.parent))) parent = parent.parent;
  const declaration = ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name) && ts.isVariableDeclarationList(parent.parent.parent) && (parent.parent.parent.flags & ts.NodeFlags.Const) && ts.isVariableStatement(parent.parent.parent.parent)
    ? parent.parent as ts.VariableDeclaration & { readonly name: ts.Identifier } : undefined;
  if (!declaration && !(ts.isPropertyAssignment(parent.parent) && parent.parent === membership || ts.isPropertyAssignment(parent.parent) && resource.kind === "input" || ts.isPropertyAssignment(parent.parent) && resource.kind === "secret")) throw new Error("This declaration is computed or does not have an unambiguous authored owner. Rename it in your editor.");
  return { resource, facts, membership, declaration, source: facts.key };
}

export function resourceRenameEligibility(root: string, state: StudioState, entity: string, overrides: ReadonlyMap<string, string> = new Map()): { readonly allowed: boolean; readonly reason?: string; readonly source?: SourceLocation } {
  try { return { allowed: true, source: ownerOf(root, state, entity, overrides).source }; }
  catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error), source: state.snapshot.source.entities[entity]?.value }; }
}

function metadataPins(root: string, state: StudioState, entity: string, overlays: Map<string, string>): void {
  const resources = new Map(Object.values(state.snapshot.models).flatMap(model => model.resources).filter(resource => resource.id === entity || resource.id.startsWith(entity + ".")).map(resource => [resource.id, resource]));
  for (const resource of resources.values()) {
    if (resource.kind !== "input" && resource.kind !== "secret") continue;
    const view = catalogView(root, overlays);
    const facts = view.entries.get(resource.path.join("."));
    if (!facts) continue;
    const file = path.join(root, facts.value.file);
    let text = view.files.text(file);
    const source = parse(file, text);
    const expression = expressionAt(source, facts.value.start, facts.value.end);
    if (!expression) continue;
    const bases: { base: ts.CallExpression; method: string }[] = [];
    const collect = (value: ts.Expression): void => {
      value = unwrap(value);
      if (ts.isConditionalExpression(value)) { collect(value.whenTrue); collect(value.whenFalse); return; }
      if (ts.isIdentifier(value) && value.text === "undefined") return;
      for (let current = value; ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression); current = unwrap(current.expression.expression)) {
        if (["fromEnv", "secret", "value"].includes(current.expression.name.text)) { bases.push({ base: current, method: current.expression.name.text }); return; }
      }
      if (resource.kind === "secret" || resource.fromEnv) throw new Error("This descriptor's environment or secret binding cannot be pinned safely. Make its original environment name and bindingPath explicit in a literal declaration in your editor before renaming.");
    };
    collect(expression);
    for (const { base, method } of bases.sort((a, b) => b.base.getStart() - a.base.getStart())) {
    if (method === "value") continue;
    const first = base.arguments[0] && unwrap(base.arguments[0]);
    const missingEnvironment = !first || ts.isIdentifier(first) && first.text === "undefined";
    const pinEnvironment = !!(missingEnvironment && resource.fromEnv);
    const options = base.arguments[1] && unwrap(base.arguments[1]);
    const pinBinding = method === "secret" && (!options || ts.isObjectLiteralExpression(options) && !findProperty(options, "bindingPath").property);
    if (!pinEnvironment && !pinBinding) continue;
    if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment))) throw new Error("Secret binding metadata is computed. Make its original bindingPath explicit in your editor before renaming.");
    if (pinBinding && options && ts.isObjectLiteralExpression(options)) {
      let marker = "__studioNamingBindingPath__";
      while (text.includes(marker)) marker += "_";
      text = insertProperty(text, source, options, ["bindingPath"], marker, { after: [], before: [] }).replace(formatLiteral(marker, quoteOf(source)), JSON.stringify(resource.path));
    }
    else if (pinBinding) {
      const at = base.end - 1;
      const environment = base.arguments.length ? "" : JSON.stringify(resource.fromEnv ?? "");
      text = text.slice(0, at) + `${environment}${base.arguments.length ? base.arguments.hasTrailingComma ? " " : ", " : ", "}{ bindingPath: ${JSON.stringify(resource.path)} }` + text.slice(at);
    }
    if (pinEnvironment && first) text = text.slice(0, first.getStart()) + JSON.stringify(resource.fromEnv) + text.slice(first.end);
    else if (pinEnvironment && !pinBinding) text = text.slice(0, base.end - 1) + JSON.stringify(resource.fromEnv) + text.slice(base.end - 1);
    }
    if (text !== view.files.text(file)) overlays.set(file, text);
  }
}

function normalizeMembership(root: string, state: StudioState, entity: string, overlays: Map<string, string>): { owner: RenameOwner; shorthand: boolean } {
  let owner = ownerOf(root, state, entity, overlays);
  const shorthand = ts.isShorthandPropertyAssignment(owner.membership);
  if (shorthand) {
    const file = path.join(root, owner.facts.key.file);
    const text = overlays.get(file) ?? readFileSync(file, "utf8");
    const name = owner.membership.name.getText();
    overlays.set(file, text.slice(0, owner.membership.getStart()) + `${name}: ${name}` + text.slice(owner.membership.end));
    owner = ownerOf(root, state, entity, overlays);
  }
  return { owner, shorthand };
}

function applyEdits(index: NamingProgramIndex, overlays: Map<string, string>, edits: readonly NamingTextEdit[], name: string): void {
  const files = new Map<string, NamingTextEdit[]>();
  for (const edit of edits) { const list = files.get(edit.file) ?? []; list.push(edit); files.set(edit.file, list); }
  for (const [file, list] of files) {
    let text = overlays.get(file) ?? index.texts.get(file) ?? readFileSync(file, "utf8");
    let boundary = text.length + 1;
    for (const edit of list.sort((a, b) => b.start - a.start)) {
      if (edit.start + edit.length > boundary) throw new Error("TypeScript returned overlapping rename edits. Resolve this source in your editor.");
      text = text.slice(0, edit.start) + edit.prefix + name + edit.suffix + text.slice(edit.start + edit.length);
      boundary = edit.start;
    }
    overlays.set(file, text);
  }
}

function migrateRecipes(root: string, overlays: Map<string, string>, remap: Readonly<Record<string, string>>): void {
  const file = path.join(root, CLIENT_ENVIRONMENT_FILE);
  if (!existsSync(file) && !overlays.has(file)) return;
  const before = overlays.get(file) ?? readFileSync(file, "utf8");
  const { source, object, mappings } = parseClientMappings(before);
  const edits: { start: number; end: number; text: string }[] = [];
  const literalObject = (value: ts.Expression): ts.ObjectLiteralExpression => {
    const expression = unwrap(value);
    if (!ts.isObjectLiteralExpression(expression)) throw new Error("Client recipe references require literal source objects.");
    return expression;
  };
  const property = (object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
    const item = object.properties.find(item => literalKey(item) === key);
    return item && ts.isPropertyAssignment(item) ? item.initializer : undefined;
  };
  const reference = (value: ts.Expression | undefined) => {
    if (!value) return;
    const literal = unwrap(value);
    if (!ts.isStringLiteralLike(literal)) throw new Error("Client recipe references require literal source strings.");
    const next = remap[literal.text];
    if (!next || next === literal.text) return;
    const quote = literal.getText(source)[0];
    edits.push({ start: literal.getStart(source), end: literal.end, text: quote === "`" ? `\`${next}\`` : formatLiteral(next, quote === "'" ? "'" : '"') });
  };
  const binding = (expression: ts.Expression, value: ClientEnvironmentBinding) => {
    const object = literalObject(expression);
    if (value.kind === "input") reference(property(object, "name"));
    if (value.kind === "endpoint") { reference(property(object, "port")); reference(property(object, "override")); }
    const when = property(object, "when");
    if (when) reference(property(literalObject(when), "input"));
  };
  for (const item of object.properties) {
    if (!ts.isPropertyAssignment(item)) continue;
    const value = mappings[literalKey(item)!]!;
    if (isSplitMapping(value)) {
      const object = literalObject(item.initializer);
      binding(property(object, "dev")!, value.dev);
      binding(property(object, "prod")!, value.prod);
    } else binding(item.initializer, value);
  }
  if (!edits.length) return;
  let after = before;
  for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  parseClientMappings(after);
  overlays.set(file, after);
}

function validName(name: string): boolean {
  return codeNameError(name) === undefined;
}

function remapFor(state: StudioState, entity: string, nextPath: readonly string[]): Record<string, string> {
  const next = `resource:${nextPath.join(".")}`;
  return Object.fromEntries([...new Set([entity, ...Object.values(state.snapshot.models).flatMap(model => model.resources.map(resource => resource.id)).filter(id => id.startsWith(entity + "."))])].map(id => [id, next + id.slice(entity.length)]));
}

function emptyResult(index: NamingProgramIndex, issue: RenameIssue): ResourceRenameResult {
  return { entityRemap: {}, issues: [issue], referenceCount: 0, sourceHashes: { ...index.hashes }, sourceFiles: [], sourceFingerprint: index.fingerprint };
}

/** Renames declarations and catalog symbols through overlays; never writes source. */
export function planResourceRename(root: string, state: StudioState, entity: string, name: string, overrides: Map<string, string>): ResourceRenameResult {
  const index = namingProgramIndex(root, overrides);
  const working = new Map(overrides);
  const fallback = state.snapshot.source.entities[entity]?.value ?? namingLocation(root, path.join(root, "framework-config/resources.ts"), readFileSync(path.join(root, "framework-config/resources.ts"), "utf8"), 0);
  if (!validName(name)) return emptyResult(index, { message: codeNameError(name)!, source: fallback });
  try {
    let owner = ownerOf(root, state, entity, working);
    const oldPath = owner.resource.path;
    const nextPath = [...oldPath.slice(0, -1), name];
    if (oldPath.at(-1) === name) return { entityRemap: {}, issues: [], referenceCount: 0, sourceHashes: { ...index.hashes }, sourceFiles: [], sourceFingerprint: index.fingerprint };
    if (catalogView(root, working).entries.has(nextPath.join("."))) return emptyResult(index, { message: "That resource code name already exists in this group. Choose another name.", source: owner.source });
    metadataPins(root, state, entity, working);
    const normalized = normalizeMembership(root, state, entity, working);
    owner = normalized.owner;
    const issues: RenameIssue[] = [];
    let references = 0;
    if (owner.declaration) {
      const seed: NamingSeed = { file: path.join(root, owner.facts.value.file), start: owner.declaration.name.getStart(), name: owner.declaration.name.text };
      const found = namingReferences(index, working, seed);
      issues.push(...found.issues); references += found.edits.length;
      applyEdits(index, working, found.edits, name);
    }
    owner = ownerOf(root, state, entity, working);
    const seed: NamingSeed = { file: path.join(root, owner.facts.key.file), start: owner.membership.name.getStart(), name: oldPath.at(-1)! };
    const found = namingReferences(index, working, seed, true);
    issues.push(...found.issues); references += found.edits.length;
    applyEdits(index, working, found.edits.length ? found.edits : [{ file: seed.file, start: seed.start, length: owner.membership.name.end - seed.start, prefix: "", suffix: "" }], name);
    const entityRemap = remapFor(state, entity, nextPath);
    if (normalized.shorthand) {
      const facts = catalogView(root, working).entries.get(nextPath.join("."));
      if (facts) {
        const file = path.join(root, facts.key.file), text = working.get(file) ?? readFileSync(file, "utf8");
        const property = nodeAt(parse(file, text), facts.key.start)?.parent;
        if (property && ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ts.isIdentifier(property.initializer) && property.name.text === property.initializer.text && !/\/\*|\/\//.test(text.slice(property.name.end, property.initializer.getStart()))) working.set(file, text.slice(0, property.getStart()) + property.name.text + text.slice(property.end));
      }
    }
    migrateRecipes(root, working, entityRemap);
    const changed: string[] = [];
    for (const [file, after] of working) if (after !== (overrides.get(file) ?? index.texts.get(file) ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined))) { overrides.set(file, after); changed.push(file); }
    return { entityRemap, issues: [...new Map(issues.map(issue => [`${issue.source.file}:${issue.source.start}:${issue.message}`, issue])).values()], referenceCount: references, sourceHashes: { ...index.hashes }, sourceFiles: changed, sourceFingerprint: index.fingerprint };
  } catch (error) { return emptyResult(index, { message: error instanceof Error ? error.message : String(error), source: fallback }); }
}

/** The same semantic inventory guards the older input/secret kind conversion writer. */
export function resourceReferenceIssues(root: string, state: StudioState, entity: string, overrides: ReadonlyMap<string, string> = new Map()): readonly RenameIssue[] {
  return resourceReferenceInventory(root, state, entity, overrides).issues;
}

function resourceReferenceInventory(root: string, state: StudioState, entity: string, overrides: ReadonlyMap<string, string>, index = namingProgramIndex(root, overrides)): { issues: RenameIssue[]; referenceCount: number } {
  const working = new Map(overrides);
  try {
    const { owner } = normalizeMembership(root, state, entity, working);
    const seed = { file: path.join(root, owner.facts.key.file), start: owner.membership.name.getStart(), name: owner.resource.path.at(-1)! };
    const found = namingReferences(index, working, seed, true);
    const issues = [...found.issues];
    let referenceCount = 0;
    for (const edit of found.edits) {
      if (edit.file === seed.file && edit.start >= seed.start && edit.start + edit.length <= owner.membership.name.end) continue;
      referenceCount++;
      const source = parse(edit.file, working.get(edit.file) ?? readFileSync(edit.file, "utf8"));
      if (!legacyReference(root, source, edit.start, owner.resource.path)) issues.push({ message: `This reference needs a structural source rewrite. In your editor, use a direct typed reference to the existing resources.${owner.resource.path.join(".")} catalog entry, save, then review again. Keep the existing resource name until Apply.`, source: namingLocation(root, edit.file, source.text, edit.start, edit.start + edit.length) });
    }
    return { issues, referenceCount };
  } catch (error) {
    const source = state.snapshot.source.entities[entity]?.value ?? namingLocation(root, path.join(root, "framework-config/resources.ts"), readFileSync(path.join(root, "framework-config/resources.ts"), "utf8"), 0);
    return { issues: [{ message: error instanceof Error ? error.message : String(error), source }], referenceCount: 0 };
  }
}

function accessPath(node: ts.Expression): string[] | undefined {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) { const parent = accessPath(node.expression); return parent && [...parent, node.name.text]; }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) { const parent = accessPath(node.expression); return parent && [...parent, node.argumentExpression.text]; }
  return undefined;
}

/** Exactly the bounded access forms the existing path and kind writers rewrite. */
function legacyReference(root: string, source: ts.SourceFile, position: number, resourcePath: readonly string[]): boolean {
  const token = nodeAt(source, position);
  const access = token && (ts.isPropertyAccessExpression(token.parent) && token.parent.name === token || ts.isElementAccessExpression(token.parent) && token.parent.argumentExpression === token) ? token.parent : undefined;
  if (!access || !ts.isExpression(access)) return false;
  const parts = accessPath(access);
  if (!parts || parts.slice(1).join(".") !== resourcePath.join(".")) return false;
  return source.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) return false;
    const target = path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text.replace(/\.js$/, ""));
    if (![target, `${target}.ts`].some(file => file === path.join(root, "framework-config/resources.ts") || file === path.join(root, "framework.config.ts"))) return false;
    const bindings = statement.importClause?.namedBindings;
    return !!bindings && ts.isNamedImports(bindings) && bindings.elements.some(binding => (binding.propertyName?.text ?? binding.name.text) === "resources" && binding.name.text === parts[0]);
  });
}

/** Moving between parents requires structural source rewrites, with explicit blockers. */
export function planResourceMove(root: string, state: StudioState, entity: string, nextPath: readonly string[], overrides: Map<string, string>): ResourceRenameResult {
  const index = namingProgramIndex(root, overrides);
  const source = state.snapshot.source.entities[entity]?.value ?? namingLocation(root, path.join(root, "framework-config/resources.ts"), readFileSync(path.join(root, "framework-config/resources.ts"), "utf8"), 0);
  const working = new Map(overrides);
  try {
    const originalOwner = ownerOf(root, state, entity, working), resource = originalOwner.resource;
    if (resource.kind !== "input" && resource.kind !== "secret" || nextPath.length < 1 || nextPath.length > 2 || nextPath.at(-1) !== resource.path.at(-1) || nextPath.some(part => !validName(part))) return emptyResult(index, { message: "Move one input or secret between literal groups, preserving its code name. Review code renaming separately.", source });
    const inventory = resourceReferenceInventory(root, state, entity, working, index);
    const issues = inventory.issues;
    metadataPins(root, state, entity, working);
    const candidate = planResourceSource(root, state, resource, { resource: entity, kind: resource.kind, fromEnv: resource.fromEnv ?? null, modes: inputModeIntents(resource), group: nextPath.length > 1 ? nextPath[0]! : "", requirements: {} }, working, true);
    const entityRemap = remapFor(state, entity, nextPath);
    for (const [file, text] of Object.entries(candidate.overrides)) working.set(file, text);
    migrateRecipes(root, working, entityRemap);
    const changed: string[] = [];
    for (const [file, text] of working) if (text !== (overrides.get(file) ?? index.texts.get(file) ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined))) { overrides.set(file, text); changed.push(file); }
    return { entityRemap, issues, referenceCount: inventory.referenceCount, sourceHashes: { ...index.hashes }, sourceFiles: changed, sourceFingerprint: index.fingerprint };
  } catch (error) { return emptyResult(index, { message: error instanceof Error ? error.message : String(error), source }); }
}
