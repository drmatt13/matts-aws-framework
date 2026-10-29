import path from "node:path";
import ts from "typescript";
import { locateConfigSource, type LocatedConfigSource } from "../../../packages/framework/scripts/config-source";
import type { Editability, ModeModel, SourceLocation } from "../../shared/model";
import { toRelative } from "../files";
import { parseOrigin } from "../model/origin";
import { readCatalogSource, type CatalogEntrySource } from "./catalog";
import { locateManagedDatabase } from "./database";
import type { SourceFiles } from "./index";
import { declarationObject, expressionAt, findProperty, lineAndColumn, literalKey, unwrap } from "./syntax";

/** Reuse one snapshot's discovery results; never retain them across source overlays. */
export interface TagSourceContext {
  readonly located: LocatedConfigSource;
  readonly catalog: ReadonlyMap<string, CatalogEntrySource>;
}

export interface TagSite {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly object?: ts.ObjectLiteralExpression;
  readonly segments: readonly string[];
  /** A resource builder without its optional literal options argument. */
  readonly call?: ts.CallExpression;
  readonly argumentIndex?: number;
}

const refuse = (message: string): never => { throw new Error(message); };
const optionsObject = (source: ts.SourceFile, expression: ts.Expression, segments: readonly string[]): TagSite => {
  let value = unwrap(expression);
  if (ts.isConditionalExpression(value)) {
    const absent = (item: ts.Expression) => ts.isIdentifier(item) && item.text === "undefined";
    if (absent(value.whenTrue) === absent(value.whenFalse)) return refuse("This resource has competing conditional declarations. Edit its tags in source.");
    value = unwrap(absent(value.whenTrue) ? value.whenFalse : value.whenTrue);
  }
  while (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
    const access = value.expression;
    if (ts.isIdentifier(access.expression) && access.expression.text === "resource" && ["stack", "cdk", "fromEnv", "secret"].includes(access.name.text)) {
      const argumentIndex = ["fromEnv", "secret"].includes(access.name.text) ? 1 : 0;
      const options = value.arguments[argumentIndex] && unwrap(value.arguments[argumentIndex]!);
      if (!options) return { file: source.fileName, source, call: value, argumentIndex, segments };
      if (!ts.isObjectLiteralExpression(options)) return refuse("Resource options are computed. Edit tags in source so the expression is preserved.");
      return { file: source.fileName, source, object: options, segments };
    }
    value = unwrap(access.expression);
  }
  return refuse("This resource is computed. Edit its tags in source.");
};

/** Resolve declaration ownership, independently of paths and map organization. */
export function locateTagSites(root: string, model: ModeModel, files: SourceFiles, entity: string, context?: TagSourceContext): readonly TagSite[] {
  const located = context?.located ?? locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const route = model.routes.find(route => route.id === entity);
  const target = model.targets.find(target => target.ref === (route?.target ?? entity));
  if (target) return target.origins.map(origin => {
    const parsed = parseOrigin(origin);
    const entry = parsed && parsed.section !== "defaults" ? located.sections[parsed.section].find(entry => entry.key === parsed.key) : undefined;
    if (!parsed || !entry) return refuse("This workload's declaration could not be located.");
    const source = files.get(entry.file);
    const value = expressionAt(source, entry.valueSpan.start, entry.valueSpan.end);
    if (!value) return refuse("This workload's declaration could not be read.");
    const declaration = declarationObject(value, parsed.section, parsed.chain);
    if ("unsupported" in declaration) return refuse(declaration.unsupported);
    return { file: entry.file, source, object: declaration.object, segments: ["tags"] };
  });
  if (entity.startsWith("island:vpc:")) {
    const entry = located.networks.find(network => `island:vpc:${network.id}` === entity);
    if (!entry) return refuse("The VPC declaration could not be located.");
    const source = files.get(entry.file);
    const value = expressionAt(source, entry.span.start, entry.span.end);
    const object = value && ts.isCallExpression(value) && value.arguments[0] && unwrap(value.arguments[0]);
    if (!object || !ts.isObjectLiteralExpression(object)) return refuse("VPC options are computed. Edit tags in source.");
    return [{ file: entry.file, source, object, segments: ["tags"] }];
  }
  if (entity.startsWith("framework-stack:")) {
    const name = entity.slice("framework-stack:".length);
    // framework.config.ts tags an uncataloged stack by class, in stacks or the module it imports.
    const stacks = located.properties.stacks;
    if (stacks) {
      const source = files.get(stacks.file);
      const value = expressionAt(source, stacks.span.start, stacks.span.end);
      const object = value && unwrap(value);
      if (!object || !ts.isObjectLiteralExpression(object)) return refuse("stacks is computed. Edit its tags in source.");
      return [{ file: stacks.file, source, object, segments: [name, "tags"] }];
    }
    const source = files.get(located.configFile);
    const configs: ts.ObjectLiteralExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineFrameworkConfig" && node.arguments[0] && ts.isObjectLiteralExpression(unwrap(node.arguments[0]))) configs.push(unwrap(node.arguments[0]) as ts.ObjectLiteralExpression);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (configs.length !== 1) return refuse("framework.config.ts needs one literal defineFrameworkConfig({ ... }) for Studio to add stack tags.");
    return [{ file: located.configFile, source, object: configs[0]!, segments: ["stacks", name, "tags"] }];
  }
  if (entity.startsWith("database:")) {
    const database = locateManagedDatabase(root, files);
    if (!database || entity !== `database:${database.id}`) return refuse("The database declaration could not be located.");
    return [{ file: database.file, source: database.source, object: database.object, segments: ["tags"] }];
  }
  if (entity.startsWith("resource:")) {
    const resources = located.properties.resources;
    if (!resources) return refuse("The resource catalog could not be located.");
    const catalog = context?.catalog ?? readCatalogSource(root, resources.file, resources.span, file => files.text(file));
    const key = entity.slice("resource:".length);
    let entry = catalog.get(key);
    let member: string | undefined;
    if (!entry) {
      const prefix = [...catalog.keys()].filter(prefix => key.startsWith(`${prefix}.`) && catalog.get(prefix)?.stack).sort((a, b) => b.length - a.length)[0];
      if (prefix) { entry = catalog.get(prefix); member = key.slice(prefix.length + 1); }
    }
    if (!entry || (member && member.includes("."))) return refuse("This catalog member has no independently editable metadata declaration.");
    const aliases = [...catalog].filter(([, candidate]) => candidate.value.file === entry!.value.file && candidate.value.start === entry!.value.start && candidate.value.end === entry!.value.end);
    if (aliases.length > 1) return refuse(`This resource descriptor is shared by ${aliases.map(([key]) => `resources.${key}`).join(" and ")}. Edit its shared metadata in source so every catalog owner is reviewed together.`);
    const file = path.join(root, entry.value.file);
    const source = files.get(file);
    const value = expressionAt(source, entry.value.start, entry.value.end);
    if (!value) return refuse("This resource declaration could not be read.");
    return [optionsObject(source, value, member ? ["members", member, "tags"] : ["tags"])];
  }
  return refuse("This logical item has no independently authored tags. Follow its owning declaration.");
}

/** An uncataloged stack's entry in stacks, once one is written. */
export function stackTagLocation(root: string, model: ModeModel, files: SourceFiles, name: string, context?: TagSourceContext): SourceLocation | undefined {
  try {
    const [site] = locateTagSites(root, model, files, `framework-stack:${name}`, context);
    const property = site?.object && site.segments.length === 2 ? findProperty(site.object, name).property : undefined;
    if (!site || !property) return undefined;
    const start = property.getStart(site.source);
    return { file: toRelative(root, site.file), ...lineAndColumn(site.source, start), start, end: property.end };
  } catch { return undefined; }
}

/** Only explicit string pairs are editable. Shared fragments stay source-owned. */
export function readTagSite(site: TagSite): { readonly value: Readonly<Record<string, string>>; readonly object?: ts.ObjectLiteralExpression } {
  let container = site.object;
  if (!container) return { value: {} };
  for (const segment of site.segments) {
    const found = findProperty(container, segment);
    if (found.spread) return refuse("Tags may come from a spread. Make the tags explicit in source before editing them here.");
    if (!found.property) return { value: {} };
    if (!ts.isPropertyAssignment(found.property)) return refuse("Tags use a shared expression. Edit that expression in source.");
    const value = unwrap(found.property.initializer);
    if (!ts.isObjectLiteralExpression(value)) return refuse("Tags are computed. Edit the expression in source.");
    container = value;
  }
  const value: Record<string, string> = Object.create(null);
  for (const property of container.properties) {
    const key = literalKey(property);
    if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name) || key === undefined || Object.hasOwn(value, key) || !ts.isStringLiteral(unwrap(property.initializer))) return refuse("Tags require distinct literal keys and string values for Studio editing. Edit this map in source.");
    value[key] = (unwrap(property.initializer) as ts.StringLiteral).text;
  }
  return { value, object: container };
}

export function tagEditability(root: string, model: ModeModel, files: SourceFiles, entity: string, context?: TagSourceContext): Editability {
  try {
    const sites = locateTagSites(root, model, files, entity, context);
    const facts = model.tagging?.[entity];
    for (const site of sites) {
      const read = readTagSite(site);
      const signature = (value: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (facts && signature(read.value) !== signature(facts.authored)) return { kind: "unsupported", reason: "Authored tags differ from the evaluated declaration. Edit the source expression directly." };
    }
    return sites.some(site => readTagSite(site).object) ? { kind: "literal", text: "literal tag map" } : { kind: "absent" };
  } catch (error) { return { kind: "unsupported", reason: error instanceof Error ? error.message : String(error) }; }
}
